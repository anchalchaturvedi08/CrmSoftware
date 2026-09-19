/**
 * Complaint HTTP layer.
 *
 * Shapes responses and delegates. The one piece of judgement here is what a
 * complaint looks like on the wire — in particular, never serialising the
 * Happy Code by accident.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { snapshot } from '../../core/sla.js';
import { availableTransitions, stateViewOf } from '../../core/statusMachine.js';
import { requireAuth } from '../../middleware/authenticate.js';
import type { ComplaintDoc } from '../../models/index.js';
import * as complaintService from './complaint.service.js';
import { recommendServiceCenters } from './recommendation.service.js';
import {
  createComplaintSchema,
  listComplaintsSchema,
  recommendationQuerySchema,
} from './complaint.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * Serialises a complaint for a client.
 *
 * `happyCodeSecret` is `select: false` so it is normally absent, but this
 * function deletes it explicitly rather than relying on that. A future query
 * adding `.select('+happyCodeSecret')` for an unrelated reason must not turn
 * this into a leak.
 */
function present(complaint: ComplaintDoc) {
  const plain = JSON.parse(JSON.stringify(complaint)) as Record<string, unknown>;
  delete plain['happyCodeSecret'];

  return {
    ...plain,
    /* Derived, not stored — so SLA figures are right on every read. */
    slaSnapshot: snapshot(complaint.sla),
  };
}

export const postComplaint = handler(async (req, res) => {
  const auth = requireAuth(req);
  const input = createComplaintSchema.parse(req.body);

  const { complaint, happyCode } = await complaintService.createComplaint(input, auth);

  /**
   * The code is returned once, at creation, so Admin can act on it
   * immediately (Workflow A step 14) without a second round trip. Reading it
   * again later goes through the audited `/whatsapp` route.
   */
  res.status(201).json({
    complaint: present(complaint),
    happyCode,
    nextActions: availableTransitions(stateViewOf(complaint), auth.role).map((rule) => ({
      to: rule.to,
      action: rule.action,
      requiresReason: rule.requiresReason ?? false,
    })),
  });
});

export const getComplaints = handler(async (req, res) => {
  const auth = requireAuth(req);
  const query = listComplaintsSchema.parse(req.query);

  const page = await complaintService.listComplaints(query, auth);

  res.status(200).json({
    ...page,
    items: page.items.map((item) => present(item)),
  });
});

export const getComplaintById = handler(async (req, res) => {
  const auth = requireAuth(req);
  const complaint = await complaintService.getComplaint(String(req.params['id']), auth);

  res.status(200).json({
    complaint: present(complaint),
    /* What this caller can do next. A convenience for the UI — the status
       machine still re-validates on the write path. */
    nextActions: availableTransitions(stateViewOf(complaint), auth.role).map((rule) => ({
      to: rule.to,
      action: rule.action,
      requiresReason: rule.requiresReason ?? false,
    })),
  });
});

/**
 * Section 8 recommendations.
 *
 * Returns a ranked list with reasons. It is explicitly not a decision — the
 * response carries `manualSelectionRequired: true` so no client can mistake
 * the top entry for an assignment.
 */
export const getRecommendations = handler(async (req, res) => {
  requireAuth(req);
  const query = recommendationQuerySchema.parse(req.query);

  const result = await recommendServiceCenters(query);

  const shape = (entry: Awaited<ReturnType<typeof recommendServiceCenters>>['recommended'][number]) => ({
    id: String(entry.center._id),
    name: entry.center.name,
    code: entry.center.code,
    mobile: entry.center.mobile,
    address: entry.center.address,
    pincode: entry.center.pincode,
    reason: entry.reason,
    explanation: entry.explanation,
    score: entry.score,
  });

  res.status(200).json({
    recommended: result.recommended.map(shape),
    others: result.others.map(shape),
    fellBackToAll: result.fellBackToAll,
    manualSelectionRequired: true,
  });
});

export const getWhatsApp = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await complaintService.getWhatsAppLink(
    String(req.params['id']),
    auth,
  );

  if (!result.link.available) {
    /* 200, not an error: an unusable link is a normal state the UI renders as
       a disabled button with a reason (section 6.4). The complaint workflow is
       unaffected either way. */
    res.status(200).json({
      available: false,
      reason: result.link.reason,
    });
    return;
  }

  res.status(200).json({
    available: true,
    url: result.link.url,
    message: result.link.message,
    happyCode: result.happyCode,
    /* Section 6.4: never claim the message was delivered or read. */
    note: 'Opens WhatsApp with the message pre-filled. You must press send yourself.',
  });
});
