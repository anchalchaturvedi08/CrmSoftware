/**
 * Auth endpoint tests.
 *
 * These exercise the properties that would be expensive to discover were
 * missing: no user enumeration, per-account lockout (including under
 * concurrent guesses), token-kind separation, service-center deactivation
 * cutting off its staff, per-device sessions and sign-out, session revocation
 * on password change, and the temporary-password gate.
 */
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { issueTokens } from '../../src/core/tokens.js';
import { SERVICE_CENTER_DEACTIVATED } from '../../src/middleware/authenticate.js';
import {
  AuthSession,
  MAX_SESSIONS_PER_USER,
  ServiceCenter,
  User,
} from '../../src/models/index.js';
import { TEST_PASSWORD, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();

async function login(mobile: string, password = TEST_PASSWORD) {
  return request(app).post('/auth/login').send({ mobile, password });
}

async function me(accessToken: string) {
  return request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
}

async function refreshWith(refreshToken: string) {
  return request(app).post('/auth/refresh').send({ refreshToken });
}

async function logoutWith(refreshToken: string) {
  return request(app).post('/auth/logout').send({ refreshToken });
}

describe('POST /auth/login', () => {
  it('signs in an Admin and returns tokens plus identity', async () => {
    await seedWorld();

    const res = await login('9800000001');

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user).toMatchObject({
      role: 'ADMIN',
      mobile: '9800000001',
      mustChangePassword: false,
    });
    /* Admin is global: no center scope. */
    expect(res.body.user.serviceCenterId).toBeUndefined();
  });

  it('returns the service center scope for an Owner', async () => {
    const world = await seedWorld();

    const res = await login('9800000002');

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('SERVICE_CENTER_OWNER');
    expect(res.body.user.serviceCenterId).toBe(String(world.center._id));
  });

  it('accepts a mobile number typed with punctuation and a country code', async () => {
    await seedWorld();

    const res = await request(app)
      .post('/auth/login')
      .send({ mobile: '+91 98000-00001', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
  });

  it('never leaks whether an account exists', async () => {
    await seedWorld();

    const wrongPassword = await login('9800000001', 'definitely-not-it');
    const noSuchAccount = await login('9777777777', 'definitely-not-it');

    /* Identical status and identical message. A difference in either would
       let someone enumerate which staff mobile numbers are registered. */
    expect(wrongPassword.status).toBe(401);
    expect(noSuchAccount.status).toBe(401);
    expect(noSuchAccount.body.error.message).toBe(wrongPassword.body.error.message);
    expect(noSuchAccount.body.error.code).toBe(wrongPassword.body.error.code);
  });

  it('refuses a deactivated account', async () => {
    const world = await seedWorld();
    await User.updateOne({ _id: world.technician._id }, { $set: { isActive: false } });

    const res = await login('9800000003');

    /* Section 9: a deactivated technician keeps their history but loses access. */
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/deactivated/i);
  });

  it('locks the account after the configured number of failures', async () => {
    await seedWorld();

    /* LOGIN_MAX_ATTEMPTS defaults to 5. */
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await login('9800000001', 'wrong-password-here');
      expect(res.status).toBe(401);
    }

    /* The sixth attempt is refused even with the *correct* password — the
       lockout is on the account, not on the guess. */
    const locked = await login('9800000001', TEST_PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect(locked.body.error.message).toMatch(/try again in \d+ minute/i);
  });

  it('locks the account correctly when wrong passwords arrive in parallel', async () => {
    await seedWorld();

    /* The bug this guards against: checking the lock, verifying the password,
       then saving `failedLoginAttempts + 1` from a copy read before any of
       that. Fired one at a time, that sequence locks correctly. Fired at
       once — as a script guessing passwords actually would — every request
       reads the same starting count, so all of them save "1" and the account
       never locks. `claimAttempt`'s single `findOneAndUpdate` closes that gap:
       MongoDB applies concurrent updates to one document one at a time, so of
       ten simultaneous guesses exactly `LOGIN_MAX_ATTEMPTS` (5) are still
       counted as attempts against the password (401) and the remaining five
       find the account already locked before their password is even looked
       at (429) — never more than five verifies, however many arrive together. */
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => login('9800000001', 'wrong-password-here')),
    );

    const statuses = attempts.map((res) => res.status).sort((a, b) => a - b);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);

    /* The counter itself must land exactly at the reset-on-lock value, not
       above it — the tell-tale sign of a race is a count past the limit. */
    const user = await User.findOne({ mobile: '9800000001' }).lean().exec();
    expect(user?.failedLoginAttempts).toBe(0);
    expect(user?.lockedUntil).toBeInstanceOf(Date);
    expect(user!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    /* And the correct password is refused too — this is an account lockout,
       not a tally of wrong guesses. */
    expect((await login('9800000001', TEST_PASSWORD)).status).toBe(429);
  });

  it('lets a locked account back in once the lockout expires', async () => {
    await seedWorld();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login('9800000001', 'wrong-password-here');
    }
    expect((await login('9800000001')).status).toBe(429);

    /* Wind the clock back rather than waiting fifteen minutes. */
    await User.updateOne(
      { mobile: '9800000001' },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );

    expect((await login('9800000001')).status).toBe(200);
  });

  it('resets the failure count after a successful login', async () => {
    await seedWorld();

    await login('9800000001', 'wrong-password-here');
    await login('9800000001', 'wrong-password-here');
    expect((await login('9800000001')).status).toBe(200);

    const user = await User.findOne({ mobile: '9800000001' }).lean().exec();
    expect(user?.failedLoginAttempts).toBe(0);
  });

  it('rejects a malformed mobile number with a field-level issue', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ mobile: '12345', password: TEST_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'mobile' })]),
    );
  });
});

describe('GET /auth/me', () => {
  it('requires a token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
  });

  it('returns the caller identity for a valid token', async () => {
    const world = await seedWorld();
    const { body } = await login('9800000002');

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: String(world.owner._id),
      role: 'SERVICE_CENTER_OWNER',
      serviceCenterId: String(world.center._id),
    });
  });

  it('refuses a refresh token used as an access token', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    /* Both token types carry the same claims. Without the `kind` check, a
       30-day refresh token would work as a 15-minute access token. */
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.refreshToken}`);

    expect(res.status).toBe(401);
  });

  it('refuses a token for a user deactivated after it was issued', async () => {
    const world = await seedWorld();
    const { body } = await login('9800000003');

    /* The token is still cryptographically valid — authorization is re-read
       from the database on every request precisely for this case. */
    await User.updateOne({ _id: world.technician._id }, { $set: { isActive: false } });

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);

    expect(res.status).toBe(403);
  });

  it('refuses a token for a user who no longer exists', async () => {
    const world = await seedWorld();
    const { body } = await login('9800000003');
    await User.deleteOne({ _id: world.technician._id });

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);

    expect(res.status).toBe(401);
  });

  it('ignores a token signed with the wrong secret', async () => {
    await seedWorld();

    /* A token shaped correctly but signed by someone else. */
    const forged = issueTokens({
      userId: '000000000000000000000000',
      role: 'ADMIN',
      sessionId: 'forged-session',
    });
    const tampered = `${forged.accessToken.slice(0, -4)}AAAA`;

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a new pair', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('refuses an access token used as a refresh token', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: body.accessToken });

    expect(res.status).toBe(401);
  });

  it('refuses to refresh a deactivated account', async () => {
    const world = await seedWorld();
    const { body } = await login('9800000003');

    await User.updateOne({ _id: world.technician._id }, { $set: { isActive: false } });

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken });

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password and revokes existing sessions', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const change = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
      });

    expect(change.status).toBe(200);
    expect(change.body.sessionsRevoked).toBe(true);

    /* The old access token must stop working immediately. Without this, a
       password changed because it was compromised would leave the attacker's
       token alive for its full lifetime. */
    const stale = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);
    expect(stale.status).toBe(401);

    /* And so must the old refresh token. */
    const staleRefresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken });
    expect(staleRefresh.status).toBe(401);

    /* The new password works; the old one does not. */
    expect((await login('9800000001', 'a-brand-new-passphrase')).status).toBe(200);
    expect((await login('9800000001', TEST_PASSWORD)).status).toBe(401);
  });

  it('rejects a wrong current password', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({
        currentPassword: 'not-the-current-one',
        newPassword: 'a-brand-new-passphrase',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'currentPassword' }),
      ]),
    );
  });

  it('rejects a new password that is too short', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'newPassword' })]),
    );
  });

  it('rejects reusing the current password', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });

    expect(res.status).toBe(400);
  });

  it('clears mustChangePassword, which is the technician onboarding gate', async () => {
    const world = await seedWorld();

    /* An Owner creates a technician with a temporary password
       (DECISIONS.md section 4.5). */
    await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000009',
      serviceCenterId: world.center._id,
      password: 'temporary-password-x',
      mustChangePassword: true,
    });

    const first = await login('9800000009', 'temporary-password-x');
    expect(first.status).toBe(200);
    expect(first.body.user.mustChangePassword).toBe(true);

    const change = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({
        currentPassword: 'temporary-password-x',
        newPassword: 'chosen-by-the-technician',
      });
    expect(change.status).toBe(200);

    const after = await login('9800000009', 'chosen-by-the-technician');
    expect(after.status).toBe(200);
    expect(after.body.user.mustChangePassword).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/auth/change-password')
      .send({ currentPassword: 'a', newPassword: 'a-brand-new-passphrase' });

    expect(res.status).toBe(401);
  });
});

/**
 * Decided with the client: deactivating a service center must block sign-in
 * for its Owner and Technicians, everywhere a session could keep them in —
 * not just at the next login. Admin has no center and is never touched.
 */
describe('a deactivated service center blocks its staff', () => {
  it('refuses login with a plain-English message', async () => {
    const world = await seedWorld();
    await ServiceCenter.updateOne({ _id: world.center._id }, { $set: { isActive: false } });

    const res = await login('9800000002');

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(SERVICE_CENTER_DEACTIVATED);
  });

  it('refuses an access token already issued, as a 401 so the client signs out', async () => {
    const world = await seedWorld();
    const { body } = await login('9800000002');

    /* The token is still cryptographically valid; the center's own state is
       what changed, and every request re-reads it. */
    await ServiceCenter.updateOne({ _id: world.center._id }, { $set: { isActive: false } });

    const res = await me(body.accessToken);

    /* 401, not 403: the client reads a 401 as "sign back in", tries one
       refresh (also refused below), and lands on the sign-in page, which
       shows why. A 403 would leave the portal open with every screen failing
       and nothing explaining it. */
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(SERVICE_CENTER_DEACTIVATED);
  });

  it('refuses a refresh from that device too', async () => {
    const world = await seedWorld();
    const { body } = await login('9800000003');

    await ServiceCenter.updateOne({ _id: world.center._id }, { $set: { isActive: false } });

    const res = await refreshWith(body.refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(SERVICE_CENTER_DEACTIVATED);
  });

  it('restores access as soon as the center is reactivated', async () => {
    const world = await seedWorld();
    await ServiceCenter.updateOne({ _id: world.center._id }, { $set: { isActive: false } });
    expect((await login('9800000002')).status).toBe(403);

    await ServiceCenter.updateOne({ _id: world.center._id }, { $set: { isActive: true } });

    /* Nothing was copied onto the user when the center was deactivated, so
       there is nothing to undo — reactivating the center alone is enough. */
    const res = await login('9800000002');
    expect(res.status).toBe(200);

    const followUp = await me(res.body.accessToken);
    expect(followUp.status).toBe(200);
  });

  it('never affects Admin, who has no service center', async () => {
    const world = await seedWorld();
    await ServiceCenter.updateOne({ _id: world.center._id }, { $set: { isActive: false } });

    const res = await login('9800000001');
    expect(res.status).toBe(200);

    const followUp = await me(res.body.accessToken);
    expect(followUp.status).toBe(200);
    expect(followUp.body.role).toBe('ADMIN');
  });
});

describe('POST /auth/logout', () => {
  it('ends that device session so its refresh token stops working', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    const out = await logoutWith(body.refreshToken);
    expect(out.status).toBe(204);

    const res = await refreshWith(body.refreshToken);
    expect(res.status).toBe(401);
  });

  it("leaves the person's other devices signed in", async () => {
    await seedWorld();
    const deviceA = await login('9800000002');
    const deviceB = await login('9800000002');

    await logoutWith(deviceA.body.refreshToken);

    expect((await refreshWith(deviceA.body.refreshToken)).status).toBe(401);
    /* The second device's session is untouched — it was never named. */
    expect((await refreshWith(deviceB.body.refreshToken)).status).toBe(200);
  });

  it('is idempotent: signing out twice is not an error', async () => {
    await seedWorld();
    const { body } = await login('9800000001');

    expect((await logoutWith(body.refreshToken)).status).toBe(204);
    /* Already gone — still 204, not 404 or 401. A retried request or a
       second tap must not surface an error. */
    expect((await logoutWith(body.refreshToken)).status).toBe(204);
  });

  it('rejects a call with no refresh token as unauthenticated, not as a bad request', async () => {
    const res = await request(app).post('/auth/logout').send({});

    /* Every protected route answers a missing credential with 401 — the
       route security audit checks this uniformly across the whole API. */
    expect(res.status).toBe(401);
  });

  it('gives a revoked refresh token the same rejection as a forged one', async () => {
    await seedWorld();
    const { body } = await login('9800000001');
    await logoutWith(body.refreshToken);

    const revoked = await refreshWith(body.refreshToken);
    const forged = await refreshWith(`${body.refreshToken.slice(0, -4)}AAAA`);

    expect(revoked.status).toBe(forged.status);
    expect(revoked.body.error.message).toBe(forged.body.error.message);
  });

  it('rejects a refresh token minted before sessions existed (no sid claim)', async () => {
    const world = await seedWorld();

    /* Signed with the real secret and shape, but predating the `sid` claim —
       exactly what a token issued by an older deploy would look like. There
       is nothing on the server such a token could name to be revoked, so it
       is refused like any other unusable token rather than trusted forever. */
    const legacyToken = jwt.sign(
      { sub: String(world.admin._id), role: 'ADMIN', kind: 'refresh', ims: Date.now() },
      config.JWT_REFRESH_SECRET,
      { issuer: 'cooler-crm', expiresIn: '30d' },
    );

    const res = await refreshWith(legacyToken);
    expect(res.status).toBe(401);
  });
});

describe('sessions and password change', () => {
  it('ends every device when the password changes, not just the one used', async () => {
    await seedWorld();
    const deviceA = await login('9800000002');
    const deviceB = await login('9800000002');

    const change = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${deviceA.body.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-passphrase' });
    expect(change.status).toBe(200);

    expect((await refreshWith(deviceA.body.refreshToken)).status).toBe(401);
    /* Section header: "changing a compromised password would otherwise leave
       the attacker's session alive" — that has to include sessions started
       from a different device than the one making the change. */
    expect((await refreshWith(deviceB.body.refreshToken)).status).toBe(401);
  });

  it('caps sessions per user, evicting the one used least recently', async () => {
    const world = await seedWorld();

    /* Ten sessions already on file, with distinct, controlled expiries —
       real logins issued moments apart can land on the same JWT `exp` second
       and make eviction order a coin flip, so the ordering is set directly
       instead of relying on wall-clock timing. */
    const now = Date.now();
    const preexisting = await AuthSession.insertMany(
      Array.from({ length: MAX_SESSIONS_PER_USER }, (_, i) => ({
        _id: `test-session-${i}`,
        userId: world.owner._id,
        expiresAt: new Date(now + (i + 1) * 60_000),
      })),
    );
    const oldest = preexisting[0]!._id;

    /* One more sign-in, the same as any other device joining. */
    const res = await login('9800000002');
    expect(res.status).toBe(200);

    const remaining = await AuthSession.find({ userId: world.owner._id }).lean().exec();
    expect(remaining).toHaveLength(MAX_SESSIONS_PER_USER);

    /* The newest sign-in survives, and so do the nine next-newest of the
       pre-existing ten; only the very oldest — used least recently — is
       gone. */
    expect(remaining.some((s) => s._id === oldest)).toBe(false);
  });
});
