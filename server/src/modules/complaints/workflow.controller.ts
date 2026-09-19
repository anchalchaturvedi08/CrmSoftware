/**
 * Workflow HTTP layer.
 *
 * Each handler parses, delegates, and returns the complaint plus the actions
 * now available to this caller — so a client can render the next step without
 * a second request or its own copy of the transition rules.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { snapshot } from '../../core/sla.js';
import { availableTransitions, stateViewOf } from '../../core/statusMachine.js';
import { requireAuth } from '../../middleware/authenticate.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import type { ComplaintDoc } from '../../models/index.js';
import * as workflow from './workflow.service.js';
import {
  assignServiceCenterSchema,
  assignTechnicianSchema,
  closeComplaintSchema,
  rateServiceSchema,
  reasonOnlySchema,
  reviewResolutionSchema,
  scheduleVisitSchema,
  startVisitSchema,
  submitResolutionSchema,
  verifyHappyCodeSchema,
  waitingForPartsSchema,
} from './workflow.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** Strips the Happy Code ciphertext and attaches derived SLA figures. */
function present(complaint: ComplaintDoc, auth: AuthContext) {
  const plain = JSON.parse(JSON.stringify(complaint)) as Record<string, unknown>;
  delete plain['happyCodeSecret'];

  return {
    complaint: { ...plain, slaSnapshot: snapshot(complaint.sla) },
    nextActions: availableTransitions(stateViewOf(complaint), auth.role).map((rule) => ({
      to: rule.to,
      action: rule.action,
      requiresReason: rule.requiresReason ?? false,
    })),
  };
}

const id = (req: Request): string => String(req.params['id']);

export const postAssignServiceCenter = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = assignServiceCenterSchema.parse(req.body);
  const complaint = await workflow.assignServiceCenter(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

export const postAssignTechnician = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = assignTechnicianSchema.parse(req.body);
  const complaint = await workflow.assignTechnician(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

export const postScheduleVisit = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = scheduleVisitSchema.parse(req.body);
  const { complaint, visit } = await workflow.scheduleVisit(id(req), input, auth);

  res.status(201).json({
    ...present(complaint, auth),
    visit: { id: String(visit._id), sequence: visit.sequence, scheduledAt: visit.scheduledAt },
  });
});

export const postStartVisit = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = startVisitSchema.parse(req.body ?? {});
  const { complaint, visit } = await workflow.startVisit(id(req), input, auth);

  res.status(200).json({
    ...present(complaint, auth),
    visit: { id: String(visit._id), sequence: visit.sequence, startedAt: visit.startedAt },
  });
});

export const postSubmitResolution = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = submitResolutionSchema.parse(req.body);
  const { complaint, visit, closed } = await workflow.submitResolution(id(req), input, auth);

  res.status(200).json({
    ...present(complaint, auth),
    visit: { id: String(visit._id), sequence: visit.sequence, completedAt: visit.completedAt },
    closed,
    note: closed
      ? 'Happy Code verified. Complaint closed.'
      : 'Submitted for review. The service centre or Admin can close it with the Happy Code.',
  });
});

export const postReviewResolution = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = reviewResolutionSchema.parse(req.body);
  const complaint = await workflow.reviewResolution(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

export const postVerifyHappyCode = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = verifyHappyCodeSchema.parse(req.body);
  const result = await workflow.verifyComplaintHappyCode(id(req), input, auth);

  /**
   * A wrong code is 200 with `verified: false`, not an error status.
   *
   * It is an expected outcome of a phone call, not a fault — and the response
   * carries the remaining attempts so Admin knows where they stand before the
   * code locks.
   */
  res.status(200).json({
    verified: result.verified,
    attemptsRemaining: result.attemptsRemaining,
    ...present(result.complaint, auth),
    message: result.verified
      ? 'Code verified. The complaint can now be closed.'
      : `That code does not match. ${result.attemptsRemaining} attempt(s) remaining.`,
  });
});

export const postRegenerateHappyCode = handler(async (req, res) => {
  const auth = requireAuth(req);
  const { complaint, happyCode } = await workflow.regenerateComplaintHappyCode(
    id(req),
    auth,
  );

  res.status(200).json({
    ...present(complaint, auth),
    happyCode,
    note: 'Send the new code to the customer. The previous one no longer works.',
  });
});

export const postClose = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = closeComplaintSchema.parse(req.body ?? {});
  const result = await workflow.closeComplaint(id(req), input, auth);

  if (result.verified === false) {
    res.status(200).json({
      verified: false,
      attemptsRemaining: result.attemptsRemaining,
      ...present(result.complaint, auth),
      message: `That code does not match. ${result.attemptsRemaining} attempt(s) remaining.`,
    });
    return;
  }

  res.status(200).json(present(result.complaint, auth));
});

/** Section 3.1: the customer says it is not fixed, so the work goes back. */
export const postRequireRework = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = reasonOnlySchema.parse(req.body ?? {});
  const complaint = await workflow.requireRework(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

export const postReopen = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = reasonOnlySchema.parse(req.body);
  const { complaint, happyCode } = await workflow.reopenComplaint(id(req), input, auth);

  res.status(200).json({
    ...present(complaint, auth),
    happyCode,
    note: 'Previous closure preserved in history. A new Happy Code has been issued.',
  });
});

export const postCancel = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = reasonOnlySchema.parse(req.body);
  const complaint = await workflow.cancelComplaint(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

/** Admin's star rating of the service centre's work (DECISIONS.md section 31). */
export const postRateService = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = rateServiceSchema.parse(req.body);
  const complaint = await workflow.rateService(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

export const postWaitingForParts = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = waitingForPartsSchema.parse(req.body);
  const complaint = await workflow.markWaitingForParts(id(req), input, auth);
  res.status(200).json(present(complaint, auth));
});

export const postResumeWork = handler(async (req, res) => {
  const auth = requireAuth(req);
  const complaint = await workflow.resumeWork(id(req), auth);
  res.status(200).json(present(complaint, auth));
});
