/**
 * Auth HTTP layer.
 *
 * Controllers parse, delegate and format. They make no decisions — every rule
 * about who may do what lives in the service or the middleware, so there is
 * exactly one place to check when asking whether something is enforced.
 */
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { unauthenticated } from '../../http/errors.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as authService from './auth.service.js';
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
} from './auth.validation.js';

/** Wraps an async handler so a rejection reaches the error middleware. */
function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const postLogin = handler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const session = await authService.login(input, req);
  res.status(200).json(session);
});

export const postRefresh = handler(async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  const session = await authService.refresh(refreshToken, req);
  res.status(200).json(session);
});

/**
 * Signs this device out on the server. 204 whether or not the session was
 * still open — see `authService.logout`.
 *
 * The refresh token in the body is the credential, as for `/auth/refresh`. A
 * request without one is refused as unauthenticated (401) rather than as a
 * malformed body (400): a caller presenting no credential gets the same answer
 * from every protected route, which is what the route audit checks.
 */
export const postLogout = handler(async (req, res) => {
  const parsed = logoutSchema.safeParse(req.body);
  if (!parsed.success) {
    throw unauthenticated('Authentication required');
  }

  await authService.logout(parsed.data.refreshToken, req);
  res.status(204).end();
});

export const postChangePassword = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = changePasswordSchema.parse(req.body);

  await authService.changePassword(auth.userId, input, req);

  /* 200 with an explicit note rather than 204: the client has to know its
     tokens are now dead and it must sign in again. */
  res.status(200).json({
    message: 'Password changed. Please sign in again.',
    sessionsRevoked: true,
  });
});

/**
 * The caller's own identity.
 *
 * Returns what the *database* says, not what the token claimed — the same
 * principle `authenticate` follows, so a client refreshing this after being
 * reassigned or deactivated sees the truth.
 */
export const getMe = handler(async (req, res) => {
  const auth = requireAuth(req);

  res.status(200).json({
    id: auth.userId,
    name: auth.name,
    role: auth.role,
    ...(auth.serviceCenterId ? { serviceCenterId: auth.serviceCenterId } : {}),
    mustChangePassword: auth.mustChangePassword,
  });
});
