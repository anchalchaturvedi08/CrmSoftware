/**
 * Authorization middleware.
 *
 * Spec section 19: "Enforce RBAC on backend" and "Never trust client-side
 * permissions". The UI hiding a button is a courtesy; these are the control.
 *
 * Section 3 lists what each role may do, and sections 3.2 and 3.3 list what
 * they may *not* — an Owner cannot final-close, a Technician cannot close or
 * verify a Happy Code. Those prohibitions are enforced here and in the status
 * machine, never assumed from the shape of the UI.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden } from '../http/errors.js';
import type { Role } from '../models/enums.js';
import { requireAuth } from './authenticate.js';

/**
 * Restricts a route to the listed roles.
 *
 * Deliberately allow-list only. A deny-list would silently admit any role
 * added later, which is the wrong default for a permission check.
 */
export function requireRole(...allowed: readonly Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = requireAuth(req);

      if (!allowed.includes(auth.role)) {
        throw forbidden('You do not have permission to do that');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Admin only — complaint creation, final closure, Happy Code verification. */
export const adminOnly = requireRole('ADMIN');

/**
 * Blocks normal work until a temporary password has been replaced.
 *
 * Owners create technicians with a temporary password (DECISIONS.md section
 * 4.5). Until it is changed the account can reach only the change-password
 * and session routes — otherwise a password the Owner knows would keep working
 * indefinitely for the technician's whole job queue.
 */
export const requirePasswordChanged: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const auth = requireAuth(req);

    if (auth.mustChangePassword) {
      throw forbidden(
        'You must change your temporary password before continuing',
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Asserts the caller has a service-center scope, and returns it.
 *
 * Owners and Technicians always should — the `User` model enforces it at write
 * time. Reaching here without one means a data inconsistency, and returning
 * an unscoped query in that case would leak every centre's complaints, so it
 * fails closed instead.
 */
export function requireServiceCenter(req: Request): string {
  const auth = requireAuth(req);

  if (!auth.serviceCenterId) {
    throw forbidden('This account is not attached to a service center');
  }

  return auth.serviceCenterId;
}
