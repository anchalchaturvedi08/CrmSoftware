/**
 * Complaint endpoint tests (spec section 6, Workflow A).
 *
 * The properties worth proving here are the ones that would be expensive to
 * discover were wrong later: numbering is unique under load, the Happy Code
 * never leaks into a normal response, snapshots survive master-data edits,
 * service center scoping holds, and a failed creation leaves nothing behind.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  City,
  Complaint,
  ComplaintActivity,
  Customer,
  Product,
  ProductModel,
  ServiceCenter,
} from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();

async function tokenFor(mobile: string): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

/** A valid creation payload against the seeded world. */
function payload(world: Awaited<ReturnType<typeof seedWorld>>, overrides = {}) {
  return {
    customerId: String(world.customer._id),
    productId: String(world.product._id),
    productModelId: String(world.productModel._id),
    serialNumber: 'SN-0001',
    category: 'Not cooling',
    description: 'Cooler runs but air is warm.',
    priority: 'HIGH',
    warrantyStatus: 'IN_WARRANTY',
    ...overrides,
  };
}

describe('POST /complaints', () => {
  it('creates a complaint with a formatted number and a Happy Code', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    expect(res.status).toBe(201);
    /* Section 6.2 format. */
    expect(res.body.complaint.complaintNumber).toMatch(/^CMP-\d{4}-\d{6}$/);
    expect(res.body.happyCode).toMatch(/^\d{6}$/);
  });

  it('starts as NEW when no service center is chosen', async () => {
    /* This is the contradiction resolved in DECISIONS.md section 4.1 — without
       an optional service center, NEW would be unreachable. */
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    expect(res.body.complaint.status).toBe('NEW');
  });

  it('starts as ASSIGNED when a service center is chosen at creation', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { serviceCenterId: String(world.center._id) }));

    expect(res.body.complaint.status).toBe('ASSIGNED');
  });

  it('never returns the encrypted Happy Code material', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    /* The plaintext is returned once by design; the stored ciphertext must
       never appear anywhere. */
    expect(res.body.complaint.happyCodeSecret).toBeUndefined();
    expect(JSON.stringify(res.body.complaint)).not.toContain('ciphertext');
  });

  it('computes SLA due dates from the priority rule', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { priority: 'CRITICAL' }));

    /* Section 14: CRITICAL is 2h response, 8h resolution. */
    const created = new Date(res.body.complaint.createdAt).getTime();
    const responseDue = new Date(res.body.complaint.sla.responseDueAt).getTime();
    const resolutionDue = new Date(res.body.complaint.sla.resolutionDueAt).getTime();

    expect(Math.round((responseDue - created) / 3_600_000)).toBe(2);
    expect(Math.round((resolutionDue - created) / 3_600_000)).toBe(8);
  });

  it('snapshots customer and product so later edits cannot rewrite history', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    /* The customer moves house and changes their name. */
    await Customer.updateOne(
      { _id: world.customer._id },
      { $set: { name: 'Anita Verma', address: '99 New Street' } },
    );

    const fetched = await request(app)
      .get(`/complaints/${created.body.complaint.id}`)
      .set('Authorization', `Bearer ${token}`);

    /* Rule 15 and section 22: the complaint still records where the
       technician actually went and who they were dealing with. */
    expect(fetched.body.complaint.customerSnapshot.name).toBe('Anita Sharma');
    expect(fetched.body.complaint.serviceAddress.address).toBe('4 Lake View');
  });

  it('snapshots a zero-month default warranty rather than dropping it', async () => {
    /* 0 is a real, allowed value for defaultWarrantyMonths (spare parts and
       accessories sold with no factory warranty). The snapshot must keep it
       via a nullish check — a truthy check would read 0 as "not set" and
       omit warrantyMonths entirely, which every warranty display then reads
       as the 12-month default instead of "no warranty". */
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    await Product.updateOne({ _id: world.product._id }, { $set: { defaultWarrantyMonths: 0 } });

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    expect(res.status).toBe(201);
    expect(res.body.complaint.productSnapshot.warrantyMonths).toBe(0);
  });

  it('writes a timeline entry for the creation', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    /* Section 17: "Complaint created" is the first required timeline event. */
    const entries = await ComplaintActivity.find({
      complaintId: res.body.complaint.id,
    }).lean().exec();

    expect(entries.map((e) => e.action)).toContain('COMPLAINT_CREATED');
    expect(entries[0]?.actorRole).toBe('ADMIN');
  });

  it('records the service center selection as its own timeline event', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { serviceCenterId: String(world.center._id) }));

    const actions = (
      await ComplaintActivity.find({ complaintId: res.body.complaint.id }).lean().exec()
    ).map((e) => e.action);

    expect(actions).toContain('SERVICE_CENTER_SELECTED');
  });

  /** A creation payload with a customer typed in rather than picked. */
  function inlinePayload(
    world: Awaited<ReturnType<typeof seedWorld>>,
    customer: Record<string, unknown>,
    overrides = {},
  ) {
    const body: Record<string, unknown> = {
      ...payload(world, overrides),
      newCustomer: {
        cityId: String(world.city._id),
        state: 'Rajasthan',
        ...customer,
      },
    };
    delete body['customerId'];
    return body;
  }

  it('creates a customer inline', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(
        inlinePayload(world, {
          name: 'Ravi Kumar',
          mobile: '98290 12345',
          address: '7 Civil Lines',
          pincode: '302006',
        }),
      );

    expect(res.status).toBe(201);
    const created = await Customer.findOne({ mobile: '9829012345' }).lean().exec();
    expect(res.body.complaint.customerId).toBe(String(created!._id));
    expect(res.body.complaint.customerSnapshot.name).toBe('Ravi Kumar');
    expect(res.body.complaint.serviceAddress.address).toBe('7 Civil Lines');
  });

  it('refuses a "new" customer whose mobile is already on file, naming whose it is', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    /**
     * The bug: the complaint was saved with the stored customer's name and old
     * address while the Admin had typed a new one, so the technician went to
     * the old address. Nothing on screen said so. Now it is refused, and the
     * Admin is told whose number it is.
     */
    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(
        inlinePayload(world, {
          name: 'A. Sharma',
          mobile: '9811111111', // Anita Sharma's, in the seeded world
          address: '22 New Colony',
          pincode: '302020',
        }),
      );

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/belongs to Anita Sharma/);
    expect(res.body.error.issues).toEqual([
      expect.objectContaining({ field: 'newCustomer.mobile', message: expect.stringMatching(/Anita Sharma/) }),
    ]);

    /* Section 13: still one record per mobile, and nothing half-created. */
    expect(await Customer.countDocuments({ mobile: '9811111111' })).toBe(1);
    expect(await Complaint.countDocuments()).toBe(0);
  });

  it('saves the service address that was confirmed, not the saved one', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    /* Workflow A step 8: an existing customer, serviced somewhere else this time. */
    const otherCity = await City.create({
      name: 'Ajmer',
      state: 'Rajasthan',
      territoryId: world.territory._id,
    });

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(
        payload(world, {
          serviceAddress: {
            address: '9 Dargah Bazaar',
            cityId: String(otherCity._id),
            state: 'Rajasthan',
            pincode: '305001',
          },
        }),
      );

    expect(res.status).toBe(201);
    expect(res.body.complaint.serviceAddress).toMatchObject({
      address: '9 Dargah Bazaar',
      cityId: String(otherCity._id),
      cityName: 'Ajmer',
      pincode: '305001',
    });

    /* The customer's own record is untouched: a different address is for this complaint. */
    const customer = await Customer.findById(world.customer._id).lean().exec();
    expect(customer!.address).toBe('4 Lake View');
  });

  it('still validates a service address', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(
        payload(world, {
          serviceAddress: { address: '  ', cityId: String(world.city._id), state: '', pincode: '3020' },
        }),
      );

    expect(res.status).toBe(400);
    const fields = res.body.error.issues.map((issue: { field: string }) => issue.field);
    expect(fields).toEqual(
      expect.arrayContaining(['serviceAddress.address', 'serviceAddress.state', 'serviceAddress.pincode']),
    );
  });

  it('rejects a model that belongs to a different product', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    /* A genuinely separate product line with its own model. */
    const otherProduct = await Product.create({
      name: 'Tower Cooler 30L',
      code: 'TC30',
    });
    const otherModel = await ProductModel.create({
      productId: otherProduct._id,
      modelNumber: 'TC30-A',
    });

    /* Pairing product DC50 with model TC30-A would produce a complaint whose
       own snapshot contradicts itself: "Desert Cooler 50L (TC30-A)". */
    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(
        payload(world, {
          productId: String(world.product._id),
          productModelId: String(otherModel._id),
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'productModelId' }),
      ]),
    );
  });

  it('refuses a deactivated service center by name', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    await ServiceCenter.updateOne(
      { _id: world.center._id },
      { $set: { isActive: false } },
    );

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { serviceCenterId: String(world.center._id) }));

    /* Section 8: a deactivated centre keeps its history but takes no new work. */
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/deactivated/i);
  });

  it('leaves nothing behind when creation fails', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const before = await Complaint.countDocuments();

    /* A product that does not exist fails after the customer lookup, partway
       through the transaction. */
    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { productId: String(new mongoose.Types.ObjectId()) }));

    expect(res.status).toBe(404);
    expect(await Complaint.countDocuments()).toBe(before);
    /* And no orphan timeline entry. */
    expect(await ComplaintActivity.countDocuments()).toBe(0);
  });

  it('issues distinct numbers to concurrent creations', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    /* The race section 6.2 has to survive: two complaints must never share an
       identifier. */
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .post('/complaints')
          .set('Authorization', `Bearer ${token}`)
          .send(payload(world, { serialNumber: `SN-${i}` })),
      ),
    );

    const numbers = responses
      .filter((r) => r.status === 201)
      .map((r) => r.body.complaint.complaintNumber as string);

    expect(numbers.length).toBe(8);
    expect(new Set(numbers).size).toBe(8);
  });
});

describe('complaint creation permissions', () => {
  it('refuses a service center owner', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000002');

    /* Rule 1: "Only Admin can create complaints." */
    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    expect(res.status).toBe(403);
  });

  it('refuses a technician', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000003');

    const res = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    expect(res.status).toBe(403);
  });

  it('refuses a technician still on a temporary password', async () => {
    const world = await seedWorld();
    await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000009',
      serviceCenterId: world.center._id,
      mustChangePassword: true,
    });

    const login = await request(app)
      .post('/auth/login')
      .send({ mobile: '9800000009', password: TEST_PASSWORD });

    const res = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/temporary password/i);
  });
});

describe('GET /complaints scoping', () => {
  it('shows an owner only their own center and hides other centers', async () => {
    const world = await seedWorld();
    const adminToken = await tokenFor('9800000001');

    /* A second centre with its own owner. */
    const otherCenter = await makeServiceCenter(
      world.city._id,
      world.territory._id,
      'JAI-02',
    );
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000005',
      serviceCenterId: otherCenter._id,
    });

    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload(world, { serviceCenterId: String(world.center._id) }));

    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload(world, {
        serviceCenterId: String(otherCenter._id),
        serialNumber: 'SN-OTHER',
      }));

    const ownerOne = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${await tokenFor('9800000002')}`);

    /* Section 3.2: scoped only to their service center. */
    expect(ownerOne.body.total).toBe(1);
    expect(ownerOne.body.items[0].serviceCenterId).toBe(String(world.center._id));

    const admin = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(admin.body.total).toBe(2);
  });

  it('cannot be widened by supplying a serviceCenterId filter', async () => {
    const world = await seedWorld();
    const adminToken = await tokenFor('9800000001');

    const otherCenter = await makeServiceCenter(
      world.city._id,
      world.territory._id,
      'JAI-02',
    );

    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload(world, { serviceCenterId: String(otherCenter._id) }));

    /* The attack `withScope`'s $and merge exists to stop: an owner asking for
       another centre's complaints by name. */
    const res = await request(app)
      .get('/complaints')
      .query({ serviceCenterId: String(otherCenter._id) })
      .set('Authorization', `Bearer ${await tokenFor('9800000002')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('returns 404 rather than 403 for an out-of-scope complaint', async () => {
    const world = await seedWorld();
    const adminToken = await tokenFor('9800000001');

    const otherCenter = await makeServiceCenter(
      world.city._id,
      world.territory._id,
      'JAI-02',
    );

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload(world, { serviceCenterId: String(otherCenter._id) }));

    /* 403 would confirm the complaint exists, letting one centre probe
       another's workload by id. */
    const res = await request(app)
      .get(`/complaints/${created.body.complaint.id}`)
      .set('Authorization', `Bearer ${await tokenFor('9800000002')}`);

    expect(res.status).toBe(404);
  });

  it('searches by complaint number, serial number and customer mobile', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { serialNumber: 'SN-FINDME' }));

    for (const term of [
      created.body.complaint.complaintNumber,
      created.body.complaint.complaintNumber.toLowerCase(),
      'SN-FINDME',
      'sn-find',
      '9811111111',
    ]) {
      const res = await request(app)
        .get('/complaints')
        .query({ search: term })
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.total, `searching for ${term}`).toBe(1);
    }
  });

  it('finds a mobile typed the way the screens show it', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    /* The list shows "98111 11111"; people copy that, or add +91 or a 0. The
       stored number is ten bare digits, so these all found nothing. */
    for (const term of ['98111 11111', '+91 98111 11111', '+919811111111', '09811111111', ' 98111-111 ', '98111 1']) {
      const res = await request(app)
        .get('/complaints')
        .query({ search: term })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status, `searching for "${term}"`).toBe(200);
      expect(res.body.total, `searching for "${term}"`).toBe(1);
    }
  });

  it('does not match a number against the middle of a mobile', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world, { serialNumber: '1111-A' }));

    /* A numeric serial search must not pull in every customer whose mobile
       happens to contain those digits. "1111" starts the serial number, so one
       result — for the serial, and not twice over. "11111" starts neither. */
    const serial = await request(app)
      .get('/complaints')
      .query({ search: '1111' })
      .set('Authorization', `Bearer ${token}`);
    const middle = await request(app)
      .get('/complaints')
      .query({ search: '11111' })
      .set('Authorization', `Bearer ${token}`);

    expect(serial.body.total).toBe(1);
    expect(middle.body.total).toBe(0);
  });
});

describe('GET /complaints/recommendations', () => {
  it('ranks by pincode, then city, and never decides', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .get('/complaints/recommendations')
      .query({ pincode: '302001', cityId: String(world.city._id) })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.recommended[0].reason).toBe('SERVES_PINCODE');
    /* Section 8: "Never automatically assign." The response says so plainly
       so no client can mistake the top entry for an assignment. */
    expect(res.body.manualSelectionRequired).toBe(true);
  });

  it('matches a center on its own pincode, not only its coverage list', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    /* A centre's own pincode is where it is. Records saved from the Admin
       screen no longer repeat it in `servedPincodes`, and the recommendation
       must not quietly demote the local centre to a city-level match — below
       any other centre that happens to list the pincode. */
    await ServiceCenter.updateOne(
      { _id: world.center._id },
      { $set: { servedPincodes: [], servedCityIds: [] } },
    );

    const res = await request(app)
      .get('/complaints/recommendations')
      .query({ pincode: '302001', cityId: String(world.city._id) })
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.recommended[0].id).toBe(String(world.center._id));
    expect(res.body.recommended[0].reason).toBe('SERVES_PINCODE');
  });

  it('offers every active center when nothing matches', async () => {
    await seedWorld();
    const token = await tokenFor('9800000001');

    const res = await request(app)
      .get('/complaints/recommendations')
      .query({ pincode: '999999' })
      .set('Authorization', `Bearer ${token}`);

    /* Section 22: "No service center recommendation -> Show all active
       centers for manual selection." */
    expect(res.body.fellBackToAll).toBe(true);
    expect(res.body.others.length).toBeGreaterThan(0);
  });

  it('is Admin only', async () => {
    await seedWorld();
    const res = await request(app)
      .get('/complaints/recommendations')
      .set('Authorization', `Bearer ${await tokenFor('9800000002')}`);

    expect(res.status).toBe(403);
  });
});

describe('GET /complaints/:id/whatsapp', () => {
  it('returns a wa.me link containing the Happy Code', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    const res = await request(app)
      .get(`/complaints/${created.body.complaint.id}/whatsapp`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.url).toContain('https://wa.me/919811111111');
    expect(res.body.happyCode).toBe(created.body.happyCode);
    expect(res.body.message).toContain(created.body.complaint.complaintNumber);
    /* Section 6.4: never claim delivery. */
    expect(res.body.note).toMatch(/press send yourself/i);
  });

  it('records every viewing of the code', async () => {
    const world = await seedWorld();
    const token = await tokenFor('9800000001');

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${token}`)
      .send(payload(world));

    await request(app)
      .get(`/complaints/${created.body.complaint.id}/whatsapp`)
      .set('Authorization', `Bearer ${token}`);

    /* The code gates closure, so who read it and when is worth having. */
    const actions = (
      await ComplaintActivity.find({ complaintId: created.body.complaint.id })
        .lean()
        .exec()
    ).map((e) => e.action);

    expect(actions).toContain('HAPPY_CODE_VIEWED');
  });

  it('is Admin only, because it decrypts the code', async () => {
    const world = await seedWorld();
    const adminToken = await tokenFor('9800000001');

    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload(world, { serviceCenterId: String(world.center._id) }));

    const res = await request(app)
      .get(`/complaints/${created.body.complaint.id}/whatsapp`)
      .set('Authorization', `Bearer ${await tokenFor('9800000002')}`);

    expect(res.status).toBe(403);
  });
});
