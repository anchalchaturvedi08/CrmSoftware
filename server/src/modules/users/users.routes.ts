/**
 * User management routes (spec sections 3.1, 3.2).
 *
 * Note what is *not* guarded here: creation is open to Admin and Owner alike,
 * because the rule is not "which role may call this" but "which roles may this
 * role create" — an Owner may create a technician and nothing else. That is a
 * per-request decision, so it lives in the service's `CREATION_RIGHTS` table
 * rather than in route middleware that only sees the caller.
 *
 * Reads are unguarded for the same reason: `userScope` already limits an Owner
 * to their own technicians and a technician to their own record.
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole, requirePasswordChanged } from '../../middleware/authorize.js';
import * as controller from './users.controller.js';

export const usersRouter = Router();

usersRouter.use(authenticate, requirePasswordChanged);

usersRouter.get('/', controller.getUsers);
usersRouter.get('/:id', controller.getUserById);

/* Admin and Owner both create; the service decides what each may create. */
usersRouter.post('/', requireRole('ADMIN', 'SERVICE_CENTER_OWNER'), controller.postUser);
usersRouter.patch(
  '/:id',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  controller.patchUser,
);

/**
 * Resetting someone else's password is a sensitive action even within scope,
 * so it is its own route rather than a field on the update — and it is
 * audited, with every existing session revoked.
 */
usersRouter.post(
  '/:id/reset-password',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  controller.postResetPassword,
);
