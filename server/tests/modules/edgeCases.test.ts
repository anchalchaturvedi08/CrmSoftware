/**
 * Spec section 22 edge cases that nothing else covered.
 *
 * Most of section 22's list is asserted elsewhere as a side effect of testing
 * the feature it belongs to. Three were not, and all three are about the
 * system continuing to work when something *outside* it is broken — a bad
 * phone number, an absent customer. Those are the cases a happy-path suite
 * never reaches and a real deployment hits in week one.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint, Customer, Visit } from '../../src/models/index.js';
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
      description: 'x',
      priority: 'NORMAL',
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: String(c.world.center._id),
    });
  return res.body.complaint.id as string;
}

/* ---- "Invalid customer phone" ----------------------------------------- */

describe('invalid or missing customer phone (sections 6.4, 22)', () => {
  /**
   * The API validates mobile numbers on the way in, so a bad one cannot be
   * *created* through it. It can still arrive from an import, a migration, or
   * a record that predates the validation — which is exactly when this path
   * matters, and exactly when nobody is watching.
   *
   * The snapshot on the complaint is deliberately unvalidated so history
   * survives, which is what makes the situation reachable.
   */
  it('disables the WhatsApp action and explains why', async () => {
    const id = await makeComplaint('SN-BADPHONE');

    /* Simulate imported data: a snapshot that is not a usable number. */
    await Complaint.updateOne(
      { _id: id },
      { $set: { 'customerSnapshot.mobile': '12345' } },
    );

    const res = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);

    /* 200 with `available: false`, not an error — the UI renders a disabled
       button with a reason (section 6.4). */
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/not a valid|correct the customer record/i);
    /* And no Happy Code is handed out on a link that cannot be sent. */
    expect(res.body.happyCode).toBeUndefined();
    expect(res.body.url).toBeUndefined();
  });

  it('says so plainly when there is no number at all', async () => {
    const id = await makeComplaint('SN-NOPHONE');
    await Complaint.updateOne({ _id: id }, { $set: { 'customerSnapshot.mobile': '' } });

    const res = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/no mobile number/i);
  });

  it('still records the view in the audit trail', async () => {
    const id = await makeComplaint('SN-BADPHONE2');
    await Complaint.updateOne({ _id: id }, { $set: { 'customerSnapshot.mobile': '1' } });

    await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);

    /* An Admin who looked at the code still looked at it, whether or not the
       link could be built. */
    const timeline = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.admin}`);

    const viewed = timeline.body.items.find(
      (e: { action: string }) => e.action === 'HAPPY_CODE_VIEWED',
    );
    expect(viewed).toBeTruthy();
    expect(viewed.note).toMatch(/WhatsApp is unavailable/i);
  });

  it('works again once the number is corrected', async () => {
    const id = await makeComplaint('SN-FIXPHONE');
    await Complaint.updateOne(
      { _id: id },
      { $set: { 'customerSnapshot.mobile': 'nonsense' } },
    );

    expect(
      (
        await request(app)
          .get(`/complaints/${id}/whatsapp`)
          .set('Authorization', `Bearer ${c.admin}`)
      ).body.available,
    ).toBe(false);

    /* Section 6.4: "Allow Admin to correct the number." */
    await Complaint.updateOne(
      { _id: id },
      { $set: { 'customerSnapshot.mobile': '9811111111' } },
    );

    const after = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(after.body.available).toBe(true);
    expect(after.body.url).toContain('wa.me/919811111111');
  });
});

/* ---- "WhatsApp unavailable: workflow continues normally" -------------- */

describe('WhatsApp unavailable does not block the workflow (section 22)', () => {
  it('closes a complaint whose WhatsApp link was never usable', async () => {
    /**
     * The scenario the Happy Code encryption decision exists for
     * (DECISIONS.md section 4.2). With a hashed code and a bad phone number,
     * this complaint could never be closed at all.
     */
    const id = await makeComplaint('SN-NOWHATSAPP');
    await Complaint.updateOne(
      { _id: id },
      { $set: { 'customerSnapshot.mobile': 'not-a-number' } },
    );

    /* The link is unavailable... */
    const link = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(link.body.available).toBe(false);

    /* ...but Admin can still issue a fresh code and read it, so the customer
       can be told over the phone. */
    const regenerated = await request(app)
      .post(`/complaints/${id}/regenerate-happy-code`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.happyCode).toMatch(/^\d{6}$/);

    /* And the whole workflow proceeds untouched. */
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
      .send({});
    await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({
        diagnosis: { problemFound: 'Pump seized' },
        workPerformed: { details: 'Replaced' },
        resolution: { result: 'Fixed' },
      });
    await request(app)
      .post(`/complaints/${id}/review-resolution`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ outcome: 'ACCEPTED' });

    const verified = await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ code: regenerated.body.happyCode });
    expect(verified.body.verified).toBe(true);

    const closed = await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${c.admin}`);

    /* Section 22: "WhatsApp unavailable: Complaint workflow continues
       normally; WhatsApp is only a helper." */
    expect(closed.status).toBe(200);
    expect(closed.body.complaint.status).toBe('CLOSED');
  });
});

/* ---- "Customer unavailable" ------------------------------------------- */

describe('customer unavailable (sections 10, 22)', () => {
  async function readyForVisit(serial: string): Promise<string> {
    const id = await makeComplaint(serial);
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

  it('records the outcome on the visit', async () => {
    const id = await readyForVisit('SN-ABSENT');

    /* Section 10 step 2: the technician records what they found. */
    const started = await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({
        customerAvailability: 'CUSTOMER_UNAVAILABLE',
        availabilityNote: 'Nobody home, phone unanswered',
      });

    expect(started.status).toBe(200);

    const visit = await Visit.findOne({ complaintId: id }).lean().exec();
    expect(visit!.customerAvailability).toBe('CUSTOMER_UNAVAILABLE');
    expect(visit!.availabilityNote).toMatch(/Nobody home/);
    /* The trip is a fact, so it is recorded as started even though no work
       happened. */
    expect(visit!.startedAt).toBeTruthy();
  });

  it('allows a reschedule rather than forcing a resolution', async () => {
    const id = await readyForVisit('SN-ABSENT2');
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ customerAvailability: 'RESCHEDULE_REQUIRED' });

    /* Section 22: "Customer unavailable: Record outcome and allow
       reschedule/revisit." The Owner sends it back to a scheduled visit
       rather than the technician inventing a resolution. */
    const rescheduled = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow(), reason: 'Customer was not at home' });

    expect(rescheduled.status).toBe(201);
    expect(rescheduled.body.complaint.status).toBe('VISIT_SCHEDULED');

    /* Two visits, so the wasted trip is still on the record — it is what the
       technician actually did that day. */
    const visits = await Visit.find({ complaintId: id }).sort({ sequence: 1 }).lean().exec();
    expect(visits).toHaveLength(2);
    expect(visits[0]!.customerAvailability).toBe('RESCHEDULE_REQUIRED');
  });

  it('puts the second visit on the timeline as its own event', async () => {
    const id = await readyForVisit('SN-ABSENT3');
    await request(app)
      .post(`/complaints/${id}/start-visit`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ customerAvailability: 'CUSTOMER_UNAVAILABLE' });
    await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: tomorrow(), reason: 'Customer absent' });

    const timeline = await request(app)
      .get(`/complaints/${id}/timeline`)
      .set('Authorization', `Bearer ${c.admin}`);

    const scheduled = timeline.body.items.filter(
      (e: { action: string }) => e.action === 'VISIT_SCHEDULED',
    );
    expect(scheduled.length).toBe(2);
  });
});

/* ---- A gap worth naming ------------------------------------------------ */

describe('customer record integrity', () => {
  it('will not accept an invalid mobile number through the API', async () => {
    /* The bad-phone cases above had to be created by writing directly to the
       database, because the API refuses one. Asserted here so the earlier
       tests are understood as covering *imported* data, not something a user
       can cause. */
    const res = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        name: 'Bad Number',
        mobile: '12345',
        address: 'x',
        cityId: String(c.world.city._id),
        state: 'Rajasthan',
        pincode: '302001',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'mobile' })]),
    );

    expect(await Customer.countDocuments({ name: 'Bad Number' })).toBe(0);
  });
});
