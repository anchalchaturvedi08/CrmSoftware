/**
 * Attachments (spec section 10 step 6, section 19).
 *
 * ## Access control is re-checked on every read
 *
 * Section 19: attachments must have access control and must not be publicly
 * accessible. So a file has no URL of its own — it is served by a handler that
 * loads the attachment, loads its parent complaint **within the caller's
 * scope**, and streams bytes only if both succeed. A technician sees their own
 * uploads, a centre sees its own complaints', Admin sees everything.
 *
 * Handing out a direct link would put the file outside that check permanently,
 * because a URL cannot be un-shared.
 *
 * ## Writes are ordered to avoid orphans in either direction
 *
 * Bytes are written first, then the database row. If the row fails, the bytes
 * are removed. The reverse order would risk a row pointing at a file that was
 * never written — a broken thumbnail with no way to tell whether the photo was
 * lost or never taken.
 */
import { createHash } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { recordActivity, type Actor } from '../../core/audit.js';
import { attachmentScope, complaintScope, withScope } from '../../core/scope.js';
import { detectFileType, maxFileBytes, storage } from '../../core/storage.js';
import { AppError, badRequest, forbidden, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  Attachment,
  Complaint,
  Visit,
  type AttachmentDoc,
  type ComplaintDoc,
} from '../../models/index.js';
import type { AttachmentKind } from '../../models/enums.js';

function actorFor(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

/**
 * The refusal for a file over the size limit, naming the limit.
 *
 * A 413 rather than a generic 400: it is exactly what that status means, and
 * the person holding the phone needs to know the fix is a smaller file, not a
 * retry. Used by the route, where multer enforces the limit while the upload
 * arrives, and by the service's own second check.
 */
export function fileTooLarge(what: 'photo' | 'video' | 'file'): AppError {
  const limitMb = maxFileBytes() / (1024 * 1024);
  return new AppError(413, 'VALIDATION_ERROR', `This ${what} is too large. The limit is ${limitMb} MB.`, {
    issues: [{ field: 'file', message: `Larger than ${limitMb} MB` }],
  });
}

export interface UploadInput {
  complaintId: string;
  kind: AttachmentKind;
  caption?: string | undefined;
  file: { buffer: Buffer; originalname: string };
}

export interface UploadedAttachment {
  attachment: AttachmentDoc;
  /** True when the same bytes were already attached to this complaint. */
  duplicate: boolean;
}

export async function uploadAttachment(
  input: UploadInput,
  auth: AuthContext,
): Promise<UploadedAttachment> {
  const { buffer, originalname } = input.file;

  if (buffer.byteLength === 0) {
    throw badRequest('That file is empty');
  }

  /* Multer enforces this too, but a second check costs nothing and keeps the
     rule visible next to the rest of the validation. */
  if (buffer.byteLength > maxFileBytes()) {
    throw fileTooLarge(
      input.kind === 'VIDEO' ? 'video' : input.kind.endsWith('_PHOTO') ? 'photo' : 'file',
    );
  }

  /* Type is decided by the leading bytes, not by what the client claimed. */
  const detected = detectFileType(buffer);

  const complaint = await Complaint.findOne(
    withScope<ComplaintDoc>(complaintScope(auth), { _id: input.complaintId }),
  ).exec();

  if (!complaint) throw notFound('Complaint not found');
  if (!complaint.serviceCenterId) {
    throw badRequest('This complaint has no service center yet');
  }

  /* A technician attaches to work they are doing, not to a job they merely
     happen to be able to see. */
  if (auth.role === 'TECHNICIAN' && String(complaint.technicianId) !== auth.userId) {
    throw forbidden('This complaint is assigned to a different technician');
  }

  const checksum = createHash('sha256').update(buffer).digest('hex');

  /* Link to the visit in progress, so the photo sits with the trip it
     belongs to rather than floating on the complaint. */
  const visit = await Visit.findOne({
    complaintId: complaint._id,
    status: { $in: ['IN_PROGRESS', 'COMPLETED'] },
  })
    .sort({ sequence: -1 })
    .exec();

  /**
   * Re-uploading identical bytes on the same visit is treated as the same
   * attachment.
   *
   * Field apps retry on a bad signal, and a technician tapping upload twice
   * should not produce two copies of one photo. The existing record is
   * returned instead.
   *
   * Per visit, not per complaint. Each trip keeps its own photos, and the
   * technician app counts only the current visit's — so answering a revisit's
   * upload with a record from an earlier trip would say "already uploaded"
   * while the photo slot stayed empty. The same bytes on a new visit are a new
   * attachment on that visit.
   */
  const existing = await Attachment.findOne({
    complaintId: complaint._id,
    visitId: visit ? visit._id : { $exists: false },
    checksum,
  }).exec();

  if (existing) {
    return { attachment: existing, duplicate: true };
  }

  const stored = await storage().save(buffer, {
    complaintId: String(complaint._id),
    extension: detected.extension,
    mimeType: detected.mimeType,
  });

  try {
    const attachment = await Attachment.create({
      complaintId: complaint._id,
      ...(visit ? { visitId: visit._id } : {}),
      serviceCenterId: complaint.serviceCenterId,
      kind: input.kind,
      storageKey: stored.storageKey,
      /* The uploader's filename is metadata only — it never touches the path. */
      originalFilename: originalname.slice(0, 260),
      mimeType: detected.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum,
      uploadedBy: auth.userId,
      ...(input.caption ? { caption: input.caption } : {}),
    });

    await recordActivity({
      complaintId: String(complaint._id),
      action: 'ATTACHMENT_ADDED',
      actor: actorFor(auth),
      ...(visit ? { visitId: String(visit._id) } : {}),
      note: `${input.kind.replace(/_/g, ' ').toLowerCase()}: ${originalname}`,
    });

    return { attachment, duplicate: false };
  } catch (err) {
    /* Leave no bytes behind for a row that does not exist. */
    await storage().remove(stored.storageKey).catch(() => undefined);
    throw err;
  }
}

/** Attachments on a complaint, within the caller's scope. */
export async function listAttachments(
  complaintId: string,
  auth: AuthContext,
): Promise<AttachmentDoc[]> {
  /* The complaint scope is checked first: a caller who cannot see the
     complaint should get "not found" for it, not an empty attachment list
     that implies it exists. */
  const complaint = await Complaint.findOne(
    withScope<ComplaintDoc>(complaintScope(auth), { _id: complaintId }),
  )
    .select('_id')
    .lean()
    .exec();

  if (!complaint) throw notFound('Complaint not found');

  return Attachment.find(
    withScope<AttachmentDoc>(attachmentScope(auth), { complaintId }),
  )
    .sort({ createdAt: -1 })
    .lean<AttachmentDoc[]>()
    .exec();
}

export interface AttachmentDownload {
  stream: ReadStream;
  attachment: AttachmentDoc;
}

/**
 * Opens an attachment for download, after re-checking access.
 *
 * Both checks matter and neither is redundant: the attachment scope decides
 * whether this caller may see *this file*, and the complaint scope decides
 * whether they may see the job it belongs to. A technician reassigned off a
 * complaint keeps neither.
 */
export async function downloadAttachment(
  id: string,
  auth: AuthContext,
): Promise<AttachmentDownload> {
  const attachment = await Attachment.findOne(
    withScope<AttachmentDoc>(attachmentScope(auth), { _id: id }),
  ).exec();

  if (!attachment) throw notFound('Attachment not found');

  const complaint = await Complaint.findOne(
    withScope<ComplaintDoc>(complaintScope(auth), { _id: attachment.complaintId }),
  )
    .select('_id')
    .lean()
    .exec();

  if (!complaint) throw notFound('Attachment not found');

  try {
    const stream = await storage().read(attachment.storageKey);
    return { stream, attachment };
  } catch {
    /* The row exists but the bytes are gone — a restore gap or a botched
       deploy. Say so plainly rather than returning a broken stream. */
    throw notFound('The stored file is missing. It may need to be re-uploaded.');
  }
}
