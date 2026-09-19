/**
 * Admin's star rating of a service centre's work (DECISIONS.md section 31).
 *
 * The contract: `POST /complaints/:id/rating` is Admin-only, works only on a
 * closed complaint with a service centre, stores `serviceRating` on the
 * complaint, writes one `SERVICE_CENTER_RATED` timeline entry with the old
 * and new stars, and follows the explicit-clear convention for its note —
 * leaving the note out (or blank) on a *change* removes it, rather than
 * keeping the old one.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint, ComplaintActivity } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, seedWorld } from '../fixtures.js';

const app = createApp();

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
  owner: string;
  tech: string;
  /** A second centre, for the "reopened and moved" case. */
  otherCentreId: string;
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  const other = await makeServiceCenter(world.city._id, world.territory._id, 'JAI-07');
  c = {
    world,
    admin: await token('9800000001'),
    owner: await token('9800000002'),
    tech: await token('9800000003'),
    otherCentreId: String(other._id),
  };
});

const post = (path: string, auth: string, body: Record<string, unknown> = {}) =>
  request(app).post(path).set('Authorization', `Bearer ${auth}`).send(body);

/** Creates a complaint already at the given service centre. */
async function raise(serial: string, centreId = String(c.world.center._id)): Promise<string> {
  const res = await post('/complaints', c.admin, {
    customerId: String(c.world.customer._id),
    productId: String(c.world.product._id),
    productModelId: String(c.world.productModel._id),
    serialNumber: serial,
    category: 'Not cooling',
    description: 'Warm air.',
    priority: 'NORMAL',
    warrantyStatus: 'IN_WARRANTY',
    ...(centreId ? { serviceCenterId: centreId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.complaint.id as string;
}

/**
 * Moves a complaint straight to CLOSED, as the workflow tests do (see
 * `dashboardLists.test.ts`'s `force`) — the rating route only cares about the
 * status and service centre it finds, and the full Workflow F walk to CLOSED
 * is exercised elsewhere (`workflow.test.ts`).
 */
async function close(id: string): Promise<void> {
  await Complaint.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    {
      $set: {
        status: 'CLOSED',
        closedAt: new Date(),
        /* Reopening files a closure in the history only when it knows who
           closed it, so a forced closure records that too. */
        closedBy: c.world.admin._id,
        'sla.state': 'COMPLETED',
      },
    },
  );
}

async function rate(id: string, auth: string, body: Record<string, unknown>) {
  return post(`/complaints/${id}/rating`, auth, body);
}

async function timelineOf(id: string) {
  return ComplaintActivity.find({ complaintId: id }).sort({ createdAt: 1 }).lean().exec();
}

describe('rating a closed complaint', () => {
  it('stores the rating and echoes the response like other workflow routes', async () => {
    const id = await raise('SN-RT-1');
    await close(id);

    const res = await rate(id, c.admin, { stars: 4, note: 'Quick and tidy work' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    /* Same response shape as POST /:id/close and its neighbours. */
    expect(res.body.complaint.serviceRating).toMatchObject({
      stars: 4,
      note: 'Quick and tidy work',
      revisions: 0,
    });
    expect(res.body.complaint.serviceRating.serviceCenterId).toBe(String(c.world.center._id));
    expect(res.body.complaint.serviceRating.ratedByName).toBe('Admin');
    expect(res.body).toHaveProperty('nextActions');

    const stored = (await Complaint.findById(id).lean().exec())!;
    expect(stored.serviceRating).toMatchObject({ stars: 4, note: 'Quick and tidy work', revisions: 0 });
    expect(stored.serviceRating!.ratedAt).toBeTruthy();
    expect(String(stored.serviceRating!.ratedBy)).toBe(String(c.world.admin._id));
  });

  it('writes one SERVICE_CENTER_RATED timeline entry, without changing the status', async () => {
    const id = await raise('SN-RT-2');
    await close(id);

    const before = await timelineOf(id);
    const res = await rate(id, c.admin, { stars: 5 });
    expect(res.status).toBe(200);

    const after = await timelineOf(id);
    const added = after.slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'SERVICE_CENTER_RATED',
      fieldChanged: 'serviceRating.stars',
      newValue: '5',
      note: '5 of 5',
    });
    expect(added[0]).not.toHaveProperty('oldValue');

    expect((await Complaint.findById(id).lean().exec())!.status).toBe('CLOSED');
  });

  it('records the old and new stars, and the typed note, when the rating changes', async () => {
    const id = await raise('SN-RT-3');
    await close(id);

    await rate(id, c.admin, { stars: 2, note: 'Took two visits' });
    const changed = await rate(id, c.admin, { stars: 4, note: 'Sorted on the revisit, all good now' });
    expect(changed.status).toBe(200);

    const entries = await timelineOf(id);
    const rated = entries.filter((e) => e.action === 'SERVICE_CENTER_RATED');
    expect(rated).toHaveLength(2);
    expect(rated[1]).toMatchObject({
      oldValue: '2',
      newValue: '4',
      note: '4 of 5 — Sorted on the revisit, all good now',
    });
  });

  it('counts revisions from 0 and increments on each further change', async () => {
    const id = await raise('SN-RT-4');
    await close(id);

    const first = await rate(id, c.admin, { stars: 3 });
    expect(first.body.complaint.serviceRating.revisions).toBe(0);

    const second = await rate(id, c.admin, { stars: 4 });
    expect(second.body.complaint.serviceRating.revisions).toBe(1);

    const third = await rate(id, c.admin, { stars: 5, note: 'Even better this time' });
    expect(third.body.complaint.serviceRating.revisions).toBe(2);
  });

  it('clears the note when a change omits it, rather than keeping the old one', async () => {
    const id = await raise('SN-RT-5');
    await close(id);

    await rate(id, c.admin, { stars: 3, note: 'Slow to respond' });
    const cleared = await rate(id, c.admin, { stars: 3 });

    expect(cleared.status).toBe(200);
    expect(cleared.body.complaint.serviceRating.note).toBeUndefined();

    const stored = (await Complaint.findById(id).lean().exec())!;
    expect(stored.serviceRating!.note).toBeUndefined();
  });

  it('also clears the note when a change sends it blank', async () => {
    const id = await raise('SN-RT-5b');
    await close(id);

    await rate(id, c.admin, { stars: 3, note: 'Slow to respond' });
    const cleared = await rate(id, c.admin, { stars: 3, note: '   ' });

    expect(cleared.status).toBe(200);
    expect(cleared.body.complaint.serviceRating.note).toBeUndefined();
  });

  it('does nothing when the same stars and note are submitted again', async () => {
    const id = await raise('SN-RT-5c');
    await close(id);

    const first = await rate(id, c.admin, { stars: 4, note: 'Good and quick' });
    expect(first.body.complaint.serviceRating.revisions).toBe(0);

    /* A double-click on Save, or a client retry: identical stars and note. */
    const again = await rate(id, c.admin, { stars: 4, note: 'Good and quick' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.complaint.serviceRating).toMatchObject({ stars: 4, note: 'Good and quick', revisions: 0 });

    const stored = (await Complaint.findById(id).lean().exec())!;
    expect(stored.serviceRating!.revisions).toBe(0);

    const entries = await timelineOf(id);
    expect(entries.filter((e) => e.action === 'SERVICE_CENTER_RATED')).toHaveLength(1);
  });

  it('still counts a revision when only the note changes, stars staying the same', async () => {
    const id = await raise('SN-RT-5d');
    await close(id);

    await rate(id, c.admin, { stars: 4, note: 'Good' });
    const changed = await rate(id, c.admin, { stars: 4, note: 'Good, confirmed with the customer' });

    expect(changed.status).toBe(200);
    expect(changed.body.complaint.serviceRating.revisions).toBe(1);

    const entries = await timelineOf(id);
    expect(entries.filter((e) => e.action === 'SERVICE_CENTER_RATED')).toHaveLength(2);
  });

  it('lets the Owner see the rating on GET /complaints/:id', async () => {
    const id = await raise('SN-RT-6');
    await close(id);
    await rate(id, c.admin, { stars: 4, note: 'Good work' });

    const res = await request(app)
      .get(`/complaints/${id}`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(200);
    expect(res.body.complaint.serviceRating).toMatchObject({ stars: 4, note: 'Good work' });
  });

  it('files the rating with its closure when the complaint is reopened', async () => {
    const id = await raise('SN-RT-7');
    await close(id);
    expect((await rate(id, c.admin, { stars: 5, note: 'Excellent' })).status).toBe(200);

    const reopened = await post(`/complaints/${id}/reopen`, c.admin, {
      reason: 'Same fault returned within a week',
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.complaint.status).toBe('REOPENED');

    /* The rating judged work that evidently did not hold, so it goes with
       that closure rather than travelling with the complaint — which could
       otherwise carry it into another centre's average (section 31). */
    expect(reopened.body.complaint.serviceRating).toBeUndefined();

    const stored = (await Complaint.findById(id).lean().exec())!;
    expect(stored.serviceRating).toBeUndefined();
    expect(stored.closureHistory).toHaveLength(1);
    expect(stored.closureHistory[0]!.rating).toMatchObject({ stars: 5, note: 'Excellent' });

    /* And the timeline still says who rated what. */
    const entries = await ComplaintActivity.find({ complaintId: id, action: 'SERVICE_CENTER_RATED' })
      .lean()
      .exec();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.newValue).toBe('5');
  });

  it('rates the new centre, not the old one, after a reopened complaint moves', async () => {
    const id = await raise('SN-RT-7B');
    await close(id);
    expect((await rate(id, c.admin, { stars: 1, note: 'Customer called back twice' })).status).toBe(200);

    await post(`/complaints/${id}/reopen`, c.admin, { reason: 'Fault returned' });
    const moved = await post(`/complaints/${id}/assign-service-center`, c.admin, {
      serviceCenterId: c.otherCentreId,
      reason: 'Closer centre will finish it',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    /* The new centre starts unrated: the one star belonged to the old one. */
    const stored = (await Complaint.findById(id).lean().exec())!;
    expect(String(stored.serviceCenterId)).toBe(c.otherCentreId);
    expect(stored.serviceRating).toBeUndefined();
  });
});

describe('refusals', () => {
  it('refuses a complaint that is not closed', async () => {
    const id = await raise('SN-RT-8');

    const res = await rate(id, c.admin, { stars: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/closed complaint can be rated/i);
    expect((await Complaint.findById(id).lean().exec())!.serviceRating).toBeUndefined();
  });

  it('refuses a complaint with no service center', async () => {
    const id = await raise('SN-RT-9', '');
    await close(id);

    const res = await rate(id, c.admin, { stars: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no service center/i);
  });

  for (const stars of [0, 6, 2.5]) {
    it(`refuses ${stars} stars`, async () => {
      const id = await raise(`SN-RT-BAD-${stars}`);
      await close(id);

      const res = await rate(id, c.admin, { stars });

      expect(res.status).toBe(400);
      expect((await Complaint.findById(id).lean().exec())!.serviceRating).toBeUndefined();
    });
  }

  it('refuses a Service Center Owner', async () => {
    const id = await raise('SN-RT-10');
    await close(id);

    const res = await rate(id, c.owner, { stars: 4 });

    expect(res.status).toBe(403);
  });

  it('refuses a Technician', async () => {
    const id = await raise('SN-RT-11');
    await close(id);

    const res = await rate(id, c.tech, { stars: 4 });

    expect(res.status).toBe(403);
  });
});

describe('the average', () => {
  it('ignores complaints with no rating, and is null when nothing is rated', async () => {
    const other = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-77');
    const rated = await raise('SN-RT-20');
    const unrated = await raise('SN-RT-21');
    await close(rated);
    await close(unrated);
    await rate(rated, c.admin, { stars: 4 });

    const withOne = await request(app)
      .get(`/reports/service-centers`)
      .set('Authorization', `Bearer ${c.admin}`);
    const row = withOne.body.tables
      .find((t: { key: string }) => t.key === 'byCenter')
      .rows.find((r: { serviceCenter: string }) => r.serviceCenter === c.world.center.name);
    expect(row).toMatchObject({ avgRating: 4, rated: 1 });

    /* A centre with complaints but none rated reads null, not zero — zero
       would claim a one-star average nobody gave it. */
    const otherId = await raise('SN-RT-22', String(other._id));
    await close(otherId);
    const res = await request(app)
      .get(`/reports/service-centers`)
      .set('Authorization', `Bearer ${c.admin}`);
    const otherRow = res.body.tables
      .find((t: { key: string }) => t.key === 'byCenter')
      .rows.find((r: { serviceCenter: string }) => r.serviceCenter === other.name);
    expect(otherRow).toMatchObject({ avgRating: null, rated: 0 });
  });
});
