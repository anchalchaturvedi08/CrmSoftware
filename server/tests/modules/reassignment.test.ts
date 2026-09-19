/**
 * Moving work between centres and technicians (DECISIONS.md section 29).
 *
 * Every case here is a dead end the pre-launch review walked into: a reopened
 * complaint that could never be assigned, a moved complaint whose booked
 * visit stayed behind, a centre deactivated with jobs in progress that Admin
 * could not move, a "Resume work" that led nowhere, and technicians put on
 * closed complaints. Each test drives the real routes to the state in question
 * and checks the way out works.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  Complaint,
  ComplaintActivity,
  PartRequest,
  SlaRule,
  User,
  Visit,
} from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  other: { centreId: string; technicianId: string };
  admin: string;
  owner: string;
  tech: string;
  secondTech: { id: string; token: string };
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  const centre = await makeServiceCenter(world.city._id, world.territory._id, 'JAI-02');
  const otherTech = await makeUser({
    role: 'TECHNICIAN',
    mobile: '9800000013',
    name: 'Other Centre Tech',
    serviceCenterId: centre._id,
  });
  const second = await makeUser({
    role: 'TECHNICIAN',
    mobile: '9800000004',
    name: 'Second Tech',
    serviceCenterId: world.center._id,
  });

  c = {
    world,
    other: { centreId: String(centre._id), technicianId: String(otherTech._id) },
    admin: await token('9800000001'),
    owner: await token('9800000002'),
    tech: await token('9800000003'),
    secondTech: { id: String(second._id), token: await token('9800000004') },
  };
});

const as = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });

async function post(path: string, bearer: string, body: object = {}) {
  return request(app).post(path).set(as(bearer)).send(body);
}

async function statusOf(id: string): Promise<string> {
  return (await Complaint.findById(id).lean().exec())!.status;
}

async function newComplaint(withCentre = true): Promise<string> {
  const res = await post('/complaints', c.admin, {
    customerId: String(c.world.customer._id),
    productId: String(c.world.product._id),
    productModelId: String(c.world.productModel._id),
    serialNumber: `SN-RA-${Math.random().toString(36).slice(2, 8)}`,
    category: 'Not cooling',
    description: 'Warm air.',
    priority: 'HIGH',
    warrantyStatus: 'IN_WARRANTY',
    ...(withCentre ? { serviceCenterId: String(c.world.center._id) } : {}),
  });
  expect(res.status).toBe(201);
  return res.body.complaint.id as string;
}

/** Centre, technician and a booked visit. */
async function booked(): Promise<string> {
  const id = await newComplaint();
  expect((await post(`/complaints/${id}/assign-technician`, c.owner, { technicianId: String(c.world.technician._id) })).status).toBe(200);
  expect((await post(`/complaints/${id}/visits`, c.owner, { scheduledAt: tomorrow() })).status).toBe(201);
  return id;
}

/** The technician on site, visit under way. */
async function onSite(): Promise<string> {
  const id = await booked();
  const started = await post(`/complaints/${id}/start-visit`, c.tech, { customerAvailability: 'CUSTOMER_AVAILABLE' });
  expect(started.status).toBe(200);
  return id;
}

const RESOLUTION = {
  diagnosis: { problemFound: 'Pump seized' },
  workPerformed: { details: 'Replaced pump' },
  resolution: { result: 'Fixed — cooling normally' },
};

describe('assigning a reopened complaint', () => {
  it('assigns a complaint reopened before it ever had a centre, with no reason', async () => {
    const id = await newComplaint(false);
    expect((await post(`/complaints/${id}/cancel`, c.admin, { reason: 'Customer called twice' })).status).toBe(200);
    expect((await post(`/complaints/${id}/reopen`, c.admin, { reason: 'Cancelled by mistake' })).status).toBe(200);

    /* Not asserted through `nextActions`: like a NEW complaint, the move needs
       the centre the action itself supplies, so the screen offers "Assign
       service center" from the status (a reopened complaint with no centre). */
    const assigned = await post(`/complaints/${id}/assign-service-center`, c.admin, {
      serviceCenterId: String(c.world.center._id),
    });
    expect(assigned.status).toBe(200);
    expect(await statusOf(id)).toBe('ASSIGNED');
  });

  it('needs a reason to move a reopened complaint to a different centre', async () => {
    const id = await newComplaint();
    await Complaint.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'CLOSED', closedAt: new Date(), closedBy: c.world.admin._id } },
    );
    expect((await post(`/complaints/${id}/reopen`, c.admin, { reason: 'Fault came back' })).status).toBe(200);

    const bare = await post(`/complaints/${id}/assign-service-center`, c.admin, { serviceCenterId: c.other.centreId });
    expect(bare.status).toBe(400);
    expect(bare.body.error.message).toMatch(/reason is required/i);

    const moved = await post(`/complaints/${id}/assign-service-center`, c.admin, {
      serviceCenterId: c.other.centreId,
      reason: 'Closer centre',
    });
    expect(moved.status).toBe(200);
    expect(await statusOf(id)).toBe('ASSIGNED');
  });
});

describe('moving a complaint to another centre', () => {
  it('cancels the booked visit and withdraws part requests not yet issued', async () => {
    const id = await onSite();
    const [pad, pump, motor] = c.world.parts;

    for (const part of [pad!, pump!, motor!]) {
      const res = await post(`/complaints/${id}/part-requests`, c.tech, { partId: String(part._id), quantityRequested: 1 });
      expect(res.status).toBe(201);
    }
    /* One already issued stays on record against the centre that supplied it. */
    await PartRequest.updateOne({ complaintId: id, partId: motor!._id }, { $set: { status: 'ISSUED', quantityIssued: 1 } });

    const moved = await post(`/complaints/${id}/assign-service-center`, c.admin, {
      serviceCenterId: c.other.centreId,
      reason: 'Centre closing down',
    });
    expect(moved.status).toBe(200);

    const complaint = await Complaint.findById(id).lean().exec();
    expect(complaint!.status).toBe('ASSIGNED');
    expect(String(complaint!.serviceCenterId)).toBe(c.other.centreId);
    expect(complaint!.technicianId).toBeUndefined();

    const visits = await Visit.find({ complaintId: id }).lean().exec();
    expect(visits.map((v) => v.status)).toEqual(['CANCELLED']);
    expect(visits[0]!.cancellationReason).toMatch(/Moved to Service Center JAI-02: Centre closing down/);

    const requests = await PartRequest.find({ complaintId: id }).lean().exec();
    expect(requests.map((r) => r.status).sort()).toEqual(['CANCELLED', 'CANCELLED', 'ISSUED']);

    const actions = (await ComplaintActivity.find({ complaintId: id }).lean().exec()).map((a) => a.action);
    expect(actions).toContain('VISIT_CANCELLED');
    expect(actions.filter((a) => a === 'PARTS_REQUEST_CANCELLED')).toHaveLength(2);

    /* The old centre's schedule is clear; the new centre starts clean. */
    const oldSchedule = await request(app).get('/visits').query({ status: 'SCHEDULED,IN_PROGRESS' }).set(as(c.owner));
    expect(oldSchedule.body.total).toBe(0);
  });

  it('lets Admin move work in progress, on hold, sent back or submitted — but not accepted work', async () => {
    const inProgress = await onSite();

    const onHold = await onSite();
    expect((await post(`/complaints/${onHold}/waiting-for-parts`, c.tech, { reason: 'Pump out of stock' })).status).toBe(200);

    const submitted = await onSite();
    expect((await post(`/complaints/${submitted}/resolution`, c.tech, RESOLUTION)).status).toBe(200);

    const sentBack = await onSite();
    expect((await post(`/complaints/${sentBack}/resolution`, c.tech, RESOLUTION)).status).toBe(200);
    expect((await post(`/complaints/${sentBack}/review-resolution`, c.owner, { outcome: 'REVISIT_REQUIRED', reason: 'Still warm' })).status).toBe(200);

    for (const id of [inProgress, onHold, submitted, sentBack]) {
      const res = await post(`/complaints/${id}/assign-service-center`, c.admin, {
        serviceCenterId: c.other.centreId,
        reason: 'Centre deactivated',
      });
      expect(res.status, await statusOf(id)).toBe(200);
      expect(await statusOf(id)).toBe('ASSIGNED');
    }

    const accepted = await onSite();
    expect((await post(`/complaints/${accepted}/resolution`, c.tech, RESOLUTION)).status).toBe(200);
    expect((await post(`/complaints/${accepted}/review-resolution`, c.owner, { outcome: 'ACCEPTED' })).status).toBe(200);
    const refused = await post(`/complaints/${accepted}/assign-service-center`, c.admin, {
      serviceCenterId: c.other.centreId,
      reason: 'Centre deactivated',
    });
    expect(refused.status).toBe(409);
  });

  it('restarts a clock paused on hold', async () => {
    await SlaRule.updateMany({}, { $set: { pauseOnWaitingParts: true } });
    const id = await onSite();
    expect((await post(`/complaints/${id}/waiting-for-parts`, c.tech, { reason: 'Pump out of stock' })).status).toBe(200);
    expect((await Complaint.findById(id).lean().exec())!.sla.state).toBe('PAUSED');

    await post(`/complaints/${id}/assign-service-center`, c.admin, { serviceCenterId: c.other.centreId, reason: 'Moving' });
    expect((await Complaint.findById(id).lean().exec())!.sla.state).toBe('RUNNING');
  });

  it('lets the new centre book and its technician start a visit', async () => {
    const id = await booked();
    await post(`/complaints/${id}/assign-service-center`, c.admin, { serviceCenterId: c.other.centreId, reason: 'Moving' });

    await makeUser({ role: 'SERVICE_CENTER_OWNER', mobile: '9800000012', name: 'Other Owner', serviceCenterId: new mongoose.Types.ObjectId(c.other.centreId) });
    const otherOwner = await token('9800000012');
    const otherTech = await token('9800000013');

    expect((await post(`/complaints/${id}/assign-technician`, otherOwner, { technicianId: c.other.technicianId })).status).toBe(200);
    expect((await post(`/complaints/${id}/visits`, otherOwner, { scheduledAt: tomorrow() })).status).toBe(201);
    const started = await post(`/complaints/${id}/start-visit`, otherTech, { customerAvailability: 'CUSTOMER_AVAILABLE' });
    expect(started.status).toBe(200);
  });
});

describe('changing the technician', () => {
  it('ends the previous technician’s visit under way, so nothing is left that nobody can finish', async () => {
    const id = await onSite();
    expect((await post(`/complaints/${id}/waiting-for-parts`, c.tech, { reason: 'Pump out of stock' })).status).toBe(200);

    const moved = await post(`/complaints/${id}/assign-technician`, c.owner, { technicianId: c.secondTech.id, reason: 'Ravi is ill' });
    expect(moved.status).toBe(200);

    const visits = await Visit.find({ complaintId: id }).lean().exec();
    expect(visits.map((v) => v.status)).toEqual(['CANCELLED']);

    /* Nothing under way, so there is nothing to resume: book a follow-up. */
    const resume = await post(`/complaints/${id}/resume-work`, c.owner);
    expect(resume.status).toBe(409);
    expect(resume.body.error.message).toMatch(/book a follow-up visit/i);

    const followUp = await post(`/complaints/${id}/visits`, c.owner, { scheduledAt: tomorrow() });
    expect(followUp.status).toBe(201);
    const started = await post(`/complaints/${id}/start-visit`, c.secondTech.token, { customerAvailability: 'CUSTOMER_AVAILABLE' });
    expect(started.status).toBe(200);
    expect((await post(`/complaints/${id}/resolution`, c.secondTech.token, RESOLUTION)).status).toBe(200);
  });

  it('still resumes the technician’s own visit after a hold', async () => {
    const id = await onSite();
    expect((await post(`/complaints/${id}/waiting-for-parts`, c.tech, { reason: 'Pump out of stock' })).status).toBe(200);
    expect((await post(`/complaints/${id}/resume-work`, c.tech)).status).toBe(200);
    expect((await post(`/complaints/${id}/resolution`, c.tech, RESOLUTION)).status).toBe(200);
  });

  it('refuses a technician on closed, cancelled or submitted work', async () => {
    const submitted = await onSite();
    expect((await post(`/complaints/${submitted}/resolution`, c.tech, RESOLUTION)).status).toBe(200);
    const onSubmitted = await post(`/complaints/${submitted}/assign-technician`, c.owner, { technicianId: c.secondTech.id });
    expect(onSubmitted.status).toBe(409);

    const cancelled = await booked();
    expect((await post(`/complaints/${cancelled}/cancel`, c.admin, { reason: 'Duplicate complaint' })).status).toBe(200);
    const onCancelled = await post(`/complaints/${cancelled}/assign-technician`, c.owner, { technicianId: c.secondTech.id });
    expect(onCancelled.status).toBe(409);
    expect(onCancelled.body.error.message).toMatch(/cancelled/i);

    const closed = await booked();
    await Complaint.collection.updateOne({ _id: new mongoose.Types.ObjectId(closed) }, { $set: { status: 'CLOSED' } });
    const onClosed = await post(`/complaints/${closed}/assign-technician`, c.owner, { technicianId: c.secondTech.id });
    expect(onClosed.status).toBe(409);
    expect(onClosed.body.error.message).toMatch(/closed/i);
  });
});

describe('what the timeline and errors say', () => {
  it('records a cancelled visit as cancelled, and keeps the booking note with a reason', async () => {
    const id = await booked();
    const visit = await Visit.findOne({ complaintId: id }).lean().exec();

    const cancelled = await request(app)
      .post(`/visits/${visit!._id}/cancel`)
      .set(as(c.owner))
      .send({ reason: 'Customer travelling' });
    expect(cancelled.status).toBe(200);

    const entry = await ComplaintActivity.findOne({ complaintId: id, action: 'VISIT_CANCELLED' }).lean().exec();
    expect(entry?.note).toBe('Visit 1 cancelled — Customer travelling');

    await post(`/complaints/${id}/visits`, c.owner, { scheduledAt: tomorrow(), reason: 'Customer back Friday' });
    const scheduled = await ComplaintActivity.find({ complaintId: id, action: 'VISIT_SCHEDULED' }).sort({ createdAt: -1 }).lean().exec();
    expect(scheduled[0]?.note).toMatch(/^Visit 2 scheduled for .+ — Customer back Friday$/);
  });

  it('says what is wrong with a request, not just that it failed', async () => {
    const id = await booked();
    const short = await post(`/complaints/${id}/assign-technician`, c.owner, { technicianId: c.secondTech.id, reason: 'ok' });
    expect(short.status).toBe(400);
    expect(short.body.error.message).toBe('Please give a reason of at least 3 characters');
    expect(short.body.error.issues[0].field).toBe('reason');
  });

  it('names a deactivated technician instead of a failed record', async () => {
    const id = await newComplaint();
    await post(`/complaints/${id}/assign-technician`, c.owner, { technicianId: String(c.world.technician._id) });
    await User.updateOne({ _id: c.world.technician._id }, { $set: { isActive: false } });

    const res = await post(`/complaints/${id}/visits`, c.owner, { scheduledAt: tomorrow() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Technician is deactivated\. Reassign the job/);
  });
});
