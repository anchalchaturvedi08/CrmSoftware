/**
 * Attachment routes (spec section 10 step 6, section 19).
 *
 * Uploads use multer's **memory** storage rather than its disk storage. Two
 * reasons, both about validating before anything is persisted:
 *
 *  - the file type is decided from its leading bytes, and a disk write that
 *    happens first would leave rejected files scattered in the storage root;
 *  - the checksum is computed from the same buffer, so a duplicate retry is
 *    recognised without a file ever being written twice.
 *
 * Files are capped at `STORAGE_MAX_FILE_MB` (10MB by default), which is
 * comfortable for a phone photo and small enough that buffering is fine.
 *
 * ## Upload refusals are described, not reported as our fault
 *
 * Multer signals its limits with its own `MulterError`, which the app's error
 * handler does not know — so a photo over the size cap came back as a 500,
 * "Something went wrong on our side". A technician told that waits for a fix
 * that is never coming, instead of taking a smaller photo. `acceptUpload`
 * translates multer's refusals here, beside the limits that cause them: too
 * large is a 413 naming the limit, anything else about the form a plain 400.
 */
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { maxFileBytes } from '../../core/storage.js';
import { AppError, badRequest } from '../../http/errors.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole, requirePasswordChanged } from '../../middleware/authorize.js';
import * as controller from './attachments.controller.js';
import { fileTooLarge } from './attachments.service.js';

/**
 * The type each request's file claimed to be, so a refusal can say "photo"
 * rather than "file". Weak, so an entry goes with its request.
 */
const declaredTypes = new WeakMap<object, string>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileBytes(),
    /* One file per request, and a hard cap on non-file fields so a multipart
       body cannot be used to exhaust memory with metadata. */
    files: 1,
    fields: 10,
  },
  fileFilter: (req, file, done) => {
    declaredTypes.set(req, file.mimetype);

    /* A cheap first pass on the declared type. The authoritative check is the
       magic-byte inspection in `detectFileType` — this only avoids buffering
       something obviously wrong. */
    if (/^(image\/(jpeg|png|webp)|video\/mp4)$/.test(file.mimetype)) {
      done(null, true);
      return;
    }
    done(badRequest('Upload a JPEG, PNG or WEBP image, or an MP4 video.'));
  },
});

/** Plain words for multer's other refusals. None of them happen from the apps. */
const FORM_PROBLEMS: Partial<Record<multer.ErrorCode, string>> = {
  LIMIT_FILE_COUNT: 'Upload one file at a time.',
  LIMIT_UNEXPECTED_FILE: 'Upload one file, sent in the "file" field.',
};

function describeUploadFailure(err: unknown, req: Request): unknown {
  /* Our own refusals (the type check above) already say what is wrong. */
  if (err instanceof AppError) return err;

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const declared = declaredTypes.get(req) ?? '';
      return fileTooLarge(
        declared.startsWith('image/') ? 'photo' : declared.startsWith('video/') ? 'video' : 'file',
      );
    }

    return badRequest(
      FORM_PROBLEMS[err.code] ??
        'The upload could not be read. Send one file, with its kind and an optional caption.',
      [{ field: err.field ?? 'file', message: err.message }],
    );
  }

  /**
   * Anything else thrown while receiving the body is the body itself failing:
   * a connection that dropped mid-upload, or a malformed multipart form. With
   * memory storage nothing of ours runs at this stage, so it is not a server
   * fault — and on mobile data a cut-off upload is routine, not an incident
   * worth an error-level log line each time.
   */
  return badRequest('The upload was cut off or could not be read. Please try again.', [
    { field: 'file', message: 'Incomplete or malformed upload' },
  ]);
}

const acceptUpload: RequestHandler = (req, res, next) => {
  upload.single('file')(req, res, (err?: unknown) => {
    if (err) next(describeUploadFailure(err, req));
    else next();
  });
};

export const attachmentsRouter = Router();

attachmentsRouter.use(authenticate, requirePasswordChanged);

/**
 * Uploading is for whoever does the work or oversees it. Section 10 puts
 * before/after photos in the technician's flow; Admin can attach evidence to
 * any complaint. An Owner reviews rather than documents, so they are not
 * included — say if that should change.
 */
attachmentsRouter.post(
  '/complaints/:id/attachments',
  requireRole('TECHNICIAN', 'ADMIN'),
  acceptUpload,
  controller.postAttachment,
);

attachmentsRouter.get('/complaints/:id/attachments', controller.getAttachments);

/* No static serving: every byte goes through this handler, which re-checks
   the caller's scope against the parent complaint (section 19). */
attachmentsRouter.get('/attachments/:attachmentId/file', controller.getAttachmentFile);
