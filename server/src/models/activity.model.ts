/**
 * ComplaintActivity and AuditLog (spec sections 17, 18).
 *
 * These are two different things and the spec lists both as entities:
 *
 *  - **ComplaintActivity** is the user-facing timeline on a complaint detail
 *    page. Section 17 names the exact actions it must carry, and the closed
 *    `ActivityAction` set in `enums.ts` mirrors that list — so forgetting to
 *    record one is a compile error rather than a silent gap.
 *
 *  - **AuditLog** is the system-wide record: master-data edits, logins, Happy
 *    Code views. Things that have nothing to do with one complaint's story but
 *    still need answering for later.
 *
 * Both are **append-only**. Nothing in the application updates or deletes a
 * row here, which is what rule 17 ("no hard delete for operational records")
 * and rule 15 ("old complaints must never be overwritten") actually require.
 * An audit trail that can be edited is not an audit trail.
 *
 * Old and new values are stored as strings, serialized by the audit service
 * rather than as `Mixed`. A timeline entry exists to be *read* — "Priority:
 * NORMAL to HIGH" — and `Mixed` would trade that legibility, plus schema
 * enforcement, for a fidelity nothing here needs.
 */
import { Schema, type Types } from 'mongoose';
import { baseSchemaOptions, defineModel, optionalText } from './common/base.js';
import { ACTIVITY_ACTIONS, ROLES, type ActivityAction, type Role } from './enums.js';

/* ---- Complaint timeline ------------------------------------------------ */

export interface ComplaintActivityDoc {
  _id: Types.ObjectId;
  complaintId: Types.ObjectId;
  action: ActivityAction;

  actorId: Types.ObjectId;
  actorRole: Role;
  /**
   * The actor's name as it was at the time.
   *
   * Snapshotted for the same reason the complaint snapshots its customer: a
   * technician who leaves and is renamed, or deactivated, must not silently
   * rewrite who did the work two years ago.
   */
  actorName: string;

  /** Optional link to the visit this entry belongs to. */
  visitId?: Types.ObjectId;

  fieldChanged?: string;
  oldValue?: string;
  newValue?: string;

  /** Free-text reason. Mandatory for rejections and revisits (section 22). */
  note?: string;

  createdAt: Date;
  updatedAt: Date;
}

const complaintActivitySchema = new Schema<ComplaintActivityDoc>(
  {
    complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    action: { type: String, required: true, enum: ACTIVITY_ACTIONS },

    /* Deliberately not `refActive`: the timeline must still render correctly
       once the actor has been deactivated. */
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, required: true, enum: ROLES },
    actorName: { type: String, required: true, trim: true, maxlength: 160 },

    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', required: false },

    fieldChanged: { type: String, required: false, trim: true, maxlength: 120 },
    oldValue: { type: String, required: false, trim: true, maxlength: 2000 },
    newValue: { type: String, required: false, trim: true, maxlength: 2000 },
    note: optionalText(2000),
  },
  baseSchemaOptions,
);

/**
 * The timeline query: one complaint's entries, oldest first.
 *
 * A separate collection rather than an array on the complaint, because a
 * reopened complaint's timeline grows without bound and MongoDB documents cap
 * at 16MB. Paginating a subdocument array is also far more awkward than
 * paginating a collection.
 */
complaintActivitySchema.index({ complaintId: 1, createdAt: 1 });
complaintActivitySchema.index({ actorId: 1, createdAt: -1 });
complaintActivitySchema.index({ action: 1, createdAt: -1 });
/* Admin's activity feed across every complaint, newest first. `_id` breaks
   ties, so an action and the status change recorded in the same millisecond
   keep one order from page to page. */
complaintActivitySchema.index({ createdAt: -1, _id: -1 });

export const ComplaintActivity = defineModel<ComplaintActivityDoc>(
  'ComplaintActivity',
  complaintActivitySchema,
);

/* ---- System-wide audit log --------------------------------------------- */

/** One changed field within an audited action. */
export interface AuditChange {
  field: string;
  oldValue?: string;
  newValue?: string;
}

export interface AuditLogDoc {
  _id: Types.ObjectId;

  /** Model name the action applied to, e.g. `ServiceCenter`. */
  entityType: string;
  entityId?: Types.ObjectId;

  /**
   * Free-form action verb, e.g. `SERVICE_CENTER_DEACTIVATED`, `LOGIN_FAILED`.
   *
   * Unlike the timeline this is not a closed set: the audit log has to be able
   * to record something new without a schema change, and an unrecordable event
   * is worse than an unenumerated one.
   */
  action: string;

  actorId?: Types.ObjectId;
  actorRole?: Role;
  actorName?: string;

  changes: AuditChange[];
  note?: string;

  /** Request context, for tracing an action back to its source. */
  ipAddress?: string;
  userAgent?: string;

  createdAt: Date;
  updatedAt: Date;
}

const auditChangeSchema = new Schema<AuditChange>(
  {
    field: { type: String, required: true, trim: true, maxlength: 120 },
    oldValue: { type: String, required: false, trim: true, maxlength: 2000 },
    newValue: { type: String, required: false, trim: true, maxlength: 2000 },
  },
  { _id: false },
);

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    entityType: { type: String, required: true, trim: true, maxlength: 60 },
    entityId: { type: Schema.Types.ObjectId, required: false },
    action: { type: String, required: true, trim: true, maxlength: 80 },

    /**
     * Actor is optional: a failed login has no authenticated user yet, and
     * that is precisely an event worth recording.
     */
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    actorRole: { type: String, required: false, enum: ROLES },
    actorName: { type: String, required: false, trim: true, maxlength: 160 },

    changes: { type: [auditChangeSchema], required: true, default: [] },
    note: optionalText(2000),

    ipAddress: { type: String, required: false, trim: true, maxlength: 64 },
    userAgent: { type: String, required: false, trim: true, maxlength: 400 },
  },
  baseSchemaOptions,
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog = defineModel<AuditLogDoc>('AuditLog', auditLogSchema);
