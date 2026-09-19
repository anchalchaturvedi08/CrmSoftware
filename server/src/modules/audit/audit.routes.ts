/**
 * Audit trail routes (spec section 17).
 */
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';
import { adminOnly, requirePasswordChanged } from '../../middleware/authorize.js';
import * as audit from './audit.service.js';
import { listActivitySchema, listAuditSchema, listTimelineSchema } from './audit.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const getTimeline = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await audit.complaintTimeline(
    String(req.params['id']),
    listTimelineSchema.parse(req.query),
    auth,
  );
  res.status(200).json(result);
});

const getActivity = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await audit.listActivity(listActivitySchema.parse(req.query)));
});

const getAudit = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json(await audit.listAudit(listAuditSchema.parse(req.query), auth));
});

export const auditRouter = Router();

auditRouter.use(authenticate, requirePasswordChanged);

/* Scoped to whoever can see the complaint — an Owner and a technician both
   need the story of a job they are working on. */
auditRouter.get('/complaints/:id/timeline', getTimeline);

/**
 * Admin only. The system log spans every service center, so there is no
 * sensible per-centre scoping of it, and showing it to an Owner would leak
 * other centres' activity.
 */
auditRouter.get('/audit', adminOnly, getAudit);

/* Complaint activity across every complaint. Admin only for the same reason:
   an Owner already has each of their complaints' timelines. */
auditRouter.get('/audit/activity', adminOnly, getActivity);
