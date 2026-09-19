/**
 * Attachment HTTP layer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { ATTACHMENT_KINDS } from '../../models/enums.js';
import * as attachments from './attachments.service.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const uploadSchema = z.object({
  kind: z.enum(ATTACHMENT_KINDS).default('OTHER'),
  caption: z.string().trim().max(500).optional(),
});

export const postAttachment = handler(async (req, res) => {
  const auth = requireAuth(req);

  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    throw badRequest('No file was uploaded', [
      { field: 'file', message: 'Attach a file to upload' },
    ]);
  }

  /* Multipart fields arrive as strings, so the same schema parses them. */
  const meta = uploadSchema.parse(req.body ?? {});

  const result = await attachments.uploadAttachment(
    {
      complaintId: String(req.params['id']),
      kind: meta.kind,
      caption: meta.caption,
      file: { buffer: file.buffer, originalname: file.originalname },
    },
    auth,
  );

  res.status(result.duplicate ? 200 : 201).json({
    attachment: result.attachment,
    ...(result.duplicate
      ? {
          /* A retry on a bad signal is normal in the field; say what happened
             rather than silently creating a second copy. */
          note: 'This file was already attached to this complaint. The existing one is returned.',
        }
      : {}),
  });
});

export const getAttachments = handler(async (req, res) => {
  const auth = requireAuth(req);
  const items = await attachments.listAttachments(String(req.params['id']), auth);
  res.status(200).json({ items, total: items.length });
});

/**
 * Streams the file.
 *
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
 * together stop the browser rendering an upload inline in our own origin —
 * which is what turns a crafted file into stored XSS against whoever opens it.
 */
export const getAttachmentFile = handler(async (req, res) => {
  const auth = requireAuth(req);
  const { stream, attachment } = await attachments.downloadAttachment(
    String(req.params['attachmentId']),
    auth,
  );

  /* Quote and strip the filename: it came from an uploader and must not be
     able to inject header syntax. */
  const safeName = attachment.originalFilename.replace(/["\\\r\n]/g, '_');

  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Length', String(attachment.sizeBytes));
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  /* Private: these are customer premises photos, never cacheable by a proxy. */
  res.setHeader('Cache-Control', 'private, no-store');

  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });

  stream.pipe(res);
});
