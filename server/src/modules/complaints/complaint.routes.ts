/**
 * Complaint routes (spec section 20).
 *
 * Note the role guards, which are the enforcement of section 3:
 *
 *  - creation is Admin-only (rule 1: "Only Admin can create complaints")
 *  - reading is open to all three roles, but each sees only their own scope —
 *    applied in the service through `complaintScope`, not here
 *  - the WhatsApp route is Admin-only because it decrypts the Happy Code
 *
 * `requirePasswordChanged` sits in front of everything: a technician still
 * holding the temporary password their Owner issued cannot reach live work
 * until they have replaced it.
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import {
  adminOnly,
  requireRole,
  requirePasswordChanged,
} from '../../middleware/authorize.js';
import * as controller from './complaint.controller.js';
import * as workflow from './workflow.controller.js';
import * as parts from '../parts/parts.controller.js';

export const complaintRouter = Router();

complaintRouter.use(authenticate, requirePasswordChanged);

/* Section 8 recommendations. Declared before `/:id` so the literal path is
   not swallowed by the parameter route. */
complaintRouter.get('/recommendations', adminOnly, controller.getRecommendations);

complaintRouter.post('/', adminOnly, controller.postComplaint);
complaintRouter.get('/', controller.getComplaints);
complaintRouter.get('/:id', controller.getComplaintById);

/* Decrypts the Happy Code, so Admin only and audited on every call. */
complaintRouter.get('/:id/whatsapp', adminOnly, controller.getWhatsApp);

/* ---- Workflow transitions ---------------------------------------------
 *
 * The role guard on each route mirrors the status machine's own rule, so an
 * unauthorised attempt is refused at the door with a clear message rather
 * than reaching the service and failing there. The machine still re-checks —
 * these guards are defence in depth, not the control itself.
 */

/* Section 8: Admin selects and reassigns the service center. */
complaintRouter.post(
  '/:id/assign-service-center',
  adminOnly,
  workflow.postAssignServiceCenter,
);

/* Workflow B: the Owner assigns and reassigns their own technicians. */
complaintRouter.post(
  '/:id/assign-technician',
  requireRole('SERVICE_CENTER_OWNER'),
  workflow.postAssignTechnician,
);
complaintRouter.post(
  '/:id/visits',
  requireRole('SERVICE_CENTER_OWNER'),
  workflow.postScheduleVisit,
);

/* Workflow C: the technician's own steps. */
complaintRouter.post(
  '/:id/start-visit',
  requireRole('TECHNICIAN'),
  workflow.postStartVisit,
);
complaintRouter.post(
  '/:id/resolution',
  requireRole('TECHNICIAN'),
  workflow.postSubmitResolution,
);

/* Workflow E: the Owner accepts or sends it back. Note there is no close
   route here — section 3.2 keeps final closure with Admin. */
complaintRouter.post(
  '/:id/review-resolution',
  requireRole('SERVICE_CENTER_OWNER'),
  workflow.postReviewResolution,
);

/* Workflow D: parts holds, available to whoever discovers the shortage. */
complaintRouter.post(
  '/:id/waiting-for-parts',
  requireRole('SERVICE_CENTER_OWNER', 'TECHNICIAN'),
  workflow.postWaitingForParts,
);
complaintRouter.post(
  '/:id/resume-work',
  requireRole('SERVICE_CENTER_OWNER', 'TECHNICIAN'),
  workflow.postResumeWork,
);

/* Workflow F: customer confirmation and closure.
   Admin and Owner can verify the Happy Code and close (DECISIONS.md section 33).
   Regenerating or viewing the code for WhatsApp stays Admin-only. */
complaintRouter.post(
  '/:id/verify-happy-code',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  workflow.postVerifyHappyCode,
);
complaintRouter.post(
  '/:id/regenerate-happy-code',
  adminOnly,
  workflow.postRegenerateHappyCode,
);
complaintRouter.post(
  '/:id/close',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  workflow.postClose,
);
complaintRouter.post('/:id/require-rework', adminOnly, workflow.postRequireRework);
complaintRouter.post('/:id/reopen', adminOnly, workflow.postReopen);
complaintRouter.post('/:id/cancel', adminOnly, workflow.postCancel);

/* Admin's star rating of the service centre's work, once closed
   (DECISIONS.md section 31). Not part of Workflow F's status sequence — the
   complaint stays CLOSED — so it sits after those routes rather than in them. */
complaintRouter.post('/:id/rating', adminOnly, workflow.postRateService);

/* ---- Parts against a complaint (section 11) ----------------------------
 *
 * These live under the complaint rather than under /parts because that is
 * what they are about: a technician requests a part *for a job*, and records
 * what they fitted *on a visit*. The stock side lives under /parts.
 */
complaintRouter.post(
  '/:id/part-requests',
  requireRole('TECHNICIAN'),
  parts.postPartRequest,
);
complaintRouter.post('/:id/part-usage', requireRole('TECHNICIAN'), parts.postUsage);
complaintRouter.get('/:id/part-usage', parts.getUsage);
