/**
 * User management HTTP layer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import * as users from './users.service.js';
import {
  createUserSchema,
  listUsersSchema,
  resetPasswordSchema,
  updateUserSchema,
} from './users.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const postUser = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await users.createUser(createUserSchema.parse(req.body), auth);

  res.status(201).json({
    user: result.user,
    temporaryPassword: result.temporaryPassword,
    /* Said plainly because it is true and irreversible: only a scrypt hash is
       stored, so this is the one time the password can be read. */
    note:
      'Give this password to the user now - it cannot be shown again. ' +
      'They must change it the first time they sign in.',
  });
});

export const getUsers = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json(await users.listUsers(listUsersSchema.parse(req.query), auth));
});

export const getUserById = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json({ user: await users.getUser(String(req.params['id']), auth) });
});

export const patchUser = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await users.updateUser(
    String(req.params['id']),
    updateUserSchema.parse(req.body),
    auth,
  );

  res.status(200).json({
    user: result.user,
    ...(result.openJobsNeedingReassignment
      ? {
          openJobsNeedingReassignment: result.openJobsNeedingReassignment,
          /* Section 9: history survives, but the live work needs a new owner. */
          warning:
            `${result.openJobsNeedingReassignment.length} open job(s) are still ` +
            'assigned to this technician and must be reassigned.',
        }
      : {}),
  });
});

export const postResetPassword = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await users.resetPassword(
    String(req.params['id']),
    resetPasswordSchema.parse(req.body ?? {}),
    auth,
  );

  res.status(200).json({
    user: result.user,
    temporaryPassword: result.temporaryPassword,
    note:
      'Give this password to the user now - it cannot be shown again. ' +
      'All their existing sessions have been signed out.',
  });
});
