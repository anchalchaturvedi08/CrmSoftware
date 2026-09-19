/**
 * Domain enumerations.
 *
 * These are the vocabulary of the whole system, so they live in one file and
 * nothing redefines them locally. Every value here traces to the spec; the
 * section reference is given so a future change can be checked against intent.
 */

/* ---- Roles (spec section 3) ------------------------------------------- */

export const ROLES = ['ADMIN', 'SERVICE_CENTER_OWNER', 'TECHNICIAN'] as const;
export type Role = (typeof ROLES)[number];

/* ---- Complaint status (spec section 7) -------------------------------- */

/**
 * The twelve visible statuses, in the order the spec lists them.
 *
 * `NEW` is reachable because service center is optional at creation — see
 * DECISIONS.md section 4.1, which resolves a contradiction in the spec where
 * every complaint would otherwise have been born `ASSIGNED`.
 */
export const COMPLAINT_STATUSES = [
  'NEW',
  'ASSIGNED',
  'TECHNICIAN_ASSIGNED',
  'VISIT_SCHEDULED',
  'IN_PROGRESS',
  'WAITING_FOR_PARTS',
  'REVISIT_REQUIRED',
  'RESOLUTION_SUBMITTED',
  'ADMIN_CONFIRMATION',
  'CLOSED',
  'REOPENED',
  'CANCELLED',
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/** Statuses in which a complaint is no longer active work. */
export const TERMINAL_STATUSES: readonly ComplaintStatus[] = ['CLOSED', 'CANCELLED'];

/* ---- Priority and warranty (spec sections 6.1, 12, 14) ---------------- */

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const WARRANTY_STATUSES = ['IN_WARRANTY', 'OUT_OF_WARRANTY'] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

/* ---- Visits (spec section 10) ----------------------------------------- */

export const VISIT_STATUSES = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** Step 2 of the technician visit flow: was the customer actually there. */
export const CUSTOMER_AVAILABILITY = [
  'CUSTOMER_AVAILABLE',
  'CUSTOMER_UNAVAILABLE',
  'RESCHEDULE_REQUIRED',
  'OTHER',
] as const;
export type CustomerAvailability = (typeof CUSTOMER_AVAILABILITY)[number];

/* ---- Parts (spec section 11) ------------------------------------------ */

export const PART_REQUEST_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'ISSUED',
  'UNAVAILABLE',
  'REJECTED',
  'CANCELLED',
] as const;
export type PartRequestStatus = (typeof PART_REQUEST_STATUSES)[number];

/* ---- SLA (spec section 14) -------------------------------------------- */

export const SLA_STATES = ['RUNNING', 'PAUSED', 'BREACHED', 'COMPLETED'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/* ---- Attachments (spec sections 10, 19) ------------------------------- */

export const ATTACHMENT_KINDS = ['BEFORE_PHOTO', 'AFTER_PHOTO', 'VIDEO', 'OTHER'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/* ---- Resolution review (spec sections 9, 22) -------------------------- */

export const RESOLUTION_REVIEW_OUTCOMES = ['ACCEPTED', 'REVISIT_REQUIRED'] as const;
export type ResolutionReviewOutcome = (typeof RESOLUTION_REVIEW_OUTCOMES)[number];

/* ---- Timeline actions (spec section 17) ------------------------------- */

/**
 * Every action that must appear on the complaint timeline. The spec lists
 * these explicitly; keeping them as a closed set means an unrecorded action
 * is a compile error rather than a silent gap in the audit trail.
 */
export const ACTIVITY_ACTIONS = [
  'COMPLAINT_CREATED',
  'SERVICE_CENTER_SELECTED',
  'SERVICE_CENTER_REASSIGNED',
  'TECHNICIAN_ASSIGNED',
  'TECHNICIAN_REASSIGNED',
  'VISIT_SCHEDULED',
  'VISIT_RESCHEDULED',
  'VISIT_STARTED',
  /** A booked visit called off, with no new date: its own event, not a reschedule. */
  'VISIT_CANCELLED',
  'STATUS_CHANGED',
  'DIAGNOSIS_ADDED',
  'WORK_RECORDED',
  'PARTS_REQUESTED',
  'PARTS_ISSUED',
  'PARTS_USED',
  'PARTS_MARKED_UNAVAILABLE',
  /* The Owner's decision on a part request, recorded as what it was rather
     than as another "Parts requested". */
  'PARTS_REQUEST_APPROVED',
  'PARTS_REQUEST_REJECTED',
  /** Withdrawn by the system, e.g. when the complaint moves to another centre. */
  'PARTS_REQUEST_CANCELLED',
  'ATTACHMENT_ADDED',
  'RESOLUTION_SUBMITTED',
  'RESOLUTION_REJECTED',
  'REVISIT_REQUIRED',
  'ADMIN_CONFIRMATION_STARTED',
  'HAPPY_CODE_VERIFIED',
  'HAPPY_CODE_VERIFY_FAILED',
  'HAPPY_CODE_VIEWED',
  'HAPPY_CODE_REGENERATED',
  'COMPLAINT_CLOSED',
  /** Admin's star rating of the centre's work on a closed complaint. */
  'SERVICE_CENTER_RATED',
  'COMPLAINT_REOPENED',
  'COMPLAINT_CANCELLED',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
