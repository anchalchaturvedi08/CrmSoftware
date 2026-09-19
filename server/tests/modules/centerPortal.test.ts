/**
 * What the Service Center portal needs from the API (spec section 9).
 *
 * Written while building the Owner's screens. Two are bugs:
 *
 *  - Cancelling a visit stranded the complaint. It stayed VISIT_SCHEDULED
 *    with nothing booked, and scheduling a new visit was then refused as
 *    "already visit scheduled" — the only way out was cancelling the whole
 *    complaint.
 *  - `?includeInactive=false` and `?lowOnly=false` meant *true*.
 *    `z.coerce.boolean()` is JavaScript's `Boolean("false")`, and any
 *    non-empty string is true.
 *
 * The rest are read-model additions section 9 asks for: the technician and
 * visit date on the complaint list, names on the parts request queue,
 * technician workload, and visits that were missed.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { startOfCompanyDay } from '../../src/core/time.js';
import { Complaint, User, Visit } from '../../src/models/index.js';
import { TEST_PASSWORD, makeUser, seedWorld } from '../fixtures.js';

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

async function makeComplaint(serial: string): Promise<string> {
  const res = await request(app)
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
  return res.body.complaint.id as string;
}

/** A complaint with its technician assigned and a visit booked for tomorrow. */
async function scheduled(serial: string): Promise<{ id: string; visitId: string }> {
  const id = await makeComplaint(serial);
  await request(app)
    .post(`/complaints/${id}/assign-technician`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ technicianId: String(c.world.technician._id) });
  const booked = await request(app)
    .post(`/complaints/${id}/visits`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ scheduledAt: tomorrow() });
  return { id, visitId: booked.body.visit.id as string };
}

/* ---- Cancelling a visit ------------------------------------------------ */

describe('cancelling a visit', () => {
  it('returns the complaint to "technician assigned" so it can be booked again', async () => {
    const { id, visitId } = await scheduled('SN-CP-1');

    const cancelled = await request(app)
      .post(`/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ reason: 'Customer travelling, will call back' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.visit.status).toBe('CANCELLED');

    const complaint = await Complaint.findById(id).lean().exec();
    expect(complaint!.status).toBe('TECHNICIAN_ASSIGNED');

    /* The point of the fix: the Owner can book again. */
    const rebooked = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow() });
    expect(rebooked.status).toBe(201);
    expect(rebooked.body.complaint.status).toBe('VISIT_SCHEDULED');
  });

  it('requires a reason', async () => {
    const { visitId } = await scheduled('SN-CP-2');

    const res = await request(app)
      .post(`/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({});

    expect(res.status).toBe(400);
    const visit = await Visit.findById(visitId).lean().exec();
    expect(visit!.status).toBe('SCHEDULED');
  });

  it('records why on the timeline', async () => {
    const { id, visitId } = await scheduled('SN-CP-3');
    await request(app)
      .post(`/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ reason: 'Customer travelling, will call back' });

    const timeline = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.owner}`);

    const notes = timeline.body.items.map((entry: { note?: string }) => entry.note ?? '');
    expect(notes.some((note: string) => /travelling/.test(note))).toBe(true);
  });

  it('refuses a visit that has already started', async () => {
    const { visitId, id } = await scheduled('SN-CP-4');
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ customerAvailability: 'CUSTOMER_AVAILABLE' });

    const res = await request(app)
      .post(`/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(400);
  });
});

/* ---- "false" means false ---------------------------------------------- */

describe('boolean query flags', () => {
  it('excludes deactivated technicians when includeInactive=false', async () => {
    const retired = await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000077',
      name: 'Retired Technician',
      serviceCenterId: c.world.center._id,
    });
    await User.updateOne({ _id: retired._id }, { $set: { isActive: false } });

    const off = await request(app)
      .get('/users')
      .query({ role: 'TECHNICIAN', includeInactive: 'false' })
      .set('Authorization', `Bearer ${c.owner}`);
    const on = await request(app)
      .get('/users')
      .query({ role: 'TECHNICIAN', includeInactive: 'true' })
      .set('Authorization', `Bearer ${c.owner}`);

    const names = (res: request.Response) => res.body.items.map((u: { name: string }) => u.name);
    expect(names(off)).not.toContain('Retired Technician');
    expect(names(on)).toContain('Retired Technician');
  });

  it('returns every stock line when lowOnly=false', async () => {
    const [plenty, scarce] = c.world.parts;
    await request(app)
      .put('/parts/stock')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ partId: String(plenty!._id), availableQuantity: 50, minimumStock: 5 });
    await request(app)
      .put('/parts/stock')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ partId: String(scarce!._id), availableQuantity: 1, minimumStock: 5 });

    const all = await request(app)
      .get('/parts/stock/list')
      .query({ lowOnly: 'false' })
      .set('Authorization', `Bearer ${c.owner}`);
    const low = await request(app)
      .get('/parts/stock/list')
      .query({ lowOnly: 'true' })
      .set('Authorization', `Bearer ${c.owner}`);

    expect(all.body.items).toHaveLength(2);
    expect(low.body.items).toHaveLength(1);
  });

  it('rejects a flag that is not a yes or no', async () => {
    const res = await request(app)
      .get('/parts/stock/list')
      .query({ lowOnly: 'perhaps' })
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(400);
  });
});

/* ---- Complaint list: technician and visit (section 9) ------------------ */

describe('complaint list for the service center', () => {
  it('shows the technician and the booked visit', async () => {
    const { id } = await scheduled('SN-CP-5');

    const res = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${c.owner}`);

    const row = res.body.items.find((item: { id: string }) => item.id === id);
    expect(row.technicianName).toBe(c.world.technician.name);
    expect(row.currentVisit.status).toBe('SCHEDULED');
    expect(row.currentVisit.scheduledAt).toBeTruthy();
  });

  it('shows why the last visit ended when nothing is booked', async () => {
    const { id } = await scheduled('SN-CP-6');
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ customerAvailability: 'CUSTOMER_UNAVAILABLE', availabilityNote: 'Door locked' });

    const res = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${c.owner}`);

    /* In progress on paper, with nobody working it: the Owner has to rebook,
       and the list is where they will spot it. */
    const row = res.body.items.find((item: { id: string }) => item.id === id);
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.currentVisit).toBeUndefined();
    expect(row.lastVisit.customerAvailability).toBe('CUSTOMER_UNAVAILABLE');
    expect(row.lastVisit.availabilityNote).toBe('Door locked');
  });
});

describe('complaint list status filter', () => {
  it('accepts several statuses at once', async () => {
    const waiting = await makeComplaint('SN-CP-11');
    const { id: booked } = await scheduled('SN-CP-12');

    const res = await request(app)
      .get('/complaints')
      .query({ status: 'ASSIGNED,VISIT_SCHEDULED' })
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([waiting, booked]));
    expect(res.body.total).toBe(2);
  });

  it('still accepts a single status, and refuses an unknown one', async () => {
    await makeComplaint('SN-CP-13');

    const one = await request(app)
      .get('/complaints')
      .query({ status: 'ASSIGNED' })
      .set('Authorization', `Bearer ${c.owner}`);
    const bogus = await request(app)
      .get('/complaints')
      .query({ status: 'ASSIGNED,NOT_A_STATUS' })
      .set('Authorization', `Bearer ${c.owner}`);

    expect(one.body.total).toBe(1);
    expect(bogus.status).toBe(400);
  });
});

/* ---- Parts request queue ----------------------------------------------- */

describe('parts request queue', () => {
  it('names the part, the complaint and who asked', async () => {
    const { id } = await scheduled('SN-CP-7');
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ customerAvailability: 'CUSTOMER_AVAILABLE' });
    const part = c.world.parts[0]!;
    await request(app)
      .post(`/complaints/${id}/part-requests`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ partId: String(part._id), quantityRequested: 2, reason: 'Pump seized' });

    const res = await request(app)
      .get('/parts/requests/list')
      .set('Authorization', `Bearer ${c.owner}`);

    const row = res.body.items[0];
    expect(row.part.name).toBe(part.name);
    expect(row.part.code).toBe(part.code);
    expect(row.complaint.complaintNumber).toMatch(/^CMP-/);
    expect(row.complaint.customerName).toBe(c.world.customer.name);
    expect(row.requestedByName).toBe(c.world.technician.name);
  });
});

/* ---- Technician workload ----------------------------------------------- */

describe('technician workload', () => {
  it('counts open jobs and today\'s visits per technician', async () => {
    const { id } = await scheduled('SN-CP-8');
    await scheduled('SN-CP-9');
    /* 23:00 today in the company timezone — "today" is the company's day, not
       the machine's, so this must not depend on where the tests run. */
    const today = new Date(startOfCompanyDay().getTime() + 23 * 3_600_000);
    await Visit.updateOne({ complaintId: id }, { $set: { scheduledAt: today } });

    const res = await request(app)
      .get('/users')
      .query({ role: 'TECHNICIAN' })
      .set('Authorization', `Bearer ${c.owner}`);

    const row = res.body.items.find(
      (user: { id: string }) => user.id === String(c.world.technician._id),
    );
    expect(row.workload.openJobs).toBe(2);
    expect(row.workload.visitsToday).toBe(1);
  });
});

/* ---- Missed visits ----------------------------------------------------- */

describe('dashboard', () => {
  it('counts visits whose day passed without anyone starting them', async () => {
    const { id } = await scheduled('SN-CP-10');
    await Visit.updateOne(
      { complaintId: id },
      { $set: { scheduledAt: new Date(Date.now() - 30 * 3_600_000) } },
    );

    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.body.operations.missedVisits).toBe(1);
  });
});
