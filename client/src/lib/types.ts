/**
 * Response shapes from the API.
 *
 * Mirrors what the server sends after `normalizeResponse` has run — so `id`,
 * never `_id`, and no `__v`. Kept to the fields the screens actually read.
 */
import type { ComplaintStatus, Priority } from './format';

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SlaSnapshot {
  state: 'RUNNING' | 'PAUSED' | 'BREACHED' | 'COMPLETED';
  responseDueAt: string;
  resolutionDueAt: string;
  resolutionRemainingMs: number | null;
  responseRemainingMs: number | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
}

export interface Complaint {
  id: string;
  complaintNumber: string;
  customerId: string;
  productId: string;
  productModelId: string;
  serialNumber: string;
  purchaseDate?: string;
  category: string;
  description: string;
  priority: Priority;
  warrantyStatus: 'IN_WARRANTY' | 'OUT_OF_WARRANTY';
  warrantyNotes?: string;
  serviceAddress: {
    address: string;
    cityId: string;
    cityName: string;
    state: string;
    pincode: string;
  };
  customerSnapshot: { name: string; mobile: string; alternateMobile?: string };
  productSnapshot: {
    productName: string;
    modelNumber: string;
    /** The warranty the product carried when this complaint was raised. */
    warrantyMonths?: number;
  };
  serviceCenterId?: string;
  technicianId?: string;
  status: ComplaintStatus;
  happyCode: {
    issuedAt: string;
    verifiedAt?: string;
    attempts: number;
    lockedAt?: string;
    regenerationCount: number;
  };
  sla: {
    responseDueAt: string;
    resolutionDueAt: string;
    state: SlaSnapshot['state'];
    breachedAt?: string;
  };
  slaSnapshot?: SlaSnapshot;
  /** Admin's rating of the centre's work; only ever set on a closed complaint. */
  serviceRating?: {
    stars: number;
    note?: string;
    serviceCenterId: string;
    ratedAt: string;
    ratedByName: string;
    revisions: number;
  };
  resolutionReview?: {
    reviewedAt: string;
    outcome: 'ACCEPTED' | 'REVISIT_REQUIRED';
    rejectionReason?: string;
  };
  closedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  /** The visit whose resolution is awaiting (or last had) review. */
  lastResolutionVisitId?: string;
  lastResolutionSubmittedAt?: string;
  reopenCount: number;
  closureHistory: Array<{
    closedAt: string;
    reopenedAt: string;
    reopenReason: string;
  }>;
  createdAt: string;
  updatedAt: string;

  /* Joined in by the list endpoint only (section 9's list columns). */
  technicianName?: string;
  /** The visit booked or under way, if any. */
  currentVisit?: VisitSummary;
  /** The most recent visit of any kind. */
  lastVisit?: VisitSummary;
}

export interface VisitSummary {
  id: string;
  sequence: number;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  customerAvailability?: CustomerAvailability;
  availabilityNote?: string;
}

export interface NextAction {
  to: ComplaintStatus;
  action: string;
  requiresReason: boolean;
}

export interface ComplaintDetail {
  complaint: Complaint;
  nextActions: NextAction[];
}

export interface TimelineEntry {
  id: string;
  action: string;
  actorName: string;
  actorRole: string;
  at: string;
  visitId?: string;
  fieldChanged?: string;
  oldValue?: string;
  newValue?: string;
  note?: string;
}

export interface LabelCount {
  label: string;
  count: number;
}

export interface Dashboard {
  kpis: {
    totalOpen: number;
    newComplaints: number;
    inProgress: number;
    waitingForParts: number;
    revisitRequired: number;
    resolutionSubmitted: number;
    adminConfirmationPending: number;
    closed: number;
    slaBreached: number;
    critical: number;
  };
  breakdowns: {
    byStatus: LabelCount[];
    byPriority: LabelCount[];
    byCity: LabelCount[];
    byServiceCenter: LabelCount[];
    byModel: LabelCount[];
    byWarranty: LabelCount[];
    repeatComplaints: { repeat: number; first: number };
    slaPerformance: { met: number; breached: number; paused: number };
    technicianWorkload: LabelCount[];
  };
  operations?: {
    todaysVisits: number;
    upcomingVisits: number;
    /** Booked for an earlier day and never started. */
    missedVisits: number;
    pendingReview: number;
    pendingPartRequests: number;
    lowStockParts: number;
    activeTechnicians: number;
  };
  /** Admin's star ratings of the centre's work (DECISIONS.md section 31). */
  ratings: {
    /** Null when nothing in the period has been rated. */
    average: number | null;
    rated: number;
    /** Closed complaints still waiting for Admin to rate them. */
    closedUnrated: number;
  };
  generatedAt: string;
}

export interface ServiceCenter {
  id: string;
  name: string;
  code: string;
  mobile: string;
  email?: string;
  address: string;
  pincode: string;
  cityId?: string;
  territoryId?: string;
  /** Section 8 coverage: cities and pincodes beyond the centre's own. */
  servedCityIds?: string[];
  servedPincodes?: string[];
  notes?: string;
  isActive: boolean;
}

export interface Territory {
  id: string;
  name: string;
  code: string;
  notes?: string;
  isActive: boolean;
}

/** One priority's SLA windows, as `/sla-rules` returns them. */
export interface SlaRule {
  id: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  responseHours: number;
  resolutionHours: number;
  pauseOnWaitingParts: boolean;
  pauseOnRevisitRequired: boolean;
  notes?: string;
  updatedAt: string;
}

/** Open work stranded by deactivating a centre or a technician. */
export interface StrandedWork {
  complaintId: string;
  complaintNumber: string;
  status: string;
}

export interface Recommendation {
  id: string;
  name: string;
  code: string;
  mobile: string;
  address: string;
  pincode: string;
  reason: string;
  explanation: string;
  score: number;
}

export interface Customer {
  id: string;
  name: string;
  mobile: string;
  alternateMobile?: string;
  email?: string;
  address: string;
  cityId: string;
  state: string;
  pincode: string;
  notes?: string;
  isActive?: boolean;
  createdAt?: string;
}

/** One unit a customer owns, as their complaints record it (section 32). */
export interface CustomerProduct {
  serialNumber: string;
  productName: string;
  modelNumber: string;
  purchaseDate?: string;
  warrantyMonths?: number;
  complaints: number;
  lastComplaintAt: string;
  openComplaints: number;
}

export interface Product {
  id: string;
  name: string;
  code: string;
  category?: string;
  defaultWarrantyMonths?: number;
  notes?: string;
  isActive?: boolean;
}

export interface ProductModel {
  id: string;
  productId: string;
  modelNumber: string;
  name?: string;
  defaultWarrantyMonths?: number;
  isActive?: boolean;
}

export interface City {
  id: string;
  name: string;
  state: string;
  territoryId: string;
  isActive?: boolean;
}

export interface User {
  id: string;
  role: string;
  name: string;
  mobile: string;
  email?: string;
  serviceCenterId?: string;
  isActive: boolean;
  /** True until the person replaces the temporary password they were given. */
  mustChangePassword?: boolean;
  lastLoginAt?: string;
  createdAt?: string;
  /** Technicians only, on list responses. */
  workload?: { openJobs: number; visitsToday: number };
}

/** A user just created or reset — the one time the password is readable. */
export interface IssuedPassword {
  user: User;
  temporaryPassword: string;
  note: string;
}

/* ---- Technician (section 10) ------------------------------------------ */

export type CustomerAvailability =
  | 'CUSTOMER_AVAILABLE'
  | 'CUSTOMER_UNAVAILABLE'
  | 'RESCHEDULE_REQUIRED'
  | 'OTHER';

/**
 * A visit with the complaint context a job card needs, as `/visits` returns it.
 *
 * `REVISIT_REQUIRED` is not a real visit status: My Jobs sends a placeholder
 * card with it for a job sent back but not yet rescheduled.
 */
export interface VisitCard {
  id: string;
  sequence: number;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'REVISIT_REQUIRED';
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  customerAvailability?: CustomerAvailability;
  availabilityNote?: string;
  /** Present only when work was submitted on this visit. */
  resolutionResult?: string;
  technicianId: string;
  serviceCenterId: string;
  /** On schedule listings (`GET /visits`), not on My Jobs. */
  technicianName?: string;
  serviceCenterName?: string;
  complaint: {
    id: string;
    complaintNumber: string;
    status: ComplaintStatus;
    priority: Priority;
    category: string;
    customerName: string;
    customerMobile: string;
    address: string;
    cityName: string;
    pincode: string;
    productName: string;
    modelNumber: string;
    serialNumber: string;
    warrantyStatus: 'IN_WARRANTY' | 'OUT_OF_WARRANTY';
  } | null;
}

export interface MyJobs {
  today: VisitCard[];
  upcoming: VisitCard[];
  inProgress: VisitCard[];
  revisitRequired: VisitCard[];
  completed: VisitCard[];
  counts: { today: number; upcoming: number; inProgress: number; revisitRequired: number };
}

export interface Part {
  id: string;
  name: string;
  code: string;
  unit: string;
  category?: string;
  isActive?: boolean;
}

export interface PartUsage {
  id: string;
  partId: string;
  visitId?: string;
  quantity: number;
  remarks?: string;
  recordedBy?: string;
  /** Set when the centre confirms it and stock is deducted (section 11). */
  finalizedAt?: string;
  createdAt: string;
  /** The part itself, if the server joins it in (as it does for part requests). */
  part?: { name: string; code: string; unit: string };
}

export interface Attachment {
  id: string;
  visitId?: string;
  kind: 'BEFORE_PHOTO' | 'AFTER_PHOTO' | 'VIDEO' | 'OTHER';
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
  createdAt: string;
}

/* ---- Service Center (sections 9, 11) ----------------------------------- */

/** One visit in full, as `GET /visits/:id` returns it. */
export interface VisitDetail {
  id: string;
  sequence: number;
  status: VisitSummary['status'];
  technicianId: string;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  customerAvailability?: CustomerAvailability;
  availabilityNote?: string;
  diagnosis?: { problemFound: string; notes?: string; recordedAt: string };
  workPerformed?: { details: string; remarks?: string; recordedAt: string };
  resolution?: {
    result: string;
    remarks?: string;
    customerFeedback?: string;
    submittedAt: string;
  };
  rescheduleHistory: Array<{
    previousScheduledAt: string;
    newScheduledAt: string;
    rescheduledAt: string;
    reason?: string;
  }>;
}

export interface StockRow {
  id: string;
  partId: string;
  partName: string;
  partCode: string;
  unit: string;
  serviceCenterId: string;
  availableQuantity: number;
  minimumStock: number;
  isLowStock: boolean;
  lastRestockedAt?: string;
}

export type PartRequestStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'ISSUED'
  | 'UNAVAILABLE'
  | 'REJECTED'
  | 'CANCELLED';

export interface PartRequestRow {
  id: string;
  complaintId: string;
  visitId?: string;
  partId: string;
  requestedBy: string;
  quantityRequested: number;
  quantityIssued?: number;
  reason?: string;
  status: PartRequestStatus;
  decisionRemarks?: string;
  decidedAt?: string;
  createdAt: string;
  part?: { name: string; code: string; unit: string };
  complaint?: {
    id: string;
    complaintNumber: string;
    customerName: string;
    status: ComplaintStatus;
  };
  requestedByName?: string;
}

/* ---- Reports (section 16) ------------------------------------------------ */

export type ReportKind = 'complaints' | 'service-centers' | 'technicians' | 'products' | 'parts';

/** How a report value reads: `45` with `percent` is 45%. */
export type ReportValueFormat = 'number' | 'decimal' | 'percent' | 'hours' | 'text' | 'date';

export interface ReportSummaryItem {
  key: string;
  label: string;
  /** Null when there is nothing to measure, e.g. no closures to average. */
  value: number | null;
  format: 'number' | 'decimal' | 'percent' | 'hours';
}

export interface ReportBreakdown {
  key: string;
  title: string;
  labelHeader: string;
  valueHeader: string;
  items: Array<{ key: string; label: string; value: number }>;
}

export interface ReportTrend {
  title: string;
  unit: 'day' | 'week' | 'month' | 'year';
  valueHeader: string;
  points: Array<{ key: string; label: string; value: number }>;
}

export interface ReportColumn {
  key: string;
  header: string;
  format: ReportValueFormat;
}

export interface ReportTable {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null | undefined>>;
  total: number;
  truncated?: boolean;
}

export interface Report {
  kind: ReportKind;
  title: string;
  dateBasis: string;
  summary: ReportSummaryItem[];
  breakdowns: ReportBreakdown[];
  trend?: ReportTrend;
  tables: ReportTable[];
  filters: Array<{ label: string; value: string }>;
  ignoredFilters: Array<{ key: string; label: string }>;
  generatedAt: string;
}

/* ---- Audit log (section 17) ---------------------------------------------- */

/** A complaint timeline entry, with the complaint it belongs to. */
export interface ActivityEntry extends TimelineEntry {
  complaint: { id: string; complaintNumber: string } | null;
}

/** The rules in force, as `GET /settings` reports them (Admin only). */
export interface SystemSettings {
  signIn: {
    maxFailedAttempts: number;
    lockoutMinutes: number;
    passwordMinLength: number;
    sessionRenewMinutes: number | null;
    staySignedInMinutes: number | null;
  };
  happyCode: { digits: number; maxAttempts: number };
  attachments: { maxFileMb: number };
  timezone: string;
}

/** A system audit log entry, with names in place of ids. */
export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  entityType: string;
  entityId?: string;
  entityName?: string;
  actorId?: string;
  actorName?: string;
  actorRole?: string;
  changes: Array<{ field: string; oldValue?: string; newValue?: string }>;
  note?: string;
  ipAddress?: string;
  userAgent?: string;
}
