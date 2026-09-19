/**
 * Per-IP credential rate limiting.
 *
 * Each test uses its own `X-Forwarded-For` address. The app sets
 * `trust proxy`, so that header becomes `req.ip` and therefore the limiter's
 * bucket key — which gives every test an independent counter against one
 * shared in-memory store, and incidentally proves the limit really is
 * per-address rather than global.
 *
 * This is the outer of two defences. The inner one — failures counted against
 * the account itself — is what spec section 19 is really asking for, since an
 * attacker rotating IP addresses walks straight through this limit. It is
 * tested at its real setting in `auth.test.ts`.
 */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { seedWorld, TEST_PASSWORD } from '../fixtures.js';

const app = createApp();

/* The suite-wide ceiling is raised out of the way (see vitest.config.ts); put
   it back to something reachable for this file only. */
const originalLimit = config.LOGIN_RATE_MAX_REQUESTS;
config.LOGIN_RATE_MAX_REQUESTS = 4;

afterAll(() => {
  config.LOGIN_RATE_MAX_REQUESTS = originalLimit;
});

/** A login attempt from a specific pretend client address. */
function loginFrom(ip: string, mobile: string, password: string) {
  return request(app)
    .post('/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ mobile, password });
}

describe('login rate limiting', () => {
  it('refuses further attempts from one address once the ceiling is hit', async () => {
    await seedWorld();

    /* A mobile number with no account, so the per-account lockout cannot be
       what produces the 429 — this has to be the IP limiter. */
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const res = await loginFrom('203.0.113.10', '9777777777', 'wrong-password');
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.slice(4)).toEqual([429, 429]);
  });

  it('reports the limit in the standard error envelope', async () => {
    await seedWorld();

    let last = await loginFrom('203.0.113.11', '9777777777', 'wrong-password');
    for (let attempt = 1; attempt <= 6 && last.status !== 429; attempt += 1) {
      last = await loginFrom('203.0.113.11', '9777777777', 'wrong-password');
    }

    expect(last.status).toBe(429);
    /* Same envelope as every other error, so clients branch on one shape. */
    expect(last.body.error.code).toBe('RATE_LIMITED');
    expect(last.body.error.message).toMatch(/too many attempts/i);
  });

  it('limits each address independently', async () => {
    await seedWorld();

    /* Exhaust one address. */
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await loginFrom('203.0.113.12', '9777777777', 'wrong-password');
    }
    expect((await loginFrom('203.0.113.12', '9777777777', 'x')).status).toBe(429);

    /* A different address is unaffected — otherwise one abusive client would
       lock out every service center at once. */
    expect((await loginFrom('203.0.113.13', '9777777777', 'x')).status).toBe(401);
  });

  it('does not count successful logins toward the ceiling', async () => {
    await seedWorld();

    /* `skipSuccessfulRequests` matters operationally: a shift change at one
       service center behind a single NAT address is normal traffic, and
       throttling it would lock out the whole site. Eight successes against a
       ceiling of four must all pass. */
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const res = await loginFrom('203.0.113.14', '9800000001', TEST_PASSWORD);
      expect(res.status).toBe(200);
    }
  });
});
