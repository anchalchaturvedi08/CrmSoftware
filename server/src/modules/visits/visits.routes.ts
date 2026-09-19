/**
 * Visit routes (spec sections 9, 10).
 *
 * Scheduling a *new* visit stays on the complaint router, because it is a
 * status transition on the complaint. These routes are about visits that
 * already exist: reading the schedule, moving one, calling one off.
 */
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';
import { requireRole, requirePasswordChanged } from '../../middleware/authorize.js';
import { cancelScheduledVisit } from '../complaints/workflow.service.js';
import * as visits from './visits.service.js';
import {
  cancelVisitSchema,
  listVisitsSchema,
  rescheduleVisitSchema,
} from './visits.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const getVisits = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json(await visits.listVisits(listVisitsSchema.parse(req.query), auth));
});

const getMyJobs = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json(await visits.myJobs(auth));
});

const getVisitById = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json({ visit: await visits.getVisit(String(req.params['id']), auth) });
});

const postReschedule = handler(async (req, res) => {
  const auth = requireAuth(req);
  const visit = await visits.rescheduleVisit(
    String(req.params['id']),
    rescheduleVisitSchema.parse(req.body),
    auth,
  );
  res.status(200).json({ visit });
});

const postCancel = handler(async (req, res) => {
  const auth = requireAuth(req);
  const id = String(req.params['id']);
  const input = cancelVisitSchema.parse(req.body ?? {});

  /* The visit's complaint must be the caller's too, not only the visit: a
     visit keeps the centre it was booked under when its complaint moves
     (visits.service.ts, `findManageableVisit`). */
  await visits.findManageableVisit(id, auth);

  /* Lives with the workflow, not the schedule: cancelling the only booked
     visit changes the complaint's status too. */
  const { visit, complaint } = await cancelScheduledVisit(id, input, auth);
  res.status(200).json({
    visit,
    complaint: { id: String(complaint._id), status: complaint.status },
  });
});

export const visitsRouter = Router();

visitsRouter.use(authenticate, requirePasswordChanged);

/**
 * The technician's home screen (section 10), declared before `/:id` so the
 * literal path is not captured by the parameter route.
 */
visitsRouter.get('/my-jobs', getMyJobs);

/* The centre calendar and the Admin view, scoped per role. */
visitsRouter.get('/', getVisits);
visitsRouter.get('/:id', getVisitById);

/* Section 9 gives scheduling and rescheduling to the Owner. */
visitsRouter.post(
  '/:id/reschedule',
  requireRole('SERVICE_CENTER_OWNER', 'ADMIN'),
  postReschedule,
);
visitsRouter.post(
  '/:id/cancel',
  requireRole('SERVICE_CENTER_OWNER', 'ADMIN'),
  postCancel,
);
