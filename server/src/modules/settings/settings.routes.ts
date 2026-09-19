/**
 * Settings (spec section 4, Admin navigation): the rules in force.
 *
 * Sign-in lockout, session length, Happy Code attempts and upload size are
 * set in the server's configuration (spec section 19: configurable, not
 * hard-coded). Admin is who staff call when they are locked out, so this
 * returns those values as configured — never a copy in help text that drifts
 * from the real ones.
 *
 * Read-only on purpose. Changing a lockout rule from a web page would let one
 * stolen Admin session weaken sign-in for everyone; it stays a server change.
 * Secrets are never part of the response.
 */
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../../config/env.js';
import { HAPPY_CODE_DIGITS } from '../../core/happyCode.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';
import { adminOnly, requirePasswordChanged } from '../../middleware/authorize.js';
import { PASSWORD_MIN_LENGTH } from '../auth/auth.validation.js';

function handler(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

const UNIT_MINUTES: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1_440 };

/**
 * Minutes in a token lifetime such as `15m` or `30d`, or null when the value
 * is in a form this cannot read — reported as unknown rather than guessed.
 */
export function durationMinutes(value: string): number | null {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * UNIT_MINUTES[match[2]!]!;
}

export interface SystemSettings {
  signIn: {
    maxFailedAttempts: number;
    lockoutMinutes: number;
    passwordMinLength: number;
    /** How often a signed-in screen renews its session. */
    sessionRenewMinutes: number | null;
    /** How long a device stays signed in without a new sign-in. */
    staySignedInMinutes: number | null;
  };
  happyCode: { digits: number; maxAttempts: number };
  attachments: { maxFileMb: number };
  timezone: string;
}

const getSettings = handler((req, res) => {
  requireAuth(req);

  const settings: SystemSettings = {
    signIn: {
      maxFailedAttempts: config.LOGIN_MAX_ATTEMPTS,
      lockoutMinutes: config.LOGIN_LOCKOUT_MINUTES,
      passwordMinLength: PASSWORD_MIN_LENGTH,
      sessionRenewMinutes: durationMinutes(config.JWT_ACCESS_TTL),
      staySignedInMinutes: durationMinutes(config.JWT_REFRESH_TTL),
    },
    happyCode: { digits: HAPPY_CODE_DIGITS, maxAttempts: config.HAPPY_CODE_MAX_ATTEMPTS },
    attachments: { maxFileMb: config.STORAGE_MAX_FILE_MB },
    timezone: config.APP_TIMEZONE,
  };

  res.status(200).json(settings);
});

export const settingsRouter = Router();

settingsRouter.use(authenticate, requirePasswordChanged);
settingsRouter.get('/', adminOnly, getSettings);
