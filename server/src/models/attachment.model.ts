/**
 * Attachment — before/after photos and optional video (spec sections 10, 19).
 *
 * Section 19 is specific about these: access-controlled, tied to a complaint
 * or visit, metadata stored, file type and size validated, and **not publicly
 * accessible by default**.
 *
 * So this model stores a storage *key*, never a public URL. Files are served
 * through an authenticated endpoint that re-checks the caller's scope against
 * the parent complaint — a technician may see their own job's photos, a centre
 * its own complaints', Admin everything. Handing out a direct URL would put
 * the file outside that check permanently, since a URL cannot be un-shared.
 *
 * `checksum` is stored so a re-upload of the same file is detectable and so
 * corruption is distinguishable from tampering.
 */
import { Schema, type Types } from 'mongoose';
import { baseSchemaOptions, defineModel, optionalText } from './common/base.js';
import { ATTACHMENT_KINDS, type AttachmentKind } from './enums.js';

export interface AttachmentDoc {
  _id: Types.ObjectId;
  complaintId: Types.ObjectId;
  visitId?: Types.ObjectId;
  /** Denormalized for scope checks without a join. */
  serviceCenterId: Types.ObjectId;

  kind: AttachmentKind;

  /**
   * Path within the storage driver — never a URL.
   *
   * Kept opaque so switching the local driver for S3 is a config change
   * (`STORAGE_DRIVER`) rather than a data migration.
   */
  storageKey: string;

  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 of the file contents. */
  checksum: string;

  uploadedBy: Types.ObjectId;
  caption?: string;

  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<AttachmentDoc>(
  {
    complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', required: false },
    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: true,
    },

    kind: { type: String, required: true, enum: ATTACHMENT_KINDS, default: 'OTHER' },

    storageKey: { type: String, required: true, trim: true, maxlength: 500 },
    originalFilename: { type: String, required: true, trim: true, maxlength: 260 },
    mimeType: { type: String, required: true, trim: true, maxlength: 120 },
    sizeBytes: { type: Number, required: true, min: 1 },
    checksum: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^[0-9a-f]{64}$/, 'Checksum must be a SHA-256 hex digest'],
    },

    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    caption: optionalText(500),
  },
  baseSchemaOptions,
);

/* One row per stored object; a duplicate key would mean two records claiming
   the same file, and deleting one would break the other. */
attachmentSchema.index({ storageKey: 1 }, { unique: true });

attachmentSchema.index({ complaintId: 1, createdAt: -1 });
attachmentSchema.index({ visitId: 1, kind: 1 });
attachmentSchema.index({ serviceCenterId: 1, createdAt: -1 });

export const Attachment = defineModel<AttachmentDoc>('Attachment', attachmentSchema);
