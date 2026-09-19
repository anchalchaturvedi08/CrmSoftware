/**
 * Auth routes (spec section 20: `POST /auth/login`).
 *
 * Note which routes deliberately sit *before* `requirePasswordChanged`:
 * `/auth/me` and `/auth/change-password` must stay reachable while
 * `mustChangePassword` is set, or a technician handed a temporary password
 * would have no way to replace it.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../config/env.js';
import { authenticate } from '../../middleware/authenticate.js';
import * as controller from './auth.controller.js';

/**
 * Per-IP ceiling on credential attempts, applied before any database work.
 *
 * This is the outer of two limits. The inner one counts failures against the
 * account itself (see `auth.service.ts`), because an attacker who rotates IP
 * addresses walks straight through this one.
 */
const credentialLimiter = rateLimit({
  windowMs: config.LOGIN_RATE_WINDOW_MINUTES * 60_000,
  /* Read per request rather than captured at module load, so the ceiling is
     observable in a test without standing up a second app. */
  limit: () => config.LOGIN_RATE_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  /* Successful logins should not count toward the limit — a busy shift change
     at one service center behind a single NAT address is normal traffic. */
  skipSuccessfulRequests: true,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many attempts from this address. Please try again later.',
    },
  },
});

export const authRouter = Router();

authRouter.post('/login', credentialLimiter, controller.postLogin);
authRouter.post('/refresh', credentialLimiter, controller.postRefresh);

/**
 * Ends this device's session.
 *
 * Not behind `authenticate`: the access token has often expired by the time
 * someone signs out — the refresh token in the body is the credential. And not
 * behind `credentialLimiter`: that limiter counts failed requests per address,
 * so a sign-out with an old token from a busy service center would use up the
 * sign-in allowance of everyone behind the same address. There is nothing to
 * guess here — a token either carries a valid signature or is refused before
 * the database is touched.
 */
authRouter.post('/logout', controller.postLogout);

authRouter.get('/me', authenticate, controller.getMe);
authRouter.post(
  '/change-password',
  authenticate,
  credentialLimiter,
  controller.postChangePassword,
);
