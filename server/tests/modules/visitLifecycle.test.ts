/**
 * A visit always ends (sections 9, 10, 22).
 *
 * Found while building the technician app: three paths left a visit open
 * forever. Each one surfaces on the technician's phone as a job that cannot be
 * finished and cannot be cleared — and quietly inflates every report that
 * counts visits.
 *
 *  - The customer was not home. The visit stayed "in progress", so the app
 *    offered to continue into a diagnosis of a unit nobody saw.
 *  - The Owner scheduled a follow-up (after parts, or after the customer was
 *    out). The new visit was created; the old one was never closed.
 *  - The complaint was cancelled. Its scheduled visit stayed on the
 *    technician's list for a job that no longer exists.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Visit } from '../../src/models/index.js';
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

/** A complaint with a visit scheduled for tomorrow, ready to start. */
async function scheduled(serial: string): Promise<string> {
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

  return id;
}

function start(id: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/complaints/${id}/start-visit`)
    .set('Authorization', `Bearer ${c.tech}`)
    .send(body);
}

const visitsOf = (id: string) =>
  Visit.find({ complaintId: id }).sort({ sequence: 1 }).lean().exec();

/* ---- The customer was not there ---------------------------------------- */

describe('a visit where no work could be done', () => {
  it('ends the visit when nobody is home', async () => {
    const id = await scheduled('SN-LC-1');

    const res = await start(id, {
      customerAvailability: 'CUSTOMER_UNAVAILABLE',
      availabilityNote: 'Rang twice, phone off',
    });

    expect(res.status).toBe(200);
    /* The trip still counts as attendance, and the Owner's "Reschedule
       visit" transition leaves from IN_PROGRESS. */
    expect(res.body.complaint.status).toBe('IN_PROGRESS');

    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('COMPLETED');
    expect(visit!.startedAt).toBeTruthy();
    expect(visit!.completedAt).toBeTruthy();
    expect(visit!.customerAvailability).toBe('CUSTOMER_UNAVAILABLE');
    expect(visit!.resolution).toBeUndefined();
  });

  it('ends the visit when the customer asks for another day', async () => {
    const id = await scheduled('SN-LC-2');
    await start(id, { customerAvailability: 'RESCHEDULE_REQUIRED' });

    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('COMPLETED');
  });

  it('refuses a resolution for a visit that ended without work', async () => {
    const id = await scheduled('SN-LC-3');
    await start(id, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });

    /* Otherwise a technician could file a diagnosis for a unit they never
       saw — exactly what recording the absence is meant to prevent. */
    const res = await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({
        diagnosis: { problemFound: 'Invented' },
        workPerformed: { details: 'Invented' },
        resolution: { result: 'Invented' },
      });

    expect(res.status).toBe(400);
  });

  it('moves it off the technician\'s in-progress list and into history', async () => {
    const id = await scheduled('SN-LC-4');
    await start(id, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });

    const jobs = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(jobs.body.inProgress).toHaveLength(0);
    expect(jobs.body.completed).toHaveLength(1);
    /* The card says why, so history does not read as a finished repair. */
    expect(jobs.body.completed[0].customerAvailability).toBe('CUSTOMER_UNAVAILABLE');
  });

  it('lets the technician carry on when someone else lets them in', async () => {
    const id = await scheduled('SN-LC-5');

    /* The customer is out, but the cooler is on the terrace and a neighbour
       has the key. Absence alone does not end the visit if work is possible. */
    const res = await start(id, {
      customerAvailability: 'CUSTOMER_UNAVAILABLE',
      availabilityNote: 'Neighbour let me in',
      endVisit: false,
    });

    expect(res.status).toBe(200);
    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('IN_PROGRESS');
  });

  it('continues by default when the reason is something else', async () => {
    const id = await scheduled('SN-LC-6');
    await start(id, { customerAvailability: 'OTHER', availabilityNote: 'Son is home' });

    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('IN_PROGRESS');
  });

  it('ends the visit for something else when told to', async () => {
    const id = await scheduled('SN-LC-7');
    await start(id, {
      customerAvailability: 'OTHER',
      availabilityNote: 'Power cut in the area',
      endVisit: true,
    });

    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('COMPLETED');
  });

  it('refuses to end a visit without saying why', async () => {
    const id = await scheduled('SN-LC-8');

    const available = await start(id, {
      customerAvailability: 'CUSTOMER_AVAILABLE',
      endVisit: true,
    });
    expect(available.status).toBe(400);

    const silent = await start(id, { endVisit: true });
    expect(silent.status).toBe(400);

    /* Neither refusal consumed the visit. */
    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('SCHEDULED');
  });

  it('closes cleanly when the Owner reschedules', async () => {
    const id = await scheduled('SN-LC-9');
    await start(id, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });

    const res = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow(), reason: 'Customer was not at home' });

    expect(res.status).toBe(201);
    const visits = await visitsOf(id);
    expect(visits.map((v) => v.status)).toEqual(['COMPLETED', 'SCHEDULED']);

    /* And the second visit runs normally. */
    const second = await start(id, { customerAvailability: 'CUSTOMER_AVAILABLE' });
    expect(second.status).toBe(200);
  });
});

/* ---- A follow-up visit ------------------------------------------------- */

describe('scheduling a follow-up visit', () => {
  it('closes the visit left open when work stopped for parts', async () => {
    const id = await scheduled('SN-LC-10');
    await start(id, { customerAvailability: 'CUSTOMER_AVAILABLE' });

    await request(app)
      .post(`/complaints/${id}/waiting-for-parts`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ reason: 'Fan motor out of stock' });

    /* Parts arrive after the technician has gone home: a fresh trip. */
    const res = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow() });

    expect(res.status).toBe(201);
    const visits = await visitsOf(id);
    expect(visits.map((v) => v.status)).toEqual(['COMPLETED', 'SCHEDULED']);
    expect(visits[0]!.completedAt).toBeTruthy();

    const jobs = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);
    expect(jobs.body.inProgress).toHaveLength(0);
  });

  it('lets the technician submit on the follow-up visit', async () => {
    const id = await scheduled('SN-LC-11');
    await start(id, { customerAvailability: 'CUSTOMER_AVAILABLE' });
    await request(app)
      .post(`/complaints/${id}/waiting-for-parts`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ reason: 'Pump out of stock' });
    await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow() });
    await start(id, { customerAvailability: 'CUSTOMER_AVAILABLE' });

    const res = await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({
        diagnosis: { problemFound: 'Pump seized' },
        workPerformed: { details: 'Replaced pump' },
        resolution: { result: 'Working' },
      });

    expect(res.status).toBe(200);
    const visits = await visitsOf(id);
    /* The resolution lands on the visit where the work was finished. */
    expect(visits[0]!.resolution).toBeUndefined();
    expect(visits[1]!.resolution?.result).toBe('Working');
  });
});

/* ---- Cancellation ------------------------------------------------------ */

describe('cancelling a complaint', () => {
  it('cancels its scheduled visit', async () => {
    const id = await scheduled('SN-LC-12');

    const res = await request(app)
      .post(`/complaints/${id}/cancel`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ reason: 'Duplicate of an earlier complaint' });

    expect(res.status).toBe(200);
    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('CANCELLED');
    expect(visit!.cancelledAt).toBeTruthy();
    expect(visit!.cancellationReason).toMatch(/Duplicate/);
  });

  it('stops a visit in progress', async () => {
    const id = await scheduled('SN-LC-13');
    await start(id, { customerAvailability: 'CUSTOMER_AVAILABLE' });

    await request(app)
      .post(`/complaints/${id}/cancel`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ reason: 'Customer withdrew the complaint' });

    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('CANCELLED');
    /* The trip itself stays on record. */
    expect(visit!.startedAt).toBeTruthy();
  });

  it('clears the job from the technician\'s list', async () => {
    const id = await scheduled('SN-LC-14');
    await request(app)
      .post(`/complaints/${id}/cancel`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ reason: 'Duplicate' });

    const jobs = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(jobs.body.today).toHaveLength(0);
    expect(jobs.body.upcoming).toHaveLength(0);
    expect(jobs.body.inProgress).toHaveLength(0);
  });

  it('leaves completed visits as they were', async () => {
    const id = await scheduled('SN-LC-15');
    await start(id, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });
    await request(app)
      .post(`/complaints/${id}/cancel`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ reason: 'Customer bought a new cooler' });

    const [visit] = await visitsOf(id);
    expect(visit!.status).toBe('COMPLETED');
  });
});

/* ---- A missed visit ---------------------------------------------------- */

describe('a visit whose day has passed', () => {
  it('stays on the technician\'s list, ahead of today\'s visits', async () => {
    const missed = await scheduled('SN-LC-17');
    await scheduled('SN-LC-18');

    /* The API refuses to schedule in the past, so age the visit directly —
       exactly what happens overnight to a visit nobody started. */
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    await Visit.updateOne({ complaintId: missed }, { $set: { scheduledAt: yesterday } });

    const jobs = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);

    /* It was in no bucket at all: not today's, not upcoming. A missed visit
       is the one most in need of attention, so it leads today's list. */
    expect(jobs.body.counts.today).toBe(1);
    expect(jobs.body.today[0].complaint.id).toBe(missed);
    expect(jobs.body.counts.upcoming).toBe(1);
  });
});

/* ---- History ----------------------------------------------------------- */

describe('visit history', () => {
  it('can be read in the order the visits were finished', async () => {
    /* Booked first, finished last — the usual shape of a day that did not go
       to plan. History read by booking time would put it in the wrong place. */
    const bookedFirst = await scheduled('SN-LC-19');
    const bookedLater = await scheduled('SN-LC-20');
    await Visit.updateOne(
      { complaintId: bookedLater },
      { $set: { scheduledAt: new Date(Date.now() + 48 * 3_600_000) } },
    );

    await start(bookedLater, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });
    await start(bookedFirst, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });
    /* Separate the two completion times beyond clock resolution. */
    await Visit.updateOne(
      { complaintId: bookedFirst },
      { $set: { completedAt: new Date(Date.now() + 60_000) } },
    );

    const res = await request(app)
      .get('/visits')
      .query({ status: 'COMPLETED', orderBy: 'completedAt', sort: 'desc' })
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((v: { complaint: { id: string } }) => v.complaint.id)).toEqual([
      bookedFirst,
      bookedLater,
    ]);
  });
});

/* ---- Reporting --------------------------------------------------------- */

describe('technician report', () => {
  it('does not count a visit without work as a submitted resolution', async () => {
    const id = await scheduled('SN-LC-16');
    await start(id, { customerAvailability: 'CUSTOMER_UNAVAILABLE' });

    const res = await request(app)
      .get('/reports/technicians')
      .set('Authorization', `Bearer ${c.admin}`);

    const [technician] = res.body.tables.find((t: { key: string }) => t.key === 'byTechnician').rows;
    expect(technician.visitsCompleted).toBe(1);
    expect(technician.resolutionsSubmitted).toBe(0);
  });
});
