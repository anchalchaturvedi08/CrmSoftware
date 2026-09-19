/**
 * Settings (spec section 4, Admin navigation).
 *
 * The rules that govern day-to-day use — when an account locks, how long a
 * session lasts, how many Happy Code tries a complaint gets — live in the
 * server's configuration. Admin is the one staff call when they are locked
 * out, so the page shows those rules as they are actually configured, rather
 * than as a help text that drifts from the real values.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { durationMinutes } from '../../src/modules/settings/settings.routes.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

let admin: string;
let owner: string;
let tech: string;

beforeEach(async () => {
  await seedWorld();
  admin = await token('9800000001');
  owner = await token('9800000002');
  tech = await token('9800000003');
});

describe('GET /settings', () => {
  it('shows the rules as they are configured', async () => {
    const res = await request(app).get('/settings').set('Authorization', `Bearer ${admin}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      signIn: {
        maxFailedAttempts: config.LOGIN_MAX_ATTEMPTS,
        lockoutMinutes: config.LOGIN_LOCKOUT_MINUTES,
        passwordMinLength: 12,
        sessionRenewMinutes: durationMinutes(config.JWT_ACCESS_TTL),
        staySignedInMinutes: durationMinutes(config.JWT_REFRESH_TTL),
      },
      happyCode: { digits: 6, maxAttempts: config.HAPPY_CODE_MAX_ATTEMPTS },
      attachments: { maxFileMb: config.STORAGE_MAX_FILE_MB },
      timezone: config.APP_TIMEZONE,
    });
  });

  it('never includes a secret', async () => {
    const res = await request(app).get('/settings').set('Authorization', `Bearer ${admin}`);

    const body = JSON.stringify(res.body);
    for (const secret of [config.JWT_ACCESS_SECRET, config.JWT_REFRESH_SECRET, config.HAPPY_CODE_KEY, config.MONGO_URI]) {
      expect(body).not.toContain(secret);
    }
  });

  it('is Admin only', async () => {
    for (const other of [owner, tech]) {
      expect((await request(app).get('/settings').set('Authorization', `Bearer ${other}`)).status).toBe(403);
    }
  });
});

describe('durationMinutes', () => {
  it('reads the token lifetimes the configuration uses', () => {
    expect(durationMinutes('15m')).toBe(15);
    expect(durationMinutes('30d')).toBe(43_200);
    expect(durationMinutes('12h')).toBe(720);
    expect(durationMinutes('90s')).toBe(1.5);
    /* Something it cannot read is reported as unknown, not guessed. */
    expect(durationMinutes('soon')).toBeNull();
  });
});
