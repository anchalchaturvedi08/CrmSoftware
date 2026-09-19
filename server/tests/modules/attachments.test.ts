/**
 * Attachment tests (spec section 10 step 6, section 19).
 *
 * The ones that matter are the refusals: a file whose contents do not match
 * what it claims to be, and a caller reading someone else's photos. Section 19
 * asks for type validation and access control, and both are easy to implement
 * in a way that looks right and is not.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { Attachment, ComplaintActivity } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();

/**
 * The storage root comes from the loaded config, not from an assignment here.
 *
 * `config/env.ts` parses the environment on first import, which happens before
 * any test body runs — so setting `process.env.STORAGE_LOCAL_PATH` in this
 * file would arrive too late and uploads would land in `server/storage/`.
 * It is set in `vitest.config.ts` instead; this just reads where that points.
 */
const storageRoot = config.STORAGE_LOCAL_PATH;

afterAll(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** A minimal but genuine JPEG: SOI marker, then padding. */
function jpegBytes(marker = 1): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(64, marker),
  ]);
}

/** A real PNG signature. */
function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);
}

async function token(mobile: string): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
  owner: string;
  tech: string;
  complaintId: string;
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  const admin = await token('9800000001');
  const owner = await token('9800000002');
  const tech = await token('9800000003');

  const created = await request(app)
    .post('/complaints')
    .set('Authorization', `Bearer ${admin}`)
    .send({
      customerId: String(world.customer._id),
      productId: String(world.product._id),
      productModelId: String(world.productModel._id),
      serialNumber: 'SN-ATT-1',
      category: 'Not cooling',
      description: 'x',
      priority: 'NORMAL',
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: String(world.center._id),
    });

  const complaintId = created.body.complaint.id as string;

  await request(app)
    .post(`/complaints/${complaintId}/assign-technician`)
    .set('Authorization', `Bearer ${owner}`)
    .send({ technicianId: String(world.technician._id) });
  await request(app)
    .post(`/complaints/${complaintId}/visits`)
    .set('Authorization', `Bearer ${owner}`)
    .send({ scheduledAt: tomorrow() });
  await request(app)
    .post(`/complaints/${complaintId}/start-visit`)
    .set('Authorization', `Bearer ${tech}`)
    .send({});

  c = { world, admin, owner, tech, complaintId };
});

describe('upload', () => {
  it('accepts a before photo from the assigned technician', async () => {
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .field('caption', 'Cooler as found')
      .attach('file', jpegBytes(), 'before.jpg');

    expect(res.status).toBe(201);
    expect(res.body.attachment.kind).toBe('BEFORE_PHOTO');
    expect(res.body.attachment.mimeType).toBe('image/jpeg');
    expect(res.body.attachment.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links the attachment to the visit in progress', async () => {
    await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'AFTER_PHOTO')
      .attach('file', pngBytes(), 'after.png');

    /* The photo belongs with the trip it was taken on, not floating on the
       complaint — a revisit produces its own set. */
    const stored = await Attachment.findOne({ complaintId: c.complaintId }).lean().exec();
    expect(stored!.visitId).toBeTruthy();
  });

  it('generates the storage key instead of deriving it from the filename', async () => {
    await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'OTHER')
      .attach('file', jpegBytes(), 'my holiday photo (1).jpg');

    const stored = await Attachment.findOne({ complaintId: c.complaintId }).lean().exec();

    /**
     * The key is a UUID under the complaint's own folder, with the extension
     * decided by the *detected* type — not by anything the uploader sent.
     * The original name is kept as metadata only, so it can be shown without
     * ever influencing where bytes land. Traversal is covered directly
     * against the driver in `tests/core/storage.test.ts`, since multipart
     * encoders strip path components before a request is even sent.
     */
    expect(stored!.originalFilename).toBe('my holiday photo (1).jpg');
    expect(stored!.storageKey).toMatch(
      /^complaints\/[0-9a-f]{24}\/[0-9a-f-]{36}\.jpg$/,
    );
  });

  it('rejects a file whose contents do not match its claimed type', async () => {
    /**
     * The check section 19 is really asking for. A client can put any bytes
     * behind `image/jpeg`; only the leading bytes prove what it is.
     */
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'OTHER')
      .attach('file', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'innocent.jpg', {
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not accepted|Unsupported/i);
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it('rejects a type that is not on the list', async () => {
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .attach('file', Buffer.from('%PDF-1.4'), 'doc.pdf', {
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(400);
  });

  it('rejects an empty upload', async () => {
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .attach('file', Buffer.alloc(0), 'empty.jpg', { contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
  });

  it('requires a file', async () => {
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO');

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'file' })]),
    );
  });

  it('refuses a photo over the size limit, naming the limit', async () => {
    /**
     * Multer enforces the limit while the upload is still arriving. Its error
     * used to reach the phone as a 500, "Something went wrong on our side" —
     * which tells a technician to wait for a fix, not to take a smaller photo.
     */
    const tooLarge = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(config.STORAGE_MAX_FILE_MB * 1024 * 1024, 1),
    ]);

    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('file', tooLarge, 'before.jpg');

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBe(
      `This photo is too large. The limit is ${config.STORAGE_MAX_FILE_MB} MB.`,
    );
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'file' })]),
    );
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it("reports other upload form problems as the caller's to fix, not a server fault", async () => {
    /* Any MulterError, not just the size limit — here a file sent under the
       wrong field name. */
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('photo', jpegBytes(), 'before.jpg');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/one file/i);
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it('treats a re-upload of identical bytes as the same attachment', async () => {
    /* Field apps retry on a bad signal; tapping upload twice should not
       produce two copies of one photo. */
    const first = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('file', jpegBytes(9), 'photo.jpg');

    const second = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('file', jpegBytes(9), 'photo.jpg');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.attachment.id).toBe(first.body.attachment.id);
    expect(await Attachment.countDocuments({ complaintId: c.complaintId })).toBe(1);
  });

  it('files the same bytes on a revisit under the new visit, not the old record', async () => {
    const first = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('file', jpegBytes(12), 'before.jpg');

    /* The Owner books another trip, which closes the first, and the
       technician starts it. */
    await request(app)
      .post(`/complaints/${c.complaintId}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow(), reason: 'Customer asked for another day' });
    await request(app)
      .post(`/complaints/${c.complaintId}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({});

    const upload = () =>
      request(app)
        .post(`/complaints/${c.complaintId}/attachments`)
        .set('Authorization', `Bearer ${c.tech}`)
        .field('kind', 'BEFORE_PHOTO')
        .attach('file', jpegBytes(12), 'before.jpg');

    /**
     * The technician app counts only the current visit's photos. Answering
     * this with visit 1's record would say "already uploaded" while the
     * revisit's photo slot stayed empty.
     */
    const onRevisit = await upload();
    expect(first.status).toBe(201);
    expect(onRevisit.status).toBe(201);
    expect(onRevisit.body.attachment.visitId).toBeTruthy();
    expect(onRevisit.body.attachment.visitId).not.toBe(first.body.attachment.visitId);

    /* A retry within the revisit is still recognised as the same upload. */
    const retry = await upload();
    expect(retry.status).toBe(200);
    expect(retry.body.attachment.id).toBe(onRevisit.body.attachment.id);
    expect(await Attachment.countDocuments({ complaintId: c.complaintId })).toBe(2);
  });

  it('refuses a technician attaching to a job that is not theirs', async () => {
    const other = await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000044',
      serviceCenterId: c.world.center._id,
    });
    expect(other).toBeTruthy();

    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${await token('9800000044')}`)
      .attach('file', jpegBytes(), 'sneaky.jpg');

    /* Scoped out entirely — 404 rather than 403, so a technician cannot probe
       for colleagues' jobs. */
    expect(res.status).toBe(404);
  });

  it('refuses an owner uploading', async () => {
    /* Section 10 puts photographs in the technician's flow; an Owner reviews
       rather than documents. */
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.owner}`)
      .attach('file', jpegBytes(), 'owner.jpg');

    expect(res.status).toBe(403);
  });

  it('records the upload on the complaint timeline', async () => {
    await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('file', jpegBytes(), 'before.jpg');

    const actions = (
      await ComplaintActivity.find({ complaintId: c.complaintId }).lean().exec()
    ).map((e) => e.action);

    /* Section 17 lists "Attachment added" as a required timeline event. */
    expect(actions).toContain('ATTACHMENT_ADDED');
  });
});

describe('access control (section 19)', () => {
  async function uploadOne(): Promise<string> {
    const res = await request(app)
      .post(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`)
      .field('kind', 'BEFORE_PHOTO')
      .attach('file', jpegBytes(3), 'before.jpg');
    return res.body.attachment.id as string;
  }

  it('streams the file to an authorised caller with safe headers', async () => {
    const id = await uploadOne();

    const res = await request(app)
      .get(`/attachments/${id}/file`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    /* Forced download plus nosniff: without both, a crafted upload rendered
       inline becomes stored XSS against whoever opens it. */
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('requires authentication', async () => {
    const id = await uploadOne();

    /* Section 19: "Not be publicly accessible by default." */
    const res = await request(app).get(`/attachments/${id}/file`);
    expect(res.status).toBe(401);
  });

  it('refuses a caller from another service center', async () => {
    const id = await uploadOne();

    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-40',
    );
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000045',
      serviceCenterId: otherCentre._id,
    });

    const res = await request(app)
      .get(`/attachments/${id}/file`)
      .set('Authorization', `Bearer ${await token('9800000045')}`);

    expect(res.status).toBe(404);
  });

  it('lets the owning service center see it', async () => {
    const id = await uploadOne();

    const res = await request(app)
      .get(`/attachments/${id}/file`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(200);
  });

  it('scopes the list so a technician sees only their own uploads', async () => {
    await uploadOne();

    const mine = await request(app)
      .get(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.tech}`);
    expect(mine.body.total).toBe(1);

    const adminView = await request(app)
      .get(`/complaints/${c.complaintId}/attachments`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(adminView.body.total).toBe(1);
  });

  it('reports a missing file honestly rather than streaming nothing', async () => {
    const id = await uploadOne();

    /* Simulate bytes lost to a restore gap or a botched deploy. */
    const stored = await Attachment.findById(id).lean().exec();
    await fs.rm(path.join(storageRoot, stored!.storageKey), { force: true });

    const res = await request(app)
      .get(`/attachments/${id}/file`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/missing|re-upload/i);
  });
});
