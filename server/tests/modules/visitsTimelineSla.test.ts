/**
 * Visits, timeline and SLA settings (spec sections 9, 10, 14, 17).
 *
 * These three landed together because they are what the portals need before
 * any screen can be built: a schedule to render, a story to show on a
 * complaint, and targets that can be changed without a re-seed.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { companyDateKey, startOfCompanyDay } from '../../src/core/time.js';
import { Complaint, ComplaintActivity, SlaRule, Visit } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const tomorrow = () => hoursFromNow(24);
/** Noon today in the company timezone, wherever the tests run. */
const noonToday = () => new Date(startOfCompanyDay().getTime() + 12 * 3_600_000);

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

/** Creates a complaint and optionally schedules a visit on it. */
async function complaintWithVisit(
  serial: string,
  scheduledAt: string | null = tomorrow(),
): Promise<string> {
  const created = await request(app)
    .post('/complaints')
    .set('Authorization', `Bearer ${c.admin}`)
    .send({
      customerId: String(c.world.customer._id),
      productId: String(c.world.product._id),
      productModelId: String(c.world.productModel._id),
      serialNumber: serial,
      category: 'Not cooling',
      description: 'x',
      priority: 'NORMAL',
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: String(c.world.center._id),
    });

  const id = created.body.complaint.id as string;

  await request(app)
    .post(`/complaints/${id}/assign-technician`)
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ technicianId: String(c.world.technician._id) });

  if (scheduledAt) {
    await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt });
  }

  return id;
}

describe('visit schedule (section 9)', () => {
  it('returns the centre calendar with complaint context inline', async () => {
    await complaintWithVisit('SN-V1');

    const res = await request(app)
      .get('/visits')
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);

    /* Denormalised on purpose: a job card needs the customer, address and
       product, and a phone should not make five extra round trips for them. */
    const card = res.body.items[0];
    expect(card.complaint.customerName).toBe('Anita Sharma');
    expect(card.complaint.address).toBe('4 Lake View');
    expect(card.complaint.productName).toBe('Desert Cooler 50L');
    expect(card.complaint.complaintNumber).toMatch(/^CMP-/);
  });

  it('filters to a single day for a calendar view', async () => {
    /* Pinned to a fixed hour today rather than `now + 2h`, which lands
       tomorrow when the suite runs late in the evening. */
    await complaintWithVisit('SN-V2', tomorrow());
    await complaintWithVisit('SN-V3', hoursFromNow(72));

    const first = await Visit.findOne({}).sort({ createdAt: 1 }).exec();
    await Visit.updateOne({ _id: first!._id }, { $set: { scheduledAt: noonToday() } });

    /* The company's date, not UTC's: between midnight and 05:30 in India the
       UTC date is still yesterday. */
    const today = companyDateKey();
    const res = await request(app)
      .get(`/visits?date=${today}`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.body.total).toBe(1);
  });

  it('scopes an owner to their own centre', async () => {
    await complaintWithVisit('SN-V4');

    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-50',
    );
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000051',
      serviceCenterId: otherCentre._id,
    });

    const theirs = await request(app)
      .get('/visits')
      .set('Authorization', `Bearer ${await token('9800000051')}`);

    expect(theirs.body.total).toBe(0);
  });

  it('reschedules a visit and keeps the previous time in history', async () => {
    await complaintWithVisit('SN-V5');
    const visit = await Visit.findOne({}).lean().exec();
    const original = visit!.scheduledAt;

    const res = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: hoursFromNow(48), reason: 'Customer asked for Thursday' });

    expect(res.status).toBe(200);

    const after = await Visit.findById(visit!._id).lean().exec();
    /* Section 17: the calendar's history has to be auditable. */
    expect(after!.rescheduleHistory).toHaveLength(1);
    expect(new Date(after!.rescheduleHistory[0]!.previousScheduledAt).getTime()).toBe(
      new Date(original).getTime(),
    );
  });

  it('will not reschedule into the past', async () => {
    await complaintWithVisit('SN-V6');
    const visit = await Visit.findOne({}).lean().exec();

    const res = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: hoursFromNow(-48), reason: 'typo' });

    expect(res.status).toBe(400);
  });

  it('will not move a visit that has already started', async () => {
    await complaintWithVisit('SN-V7');
    const visit = await Visit.findOne({}).lean().exec();

    await request(app)
      .post(`/complaints/${visit!.complaintId}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({});

    /* An in-progress visit is a record of what actually happened; a later
       trip is a new visit, not an edit of this one (section 22). */
    const res = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow(), reason: 'too late' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot be moved|new visit/i);
  });

  it('refuses a technician rescheduling their own visit', async () => {
    await complaintWithVisit('SN-V8');
    const visit = await Visit.findOne({}).lean().exec();

    /* Section 3.3: a technician works jobs, they do not plan the calendar. */
    const res = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ scheduledAt: tomorrow(), reason: 'suits me better' });

    expect(res.status).toBe(403);
  });

  it('shuts the old centre out once the complaint has moved to another', async () => {
    const id = await complaintWithVisit('SN-V14');
    const visit = await Visit.findOne({ complaintId: id }).lean().exec();

    /**
     * Admin moved the complaint; the booked visit still carries the old centre,
     * so the old Owner passes the visit's own scope check. Written directly
     * rather than through the reassign route, so this holds whatever a centre
     * change does to open visits — the complaint's scope is the guard here.
     */
    const newCentre = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-80');
    await Complaint.updateOne(
      { _id: id },
      { $set: { serviceCenterId: newCentre._id, status: 'ASSIGNED' }, $unset: { technicianId: 1 } },
    );

    const moved = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: hoursFromNow(48), reason: 'Customer asked for Thursday' });
    const cancelled = await request(app)
      .post(`/visits/${visit!._id}/cancel`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ reason: 'Customer travelling' });

    /* Not found, not forbidden: nothing is confirmed about another centre's work. */
    expect(moved.status).toBe(404);
    expect(cancelled.status).toBe(404);

    const after = await Visit.findById(visit!._id).lean().exec();
    expect(after!.status).toBe('SCHEDULED');
    expect(after!.rescheduleHistory).toHaveLength(0);
    expect(
      await ComplaintActivity.countDocuments({
        complaintId: id,
        action: { $in: ['VISIT_RESCHEDULED', 'VISIT_CANCELLED'] },
      }),
    ).toBe(0);

    /* Admin, whose scope is every complaint, can still sort it out. */
    const byAdmin = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ scheduledAt: hoursFromNow(50), reason: 'Customer called the helpline' });
    expect(byAdmin.status).toBe(200);
  });
});

describe('the Admin schedule (sections 4, 9)', () => {
  /** A second centre with its own owner, technician and one booked visit. */
  async function secondCentreVisit(): Promise<{ centreId: string; complaintId: string }> {
    const centre = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-70');
    await makeUser({ role: 'SERVICE_CENTER_OWNER', mobile: '9800000071', serviceCenterId: centre._id });
    const technician = await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000072',
      name: 'Other Technician',
      serviceCenterId: centre._id,
    });
    const owner = await token('9800000071');

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-V-OTHER',
        category: 'Not cooling',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
        serviceCenterId: String(centre._id),
      });
    const complaintId = created.body.complaint.id as string;

    await request(app)
      .post(`/complaints/${complaintId}/assign-technician`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ technicianId: String(technician._id) });
    const booked = await request(app)
      .post(`/complaints/${complaintId}/visits`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ scheduledAt: tomorrow() });
    expect(booked.status).toBe(201);

    return { centreId: String(centre._id), complaintId };
  }

  it('shows Admin every centre, and filters to one', async () => {
    await complaintWithVisit('SN-V9');
    const other = await secondCentreVisit();

    const all = await request(app).get('/visits').set('Authorization', `Bearer ${c.admin}`);
    expect(all.body.total).toBe(2);

    const one = await request(app)
      .get(`/visits?serviceCenterId=${other.centreId}`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(one.body.total).toBe(1);
    expect(one.body.items[0].complaint.id).toBe(other.complaintId);
  });

  it('names the technician and the service center on each visit', async () => {
    /* Admin's schedule spans every centre; looking names up from a technician
       list would cap out, and "Technician" beside every row says nothing. */
    await complaintWithVisit('SN-V10');
    await secondCentreVisit();

    const res = await request(app).get('/visits').set('Authorization', `Bearer ${c.admin}`);

    const names = res.body.items.map((v: { technicianName: string; serviceCenterName: string }) => [
      v.technicianName,
      v.serviceCenterName,
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        ['Technician', 'Service Center JAI-01'],
        ['Other Technician', 'Service Center JAI-70'],
      ]),
    );
  });

  it('accepts several statuses at once', async () => {
    await complaintWithVisit('SN-V11');
    const cancelledComplaint = await complaintWithVisit('SN-V12');
    const toCancel = await Visit.findOne({ complaintId: cancelledComplaint }).lean().exec();

    const cancelled = await request(app)
      .post(`/visits/${toCancel!._id}/cancel`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ reason: 'Customer called the helpline to cancel' });
    expect(cancelled.status).toBe(200);

    const finished = await request(app)
      .get('/visits?status=COMPLETED,CANCELLED')
      .set('Authorization', `Bearer ${c.admin}`);
    expect(finished.body.total).toBe(1);
    expect(finished.body.items[0].status).toBe('CANCELLED');

    const both = await request(app)
      .get('/visits?status=SCHEDULED,CANCELLED')
      .set('Authorization', `Bearer ${c.admin}`);
    expect(both.body.total).toBe(2);

    const wrong = await request(app)
      .get('/visits?status=SCHEDULED,LOST')
      .set('Authorization', `Bearer ${c.admin}`);
    expect(wrong.status).toBe(400);
  });

  it('lets Admin move a visit when the customer calls the helpline', async () => {
    await complaintWithVisit('SN-V13');
    const visit = await Visit.findOne({}).lean().exec();

    const res = await request(app)
      .post(`/visits/${visit!._id}/reschedule`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ scheduledAt: hoursFromNow(50), reason: 'Customer asked for the weekend' });

    expect(res.status).toBe(200);
    const after = await Visit.findById(visit!._id).lean().exec();
    expect(after!.rescheduleHistory).toHaveLength(1);
  });
});

describe('my jobs (section 10)', () => {
  it('groups the technician\'s work into the buckets the spec lists', async () => {
    /**
     * "Today" is pinned explicitly rather than expressed as `now + 3 hours`.
     *
     * A relative offset made this test time-dependent: run it after 21:00 and
     * `now + 3h` lands tomorrow, so the visit bucketed as upcoming and the
     * assertion failed for reasons that had nothing to do with the code. The
     * scheduling endpoint refuses past dates, so the visit is created for
     * tomorrow and then moved to a fixed hour today — bucketing is what this
     * test is about, not the past-date guard.
     */
    await complaintWithVisit('SN-J1', tomorrow());
    await complaintWithVisit('SN-J2', hoursFromNow(72)); // definitely upcoming

    const first = await Visit.findOne({}).sort({ createdAt: 1 }).exec();
    await Visit.updateOne({ _id: first!._id }, { $set: { scheduledAt: noonToday() } });

    const res = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(200);
    expect(res.body.counts.today).toBe(1);
    expect(res.body.counts.upcoming).toBe(1);
    expect(res.body.today[0].complaint.customerMobile).toBe('9811111111');
  });

  it('moves a job to in-progress once started', async () => {
    const id = await complaintWithVisit('SN-J3', hoursFromNow(2));
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({});

    const res = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.body.counts.inProgress).toBe(1);
    expect(res.body.counts.today).toBe(0);
  });

  it('surfaces revisits even before a new visit is scheduled', async () => {
    const id = await complaintWithVisit('SN-J4', hoursFromNow(2));
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({});
    await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({
        diagnosis: { problemFound: 'Loose wire' },
        workPerformed: { details: 'Tightened' },
        resolution: { result: 'Seems fine' },
      });
    await request(app)
      .post(`/complaints/${id}/review-resolution`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ outcome: 'REVISIT_REQUIRED', reason: 'Still warm' });

    const res = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.tech}`);

    /* Revisit is a complaint state, not a visit one — the return trip has not
       been scheduled yet. Without this the technician would be surprised by a
       job appearing tomorrow. */
    expect(res.body.counts.revisitRequired).toBe(1);
    expect(res.body.revisitRequired[0].complaint.complaintNumber).toMatch(/^CMP-/);
  });

  it('shows one technician nothing of another\'s queue', async () => {
    await complaintWithVisit('SN-J5', hoursFromNow(2));

    await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000052',
      serviceCenterId: c.world.center._id,
    });

    const res = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${await token('9800000052')}`);

    expect(res.body.counts.today).toBe(0);
  });

  it('is not available to an owner', async () => {
    const res = await request(app)
      .get('/visits/my-jobs')
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/technicians/i);
  });
});

describe('complaint timeline (section 17)', () => {
  it('returns the story oldest first', async () => {
    const id = await complaintWithVisit('SN-T1');

    const res = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    const actions = res.body.items.map((e: { action: string }) => e.action);

    /* A timeline is read as a story, so creation comes first. */
    expect(actions[0]).toBe('COMPLAINT_CREATED');
    expect(actions).toContain('TECHNICIAN_ASSIGNED');
    expect(actions).toContain('VISIT_SCHEDULED');
  });

  it('records who did each thing, and their role', async () => {
    const id = await complaintWithVisit('SN-T2');

    const res = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.admin}`);

    const assigned = res.body.items.find(
      (e: { action: string }) => e.action === 'TECHNICIAN_ASSIGNED',
    );

    /* Section 17: actor, role, timestamp. */
    expect(assigned.actorName).toBe('Owner');
    expect(assigned.actorRole).toBe('SERVICE_CENTER_OWNER');
    expect(assigned.at).toBeTruthy();
  });

  it('records old and new values for a status change', async () => {
    const id = await complaintWithVisit('SN-T3');

    const res = await request(app)
      .get(`/complaints/${id}/timeline?action=STATUS_CHANGED`)
      .set('Authorization', `Bearer ${c.admin}`);

    const change = res.body.items[0];
    expect(change.fieldChanged).toBe('status');
    expect(change.oldValue).toBeTruthy();
    expect(change.newValue).toBeTruthy();
  });

  it('is visible to the technician working the job', async () => {
    const id = await complaintWithVisit('SN-T4');

    const res = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('returns not-found for a complaint outside the caller\'s scope', async () => {
    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-51',
    );
    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-T5',
        category: 'x',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
        serviceCenterId: String(otherCentre._id),
      });

    /* Not an empty timeline, which would confirm the complaint exists. */
    const res = await request(app)
      .get(`/complaints/${created.body.complaint.id}/timeline`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.status).toBe(404);
  });
});

describe('system audit log (section 17)', () => {
  it('records logins and is readable by Admin', async () => {
    const res = await request(app)
      .get('/audit?action=LOGIN_SUCCESS')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('is Admin only', async () => {
    /* It spans every service center, so there is no sensible scoping of it
       and showing it to an Owner would leak other centres' activity. */
    for (const tok of [c.owner, c.tech]) {
      const res = await request(app).get('/audit').set('Authorization', `Bearer ${tok}`);
      expect(res.status).toBe(403);
    }
  });

  it('filters by entity', async () => {
    await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Audited', code: 'AUDITED' });

    const res = await request(app)
      .get('/audit?entityType=Territory')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.items[0].action).toBe('TERRITORY_CREATED');
  });
});

describe('SLA settings (section 14)', () => {
  it('returns the four rules in severity order, in hours', async () => {
    const res = await request(app)
      .get('/sla-rules')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { priority: string }) => r.priority)).toEqual([
      'LOW',
      'NORMAL',
      'HIGH',
      'CRITICAL',
    ]);

    /* Section 14's own table. */
    const critical = res.body.items.find(
      (r: { priority: string }) => r.priority === 'CRITICAL',
    );
    expect(critical.responseHours).toBe(2);
    expect(critical.resolutionHours).toBe(8);
  });

  it('lets Admin tighten a window', async () => {
    const res = await request(app)
      .patch('/sla-rules/CRITICAL')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ responseHours: 1, resolutionHours: 4 });

    expect(res.status).toBe(200);
    expect(res.body.rule.responseHours).toBe(1);

    const stored = await SlaRule.findOne({ priority: 'CRITICAL' }).lean().exec();
    /* Stored in minutes, so a sub-hour target later is a data change. */
    expect(stored!.responseMinutes).toBe(60);
  });

  it('accepts a target shorter than an hour', async () => {
    const res = await request(app)
      .patch('/sla-rules/CRITICAL')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ responseHours: 0.5 });

    expect(res.status).toBe(200);
    const stored = await SlaRule.findOne({ priority: 'CRITICAL' }).lean().exec();
    expect(stored!.responseMinutes).toBe(30);
  });

  it('refuses a resolution window shorter than its response window', async () => {
    /* It would mean the complaint is late to resolve before it is late to
       answer. */
    const res = await request(app)
      .patch('/sla-rules/LOW')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ responseHours: 48, resolutionHours: 24 });

    expect(res.status).toBe(400);
  });

  it('does not change deadlines on complaints that already exist', async () => {
    const id = await complaintWithVisit('SN-SLA1', null);

    const before = await request(app)
      .get(`/complaints/${id}`)
      .set('Authorization', `Bearer ${c.admin}`);
    const originalDue = before.body.complaint.sla.resolutionDueAt;

    await request(app)
      .patch('/sla-rules/NORMAL')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ resolutionHours: 4 });

    const after = await request(app)
      .get(`/complaints/${id}`)
      .set('Authorization', `Bearer ${c.admin}`);

    /* Tightening policy must not retroactively breach work delivered on time
       under the old one. */
    expect(after.body.complaint.sla.resolutionDueAt).toBe(originalDue);
  });

  it('applies the new window to complaints created afterwards', async () => {
    await request(app)
      .patch('/sla-rules/NORMAL')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ responseHours: 1, resolutionHours: 6 });

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-SLA2',
        category: 'x',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
      });

    const sla = created.body.complaint.sla;
    const hours =
      (new Date(sla.resolutionDueAt).getTime() -
        new Date(created.body.complaint.createdAt).getTime()) /
      3_600_000;

    expect(Math.round(hours)).toBe(6);
  });

  it('is readable by all roles but writable only by Admin', async () => {
    expect(
      (await request(app).get('/sla-rules').set('Authorization', `Bearer ${c.tech}`)).status,
    ).toBe(200);

    const write = await request(app)
      .patch('/sla-rules/LOW')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ responseHours: 1 });
    expect(write.status).toBe(403);
  });
});
