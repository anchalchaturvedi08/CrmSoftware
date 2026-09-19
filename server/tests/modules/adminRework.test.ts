/**
 * Admin sends the work back (spec section 3.1; Workflow F).
 *
 * Admin calls the customer to confirm the repair. When the customer says the
 * cooler is still not right, section 3.1 lets Admin require rework — and the
 * status machine has always allowed ADMIN_CONFIRMATION -> REVISIT_REQUIRED —
 * but no endpoint performed it. The only ways out were closing a complaint the
 * customer had just said was not fixed, or cancelling it.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint } from '../../src/models/index.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();

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
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  c = {
    world,
    admin: await token('9800000001'),
    owner: await token('9800000002'),
    tech: await token('9800000003'),
  };
});

/** A complaint worked, submitted and accepted: waiting on Admin's call. */
async function awaitingConfirmation(serial: string): Promise<string> {
  const created = await request(app)
    .post('/complaints')
    .set('Authorization', `Bearer ${c.admin}`)
    .send({
      customerId: String(c.world.customer._id),
      productId: String(c.world.product._id),
      productModelId: String(c.world.productModel._id),
      serialNumber: serial,
      category: 'Not cooling',
      description: 'Warm air.',
      priority: 'NORMAL',
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: String(c.world.center._id),
    });
  const id = created.body.complaint.id as string;

  await request(app)
    .post(`/complaints/${id}/assign-technician`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ technicianId: String(c.world.technician._id) });
  await request(app)
    .post(`/complaints/${id}/visits`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ scheduledAt: tomorrow() });
  await request(app)
    .post(`/complaints/${id}/start-visit`)
    .set('Authorization', `Bearer ${c.tech}`)
    .send({ customerAvailability: 'CUSTOMER_AVAILABLE' });
  await request(app)
    .post(`/complaints/${id}/resolution`)
    .set('Authorization', `Bearer ${c.tech}`)
    .send({
      diagnosis: { problemFound: 'Pump seized' },
      workPerformed: { details: 'Replaced pump' },
      resolution: { result: 'Cooling restored' },
    });
  await request(app)
    .post(`/complaints/${id}/review-resolution`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ outcome: 'ACCEPTED' });

  return id;
}

const rework = (id: string, auth: string, body: Record<string, unknown>) =>
  request(app).post(`/complaints/${id}/require-rework`).set('Authorization', `Bearer ${auth}`).send(body);

describe('Admin requiring rework', () => {
  it('sends the complaint back for a revisit, with the reason on record', async () => {
    const id = await awaitingConfirmation('SN-RW-1');

    const res = await rework(id, c.admin, { reason: 'Customer says it still blows warm air' });

    expect(res.status).toBe(200);
    expect(res.body.complaint.status).toBe('REVISIT_REQUIRED');

    const after = (await Complaint.findById(id).lean().exec())!;
    expect(after.resolutionReview?.outcome).toBe('REVISIT_REQUIRED');
    expect(after.resolutionReview?.rejectionReason).toMatch(/warm air/);

    const timeline = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.admin}`);
    const revisit = timeline.body.items.find((e: { action: string }) => e.action === 'REVISIT_REQUIRED');
    expect(revisit.note).toMatch(/warm air/);
  });

  it('lets the service center book the revisit afterwards', async () => {
    const id = await awaitingConfirmation('SN-RW-2');
    await rework(id, c.admin, { reason: 'Noise from the fan' });

    const booked = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow() });

    expect(booked.status).toBe(201);
    expect(booked.body.complaint.status).toBe('VISIT_SCHEDULED');
  });

  it('requires a reason', async () => {
    const id = await awaitingConfirmation('SN-RW-3');

    const res = await rework(id, c.admin, {});

    expect(res.status).toBe(400);
    expect((await Complaint.findById(id).lean().exec())!.status).toBe('ADMIN_CONFIRMATION');
  });

  it('is Admin only', async () => {
    const id = await awaitingConfirmation('SN-RW-4');

    const res = await rework(id, c.owner, { reason: 'Owner trying to reopen review' });

    expect(res.status).toBe(403);
  });

  it('only applies while Admin is confirming with the customer', async () => {
    const id = await awaitingConfirmation('SN-RW-5');
    await rework(id, c.admin, { reason: 'First send-back' });

    /* Now REVISIT_REQUIRED: sending it back again is not a move that exists. */
    const again = await rework(id, c.admin, { reason: 'Second send-back' });

    expect(again.status).toBe(409);
  });

  it('asks for the customer to confirm again after the rework', async () => {
    const id = await awaitingConfirmation('SN-RW-6');

    /* The code was verified, then the customer rang back unhappy before the
       complaint was closed. Confirmation of the old work must not carry over
       to the new work. */
    const whatsapp = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);
    await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ code: whatsapp.body.happyCode });
    expect((await Complaint.findById(id).lean().exec())!.happyCode.verifiedAt).toBeTruthy();

    await rework(id, c.admin, { reason: 'Customer rang back: warm air again' });

    const after = (await Complaint.findById(id).lean().exec())!;
    expect(after.happyCode.verifiedAt).toBeUndefined();
  });
});
