/**
 * What the API offers each role next (the `nextActions` on a complaint).
 *
 * Found in the end-to-end walkthrough: after Admin verified the customer's
 * Happy Code, the complaint page's "Close complaint" button stayed disabled.
 * The server built `nextActions` from the stored complaint, which keeps the
 * verification under `happyCode.verifiedAt` — but the status machine reads a
 * flat `happyCodeVerifiedAt`. The field was optional in its type, so nothing
 * complained, and closing was never offered. Closing through the API worked;
 * closing from the screen never could.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

let world: Awaited<ReturnType<typeof seedWorld>>;
let admin: string;
let owner: string;
let tech: string;

beforeEach(async () => {
  world = await seedWorld();
  admin = await token('9800000001');
  owner = await token('9800000002');
  tech = await token('9800000003');
});

const post = (path: string, auth: string, body: Record<string, unknown> = {}) =>
  request(app).post(path).set('Authorization', `Bearer ${auth}`).send(body);

const offered = (body: { nextActions: Array<{ to: string }> }) => body.nextActions.map((action) => action.to);

/** A complaint worked, submitted and accepted: waiting on Admin's call. */
async function awaitingConfirmation(): Promise<string> {
  const created = await post('/complaints', admin, {
    customerId: String(world.customer._id),
    productId: String(world.product._id),
    productModelId: String(world.productModel._id),
    serialNumber: 'SN-NEXT-1',
    category: 'Not cooling',
    description: 'Warm air.',
    priority: 'NORMAL',
    warrantyStatus: 'IN_WARRANTY',
    serviceCenterId: String(world.center._id),
  });
  const id = created.body.complaint.id as string;

  await post(`/complaints/${id}/assign-technician`, owner, { technicianId: String(world.technician._id) });
  await post(`/complaints/${id}/visits`, owner, { scheduledAt: tomorrow() });
  await post(`/complaints/${id}/start-visit`, tech, { customerAvailability: 'CUSTOMER_AVAILABLE' });
  await post(`/complaints/${id}/resolution`, tech, {
    diagnosis: { problemFound: 'Pads clogged' },
    workPerformed: { details: 'Replaced pads' },
    resolution: { result: 'Cooling restored' },
  });
  const accepted = await post(`/complaints/${id}/review-resolution`, owner, { outcome: 'ACCEPTED' });
  expect(accepted.status).toBe(200);

  return id;
}

describe('closing is offered once the Happy Code is verified', () => {
  it('is not offered before verification', async () => {
    const id = await awaitingConfirmation();

    const res = await request(app).get(`/complaints/${id}`).set('Authorization', `Bearer ${admin}`);

    expect(offered(res.body)).not.toContain('CLOSED');
  });

  it('is offered on the complaint afterwards, and in the verification response', async () => {
    const id = await awaitingConfirmation();
    const whatsapp = await request(app).get(`/complaints/${id}/whatsapp`).set('Authorization', `Bearer ${admin}`);

    const verified = await post(`/complaints/${id}/verify-happy-code`, admin, { code: whatsapp.body.happyCode });
    expect(verified.status).toBe(200);
    expect(offered(verified.body)).toContain('CLOSED');

    const res = await request(app).get(`/complaints/${id}`).set('Authorization', `Bearer ${admin}`);
    expect(offered(res.body)).toContain('CLOSED');
  });
});
