/**
 * Parts: the master, per-centre stock, technician requests and actual usage
 * (spec section 11).
 *
 * The rule that shapes all four models is this one, from section 11: *"Stock
 * is decremented only when usage is finalized according to backend
 * transaction rules."* So a `PartUsage` row records what the technician says
 * they used, and only finalizing it moves stock — inside a transaction, which
 * is the whole reason the database runs as a replica set.
 *
 * Requests and usage are separate on purpose. A technician can request three
 * of something, be issued two, and fit one. Collapsing those into a single
 * quantity would make section 16's "requested vs unavailable vs consumed"
 * reports impossible to produce honestly.
 */
import { Schema, type Types } from 'mongoose';
import {
  activeFlagField,
  baseSchemaOptions,
  defineModel,
  optionalText,
  requiredName,
} from './common/base.js';
import { PART_REQUEST_STATUSES, type PartRequestStatus } from './enums.js';

/* ---- Part master ------------------------------------------------------- */

export const PART_UNITS = ['PIECE', 'SET', 'METER', 'LITRE', 'KILOGRAM'] as const;
export type PartUnit = (typeof PART_UNITS)[number];

export interface PartDoc {
  _id: Types.ObjectId;
  name: string;
  code: string;
  category?: string;
  unit: PartUnit;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const partSchema = new Schema<PartDoc>(
  {
    name: requiredName(180),
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
      match: [/^[A-Z0-9_-]+$/, 'Part code may use letters, digits, hyphen and underscore'],
    },
    category: { type: String, required: false, trim: true, maxlength: 120 },
    unit: { type: String, required: true, enum: PART_UNITS, default: 'PIECE' },
    ...activeFlagField,
  },
  baseSchemaOptions,
);

partSchema.index({ code: 1 }, { unique: true });
partSchema.index({ isActive: 1, name: 1 });

export const Part = defineModel<PartDoc>('Part', partSchema);

/* ---- Stock, per service center ----------------------------------------- */

export interface PartStockDoc {
  _id: Types.ObjectId;
  serviceCenterId: Types.ObjectId;
  partId: Types.ObjectId;
  availableQuantity: number;
  minimumStock: number;
  lastRestockedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const partStockSchema = new Schema<PartStockDoc>(
  {
    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    partId: { type: Schema.Types.ObjectId, ref: 'Part', required: true },

    /**
     * Cannot go negative. This is the backstop behind the transactional
     * decrement: even if a concurrency bug slipped through, the write fails
     * rather than quietly recording that a centre holds minus four compressors.
     */
    availableQuantity: { type: Number, required: true, default: 0, min: 0 },
    minimumStock: { type: Number, required: true, default: 0, min: 0 },
    lastRestockedAt: { type: Date, required: false },
  },
  baseSchemaOptions,
);

/**
 * Low-stock status is derived, never stored.
 *
 * Section 11 lists it as something to track, but storing it would create a
 * second source of truth that drifts the moment a quantity changes without the
 * flag being updated. The low-stock *report* (section 16) uses an aggregation
 * comparing the two fields, which is fine at the scale of parts-per-centre.
 */
partStockSchema
  .virtual('isLowStock')
  .get(function (this: PartStockDoc): boolean {
    return this.availableQuantity <= this.minimumStock;
  });

/* One stock row per part per centre — section 11 keeps stock per centre. */
partStockSchema.index({ serviceCenterId: 1, partId: 1 }, { unique: true });
partStockSchema.index({ partId: 1 });

export const PartStock = defineModel<PartStockDoc>('PartStock', partStockSchema);

/* ---- Technician part request ------------------------------------------- */

export interface PartRequestDoc {
  _id: Types.ObjectId;
  complaintId: Types.ObjectId;
  visitId?: Types.ObjectId;
  serviceCenterId: Types.ObjectId;
  partId: Types.ObjectId;
  requestedBy: Types.ObjectId;

  quantityRequested: number;
  reason?: string;

  status: PartRequestStatus;

  /** Quantity actually handed over, which may be less than requested. */
  quantityIssued: number;

  decidedBy?: Types.ObjectId;
  decidedAt?: Date;
  decisionRemarks?: string;

  createdAt: Date;
  updatedAt: Date;
}

const partRequestSchema = new Schema<PartRequestDoc>(
  {
    complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', required: false },
    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    partId: { type: Schema.Types.ObjectId, ref: 'Part', required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    quantityRequested: { type: Number, required: true, min: 1 },
    reason: optionalText(1000),

    status: {
      type: String,
      required: true,
      enum: PART_REQUEST_STATUSES,
      default: 'REQUESTED',
    },
    quantityIssued: { type: Number, required: true, default: 0, min: 0 },

    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    decidedAt: { type: Date, required: false },
    decisionRemarks: optionalText(1000),
  },
  baseSchemaOptions,
);

/* The centre's pending-request queue (section 9 dashboard). */
partRequestSchema.index({ serviceCenterId: 1, status: 1, createdAt: -1 });
partRequestSchema.index({ complaintId: 1, createdAt: -1 });
/* Section 16 reports requested and unavailable parts. */
partRequestSchema.index({ partId: 1, status: 1 });
partRequestSchema.index({ requestedBy: 1, createdAt: -1 });

export const PartRequest = defineModel<PartRequestDoc>(
  'PartRequest',
  partRequestSchema,
);

/* ---- Actual usage ------------------------------------------------------ */

export interface PartUsageDoc {
  _id: Types.ObjectId;
  complaintId: Types.ObjectId;
  visitId: Types.ObjectId;
  serviceCenterId: Types.ObjectId;
  partId: Types.ObjectId;
  recordedBy: Types.ObjectId;

  quantity: number;
  remarks?: string;

  /**
   * Stock moves only when this is set.
   *
   * Until then the row is the technician's claim about what they fitted, not
   * an inventory movement. Finalization and the matching `$inc` on
   * `PartStock.availableQuantity` happen in one transaction, so the two can
   * never disagree — which is exactly what section 11 requires and what a
   * standalone MongoDB could not have delivered.
   */
  finalizedAt?: Date;
  finalizedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const partUsageSchema = new Schema<PartUsageDoc>(
  {
    complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', required: true },
    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    partId: { type: Schema.Types.ObjectId, ref: 'Part', required: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    quantity: { type: Number, required: true, min: 1 },
    remarks: optionalText(1000),

    finalizedAt: { type: Date, required: false },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  baseSchemaOptions,
);

partUsageSchema.index({ complaintId: 1, createdAt: -1 });
partUsageSchema.index({ visitId: 1 });
/* Section 16: most-used parts, and consumption per centre. */
partUsageSchema.index({ partId: 1, finalizedAt: -1 });
partUsageSchema.index({ serviceCenterId: 1, finalizedAt: -1 });
/* Section 16: parts used per technician. */
partUsageSchema.index({ recordedBy: 1, finalizedAt: -1 });

export const PartUsage = defineModel<PartUsageDoc>('PartUsage', partUsageSchema);
