/**
 * Complaint — the central object of the system (spec section 28).
 *
 * Three design decisions in here are worth understanding before changing
 * anything:
 *
 * **1. Snapshots.** Customer details, product details and the service address
 * are copied onto the complaint at creation rather than only referenced. The
 * references are kept too, for joins and reporting — but the snapshot is what
 * the complaint *means*. Rule 15 says an old complaint must never be
 * overwritten, and section 22 requires history to survive master-data changes.
 * If a customer moves house, a complaint closed last year must still show
 * where the technician actually went. Referencing alone cannot express that.
 *
 * **2. Happy Code secrecy.** The encrypted code lives in `happyCodeSecret`,
 * which is `select: false` — no query returns it unless it explicitly asks.
 * Verification metadata (attempts, lock state) sits separately in `happyCode`
 * so the workflow can be reasoned about without ever loading the secret.
 *
 * **3. `serviceCenterId` is optional.** This is what makes `NEW` a reachable
 * status. The spec contradicts itself here — section 6.1 lists service center
 * as a creation field, which would mean no complaint is ever `NEW`, yet
 * section 7 lists `NEW` first. See DECISIONS.md section 4.1.
 */
import { Schema, type Types } from 'mongoose';
import {
  baseSchemaOptions,
  defineModel,
  optionalText,
  pincodeField,
  requiredName,
} from './common/base.js';
import {
  COMPLAINT_STATUSES,
  PRIORITIES,
  RESOLUTION_REVIEW_OUTCOMES,
  SLA_STATES,
  WARRANTY_STATUSES,
  type ComplaintStatus,
  type Priority,
  type ResolutionReviewOutcome,
  type SlaState,
  type WarrantyStatus,
} from './enums.js';

/* ---- Embedded shapes --------------------------------------------------- */

/** Where the service actually happens, frozen at creation. */
export interface ServiceAddressSnapshot {
  address: string;
  cityId: Types.ObjectId;
  /** Denormalized so a renamed or deactivated city cannot alter history. */
  cityName: string;
  state: string;
  pincode: string;
}

/** Who the customer was at creation time. */
export interface CustomerSnapshot {
  name: string;
  mobile: string;
  alternateMobile?: string;
}

/** What the product was at creation time. */
export interface ProductSnapshot {
  productName: string;
  modelNumber: string;
  /**
   * The warranty the product carried when the complaint was raised, in months
   * (DECISIONS.md section 32).
   *
   * Snapshotted like the name: changing a product's warranty next year must
   * not silently rewrite how long an old unit was covered. Absent on
   * complaints raised before this was recorded, which read as the twelve-month
   * default.
   */
  warrantyMonths?: number;
}

/**
 * AES-256-GCM material for the Happy Code.
 *
 * Encrypted rather than hashed so Admin can re-read and re-send a code the
 * customer never received. A hash would make an invalid phone number
 * (section 6.4 disables WhatsApp for those) into a permanently uncloseable
 * complaint, since section 15 forbids every other channel. DECISIONS.md
 * section 4.2 has the full reasoning.
 */
export interface HappyCodeSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Verification state. Safe to load; carries no secret material. */
export interface HappyCodeMeta {
  issuedAt: Date;
  verifiedAt?: Date;
  /**
   * Failed verification attempts. A 6-digit numeric code is only 10^6
   * possibilities, so unlimited attempts would make the control decorative.
   */
  attempts: number;
  /** Set when attempts are exhausted; Admin must regenerate to proceed. */
  lockedAt?: Date;
  regenerationCount: number;
  lastViewedAt?: Date;
  lastViewedBy?: Types.ObjectId;
}

/**
 * SLA tracking (spec section 14).
 *
 * Elapsed time is derived from these stamps rather than stored as a countdown,
 * so a restart or a clock change cannot corrupt it. Pausing is configurable
 * and ships off (DECISIONS.md section 5, item 4).
 */
export interface SlaTracking {
  responseDueAt: Date;
  resolutionDueAt: Date;
  state: SlaState;
  respondedAt?: Date;
  pausedAt?: Date;
  /** Accumulated paused milliseconds, added back when computing remaining time. */
  pausedTotalMs: number;
  breachedAt?: Date;
  completedAt?: Date;
}

/** Review of a technician's submitted resolution (sections 9, 22). */
export interface ResolutionReview {
  reviewedAt: Date;
  reviewedBy: Types.ObjectId;
  outcome: ResolutionReviewOutcome;
  /** Mandatory when the outcome is a revisit (section 22, Workflow E step 4). */
  rejectionReason?: string;
}

/**
 * A past closure, retained when a complaint is reopened.
 *
 * Rule 16 and section 22 both require that reopening preserves the previous
 * closure rather than replacing it, so each cycle is appended here.
 */
/**
 * Admin's verdict on the centre's work, once the complaint is closed
 * (DECISIONS.md section 31).
 *
 * Kept on the complaint rather than in a collection of its own: there is
 * exactly one rating per complaint, every screen that shows a rating is
 * already showing its complaint, and the centre's average is then one
 * aggregation over complaints instead of a join. `serviceCenterId` is copied
 * in so the average stays attributable to the centre that earned it even if a
 * reopened complaint later moves elsewhere.
 */
export interface ServiceRating {
  stars: number;
  note?: string;
  serviceCenterId: Types.ObjectId;
  ratedAt: Date;
  ratedBy: Types.ObjectId;
  /** Who rated, for the centre to read without a lookup. */
  ratedByName: string;
  /** How many times Admin has changed it; 0 the first time. */
  revisions: number;
}

export interface ClosureRecord {
  closedAt: Date;
  closedBy: Types.ObjectId;
  reopenedAt: Date;
  reopenedBy: Types.ObjectId;
  reopenReason: string;
  /** The rating that closure was given, if Admin had rated it. */
  rating?: ServiceRating;
}

/* ---- Complaint --------------------------------------------------------- */

export interface ComplaintDoc {
  _id: Types.ObjectId;

  /** `CMP-2026-000001`, from an atomic counter (section 6.2). */
  complaintNumber: string;

  customerId: Types.ObjectId;
  productId: Types.ObjectId;
  productModelId: Types.ObjectId;
  serialNumber: string;
  purchaseDate?: Date;

  category: string;
  description: string;
  priority: Priority;

  /**
   * Section 12 is explicit: the complaint-level selection is authoritative and
   * must not be silently changed later, even if the product master says
   * otherwise.
   */
  warrantyStatus: WarrantyStatus;
  warrantyNotes?: string;

  serviceAddress: ServiceAddressSnapshot;
  customerSnapshot: CustomerSnapshot;
  productSnapshot: ProductSnapshot;

  /** Absent while the complaint is still `NEW`. */
  serviceCenterId?: Types.ObjectId;
  technicianId?: Types.ObjectId;

  status: ComplaintStatus;

  happyCodeSecret?: HappyCodeSecret;
  happyCode: HappyCodeMeta;
  sla: SlaTracking;

  /** Latest submitted resolution, and the review of it. */
  lastResolutionVisitId?: Types.ObjectId;
  lastResolutionSubmittedAt?: Date;
  resolutionReview?: ResolutionReview;

  /** Set once Admin rates the centre's work (only on a closed complaint). */
  serviceRating?: ServiceRating;

  closedAt?: Date;
  closedBy?: Types.ObjectId;
  cancelledAt?: Date;
  cancelledBy?: Types.ObjectId;
  cancellationReason?: string;

  reopenCount: number;
  closureHistory: ClosureRecord[];

  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const serviceAddressSchema = new Schema<ServiceAddressSnapshot>(
  {
    address: { type: String, required: true, trim: true, maxlength: 500 },
    cityId: { type: Schema.Types.ObjectId, ref: 'City', required: true },
    cityName: requiredName(120),
    state: requiredName(120),
    pincode: pincodeField,
  },
  { _id: false },
);

const customerSnapshotSchema = new Schema<CustomerSnapshot>(
  {
    name: requiredName(160),
    mobile: { type: String, required: true, trim: true },
    alternateMobile: { type: String, required: false, trim: true },
  },
  { _id: false },
);

const productSnapshotSchema = new Schema<ProductSnapshot>(
  {
    productName: requiredName(180),
    modelNumber: { type: String, required: true, trim: true, maxlength: 60 },
    warrantyMonths: { type: Number, required: false, min: 0, max: 600 },
  },
  { _id: false },
);

const happyCodeSecretSchema = new Schema<HappyCodeSecret>(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
  },
  { _id: false },
);

const happyCodeMetaSchema = new Schema<HappyCodeMeta>(
  {
    issuedAt: { type: Date, required: true },
    verifiedAt: { type: Date, required: false },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    lockedAt: { type: Date, required: false },
    regenerationCount: { type: Number, required: true, default: 0, min: 0 },
    lastViewedAt: { type: Date, required: false },
    lastViewedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  { _id: false },
);

const slaSchema = new Schema<SlaTracking>(
  {
    responseDueAt: { type: Date, required: true },
    resolutionDueAt: { type: Date, required: true },
    state: { type: String, required: true, enum: SLA_STATES, default: 'RUNNING' },
    respondedAt: { type: Date, required: false },
    pausedAt: { type: Date, required: false },
    pausedTotalMs: { type: Number, required: true, default: 0, min: 0 },
    breachedAt: { type: Date, required: false },
    completedAt: { type: Date, required: false },
  },
  { _id: false },
);

const resolutionReviewSchema = new Schema<ResolutionReview>(
  {
    reviewedAt: { type: Date, required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    outcome: { type: String, required: true, enum: RESOLUTION_REVIEW_OUTCOMES },
    rejectionReason: { type: String, required: false, trim: true, maxlength: 2000 },
  },
  { _id: false },
);

const serviceRatingSchema = new Schema<ServiceRating>(
  {
    /* Whole stars, one to five: half stars would only invite arguments about
       what a 3.5 means. */
    stars: { type: Number, required: true, min: 1, max: 5, validate: { validator: Number.isInteger, message: 'A rating is a whole number of stars' } },
    note: { type: String, required: false, trim: true, maxlength: 1000 },
    serviceCenterId: { type: Schema.Types.ObjectId, ref: 'ServiceCenter', required: true },
    ratedAt: { type: Date, required: true },
    ratedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ratedByName: requiredName(160),
    revisions: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const closureRecordSchema = new Schema<ClosureRecord>(
  {
    closedAt: { type: Date, required: true },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reopenedAt: { type: Date, required: true },
    reopenedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reopenReason: { type: String, required: true, trim: true, maxlength: 2000 },
    rating: { type: serviceRatingSchema, required: false },
  },
  { _id: false },
);

const complaintSchema = new Schema<ComplaintDoc>(
  {
    complaintNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: [/^CMP-\d{4}-\d{6}$/, 'Complaint number must look like CMP-2026-000001'],
    },

    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productModelId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductModel',
      required: true,
    },
    serialNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 80,
    },
    purchaseDate: { type: Date, required: false },

    category: requiredName(120),
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    priority: { type: String, required: true, enum: PRIORITIES, default: 'NORMAL' },

    warrantyStatus: { type: String, required: true, enum: WARRANTY_STATUSES },
    warrantyNotes: optionalText(1000),

    serviceAddress: { type: serviceAddressSchema, required: true },
    customerSnapshot: { type: customerSnapshotSchema, required: true },
    productSnapshot: { type: productSnapshotSchema, required: true },

    /* `refActive` on both: new work may not be routed to a deactivated centre
       or technician (sections 8, 9). Existing rows are never touched, so
       deactivating something leaves closed complaints intact (section 22). */
    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: false,
      refActive: true,
    },
    technicianId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      refActive: true,
    },

    status: {
      type: String,
      required: true,
      enum: COMPLAINT_STATUSES,
      default: 'NEW',
    },

    /**
     * Never returned unless a query explicitly selects it. The Happy Code is
     * the gate on closure (section 22), so it must not ride along in a list
     * response, a report export or a log line.
     */
    happyCodeSecret: { type: happyCodeSecretSchema, required: false, select: false },
    happyCode: { type: happyCodeMetaSchema, required: true },
    sla: { type: slaSchema, required: true },

    lastResolutionVisitId: {
      type: Schema.Types.ObjectId,
      ref: 'Visit',
      required: false,
    },
    lastResolutionSubmittedAt: { type: Date, required: false },
    resolutionReview: { type: resolutionReviewSchema, required: false },
    serviceRating: { type: serviceRatingSchema, required: false },

    closedAt: { type: Date, required: false },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    cancelledAt: { type: Date, required: false },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    cancellationReason: { type: String, required: false, trim: true, maxlength: 2000 },

    reopenCount: { type: Number, required: true, default: 0, min: 0 },
    closureHistory: { type: [closureRecordSchema], required: true, default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  baseSchemaOptions,
);

/* ---- Indexes (spec section 19, "Important indexes") -------------------- */

complaintSchema.index({ complaintNumber: 1 }, { unique: true });

/* Section 13: searching a serial number must surface its full history. */
complaintSchema.index({ serialNumber: 1, createdAt: -1 });

/* Section 13: the same, by customer mobile. Uses the snapshot so a later
   correction to the customer record cannot hide past complaints. */
complaintSchema.index({ 'customerSnapshot.mobile': 1, createdAt: -1 });
complaintSchema.index({ customerId: 1, createdAt: -1 });

/* The centre portal's queue, scoped and sorted (section 9). */
complaintSchema.index({ serviceCenterId: 1, status: 1, createdAt: -1 });

/* A technician's job list (section 10) — only their own, newest first. */
complaintSchema.index({ technicianId: 1, status: 1, createdAt: -1 });

/* Admin dashboard counts by status and priority (section 5.1). */
complaintSchema.index({ status: 1, priority: 1, createdAt: -1 });

/* SLA dashboards and breach sweeps (section 14). */
complaintSchema.index({ 'sla.state': 1, 'sla.resolutionDueAt': 1 });

/* Reporting breakdowns (section 16). */
complaintSchema.index({ 'serviceAddress.cityId': 1, createdAt: -1 });
complaintSchema.index({ productModelId: 1, createdAt: -1 });
complaintSchema.index({ warrantyStatus: 1, createdAt: -1 });
complaintSchema.index({ createdAt: -1 });

export const Complaint = defineModel<ComplaintDoc>('Complaint', complaintSchema);
