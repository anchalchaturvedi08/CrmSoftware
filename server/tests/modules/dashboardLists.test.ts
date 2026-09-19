/**
 * A dashboard tile opens the list of what it counted (spec sections 5.1, 9).
 *
 * The bugs: "SLA breached" opened the unfiltered list, because the list had no
 * SLA filter. "Open complaints", "Critical open" and a technician's "Open jobs"
 * opened lists that included closed and cancelled complaints. With a 7/30/90
 * day range chosen, the list ignored the dates. And "Requests waiting" forgot a
 * part request the moment it was approved.
 *
 * So each test here counts both ways — the dashboard's number and the total of
 * the list its tile links to — for Admin and for an Owner, and checks both
 * against the number that is actually right.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint, PartRequest } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();
const DAY = 24 * 3_600_000;

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
  owner: string;
  otherCentreId: string;
}
let c: Ctx;

async function raise(
  serial: string,
  centreId: string,
  priority: 'NORMAL' | 'CRITICAL' = 'NORMAL',
): Promise<string> {
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
      priority,
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: centreId,
    });
  expect(res.status).toBe(201);
  return res.body.complaint.id as string;
}

/** Moves a complaint straight to a state; the workflow itself is tested elsewhere. */
async function force(id: string, fields: Record<string, unknown>): Promise<void> {
  await Complaint.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
}

beforeEach(async () => {
  const world = await seedWorld();
  const other = await makeServiceCenter(world.city._id, world.territory._id, 'JAI-09');
  c = {
    world,
    admin: await token('9800000001'),
    owner: await token('9800000002'),
    otherCentreId: String(other._id),
  };
});

/**
 * The owner's centre (A) and another centre (B):
 *
 *   open        A NORMAL, A CRITICAL, A NORMAL raised 40 days ago, B CRITICAL
 *   breached    A NORMAL still open, past its deadline but not yet swept
 *   closed      A CRITICAL (closed)
 *   cancelled   A CRITICAL (cancelled) that had breached before it was called off
 */
async function mixedWorkload() {
  const centreA = String(c.world.center._id);
  const ids = {
    open: await raise('SN-L-1', centreA),
    critical: await raise('SN-L-2', centreA, 'CRITICAL'),
    old: await raise('SN-L-3', centreA),
    otherCentre: await raise('SN-L-4', c.otherCentreId, 'CRITICAL'),
    breached: await raise('SN-L-5', centreA),
    closed: await raise('SN-L-6', centreA, 'CRITICAL'),
    cancelled: await raise('SN-L-7', centreA, 'CRITICAL'),
  };

  await force(ids.old, { createdAt: new Date(Date.now() - 40 * DAY) });
  /* Past due and still RUNNING: only a sweep records the breach. */
  await force(ids.breached, { 'sla.resolutionDueAt': new Date(Date.now() - DAY) });
  await force(ids.closed, { status: 'CLOSED', 'sla.state': 'COMPLETED' });
  await force(ids.cancelled, {
    status: 'CANCELLED',
    'sla.state': 'BREACHED',
    'sla.breachedAt': new Date(Date.now() - DAY),
  });

  return ids;
}

async function totalOf(tokenValue: string, query: Record<string, string>): Promise<number> {
  const res = await request(app)
    .get('/complaints')
    .query(query)
    .set('Authorization', `Bearer ${tokenValue}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.total as number;
}

async function kpis(tokenValue: string, query: Record<string, string> = {}) {
  const res = await request(app)
    .get('/dashboard')
    .query(query)
    .set('Authorization', `Bearer ${tokenValue}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    kpis: Record<string, number>;
    operations: Record<string, number>;
    ratings: { average: number | null; rated: number; closedUnrated: number };
  };
}

const post = (path: string, auth: string, body: Record<string, unknown> = {}) =>
  request(app).post(path).set('Authorization', `Bearer ${auth}`).send(body);

/** Rates a complaint the direct way, once `force` has already closed it. */
async function rate(id: string, auth: string, stars: number): Promise<void> {
  const res = await post(`/complaints/${id}/rating`, auth, { stars });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('dashboard tiles and the lists they open', () => {
  it('lists exactly the breached complaints the tile counts, before the dashboard has swept', async () => {
    const ids = await mixedWorkload();

    /* The list is opened first, so it has to record the breach itself. */
    const res = await request(app)
      .get('/complaints')
      .query({ slaBreached: 'true' })
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([ids.breached]);
    expect((await kpis(c.owner)).kpis.slaBreached).toBe(1);
  });

  it('agrees with the Owner dashboard on open, SLA breached and critical open', async () => {
    await mixedWorkload();
    const dash = await kpis(c.owner);

    /* Centre A: open, critical, old, breached. Closed and cancelled are not open. */
    expect(dash.kpis.totalOpen).toBe(4);
    expect(await totalOf(c.owner, { open: 'true' })).toBe(4);

    expect(dash.kpis.slaBreached).toBe(1);
    expect(await totalOf(c.owner, { slaBreached: 'true' })).toBe(1);

    expect(dash.kpis.critical).toBe(1);
    expect(await totalOf(c.owner, { priority: 'CRITICAL', open: 'true' })).toBe(1);
  });

  it('agrees with the Admin dashboard, across every centre', async () => {
    await mixedWorkload();
    const dash = await kpis(c.admin);

    expect(dash.kpis.totalOpen).toBe(5);
    expect(await totalOf(c.admin, { open: 'true' })).toBe(5);

    expect(dash.kpis.critical).toBe(2);
    expect(await totalOf(c.admin, { priority: 'CRITICAL', open: 'true' })).toBe(2);

    expect(dash.kpis.slaBreached).toBe(1);
    expect(await totalOf(c.admin, { slaBreached: 'true' })).toBe(1);

    /* A centre's own figures, as a centre details page would link them. */
    expect(await totalOf(c.admin, { serviceCenterId: c.otherCentreId, open: 'true' })).toBe(1);
  });

  it('applies the same dates to the tiles and to their lists', async () => {
    await mixedWorkload();
    const from = new Date(Date.now() - 30 * DAY).toISOString();
    const dash = await kpis(c.admin, { from });

    /* The complaint raised 40 days ago drops out of both. */
    expect(dash.kpis.totalOpen).toBe(4);
    expect(await totalOf(c.admin, { open: 'true', from })).toBe(4);
    expect(dash.kpis.closed).toBe(1);
    expect(await totalOf(c.admin, { status: 'CLOSED', from })).toBe(1);

    const to = new Date(Date.now() - 30 * DAY).toISOString();
    expect(await totalOf(c.admin, { to })).toBe(1);
    expect(await totalOf(c.admin, { from, to: new Date().toISOString() })).toBe(6);

    /* Dates chosen on the dashboard close the window at both ends, not only
       at the start: this one holds exactly the complaint raised 40 days ago. */
    const windowFrom = new Date(Date.now() - 45 * DAY).toISOString();
    const windowTo = new Date(Date.now() - 35 * DAY).toISOString();
    const windowed = await kpis(c.admin, { from: windowFrom, to: windowTo });
    expect(windowed.kpis.totalOpen).toBe(1);
    expect(await totalOf(c.admin, { open: 'true', from: windowFrom, to: windowTo })).toBe(1);
  });

  it('keeps a status filter when "open" is added, rather than replacing it', async () => {
    await mixedWorkload();

    expect(await totalOf(c.admin, { status: 'CLOSED' })).toBe(1);
    expect(await totalOf(c.admin, { status: 'CLOSED', open: 'true' })).toBe(0);
    expect(await totalOf(c.admin, { status: 'ASSIGNED,CANCELLED', open: 'true' })).toBe(5);
  });

  it('treats open=false as no filter, and refuses a flag that is not yes or no', async () => {
    await mixedWorkload();

    expect(await totalOf(c.admin, { open: 'false', slaBreached: 'false' })).toBe(7);

    const bogus = await request(app)
      .get('/complaints')
      .query({ slaBreached: 'perhaps' })
      .set('Authorization', `Bearer ${c.admin}`);
    expect(bogus.status).toBe(400);
  });

  it("lists a technician's open jobs as the workload column counts them", async () => {
    const ids = await mixedWorkload();
    const technicianId = String(c.world.technician._id);

    for (const id of [ids.open, ids.critical]) {
      const assigned = await request(app)
        .post(`/complaints/${id}/assign-technician`)
        .set('Authorization', `Bearer ${c.owner}`)
        .send({ technicianId });
      expect(assigned.status).toBeLessThan(300);
    }
    /* The second job is then closed: still theirs, no longer open. */
    await force(ids.critical, { status: 'CLOSED', 'sla.state': 'COMPLETED' });

    const users = await request(app)
      .get('/users')
      .query({ role: 'TECHNICIAN' })
      .set('Authorization', `Bearer ${c.owner}`);
    const row = users.body.items.find((user: { id: string }) => user.id === technicianId);

    expect(row.workload.openJobs).toBe(1);
    expect(await totalOf(c.owner, { technicianId, open: 'true' })).toBe(1);
    expect(await totalOf(c.owner, { technicianId })).toBe(2);
  });
});

describe('part requests waiting', () => {
  it('counts requests approved but not yet issued, as well as new ones', async () => {
    const complaintId = await raise('SN-L-P', String(c.world.center._id));
    const base = {
      complaintId,
      serviceCenterId: c.world.center._id,
      partId: c.world.parts[0]!._id,
      requestedBy: c.world.technician._id,
      quantityRequested: 1,
    };

    await PartRequest.create([
      { ...base, status: 'REQUESTED' },
      { ...base, status: 'APPROVED' },
      { ...base, status: 'ISSUED', quantityIssued: 1 },
      { ...base, status: 'REJECTED' },
      { ...base, status: 'UNAVAILABLE' },
      { ...base, status: 'CANCELLED' },
    ]);

    expect((await kpis(c.owner)).operations.pendingPartRequests).toBe(2);
    expect((await kpis(c.admin)).operations.pendingPartRequests).toBe(2);
  });
});

describe('another centre', () => {
  it("never sees the owner's figures or complaints", async () => {
    await mixedWorkload();
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000091',
      serviceCenterId: new mongoose.Types.ObjectId(c.otherCentreId),
    });
    const otherOwner = await token('9800000091');

    expect((await kpis(otherOwner)).kpis.totalOpen).toBe(1);
    expect(await totalOf(otherOwner, { open: 'true' })).toBe(1);
    /* Asking for centre A by id narrows their own scope to nothing. */
    expect(
      await totalOf(otherOwner, { open: 'true', serviceCenterId: String(c.world.center._id) }),
    ).toBe(0);
  });
});

describe('the dashboard service-centre filter and ratings (DECISIONS.md section 31)', () => {
  const centreA = () => String(c.world.center._id);

  /**
   * Centre A: two closed complaints (one rated 4 stars, one left unrated) and
   * one still open. Centre B (`otherCentreId`): one closed complaint rated
   * 2 stars, and one still open.
   */
  async function ratedWorkload() {
    const ratedA = await raise('SN-RATE-A1', centreA());
    const unratedA = await raise('SN-RATE-A2', centreA());
    const openA = await raise('SN-RATE-A3', centreA());
    const ratedB = await raise('SN-RATE-B1', c.otherCentreId);
    const openB = await raise('SN-RATE-B2', c.otherCentreId);

    for (const id of [ratedA, unratedA, ratedB]) {
      await force(id, { status: 'CLOSED', 'sla.state': 'COMPLETED' });
    }

    await rate(ratedA, c.admin, 4);
    await rate(ratedB, c.admin, 2);

    return { ratedA, unratedA, openA, ratedB, openB };
  }

  it("narrows an Admin's dashboard to one centre, the same way the complaint list does", async () => {
    await ratedWorkload();

    /* Both centres have one open job each. */
    const wholeCompany = await kpis(c.admin);
    expect(wholeCompany.kpis.totalOpen).toBe(2);

    const centreOnly = await kpis(c.admin, { serviceCenterId: centreA() });
    expect(centreOnly.kpis.totalOpen).toBe(1);
    expect(await totalOf(c.admin, { serviceCenterId: centreA(), open: 'true' })).toBe(1);
  });

  it('still narrows an Owner to their own centre when another id is given', async () => {
    await ratedWorkload();

    const own = await kpis(c.owner);
    expect(own.ratings).toMatchObject({ average: 4, rated: 1, closedUnrated: 1 });

    /* Centre A's owner naming centre B narrows their own scope to nothing,
       exactly as the complaint list's serviceCenterId filter already does. */
    const elsewhere = await kpis(c.owner, { serviceCenterId: c.otherCentreId });
    expect(elsewhere.ratings).toEqual({ average: null, rated: 0, closedUnrated: 0 });
  });

  it("reports the centre's rating average, rated count and closed-unrated count", async () => {
    await ratedWorkload();

    /* Owner: their own centre only — one rated (4), one closed and unrated. */
    const owner = await kpis(c.owner);
    expect(owner.ratings).toEqual({ average: 4, rated: 1, closedUnrated: 1 });

    /* Admin, unscoped: both centres' ratings pooled together. */
    const admin = await kpis(c.admin);
    expect(admin.ratings).toEqual({ average: 3, rated: 2, closedUnrated: 1 });

    /* Admin narrowed to centre B: just that centre's own rating. */
    const centreB = await kpis(c.admin, { serviceCenterId: c.otherCentreId });
    expect(centreB.ratings).toEqual({ average: 2, rated: 1, closedUnrated: 0 });
  });

  it('reads the average as null, not zero, when nothing in scope has been rated', async () => {
    const id = await raise('SN-RATE-NONE', centreA());
    await force(id, { status: 'CLOSED', 'sla.state': 'COMPLETED' });

    const owner = await kpis(c.owner);
    expect(owner.ratings).toEqual({ average: null, rated: 0, closedUnrated: 1 });
  });

  it("also narrows Admin's operations panel to the chosen centre, not only the KPIs", async () => {
    const complaintA = await raise('SN-OPS-A', centreA());
    const complaintB = await raise('SN-OPS-B', c.otherCentreId);

    const requestBase = {
      partId: c.world.parts[0]!._id,
      requestedBy: c.world.technician._id,
      quantityRequested: 1,
    };
    await PartRequest.create([
      { ...requestBase, complaintId: complaintA, serviceCenterId: c.world.center._id },
      {
        ...requestBase,
        complaintId: complaintB,
        serviceCenterId: new mongoose.Types.ObjectId(c.otherCentreId),
      },
    ]);
    await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000093',
      name: 'Technician B',
      serviceCenterId: new mongoose.Types.ObjectId(c.otherCentreId),
    });

    /* Unscoped: both centres' waiting requests and technicians are pooled. */
    const wholeCompany = await kpis(c.admin);
    expect(wholeCompany.operations.pendingPartRequests).toBe(2);
    expect(wholeCompany.operations.activeTechnicians).toBe(2);

    /* Narrowed to centre A: only centre A's own request and technician —
       the same figures Admin would get by opening centre A's own details
       page, and what the KPI/ratings facets above already narrow to. */
    const centreOnly = await kpis(c.admin, { serviceCenterId: centreA() });
    expect(centreOnly.operations.pendingPartRequests).toBe(1);
    expect(centreOnly.operations.activeTechnicians).toBe(1);
  });
});
