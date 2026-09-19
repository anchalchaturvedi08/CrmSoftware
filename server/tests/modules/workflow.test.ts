/**
 * Workflow transition tests (spec sections 7, 9, 10, 22, Workflows B-G).
 *
 * The centrepiece is the first test: one complaint driven from creation to
 * closure by three different roles, each doing only what the spec grants them.
 * If that walk ever breaks, the product does not work, whatever else passes.
 *
 * The rest cover the refusals — the cases where the backend has to say no.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint, ComplaintActivity, Visit } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();

/** Tomorrow, so visit scheduling never trips the past-date guard. */
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();

async function token(mobile: string): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

interface Session {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
  owner: string;
  tech: string;
}

let s: Session;

beforeEach(async () => {
  const world = await seedWorld();
  s = {
    world,
    admin: await token('9800000001'),
    owner: await token('9800000002'),
    tech: await token('9800000003'),
  };
});

/** Creates a complaint, optionally already assigned to the seeded centre. */
async function createComplaint(withCentre = false): Promise<string> {
  const res = await request(app)
    .post('/complaints')
    .set('Authorization', `Bearer ${s.admin}`)
    .send({
      customerId: String(s.world.customer._id),
      productId: String(s.world.product._id),
      productModelId: String(s.world.productModel._id),
      serialNumber: 'SN-WF-1',
      category: 'Not cooling',
      description: 'Warm air.',
      priority: 'HIGH',
      warrantyStatus: 'IN_WARRANTY',
      ...(withCentre ? { serviceCenterId: String(s.world.center._id) } : {}),
    });

  return res.body.complaint.id as string;
}

/** Drives a complaint all the way to ADMIN_CONFIRMATION. */
async function driveToConfirmation(id: string): Promise<void> {
  await request(app)
    .post(`/complaints/${id}/assign-service-center`)
    .set('Authorization', `Bearer ${s.admin}`)
    .send({ serviceCenterId: String(s.world.center._id) });

  await request(app)
    .post(`/complaints/${id}/assign-technician`)
    .set('Authorization', `Bearer ${s.owner}`)
    .send({ technicianId: String(s.world.technician._id) });

  await request(app)
    .post(`/complaints/${id}/visits`)
    .set('Authorization', `Bearer ${s.owner}`)
    .send({ scheduledAt: tomorrow() });

  await request(app)
    .post(`/complaints/${id}/start-visit`)
    .set('Authorization', `Bearer ${s.tech}`)
    .send({ customerAvailability: 'CUSTOMER_AVAILABLE' });

  await request(app)
    .post(`/complaints/${id}/resolution`)
    .set('Authorization', `Bearer ${s.tech}`)
    .send({
      diagnosis: { problemFound: 'Pump seized' },
      workPerformed: { details: 'Replaced pump' },
      resolution: { result: 'Cooling restored' },
    });

  await request(app)
    .post(`/complaints/${id}/review-resolution`)
    .set('Authorization', `Bearer ${s.owner}`)
    .send({ outcome: 'ACCEPTED' });
}

describe('the full lifecycle', () => {
  it('walks a complaint from NEW to CLOSED across all three roles', async () => {
    const id = await createComplaint();

    const statusOf = async (): Promise<string> =>
      (await Complaint.findById(id).lean().exec())!.status;

    expect(await statusOf()).toBe('NEW');

    /* Admin selects the centre (section 8). */
    const assigned = await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ serviceCenterId: String(s.world.center._id) });
    expect(assigned.status).toBe(200);
    expect(await statusOf()).toBe('ASSIGNED');

    /* Owner assigns a technician (Workflow B). */
    const tech = await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });
    expect(tech.status).toBe(200);
    expect(await statusOf()).toBe('TECHNICIAN_ASSIGNED');

    /* Owner schedules the visit. */
    const scheduled = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: tomorrow() });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.visit.sequence).toBe(1);
    expect(await statusOf()).toBe('VISIT_SCHEDULED');

    /* Technician starts (Workflow C step 3). */
    const started = await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${s.tech}`)
      .send({ customerAvailability: 'CUSTOMER_AVAILABLE' });
    expect(started.status).toBe(200);
    expect(started.body.visit.startedAt).toBeTruthy();
    expect(await statusOf()).toBe('IN_PROGRESS');

    /* Technician submits (Workflow C step 10). */
    const submitted = await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${s.tech}`)
      .send({
        diagnosis: { problemFound: 'Pump seized' },
        workPerformed: { details: 'Replaced pump, flushed tank' },
        resolution: { result: 'Cooling restored' },
      });
    expect(submitted.status).toBe(200);
    expect(await statusOf()).toBe('RESOLUTION_SUBMITTED');

    /* Owner accepts — and this must land on ADMIN_CONFIRMATION, not CLOSED. */
    const reviewed = await request(app)
      .post(`/complaints/${id}/review-resolution`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ outcome: 'ACCEPTED' });
    expect(reviewed.status).toBe(200);
    expect(await statusOf()).toBe('ADMIN_CONFIRMATION');

    /* Admin reads the code off the customer and verifies it. */
    const whatsapp = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${s.admin}`);

    const verified = await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: whatsapp.body.happyCode });
    expect(verified.body.verified).toBe(true);

    /* Admin closes. */
    const closed = await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${s.admin}`);
    expect(closed.status).toBe(200);
    expect(await statusOf()).toBe('CLOSED');

    const finalDoc = (await Complaint.findById(id).lean().exec())!;
    expect(finalDoc.closedAt).toBeTruthy();
    expect(finalDoc.sla.state).toBe('COMPLETED');
  });

  it('records the whole journey on the timeline', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    const actions = (
      await ComplaintActivity.find({ complaintId: id }).sort({ createdAt: 1 }).lean().exec()
    ).map((e) => e.action);

    /* Section 17 names these events explicitly. */
    for (const expected of [
      'COMPLAINT_CREATED',
      'SERVICE_CENTER_SELECTED',
      'TECHNICIAN_ASSIGNED',
      'VISIT_SCHEDULED',
      'VISIT_STARTED',
      'DIAGNOSIS_ADDED',
      'WORK_RECORDED',
      'RESOLUTION_SUBMITTED',
      'STATUS_CHANGED',
    ]) {
      expect(actions, `timeline should contain ${expected}`).toContain(expected);
    }
  });
});

describe('section 22 refusals, over HTTP', () => {
  it('refuses a technician trying to close', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    const res = await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${s.tech}`);

    expect(res.status).toBe(403);
  });

  it('refuses a service center owner trying to close from ADMIN_CONFIRMATION', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    const res = await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${s.owner}`);

    expect(res.status).toBe(403);
  });

  it('blocks closure until the Happy Code is verified', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    /* Section 22: "Happy Code mismatch: Admin cannot close complaint." */
    const res = await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${s.admin}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Happy Code must be verified/);
    expect((await Complaint.findById(id).lean().exec())!.status).toBe(
      'ADMIN_CONFIRMATION',
    );
  });

  it('refuses a technician starting someone else\'s visit', async () => {
    const id = await createComplaint();

    await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ serviceCenterId: String(s.world.center._id) });
    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });
    await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: tomorrow() });

    /* A second technician at the same centre, not the assignee. */
    await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000007',
      serviceCenterId: s.world.center._id,
    });

    const res = await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${await token('9800000007')}`)
      .send({});

    /**
     * 404, not 403 — and that is the stronger answer.
     *
     * `complaintScope` restricts a technician to their own assigned jobs
     * (section 3.3), so this complaint is not merely off limits, it is
     * invisible. A 403 would confirm it exists and let one technician probe
     * a colleague's workload by iterating identifiers.
     */
    expect(res.status).toBe(404);
  });

  it('moves a pending visit when the technician is reassigned', async () => {
    const id = await createComplaint(true);
    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });
    await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: tomorrow() });

    const replacement = await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000006',
      serviceCenterId: s.world.center._id,
    });

    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(replacement._id), reason: 'Original tech off sick' });

    /* Without moving the visit the complaint would strand: the old technician
       can no longer see it, and the new one would be refused for starting
       someone else's visit. */
    const visit = await Visit.findOne({ complaintId: id, status: 'SCHEDULED' })
      .lean()
      .exec();
    expect(String(visit!.technicianId)).toBe(String(replacement._id));

    const started = await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${await token('9800000006')}`)
      .send({});
    expect(started.status).toBe(200);
  });

  it('refuses an owner assigning another center\'s technician', async () => {
    const id = await createComplaint(true);

    const otherCentre = await makeServiceCenter(
      s.world.city._id,
      s.world.territory._id,
      'JAI-09',
    );
    const outsider = await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000008',
      serviceCenterId: otherCentre._id,
    });

    /* Scope proves the Owner may touch this complaint; it does not make
       another centre's staff theirs to direct. */
    const res = await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(outsider._id) });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/different service center/i);
  });

  it('will not schedule a visit in the past', async () => {
    const id = await createComplaint(true);
    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });

    const res = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: new Date(Date.now() - 86_400_000).toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'scheduledAt' })]),
    );
  });
});

describe('Happy Code verification', () => {
  it('reports a wrong code as 200 with attempts remaining', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    const res = await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: '000000' });

    /* A wrong code read over the phone is an expected outcome, not a fault. */
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.attemptsRemaining).toBe(4);
  });

  it('locks after five wrong attempts and can then be regenerated', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post(`/complaints/${id}/verify-happy-code`)
        .set('Authorization', `Bearer ${s.admin}`)
        .send({ code: '000000' });
    }

    const locked = await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: '000000' });
    expect(locked.status).toBe(423);

    /* The recovery path: issue a fresh code and send it again. */
    const fresh = await request(app)
      .post(`/complaints/${id}/regenerate-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.happyCode).toMatch(/^\d{6}$/);

    const verified = await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: fresh.body.happyCode });
    expect(verified.body.verified).toBe(true);
  });

  it('cannot be verified before the service center has accepted', async () => {
    const id = await createComplaint(true);

    const res = await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: '123456' });

    expect(res.status).toBe(409);
  });
});

describe('revisit loop (Workflow E)', () => {
  it('sends work back with a mandatory reason and accepts a second attempt', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    /* Roll back to RESOLUTION_SUBMITTED is not possible, so run a fresh one. */
    const second = await createComplaint();
    await request(app)
      .post(`/complaints/${second}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ serviceCenterId: String(s.world.center._id) });
    await request(app)
      .post(`/complaints/${second}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });
    await request(app)
      .post(`/complaints/${second}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: tomorrow() });
    await request(app)
      .post(`/complaints/${second}/start-visit`)
      .set('Authorization', `Bearer ${s.tech}`)
      .send({});
    await request(app)
      .post(`/complaints/${second}/resolution`)
      .set('Authorization', `Bearer ${s.tech}`)
      .send({
        diagnosis: { problemFound: 'Loose wire' },
        workPerformed: { details: 'Tightened' },
        resolution: { result: 'Seems fine' },
      });

    /* Reject without a reason — Workflow E step 4 makes it mandatory. */
    const noReason = await request(app)
      .post(`/complaints/${second}/review-resolution`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ outcome: 'REVISIT_REQUIRED' });
    expect(noReason.status).toBe(400);

    const rejected = await request(app)
      .post(`/complaints/${second}/review-resolution`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ outcome: 'REVISIT_REQUIRED', reason: 'Customer says still warm' });
    expect(rejected.status).toBe(200);
    expect((await Complaint.findById(second).lean().exec())!.status).toBe(
      'REVISIT_REQUIRED',
    );

    /* A revisit is a second Visit record, so the first trip's work survives. */
    await request(app)
      .post(`/complaints/${second}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: tomorrow() });

    const visits = await Visit.find({ complaintId: second }).sort({ sequence: 1 }).lean().exec();
    expect(visits).toHaveLength(2);
    expect(visits[0]!.workPerformed?.details).toBe('Tightened');
  });
});

describe('reopen (section 13, Workflow G)', () => {
  it('preserves the previous closure and issues a fresh code and clock', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    const whatsapp = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${s.admin}`);
    await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: whatsapp.body.happyCode });
    await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${s.admin}`);

    const before = (await Complaint.findById(id).lean().exec())!;

    const reopened = await request(app)
      .post(`/complaints/${id}/reopen`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ reason: 'Same fault returned within a week' });

    expect(reopened.status).toBe(200);
    const after = (await Complaint.findById(id).lean().exec())!;

    expect(after.status).toBe('REOPENED');
    /* Rule 15: the original complaint is not replaced. */
    expect(after.complaintNumber).toBe(before.complaintNumber);
    /* Rule 16 and section 22: the previous closure is retained. */
    expect(after.closureHistory).toHaveLength(1);
    expect(after.closureHistory[0]!.reopenReason).toMatch(/returned within a week/);
    expect(after.reopenCount).toBe(1);
    expect(after.closedAt).toBeUndefined();

    /* A fresh code, so the old one cannot close the reopened complaint. */
    expect(reopened.body.happyCode).toMatch(/^\d{6}$/);
    expect(reopened.body.happyCode).not.toBe(whatsapp.body.happyCode);
    expect(after.happyCode.verifiedAt).toBeUndefined();
    /* And a fresh clock, or it would read as breached from the moment it
       reopened. */
    expect(after.sla.state).toBe('RUNNING');
  });

  it('is Admin only', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);

    const res = await request(app)
      .post(`/complaints/${id}/reopen`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ reason: 'Customer called us directly' });

    expect(res.status).toBe(403);
  });

  it('can go back to the technician who did the original work', async () => {
    const id = await createComplaint();
    await driveToConfirmation(id);
    const whatsapp = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${s.admin}`);
    await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ code: whatsapp.body.happyCode });
    await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${s.admin}`);
    await request(app)
      .post(`/complaints/${id}/reopen`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ reason: 'Same fault returned within a week' });

    /* Reopening keeps the technician on the complaint, and sending them back
       is usually right — they know the unit. It was refused as "already
       assigned", which left a centre with one technician no way forward. */
    const assigned = await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });

    expect(assigned.status).toBe(200);
    expect(assigned.body.complaint.status).toBe('TECHNICIAN_ASSIGNED');

    const scheduled = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ scheduledAt: tomorrow() });
    expect(scheduled.status).toBe(201);
  });

  it('still refuses assigning the same technician when nothing would change', async () => {
    const id = await createComplaint(true);
    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });

    const again = await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });

    expect(again.status).toBe(400);
  });
});

describe('reassignment', () => {
  it('drops the technician when the service center changes', async () => {
    const id = await createComplaint(true);
    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${s.owner}`)
      .send({ technicianId: String(s.world.technician._id) });

    const otherCentre = await makeServiceCenter(
      s.world.city._id,
      s.world.territory._id,
      'JAI-10',
    );

    const res = await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({
        serviceCenterId: String(otherCentre._id),
        reason: 'Original center closed for the week',
      });

    expect(res.status).toBe(200);
    const after = (await Complaint.findById(id).lean().exec())!;

    /* The new centre has its own staff; carrying the old technician over
       would leave the job with someone who does not work there. */
    expect(after.status).toBe('ASSIGNED');
    expect(after.technicianId).toBeUndefined();
    expect(String(after.serviceCenterId)).toBe(String(otherCentre._id));
  });

  it('lets Admin correct a centre chosen by mistake, before any technician is assigned', async () => {
    /**
     * Found by clicking through the Admin UI, not by a test.
     *
     * Assigning a centre moves a complaint NEW -> ASSIGNED. If Admin picked the
     * wrong one, the only transitions the status machine offered from ASSIGNED
     * were "Owner assigns a technician" and "Admin cancels". So a simple
     * mis-click could only be fixed by cancelling the whole complaint, or by
     * waiting for the *wrong* centre to assign a technician first.
     *
     * Changing the centre while still ASSIGNED is not a status transition —
     * the status does not change — so it is handled like reassigning a
     * technician within a status: its own permission check and a timeline
     * entry, rather than an entry in the transition table.
     */
    const id = await createComplaint(true);
    expect((await Complaint.findById(id).lean().exec())!.status).toBe('ASSIGNED');

    const rightCentre = await makeServiceCenter(
      s.world.city._id,
      s.world.territory._id,
      'JAI-11',
    );

    const res = await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({
        serviceCenterId: String(rightCentre._id),
        reason: 'Assigned to the wrong centre by mistake',
      });

    expect(res.status).toBe(200);

    const after = (await Complaint.findById(id).lean().exec())!;
    expect(after.status).toBe('ASSIGNED');
    expect(String(after.serviceCenterId)).toBe(String(rightCentre._id));

    const actions = (await ComplaintActivity.find({ complaintId: id }).lean().exec()).map(
      (e) => e.action,
    );
    expect(actions).toContain('SERVICE_CENTER_REASSIGNED');
  });

  it('requires a reason to correct the centre while still ASSIGNED', async () => {
    const id = await createComplaint(true);
    const other = await makeServiceCenter(s.world.city._id, s.world.territory._id, 'JAI-12');

    const res = await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ serviceCenterId: String(other._id) });

    /* A reassignment moves work between businesses; the timeline must say why. */
    expect(res.status).toBe(400);
  });

  it('rejects reassigning to the center it is already with', async () => {
    const id = await createComplaint(true);

    const res = await request(app)
      .post(`/complaints/${id}/assign-service-center`)
      .set('Authorization', `Bearer ${s.admin}`)
      .send({ serviceCenterId: String(s.world.center._id), reason: 'no-op' });

    expect(res.status).toBe(400);
  });
});

describe('transaction integrity', () => {
  it('leaves the status unchanged when the transition is refused', async () => {
    const id = await createComplaint(true);

    /* Skipping straight to a resolution submission from ASSIGNED. */
    const res = await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${s.tech}`)
      .send({
        diagnosis: { problemFound: 'x' },
        workPerformed: { details: 'y' },
        resolution: { result: 'z' },
      });

    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = (await Complaint.findById(id).lean().exec())!;
    expect(after.status).toBe('ASSIGNED');

    /* And nothing partial was written to the timeline. */
    const actions = (await ComplaintActivity.find({ complaintId: id }).lean().exec()).map(
      (e) => e.action,
    );
    expect(actions).not.toContain('RESOLUTION_SUBMITTED');
    expect(actions).not.toContain('DIAGNOSIS_ADDED');
  });
});
