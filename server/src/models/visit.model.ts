/**
 * Visit.
 *
 * A complaint can have many visits — a revisit after a rejected resolution, a
 * return trip once parts arrive, a second attempt after the customer was out.
 * The work record therefore belongs to the visit, not the complaint: each trip
 * has its own diagnosis, work performed and resolution, and section 22
 * requires all of them to survive.
 *
 * The complaint keeps only a pointer to the most recent submitted resolution.
 * That way "what did the technician do on 3 March" remains answerable after
 * four more visits, which a single set of fields on the complaint could not do.
 *
 * `serviceCenterId` is denormalized here so the centre portal can scope its
 * visit calendar (section 9) with one indexed query rather than a join back
 * through the complaint on every request.
 */
import { Schema, type Types } from 'mongoose';
import { baseSchemaOptions, defineModel, optionalText } from './common/base.js';
import {
  CUSTOMER_AVAILABILITY,
  VISIT_STATUSES,
  type CustomerAvailability,
  type VisitStatus,
} from './enums.js';

/** One reschedule, kept so the calendar's history is auditable (section 17). */
export interface RescheduleRecord {
  previousScheduledAt: Date;
  newScheduledAt: Date;
  rescheduledBy: Types.ObjectId;
  rescheduledAt: Date;
  reason?: string;
}

/** Step 3 of the technician flow. */
export interface Diagnosis {
  problemFound: string;
  notes?: string;
  recordedAt: Date;
}

/** Step 4. */
export interface WorkPerformed {
  details: string;
  remarks?: string;
  recordedAt: Date;
}

/** Step 7, submitted at step 8. */
export interface VisitResolution {
  result: string;
  remarks?: string;
  /**
   * Whatever the technician captured from the customer on the spot. This is
   * not the Happy Code and carries no authority over closure — section 3.3 is
   * explicit that a technician can submit but never close.
   */
  customerFeedback?: string;
  submittedAt: Date;
  submittedBy: Types.ObjectId;
}

export interface VisitDoc {
  _id: Types.ObjectId;
  complaintId: Types.ObjectId;
  /** Denormalized from the complaint for scoped calendar queries. */
  serviceCenterId: Types.ObjectId;
  technicianId: Types.ObjectId;

  /** 1 for the first visit, incremented per complaint. */
  sequence: number;

  scheduledAt: Date;
  scheduledBy: Types.ObjectId;
  rescheduleHistory: RescheduleRecord[];

  status: VisitStatus;

  /** Set when the technician taps Start Visit — a server timestamp, not a client one. */
  startedAt?: Date;
  customerAvailability?: CustomerAvailability;
  availabilityNote?: string;

  diagnosis?: Diagnosis;
  workPerformed?: WorkPerformed;
  resolution?: VisitResolution;

  completedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const rescheduleRecordSchema = new Schema<RescheduleRecord>(
  {
    previousScheduledAt: { type: Date, required: true },
    newScheduledAt: { type: Date, required: true },
    rescheduledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rescheduledAt: { type: Date, required: true },
    reason: { type: String, required: false, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const diagnosisSchema = new Schema<Diagnosis>(
  {
    problemFound: { type: String, required: true, trim: true, maxlength: 2000 },
    notes: optionalText(5000),
    recordedAt: { type: Date, required: true },
  },
  { _id: false },
);

const workPerformedSchema = new Schema<WorkPerformed>(
  {
    details: { type: String, required: true, trim: true, maxlength: 5000 },
    remarks: optionalText(2000),
    recordedAt: { type: Date, required: true },
  },
  { _id: false },
);

const visitResolutionSchema = new Schema<VisitResolution>(
  {
    result: { type: String, required: true, trim: true, maxlength: 2000 },
    remarks: optionalText(2000),
    customerFeedback: optionalText(2000),
    submittedAt: { type: Date, required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

const visitSchema = new Schema<VisitDoc>(
  {
    complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },
    /* A new visit may not be assigned to a deactivated technician; section 9
       requires the Owner to reassign active jobs instead. */
    technicianId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      refActive: true,
    },

    sequence: { type: Number, required: true, min: 1 },

    scheduledAt: { type: Date, required: true },
    scheduledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rescheduleHistory: {
      type: [rescheduleRecordSchema],
      required: true,
      default: [],
    },

    status: {
      type: String,
      required: true,
      enum: VISIT_STATUSES,
      default: 'SCHEDULED',
    },

    startedAt: { type: Date, required: false },
    customerAvailability: {
      type: String,
      required: false,
      enum: CUSTOMER_AVAILABILITY,
    },
    availabilityNote: optionalText(1000),

    diagnosis: { type: diagnosisSchema, required: false },
    workPerformed: { type: workPerformedSchema, required: false },
    resolution: { type: visitResolutionSchema, required: false },

    completedAt: { type: Date, required: false },
    cancelledAt: { type: Date, required: false },
    cancellationReason: { type: String, required: false, trim: true, maxlength: 2000 },
  },
  baseSchemaOptions,
);

/* Visit numbering is per complaint, so the pair must be unique. */
visitSchema.index({ complaintId: 1, sequence: 1 }, { unique: true });

/* The technician's schedule: their visits, by date (section 10). */
visitSchema.index({ technicianId: 1, scheduledAt: -1 });

/* The technician's history, newest finished first. */
visitSchema.index({ technicianId: 1, status: 1, completedAt: -1 });

/* The centre's calendar, and "today's visits" on its dashboard (section 9). */
visitSchema.index({ serviceCenterId: 1, scheduledAt: -1 });
visitSchema.index({ serviceCenterId: 1, status: 1, scheduledAt: -1 });

visitSchema.index({ complaintId: 1, createdAt: -1 });

export const Visit = defineModel<VisitDoc>('Visit', visitSchema);
