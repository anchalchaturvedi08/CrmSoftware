/**
 * Authentication middleware.
 *
 * The governing idea: **a token proves who you are, the database decides what
 * you may do.** The token's role and scope claims are never trusted for
 * authorization — they are re-read from the user record on every request.
 *
 * That distinction matters in cases this system will actually hit. An Owner
 * moved to a different service center would otherwise keep reaching the old
 * one until their token expired. A technician deactivated mid-shift
 * (section 9) would keep working their queue for another fifteen minutes. The
 * extra read per request is a cheap price for neither of those being possible.
 *
 * The same holds one level up: deactivating a service center cuts off its
 * Owner and Technicians on their next request (decided with the client). That
 * costs Owners and Technicians one more small read; Admin, who has no centre,
 * pays nothing.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Types } from 'mongoose';
import { bearerFrom, invalidToken, verifyToken } from '../core/tokens.js';
import { forbidden, unauthenticated } from '../http/errors.js';
import { ServiceCenter, User } from '../models/index.js';
import type { Role } from '../models/enums.js';

/** What staff of a deactivated service center are told, wherever they are refused. */
export const SERVICE_CENTER_DEACTIVATED =
  'Your service center has been deactivated. Please contact the Admin.';

/**
 * Whether the user's service center has been deactivated.
 *
 * Checked in three places — sign-in, refresh and every request — so that none
 * of them is a way around the other two. Deactivation itself (Admin editing
 * the centre) needs no change for this: nothing is copied onto the users, so
 * reactivating the centre restores access with nothing to undo.
 *
 * One lean read by `_id`, selecting only `isActive`, and none at all for Admin.
 * A centre that cannot be found counts as deactivated: it can only mean broken
 * data, and access should fail closed rather than open.
 */
export async function serviceCenterDeactivated(user: {
  role: Role;
  serviceCenterId?: Types.ObjectId | null;
}): Promise<boolean> {
  if (user.role === 'ADMIN' || !user.serviceCenterId) return false;

  const centre = await ServiceCenter.findById(user.serviceCenterId)
    .select('isActive')
    .lean()
    .exec();

  return centre?.isActive !== true;
}

/** Who the caller is, as resolved from the database. */
export interface AuthContext {
  userId: string;
  role: Role;
  name: string;
  /** Present for Owner and Technician; absent for Admin, who is global. */
  serviceCenterId?: string;
  mustChangePassword: boolean;
}

/**
 * Verifies the access token and attaches the caller's authoritative context.
 */
export const authenticate: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const token = bearerFrom(req.headers.authorization);
    if (!token) {
      throw unauthenticated('Authentication required');
    }

    const claims = verifyToken(token, 'access');

    const user = await User.findById(claims.sub)
      .select('role name serviceCenterId isActive mustChangePassword passwordChangedAt')
      .lean()
      .exec();

    if (!user) {
      throw invalidToken();
    }

    /* Section 9: a deactivated technician keeps their history but loses
       access. Checked live rather than from the token. */
    if (!user.isActive) {
      throw forbidden('This account has been deactivated');
    }

    /**
     * Revocation: refuse tokens issued before the password changed.
     *
     * Compared in milliseconds, using the token's `ims` claim rather than the
     * standard `iat`. `iat` has one-second resolution, which cannot separate
     * "changed the password, signed back in two hundred milliseconds later"
     * from "token issued eight hundred milliseconds before the change" — so a
     * second-resolution check either locks people out after a password change
     * or lets revoked tokens through, depending on where the second boundary
     * happens to fall.
     */
    if (user.passwordChangedAt) {
      if (claims.issuedAtMs < user.passwordChangedAt.getTime()) {
        throw unauthenticated(
          'Your password was changed. Please sign in again.',
        );
      }
    }

    /**
     * A deactivated service center: refused as signed out, not as forbidden.
     *
     * The client reads a 401 as "this session is over": it tries one refresh,
     * which is refused for the same reason, and signs out to the sign-in page,
     * where signing in again shows why. A 403 would leave the person signed in
     * to a portal in which every screen fails, with nothing saying why.
     */
    if (await serviceCenterDeactivated(user)) {
      throw unauthenticated(SERVICE_CENTER_DEACTIVATED);
    }

    req.auth = {
      userId: String(user._id),
      role: user.role,
      name: user.name,
      ...(user.serviceCenterId
        ? { serviceCenterId: String(user.serviceCenterId) }
        : {}),
      mustChangePassword: user.mustChangePassword,
    };

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Returns the caller's context, or throws.
 *
 * Route handlers use this rather than reading `req.auth` directly, so a
 * handler accidentally mounted without `authenticate` fails loudly instead of
 * treating an undefined caller as permitted.
 */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw unauthenticated('Authentication required');
  }
  return req.auth;
}
