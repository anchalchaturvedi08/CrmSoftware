/**
 * Complaint status machine (spec sections 7, 22; DECISIONS.md section 33).
 *
 * Section 7 ends with "Status transitions must be validated by backend rules
 * and role permissions", and section 19 repeats it. This file is that
 * validation — a single declarative table, so the answer to "can a technician
 * close a complaint?" is one lookup rather than an audit of every route.
 *
 * ## What the table encodes
 *
 * Three kinds of rule, all in one place:
 *
 *  - **Who.** Section 3 grants each role its powers.
 *  - **Preconditions.** A verified Happy Code is required for Technician and
 *    Owner to close. Admin can close from RESOLUTION_SUBMITTED without it
 *    (admin override, with optional remarks).
 *  - **Reasons.** Rejections, revisits, cancellations and reopens all demand a
 *    written reason, because section 17 requires the timeline to record *why*
 *    and Workflow E step 4 makes it explicit.
 *
 * ## Closure paths (DECISIONS.md section 33)
 *
 * Three roles can close, each with their own gate:
 *
 *  - **Technician:** submits resolution with Happy Code from IN_PROGRESS.
 *  - **Owner:** verifies Happy Code from RESOLUTION_SUBMITTED or IN_PROGRESS
 *    (when the technician's phone is down and cannot submit).
 *  - **Admin:** from RESOLUTION_SUBMITTED (override, optional remarks) or
 *    from ADMIN_CONFIRMATION (legacy path, requires verified code).
 *
 * Reassignment is not modelled here. Moving a complaint to another technician
 * within `TECHNICIAN_ASSIGNED` does not change its status, so it is an
 * operation with its own permission check, not a transition.
 */
import { AppError } from '../http/errors.js';
import type { ComplaintStatus, Role } from '../models/enums.js';

/**
 * A precondition on the complaint's own state.
 *
 * Kept separate from the role check because the two fail for different
 * reasons and deserve different messages — "you may not do that" versus
 * "that cannot be done yet".
 */
export type TransitionRequirement =
  | 'SERVICE_CENTER_ASSIGNED'
  | 'TECHNICIAN_ASSIGNED'
  | 'HAPPY_CODE_VERIFIED';

export interface TransitionRule {
  from: ComplaintStatus;
  to: ComplaintStatus;
  /** Roles permitted to make this move. Allow-list only. */
  roles: readonly Role[];
  /** What this transition is called in the UI and on the timeline. */
  action: string;
  /** Preconditions on complaint state. */
  requires?: readonly TransitionRequirement[];
  /** When true, a non-empty reason must accompany the change. */
  requiresReason?: boolean;
}

/** The minimum a caller must know about a complaint to evaluate a move. */
export interface ComplaintStateView {
  status: ComplaintStatus;
  serviceCenterId?: unknown;
  technicianId?: unknown;
  /**
   * Set once the Happy Code has been verified against Admin's input.
   *
   * Required, not optional, on purpose. A stored complaint keeps this under
   * `happyCode.verifiedAt`; while the key was optional, passing the stored
   * complaint straight in compiled, read as unverified, and closing was never
   * offered to the screen. Build views with `stateViewOf`.
   */
  happyCodeVerifiedAt: Date | null | undefined;
}

/** The fields of a stored complaint that decide which moves are open. */
export interface StoredComplaintState {
  status: ComplaintStatus;
  serviceCenterId?: unknown;
  technicianId?: unknown;
  happyCode?: { verifiedAt?: Date | null | undefined } | null | undefined;
}

/** The state view of a stored complaint. */
export function stateViewOf(complaint: StoredComplaintState): ComplaintStateView {
  return {
    status: complaint.status,
    serviceCenterId: complaint.serviceCenterId,
    technicianId: complaint.technicianId,
    happyCodeVerifiedAt: complaint.happyCode?.verifiedAt ?? null,
  };
}

const ADMIN: readonly Role[] = ['ADMIN'];
const OWNER: readonly Role[] = ['SERVICE_CENTER_OWNER'];
const TECHNICIAN: readonly Role[] = ['TECHNICIAN'];
const OWNER_OR_TECHNICIAN: readonly Role[] = ['SERVICE_CENTER_OWNER', 'TECHNICIAN'];
const OWNER_OR_ADMIN: readonly Role[] = ['SERVICE_CENTER_OWNER', 'ADMIN'];

/**
 * Cancellation is available to Admin from every state that is not already
 * terminal. Generated rather than written out twelve times, so a new status
 * cannot quietly end up with no cancellation path.
 */
const CANCELLABLE_FROM: readonly ComplaintStatus[] = [
  'NEW',
  'ASSIGNED',
  'TECHNICIAN_ASSIGNED',
  'VISIT_SCHEDULED',
  'IN_PROGRESS',
  'WAITING_FOR_PARTS',
  'REVISIT_REQUIRED',
  'RESOLUTION_SUBMITTED',
  'ADMIN_CONFIRMATION',
  'REOPENED',
];

const cancellationRules: readonly TransitionRule[] = CANCELLABLE_FROM.map(
  (from) => ({
    from,
    to: 'CANCELLED' as const,
    roles: ADMIN,
    action: 'Cancel complaint',
    requiresReason: true,
  }),
);

/**
 * Where Admin may move a complaint to another centre from.
 *
 * Section 8: when a centre is deactivated, "open complaints must be
 * reassigned by Admin" — all of them, not only those that have not been
 * started. The list once stopped at VISIT_SCHEDULED, so a complaint left in
 * progress, on hold for parts, sent back, or with its work submitted at a
 * deactivated centre had no way out but cancellation (found in the pre-launch
 * review, DECISIONS.md section 29).
 *
 * Moving drops back to ASSIGNED: the new centre has its own technicians, so
 * the previous assignment, its booked visits and its pending part requests
 * cannot carry over (`assignServiceCenter` withdraws them). ADMIN_CONFIRMATION
 * is left out on purpose — the work is done and accepted, so Admin closes it,
 * or sends it back for rework and moves it from there.
 */
const CENTRE_REASSIGNABLE_FROM: readonly ComplaintStatus[] = [
  'TECHNICIAN_ASSIGNED',
  'VISIT_SCHEDULED',
  'IN_PROGRESS',
  'WAITING_FOR_PARTS',
  'REVISIT_REQUIRED',
  'RESOLUTION_SUBMITTED',
];

const centreReassignmentRules: readonly TransitionRule[] = CENTRE_REASSIGNABLE_FROM.map(
  (from) => ({
    from,
    to: 'ASSIGNED' as const,
    roles: ADMIN,
    action: 'Reassign service center',
    requires: ['SERVICE_CENTER_ASSIGNED'] as const,
    requiresReason: true,
  }),
);

/**
 * The transition table.
 *
 * Ordered to follow the end-to-end flow in section 7, so it reads as the
 * lifecycle rather than as an alphabetical list.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  /* --- Admin selects the service center (section 8) ------------------- */
  {
    from: 'NEW',
    to: 'ASSIGNED',
    roles: ADMIN,
    action: 'Assign service center',
    requires: ['SERVICE_CENTER_ASSIGNED'],
  },

  /* --- Owner assigns a technician (Workflow B) ------------------------ */
  {
    from: 'ASSIGNED',
    to: 'TECHNICIAN_ASSIGNED',
    roles: OWNER,
    action: 'Assign technician',
    requires: ['TECHNICIAN_ASSIGNED'],
  },

  /* --- Owner schedules the visit -------------------------------------- */
  {
    from: 'TECHNICIAN_ASSIGNED',
    to: 'VISIT_SCHEDULED',
    roles: OWNER,
    action: 'Schedule visit',
    requires: ['TECHNICIAN_ASSIGNED'],
  },

  {
    /**
     * Calling off the only booked visit, with no new date yet.
     *
     * Not in section 7's flow, but section 9 lets the centre manage visits and
     * the visit API offers cancellation. Without this rule a cancelled visit
     * left the complaint claiming a visit was scheduled when none was — and
     * booking a new one was refused as a no-op VISIT_SCHEDULED ->
     * VISIT_SCHEDULED move. See DECISIONS.md section 23.
     */
    from: 'VISIT_SCHEDULED',
    to: 'TECHNICIAN_ASSIGNED',
    roles: OWNER_OR_ADMIN,
    action: 'Cancel visit',
    requires: ['TECHNICIAN_ASSIGNED'],
    requiresReason: true,
  },

  /* --- Technician starts the visit (Workflow C step 3) ---------------- */
  {
    from: 'VISIT_SCHEDULED',
    to: 'IN_PROGRESS',
    roles: TECHNICIAN,
    action: 'Start visit',
  },

  /* --- Technician submits the resolution (Workflow C step 10) --------- */
  {
    from: 'IN_PROGRESS',
    to: 'RESOLUTION_SUBMITTED',
    roles: TECHNICIAN,
    action: 'Submit resolution',
  },
  {
    from: 'IN_PROGRESS',
    to: 'CLOSED',
    roles: TECHNICIAN,
    action: 'Submit with Happy Code and close',
    requires: ['HAPPY_CODE_VERIFIED'],
  },

  /* --- Parts unavailable (Workflow D) ---------------------------------- */
  {
    from: 'IN_PROGRESS',
    to: 'WAITING_FOR_PARTS',
    roles: OWNER_OR_TECHNICIAN,
    action: 'Mark waiting for parts',
    requiresReason: true,
  },
  {
    from: 'WAITING_FOR_PARTS',
    to: 'IN_PROGRESS',
    roles: OWNER_OR_TECHNICIAN,
    action: 'Resume work',
  },
  {
    /* Parts arrived after the technician left, so a fresh trip is needed. */
    from: 'WAITING_FOR_PARTS',
    to: 'VISIT_SCHEDULED',
    roles: OWNER,
    action: 'Schedule follow-up visit',
    requires: ['TECHNICIAN_ASSIGNED'],
  },

  /* --- Customer was not there (section 22, Workflow C step 5) --------- */
  {
    from: 'IN_PROGRESS',
    to: 'VISIT_SCHEDULED',
    roles: OWNER,
    action: 'Reschedule visit',
    requires: ['TECHNICIAN_ASSIGNED'],
    requiresReason: true,
  },

  /* --- Owner reviews the resolution (Workflow E) ----------------------- */
  {
    from: 'RESOLUTION_SUBMITTED',
    to: 'ADMIN_CONFIRMATION',
    roles: OWNER,
    action: 'Accept resolution',
  },
  {
    from: 'RESOLUTION_SUBMITTED',
    to: 'REVISIT_REQUIRED',
    roles: OWNER,
    action: 'Reject resolution and require revisit',
    requiresReason: true,
  },

  /* --- Owner closes with Happy Code (DECISIONS.md section 33) --------- */
  {
    from: 'RESOLUTION_SUBMITTED',
    to: 'CLOSED',
    roles: OWNER,
    action: 'Verify Happy Code and close',
    requires: ['HAPPY_CODE_VERIFIED'],
  },
  {
    from: 'IN_PROGRESS',
    to: 'CLOSED',
    roles: OWNER,
    action: 'Close with Happy Code',
    requires: ['HAPPY_CODE_VERIFIED'],
  },

  /* --- Revisit (Workflow E steps 5-7) ---------------------------------- */
  {
    from: 'REVISIT_REQUIRED',
    to: 'VISIT_SCHEDULED',
    roles: OWNER,
    action: 'Schedule revisit',
    requires: ['TECHNICIAN_ASSIGNED'],
  },

  /* --- Admin confirmation and closure (Workflow F) --------------------- */
  {
    from: 'ADMIN_CONFIRMATION',
    to: 'CLOSED',
    roles: ADMIN,
    action: 'Verify Happy Code and close',
    requires: ['HAPPY_CODE_VERIFIED'],
  },
  {
    from: 'RESOLUTION_SUBMITTED',
    to: 'CLOSED',
    roles: ADMIN,
    action: 'Close complaint',
  },
  {
    from: 'ADMIN_CONFIRMATION',
    to: 'REVISIT_REQUIRED',
    roles: ADMIN,
    action: 'Require rework',
    requiresReason: true,
  },

  /* --- Reopen (section 13, Workflow G) --------------------------------- */
  {
    from: 'CLOSED',
    to: 'REOPENED',
    roles: ADMIN,
    action: 'Reopen complaint',
    requiresReason: true,
  },
  {
    /**
     * Reopening a cancelled complaint.
     *
     * Not in the spec, which only describes reopening a *closed* one. Added
     * because without it a complaint cancelled by mistake is unrecoverable,
     * and the only remedy would be a duplicate — which fights rule 15 and
     * section 13's insistence on preserving one continuous history.
     * See DECISIONS.md section 11.
     */
    from: 'CANCELLED',
    to: 'REOPENED',
    roles: ADMIN,
    action: 'Reopen cancelled complaint',
    requiresReason: true,
  },
  {
    from: 'REOPENED',
    to: 'TECHNICIAN_ASSIGNED',
    roles: OWNER,
    action: 'Assign technician',
    requires: ['TECHNICIAN_ASSIGNED'],
  },
  {
    /**
     * Admin routes a reopened complaint to a centre.
     *
     * No reason at the machine: a complaint cancelled before any centre was
     * chosen reopens with none, and choosing one is a first assignment, not a
     * move. Found in the pre-launch review — the reason demanded here had no
     * box to type it in, so such a complaint could never be assigned.
     * `assignServiceCenter` still requires a reason when the centre actually
     * changes.
     */
    from: 'REOPENED',
    to: 'ASSIGNED',
    roles: ADMIN,
    action: 'Assign service center',
    requires: ['SERVICE_CENTER_ASSIGNED'],
  },

  /* --- Admin moves a complaint to another center (section 8) ----------- */
  ...centreReassignmentRules,

  {
    /* Owner cancelled the scheduled visit without replacing it yet. */
    from: 'VISIT_SCHEDULED',
    to: 'TECHNICIAN_ASSIGNED',
    roles: OWNER,
    action: 'Cancel scheduled visit',
    requiresReason: true,
  },

  ...cancellationRules,
];

/** Human-readable explanation for each precondition. */
const REQUIREMENT_MESSAGES: Record<TransitionRequirement, string> = {
  SERVICE_CENTER_ASSIGNED: 'a service center must be selected first',
  TECHNICIAN_ASSIGNED: 'a technician must be assigned first',
  HAPPY_CODE_VERIFIED:
    'the Happy Code must be verified with the customer before closing',
};

function meetsRequirement(
  requirement: TransitionRequirement,
  complaint: ComplaintStateView,
): boolean {
  switch (requirement) {
    case 'SERVICE_CENTER_ASSIGNED':
      return Boolean(complaint.serviceCenterId);
    case 'TECHNICIAN_ASSIGNED':
      return Boolean(complaint.technicianId);
    case 'HAPPY_CODE_VERIFIED':
      return Boolean(complaint.happyCodeVerifiedAt);
    default:
      /* An unrecognized requirement must block, not wave through. */
      return false;
  }
}

/** Every rule leaving a status, regardless of role. */
export function transitionsFrom(status: ComplaintStatus): readonly TransitionRule[] {
  return TRANSITIONS.filter((rule) => rule.from === status);
}

/**
 * What this role could do next, given the complaint's current state.
 *
 * Intended for building a UI's action list. It is a convenience, never the
 * control — `assertTransition` still runs on the write path, because a client
 * that ignores this list must still be refused.
 */
export function availableTransitions(
  complaint: ComplaintStateView,
  role: Role,
): readonly TransitionRule[] {
  return transitionsFrom(complaint.status).filter(
    (rule) =>
      rule.roles.includes(role) &&
      (rule.requires ?? []).every((req) => meetsRequirement(req, complaint)),
  );
}

export interface TransitionAttempt {
  complaint: ComplaintStateView;
  to: ComplaintStatus;
  role: Role;
  reason?: string | undefined;
}

/**
 * Validates a status change, or throws.
 *
 * Failure messages distinguish three cases on purpose, because they mean
 * genuinely different things to whoever hit them:
 *
 *  - the move does not exist in the lifecycle at all;
 *  - it exists, but not for this role;
 *  - it exists and is permitted, but the complaint is not ready.
 *
 * Collapsing them into one "forbidden" would leave an Admin unable to tell a
 * permission problem from an unverified Happy Code.
 */
export function assertTransition(attempt: TransitionAttempt): TransitionRule {
  const { complaint, to, role, reason } = attempt;

  if (complaint.status === to) {
    throw new AppError(
      409,
      'INVALID_STATUS_TRANSITION',
      `This complaint is already ${to.replace(/_/g, ' ').toLowerCase()}`,
    );
  }

  const candidates = transitionsFrom(complaint.status).filter(
    (rule) => rule.to === to,
  );

  if (candidates.length === 0) {
    throw new AppError(
      409,
      'INVALID_STATUS_TRANSITION',
      `A complaint cannot move from ${complaint.status} to ${to}`,
      { context: { from: complaint.status, to, role } },
    );
  }

  const permitted = candidates.filter((rule) => rule.roles.includes(role));

  if (permitted.length === 0) {
    /* The move is real but belongs to someone else — section 3.2 and 3.3
       prohibitions land here. */
    const allowedRoles = [...new Set(candidates.flatMap((rule) => rule.roles))];
    throw new AppError(
      403,
      'FORBIDDEN',
      `Only ${allowedRoles.join(' or ')} can do that`,
      { context: { from: complaint.status, to, role, allowedRoles } },
    );
  }

  /* Prefer a rule whose preconditions are already satisfied; otherwise report
     against the first, so the message names a real blocker. */
  const satisfied = permitted.find((rule) =>
    (rule.requires ?? []).every((req) => meetsRequirement(req, complaint)),
  );

  const rule = satisfied ?? permitted[0]!;

  if (!satisfied) {
    const unmet = (rule.requires ?? []).filter(
      (req) => !meetsRequirement(req, complaint),
    );
    throw new AppError(
      409,
      'INVALID_STATUS_TRANSITION',
      `Cannot ${rule.action.toLowerCase()}: ${unmet
        .map((req) => REQUIREMENT_MESSAGES[req])
        .join(', and ')}`,
      { context: { from: complaint.status, to, unmet } },
    );
  }

  if (rule.requiresReason && !reason?.trim()) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `A reason is required to ${rule.action.toLowerCase()}`,
      { issues: [{ field: 'reason', message: 'Please give a reason' }] },
    );
  }

  return rule;
}
