/**
 * Parts and inventory tests (spec section 11).
 *
 * The important one is `never lets concurrent finalisations oversell stock`.
 * Everything else here is ordinary CRUD with permissions; that one guards the
 * invariant that the whole replica-set decision was made for.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  AuditLog,
  ComplaintActivity,
  Part,
  PartRequest,
  PartStock,
  PartUsage,
  Visit,
} from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

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

/** A complaint at the seeded centre with the seeded technician on it. */
async function complaintWithTechnician(): Promise<string> {
  const created = await request(app)
    .post('/complaints')
    .set('Authorization', `Bearer ${c.admin}`)
    .send({
      customerId: String(c.world.customer._id),
      productId: String(c.world.product._id),
      productModelId: String(c.world.productModel._id),
      serialNumber: 'SN-PARTS-1',
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

  return id;
}

/** A complaint driven to IN_PROGRESS, which is where parts get used. */
async function complaintInProgress(): Promise<string> {
  const id = await complaintWithTechnician();

  await request(app)
    .post(`/complaints/${id}/visits`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ scheduledAt: tomorrow() });
  await request(app)
    .post(`/complaints/${id}/start-visit`)
    .set('Authorization', `Bearer ${c.tech}`)
    .send({});

  return id;
}

/** Sets a known stock level for a seeded part. */
async function stockPart(code: string, quantity: number, minimum = 2) {
  const part = await Part.findOne({ code }).lean().exec();
  await request(app)
    .put('/parts/stock')
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ partId: String(part!._id), availableQuantity: quantity, minimumStock: minimum });
  return part!;
}

/** The technician submits the in-progress visit's work. */
async function submitWork(id: string): Promise<void> {
  const submitted = await request(app)
    .post(`/complaints/${id}/resolution`)
    .set('Authorization', `Bearer ${c.tech}`)
    .send({
      diagnosis: { problemFound: 'Pump seized' },
      workPerformed: { details: 'Replaced pump' },
      resolution: { result: 'Cooling restored' },
    });
  expect(submitted.status).toBe(200);
}

/**
 * Closes an in-progress complaint the only way one closes: work accepted,
 * the customer's Happy Code verified, Admin closes.
 */
async function closeComplaint(id: string): Promise<void> {
  await submitWork(id);
  await request(app)
    .post(`/complaints/${id}/review-resolution`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ outcome: 'ACCEPTED' });

  const whatsapp = await request(app)
    .get(`/complaints/${id}/whatsapp`)
    .set('Authorization', `Bearer ${c.admin}`);
  await request(app)
    .post(`/complaints/${id}/verify-happy-code`)
    .set('Authorization', `Bearer ${c.admin}`)
    .send({ code: whatsapp.body.happyCode });

  const closed = await request(app)
    .post(`/complaints/${id}/close`)
    .set('Authorization', `Bearer ${c.admin}`);
  expect(closed.status).toBe(200);
}

async function cancelComplaint(id: string): Promise<void> {
  const cancelled = await request(app)
    .post(`/complaints/${id}/cancel`)
    .set('Authorization', `Bearer ${c.admin}`)
    .send({ reason: 'Customer bought a new cooler' });
  expect(cancelled.status).toBe(200);
}

/** The technician asks for a part on a complaint; returns the request id. */
async function requestPart(complaintId: string, partId: string, quantityRequested = 1): Promise<string> {
  const res = await request(app)
    .post(`/complaints/${complaintId}/part-requests`)
    .set('Authorization', `Bearer ${c.tech}`)
    .send({ partId, quantityRequested });
  expect(res.status).toBe(201);
  return res.body.request.id as string;
}

/** The Owner's decision on a request. */
function decide(requestId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/parts/requests/${requestId}/decide`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send(body);
}

describe('part master', () => {
  it('lets Admin create a part and hides retired ones by default', async () => {
    const created = await request(app)
      .post('/parts')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Drain Valve', code: 'VALVE-01', unit: 'PIECE' });
    expect(created.status).toBe(201);

    /* Section 17: retiring is a flag, never a delete. */
    await request(app)
      .patch(`/parts/${created.body.part.id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ isActive: false });

    const visible = await request(app)
      .get('/parts')
      .set('Authorization', `Bearer ${c.tech}`);
    expect(visible.body.items.map((p: { code: string }) => p.code)).not.toContain(
      'VALVE-01',
    );

    /* But it still exists, so reports can reach it. */
    const all = await request(app)
      .get('/parts?includeInactive=true')
      .set('Authorization', `Bearer ${c.admin}`);
    expect(all.body.items.map((p: { code: string }) => p.code)).toContain('VALVE-01');
  });

  it('refuses a duplicate part code', async () => {
    const res = await request(app)
      .post('/parts')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Another Pad', code: 'PAD-01' });

    expect(res.status).toBe(409);
  });

  it('is readable by a technician but writable only by Admin', async () => {
    /* The technician's parts picker needs the list. */
    expect((await request(app).get('/parts').set('Authorization', `Bearer ${c.tech}`)).status).toBe(200);

    const write = await request(app)
      .post('/parts')
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ name: 'Sneaky Part', code: 'SNEAK-01' });
    expect(write.status).toBe(403);
  });

  it('records who added a part in the audit log', async () => {
    const created = await request(app)
      .post('/parts')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Drain Valve', code: 'VALVE-01', unit: 'PIECE' });
    expect(created.status).toBe(201);

    /* Edits and retirement were logged but creation was not, so "Parts and
       stock" never showed a part being added. */
    const log = await request(app)
      .get('/audit?category=parts')
      .set('Authorization', `Bearer ${c.admin}`);

    const entry = log.body.items.find((item: { action: string }) => item.action === 'PART_CREATED');
    expect(entry).toMatchObject({
      entityType: 'Part',
      entityId: created.body.part.id,
      entityName: 'Drain Valve',
      actorName: 'Admin',
      note: 'Drain Valve (VALVE-01)',
    });
  });

  it('clears a category when told to, and only then', async () => {
    const created = await request(app)
      .post('/parts')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Drain Valve', code: 'VALVE-01', category: 'Plumbing' });
    const id = created.body.part.id as string;

    /* Leaving the key out keeps the category. */
    const renamed = await request(app)
      .patch(`/parts/${id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Drain Valve Large' });
    expect(renamed.body.part.category).toBe('Plumbing');

    /* The form used to omit an emptied box: "Part updated", old category kept. */
    const cleared = await request(app)
      .patch(`/parts/${id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ category: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.part).not.toHaveProperty('category');
    expect(await Part.findById(id).lean().exec()).not.toHaveProperty('category');

    const audit = await AuditLog.findOne({ entityId: id, 'changes.field': 'category' }).lean().exec();
    expect(audit).toMatchObject({ action: 'PART_UPDATED', changes: [{ field: 'category', oldValue: 'Plumbing' }] });
    expect(audit!.changes[0]!.newValue).toBeUndefined();

    /* Clearing what is already empty is not an edit, and a real value is
       still checked. */
    await request(app)
      .patch(`/parts/${id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ category: '' });
    expect(await AuditLog.countDocuments({ entityId: id, 'changes.field': 'category' })).toBe(1);

    const tooLong = await request(app)
      .patch(`/parts/${id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ category: 'x'.repeat(121) });
    expect(tooLong.status).toBe(400);
  });
});

describe('stock', () => {
  it('is scoped to the owner\'s own service center', async () => {
    await stockPart('PAD-01', 10);

    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-20',
    );
    const otherOwner = await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000021',
      serviceCenterId: otherCentre._id,
    });
    expect(otherOwner).toBeTruthy();

    const theirs = await request(app)
      .get('/parts/stock/list')
      .set('Authorization', `Bearer ${await token('9800000021')}`);

    /* Section 11 keeps stock per centre; one Owner must not see another's. */
    expect(theirs.body.total).toBe(0);
  });

  it('refuses an owner naming a different center', async () => {
    const part = await Part.findOne({ code: 'PAD-01' }).lean().exec();
    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-21',
    );

    const res = await request(app)
      .put('/parts/stock')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({
        partId: String(part!._id),
        availableQuantity: 5,
        minimumStock: 1,
        serviceCenterId: String(otherCentre._id),
      });

    /* Refused rather than silently redirected to their own centre, so the
       mistake is visible. */
    expect(res.status).toBe(403);
  });

  it('gives a technician no access to stock at all', async () => {
    const res = await request(app)
      .get('/parts/stock/list')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(403);
  });

  it('reports low stock by comparing quantity against minimum', async () => {
    await stockPart('PAD-01', 20, 5);
    await stockPart('MOTOR-01', 1, 4);

    const res = await request(app)
      .get('/parts/stock/list?lowOnly=true')
      .set('Authorization', `Bearer ${c.owner}`);

    const codes = res.body.items.map((row: { partCode: string }) => row.partCode);
    expect(codes).toContain('MOTOR-01');
    expect(codes).not.toContain('PAD-01');
  });

  it('adjusts stock by a signed delta and refuses to go negative', async () => {
    const part = await stockPart('PAD-01', 5, 1);

    const delivery = await request(app)
      .post('/parts/stock/adjust')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ partId: String(part._id), delta: 10, reason: 'Delivery received' });
    expect(delivery.body.stock.availableQuantity).toBe(15);

    const tooMany = await request(app)
      .post('/parts/stock/adjust')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ partId: String(part._id), delta: -100, reason: 'Write-off' });

    /* The guard is in the query filter, not a prior read. */
    expect(tooMany.status).toBe(409);
    const after = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(after!.availableQuantity).toBe(15);
  });

  it('moves the last delivery date only for a delivery', async () => {
    /* Adding a part to stock is a count, not a delivery. */
    const part = await stockPart('PAD-01', 10, 2);
    let row = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(row!.lastRestockedAt).toBeUndefined();

    await request(app)
      .post('/parts/stock/adjust')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ partId: String(part._id), delta: 5, reason: 'Delivery received' });
    row = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(row!.lastRestockedAt).toBeInstanceOf(Date);

    /* Pinned to an earlier day, so "unchanged" cannot pass by landing in the
       same millisecond. */
    const delivered = new Date('2026-09-01T10:00:00.000Z');
    await PartStock.updateOne({ _id: row!._id }, { $set: { lastRestockedAt: delivered } });

    /* A stocktake below the count, a new reorder level on its own, and a
       write-off. The stocktake used to show today as the last delivery. */
    await stockPart('PAD-01', 12, 2);
    await stockPart('PAD-01', 12, 6);
    await request(app)
      .post('/parts/stock/adjust')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ partId: String(part._id), delta: -1, reason: 'Damaged in the store' });

    const listed = await request(app)
      .get('/parts/stock/list')
      .set('Authorization', `Bearer ${c.owner}`);
    expect(listed.body.items[0]).toMatchObject({
      availableQuantity: 11,
      minimumStock: 6,
      lastRestockedAt: delivered.toISOString(),
    });
  });
});

describe('requests (section 11)', () => {
  it('lets a technician request a part and the owner issue it', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PUMP-01', 8);

    const requested = await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 2, reason: 'Pump seized' });
    expect(requested.status).toBe(201);

    const decided = await request(app)
      .post(`/parts/requests/${requested.body.request.id}/decide`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ status: 'ISSUED', quantityIssued: 2 });

    expect(decided.status).toBe(200);
    expect(decided.body.request.quantityIssued).toBe(2);

    /* Section 11 defers the decrement to usage finalisation, so issuing
       must not have moved stock. */
    const stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(8);
    expect(decided.body.note).toMatch(/finalised/i);
  });

  it('requires a reason to mark a request unavailable', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PUMP-01', 0, 2);

    const requested = await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 1 });

    const noReason = await request(app)
      .post(`/parts/requests/${requested.body.request.id}/decide`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ status: 'UNAVAILABLE' });
    expect(noReason.status).toBe(400);

    const withReason = await request(app)
      .post(`/parts/requests/${requested.body.request.id}/decide`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ status: 'UNAVAILABLE', remarks: 'None left, reordering' });
    expect(withReason.status).toBe(200);
  });

  it('will not re-decide a settled request', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PUMP-01', 5);

    const requested = await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 1 });

    await request(app)
      .post(`/parts/requests/${requested.body.request.id}/decide`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ status: 'ISSUED', quantityIssued: 1 });

    /* Reopening a settled request would let an Owner rewrite a decision the
       technician has already acted on. */
    const again = await request(app)
      .post(`/parts/requests/${requested.body.request.id}/decide`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ status: 'REJECTED', remarks: 'Changed my mind' });
    expect(again.status).toBe(409);
  });

  it('puts the request on the complaint timeline', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PUMP-01', 5);

    await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 1 });

    const actions = (await ComplaintActivity.find({ complaintId: id }).lean().exec()).map(
      (e) => e.action,
    );
    expect(actions).toContain('PARTS_REQUESTED');
  });

  it('keeps an approved request waiting until the part is issued', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PUMP-01', 10);

    const asked = await requestPart(id, String(part._id));
    const approved = await requestPart(id, String(part._id));
    const issued = await requestPart(id, String(part._id));
    expect((await decide(approved, { status: 'APPROVED' })).status).toBe(200);
    expect((await decide(issued, { status: 'ISSUED', quantityIssued: 1 })).status).toBe(200);

    /* Approving is not issuing. The queue listed only REQUESTED, so an
       approved request dropped out of sight with the part never handed over. */
    const waiting = await request(app)
      .get('/parts/requests/list')
      .query({ status: 'REQUESTED,APPROVED' })
      .set('Authorization', `Bearer ${c.owner}`);
    expect(waiting.status).toBe(200);
    expect(waiting.body.total).toBe(2);
    expect(waiting.body.items.map((row: { id: string }) => row.id).sort()).toEqual([asked, approved].sort());

    const unknown = await request(app)
      .get('/parts/requests/list')
      .query({ status: 'REQUESTED,SOMEDAY' })
      .set('Authorization', `Bearer ${c.owner}`);
    expect(unknown.status).toBe(400);
  });

  it('records each decision on the timeline as what it was', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('MOTOR-01', 10);

    const first = await requestPart(id, String(part._id), 2);
    await decide(first, { status: 'APPROVED', remarks: 'Fits this model' });
    await decide(first, { status: 'ISSUED', quantityIssued: 1 });
    const second = await requestPart(id, String(part._id));
    await decide(second, { status: 'REJECTED', remarks: 'Wrong part for this model' });
    const third = await requestPart(id, String(part._id));
    await decide(third, { status: 'CANCELLED' });

    const decisions = await ComplaintActivity.find({
      complaintId: id,
      fieldChanged: 'partRequest.status',
    })
      .sort({ _id: 1 })
      .lean()
      .exec();

    /* Approvals, rejections and cancellations all read "Parts requested",
       by the Owner. */
    expect(decisions.map((entry) => [entry.action, entry.note])).toEqual([
      ['PARTS_REQUEST_APPROVED', 'Fan Motor x2 approved — Fits this model'],
      ['PARTS_ISSUED', 'Fan Motor x1 issued (2 requested)'],
      ['PARTS_REQUEST_REJECTED', 'Fan Motor x1 rejected — Wrong part for this model'],
      ['PARTS_REQUEST_CANCELLED', 'Fan Motor x1 withdrawn'],
    ]);
    expect(decisions[1]).toMatchObject({ oldValue: 'APPROVED', newValue: 'ISSUED' });
  });

  it('lets only the centre that has the complaint now decide its requests', async () => {
    const id = await complaintWithTechnician();
    const part = await stockPart('PUMP-01', 5);
    const requestId = await requestPart(id, String(part._id));

    const otherCentre = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-30');
    const moved = await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ serviceCenterId: String(otherCentre._id), reason: 'Closer to the customer' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    /* Found in security review: the request still names the old centre, which
       was all its scope checked, so the old Owner could decide it and write to
       a complaint that is no longer theirs. */
    const res = await decide(requestId, { status: 'APPROVED' });
    expect(res.status).toBe(404);

    const after = await PartRequest.findById(requestId).lean().exec();
    expect(after!.status).not.toBe('APPROVED');
    expect(
      await ComplaintActivity.countDocuments({ complaintId: id, action: 'PARTS_REQUEST_APPROVED' }),
    ).toBe(0);
  });
});

describe('closed and cancelled complaints', () => {
  it('refuses new requests and usage once a complaint is closed', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10);
    await closeComplaint(id);

    /* Found in security review: both were accepted, and a usage line is what
       the centre then deducts from stock. */
    const asked = await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 1 });
    const used = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 1 });

    expect(asked.status).toBe(409);
    expect(asked.body.error.message).toMatch(/closed/);
    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/closed/);
    expect(await PartRequest.countDocuments({ complaintId: id })).toBe(0);
    expect(await PartUsage.countDocuments({ complaintId: id })).toBe(0);
  });

  it('refuses them on a cancelled complaint too', async () => {
    /* Cancelled after the work was submitted, so the visit is complete and
       would otherwise have taken a usage line. */
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10);
    await submitWork(id);
    await cancelComplaint(id);

    const used = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 1 });
    const asked = await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 1 });

    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/cancelled/);
    expect(asked.status).toBe(409);
    expect(await PartUsage.countDocuments({ complaintId: id })).toBe(0);
  });

  it('still confirms usage recorded before the complaint closed', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10, 2);
    const recorded = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 2 });
    expect(recorded.status).toBe(201);

    await closeComplaint(id);

    /* The part was fitted during the job. Admin closing before the centre
       confirmed it must not leave stock too high for good. */
    const confirmed = await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.remainingStock).toBe(8);
  });

  it('will not deduct usage recorded after the complaint closed', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10, 2);
    await closeComplaint(id);

    /* A line left by the old gap, written to the database directly because the
       API no longer accepts one. */
    const visit = await Visit.findOne({ complaintId: id }).lean().exec();
    const late = await PartUsage.create({
      complaintId: id,
      visitId: visit!._id,
      serviceCenterId: c.world.center._id,
      partId: part._id,
      recordedBy: c.world.technician._id,
      quantity: 3,
    });

    const res = await request(app)
      .post(`/parts/usage/${String(late._id)}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/after the complaint was closed/);
    const stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(10);
  });

  it('lets the centre clear, but not fill, a request left waiting when the job ended', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PUMP-01', 5);
    const requestId = await requestPart(id, String(part._id));
    /* Two more requests on the same complaint, left waiting, so the
       REJECTED path above does not consume the only request before the
       UNAVAILABLE and CANCELLED paths get their turn. */
    const unavailableId = await requestPart(id, String(part._id));
    const cancelledId = await requestPart(id, String(part._id));
    await cancelComplaint(id);

    /* Nothing should be promised or handed over for a job that is over. */
    const approve = await decide(requestId, { status: 'APPROVED' });
    const issue = await decide(requestId, { status: 'ISSUED', quantityIssued: 1 });
    expect(approve.status).toBe(409);
    expect(issue.status).toBe(409);
    expect(issue.body.error.message).toMatch(/cancelled/);

    /* But it has to be possible to take it off the waiting list, however it
       is cleared: rejected, marked unavailable or withdrawn. */
    const reject = await decide(requestId, { status: 'REJECTED', remarks: 'The job was cancelled' });
    expect(reject.status).toBe(200);
    expect(reject.body.request.status).toBe('REJECTED');

    const unavailable = await decide(unavailableId, {
      status: 'UNAVAILABLE',
      remarks: 'Out of stock everywhere',
    });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.request.status).toBe('UNAVAILABLE');
    expect(
      await ComplaintActivity.countDocuments({
        complaintId: id,
        action: 'PARTS_MARKED_UNAVAILABLE',
      }),
    ).toBe(1);

    const cancel = await decide(cancelledId, { status: 'CANCELLED' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.request.status).toBe('CANCELLED');
    expect(
      await ComplaintActivity.countDocuments({
        complaintId: id,
        action: 'PARTS_REQUEST_CANCELLED',
      }),
    ).toBe(1);
  });
});

describe('usage and stock decrement', () => {
  it('records usage without moving stock, then decrements on finalise', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10, 2);

    const recorded = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 3 });
    expect(recorded.status).toBe(201);

    /* Still a claim, not a movement. */
    let stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(10);

    const finalized = await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(finalized.status).toBe(200);
    expect(finalized.body.remainingStock).toBe(7);

    stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(7);
  });

  it('warns when the decrement takes a part to its minimum', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 5, 3);

    const recorded = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 2 });

    const finalized = await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(finalized.body.isLowStock).toBe(true);
    expect(finalized.body.warning).toMatch(/minimum stock/i);
  });

  it('refuses to finalise the same usage twice', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10);

    const recorded = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 2 });

    await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);

    /* Finalising twice would decrement twice for one physical part. */
    const again = await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(again.status).toBe(409);
    const stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(8);
  });

  it('refuses to finalise more than is in stock', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 2, 1);

    const recorded = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 5 });

    const res = await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Available: 2, needed: 5/);

    /* The usage stays un-finalised so it can be corrected, and stock is
       untouched. */
    const usage = await PartUsage.findById(recorded.body.usage.id).lean().exec();
    expect(usage!.finalizedAt).toBeUndefined();
    const stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(2);
  });

  it('never lets concurrent finalisations oversell stock', async () => {
    /**
     * The invariant the replica set exists for.
     *
     * Ten usages of 1 against a stock of 6. If the decrement were a read,
     * a check in JavaScript and then a write, several would pass the check
     * simultaneously and stock would go negative. The conditional `$gte`
     * filter makes MongoDB decide atomically, so exactly six succeed.
     */
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 6, 0);

    const usageIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const recorded = await request(app)
        .post(`/complaints/${id}/part-usage`)
        .set('Authorization', `Bearer ${c.tech}`)
        .send({ partId: String(part._id), quantity: 1 });
      usageIds.push(recorded.body.usage.id as string);
    }

    const results = await Promise.all(
      usageIds.map((usageId) =>
        request(app)
          .post(`/parts/usage/${usageId}/finalize`)
          .set('Authorization', `Bearer ${c.owner}`),
      ),
    );

    const succeeded = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 409).length;

    expect(succeeded).toBe(6);
    expect(rejected).toBe(4);

    const stock = await PartStock.findOne({ partId: part._id }).lean().exec();
    expect(stock!.availableQuantity).toBe(0);
  });

  it('will not let a technician finalise their own usage', async () => {
    const id = await complaintInProgress();
    const part = await stockPart('PAD-01', 10);

    const recorded = await request(app)
      .post(`/complaints/${id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 1 });

    /* Recording what you fitted and confirming it against inventory are
       different jobs; one person doing both removes the check. */
    const res = await request(app)
      .post(`/parts/usage/${recorded.body.usage.id}/finalize`)
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(403);
  });

  it('will not record usage before a visit has started', async () => {
    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-NOVISIT',
        category: 'Not cooling',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
        serviceCenterId: String(c.world.center._id),
      });

    await request(app)
      .post(`/complaints/${created.body.complaint.id}/assign-technician`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ technicianId: String(c.world.technician._id) });

    const part = await stockPart('PAD-01', 10);

    const res = await request(app)
      .post(`/complaints/${created.body.complaint.id}/part-usage`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/start a visit/i);
  });
});
