/**
 * Admin's service center page, and who may read customers
 * (DECISIONS.md section 29).
 *
 * The overview is checked against a centre with real work in it — an overdue
 * complaint, a booked visit, a missed one, low stock — because a page of
 * zeroes passes any assertion about counts. The customer tests come from the
 * pre-launch security review: the register and the serial history were open
 * to every signed-in role.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint, PartRequest, PartStock, Visit } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

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

/** A complaint sent to the seeded centre, optionally with its technician. */
async function complaintAtCentre(serialNumber: string, withTechnician = false): Promise<string> {
  const created = await request(app)
    .post('/complaints')
    .set('Authorization', `Bearer ${c.admin}`)
    .send({
      customerId: String(c.world.customer._id),
      productId: String(c.world.product._id),
      productModelId: String(c.world.productModel._id),
      serialNumber,
      category: 'Not cooling',
      description: 'Warm air.',
      priority: 'HIGH',
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: String(c.world.center._id),
    });
  expect(created.status).toBe(201);
  const id = created.body.complaint.id as string;

  if (withTechnician) {
    const assigned = await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ technicianId: String(c.world.technician._id) });
    expect(assigned.status).toBe(200);
  }
  return id;
}

describe('service center overview', () => {
  it('shows the centre, its people, open work, visits and low stock', async () => {
    const overdue = await complaintAtCentre('SN-OV-1', true);
    await complaintAtCentre('SN-OV-2');

    /* One complaint past its deadline, as the breach sweep would leave it. */
    await Complaint.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(overdue) },
      { $set: { 'sla.state': 'BREACHED', 'sla.breachedAt': new Date() } },
    );

    const booked = await request(app)
      .post(`/complaints/${overdue}/visits`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() });
    expect(booked.status).toBe(201);

    /* A visit whose time has passed with nobody starting it. */
    await Visit.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(booked.body.visit.id as string) },
      { $set: { scheduledAt: new Date(Date.now() - 3_600_000) } },
    );

    const [pad, pump] = c.world.parts;
    await PartStock.create([
      { serviceCenterId: c.world.center._id, partId: pad!._id, availableQuantity: 1, minimumStock: 4 },
      { serviceCenterId: c.world.center._id, partId: pump!._id, availableQuantity: 9, minimumStock: 2 },
    ]);

    const res = await request(app)
      .get(`/service-centers/${c.world.center._id}/overview`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.center.name).toBe(c.world.center.name);
    expect(body.center.city?.name).toBeTruthy();
    expect(body.center.territory?.name).toBeTruthy();

    expect(body.staff.owners.map((o: { name: string }) => o.name)).toEqual(['Owner']);
    expect(body.staff.technicians).toHaveLength(1);
    expect(body.staff.technicians[0]).toMatchObject({ name: 'Technician', openJobs: 1 });

    expect(body.complaints.open).toBe(2);
    expect(body.complaints.overdue).toBe(1);
    expect(body.complaints.waitingForTechnician).toBe(1);
    expect(body.complaints.mostUrgent).toHaveLength(2);
    const urgent = body.complaints.mostUrgent.find((row: { id: string }) => row.id === overdue);
    expect(urgent).toMatchObject({ breached: true, technicianName: 'Technician', customerName: 'Anita Sharma' });

    expect(body.visits.scheduled).toBe(1);
    expect(body.visits.missed).toBe(1);
    expect(body.visits.next[0]).toMatchObject({ missed: true, technicianName: 'Technician' });
    expect(body.visits.next[0].complaintNumber).toMatch(/^CMP-/);

    expect(body.stock.tracked).toBe(2);
    expect(body.stock.low).toBe(1);
    expect(body.stock.lowItems).toEqual([
      expect.objectContaining({ name: 'Cooling Pad', available: 1, minimum: 4 }),
    ]);

    /* No stray Mongo ids or secrets in what the page receives. */
    const text = JSON.stringify(body);
    expect(text).not.toContain('"_id"');
    expect(text).not.toContain('passwordHash');
  });

  it('counts only waiting part requests and ignores other centres', async () => {
    const id = await complaintAtCentre('SN-OV-3', true);
    const other = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'OTHER-01');

    await PartRequest.collection.insertMany([
      { complaintId: new mongoose.Types.ObjectId(id), serviceCenterId: c.world.center._id, status: 'REQUESTED' },
      { complaintId: new mongoose.Types.ObjectId(id), serviceCenterId: c.world.center._id, status: 'APPROVED' },
      { complaintId: new mongoose.Types.ObjectId(id), serviceCenterId: c.world.center._id, status: 'ISSUED' },
      { complaintId: new mongoose.Types.ObjectId(id), serviceCenterId: other._id, status: 'REQUESTED' },
    ]);

    const res = await request(app)
      .get(`/service-centers/${c.world.center._id}/overview`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.body.stock.waitingRequests).toBe(2);

    const empty = await request(app)
      .get(`/service-centers/${other._id}/overview`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(empty.status).toBe(200);
    expect(empty.body.complaints.open).toBe(0);
    expect(empty.body.staff.technicians).toEqual([]);
  });

  it('carries the centre’s all-time average rating for the heading', async () => {
    const before = await request(app)
      .get(`/service-centers/${c.world.center._id}/overview`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(before.body.ratings).toEqual({ average: null, rated: 0 });

    for (const [serial, stars] of [['SN-RT-A', 5], ['SN-RT-B', 4]] as const) {
      const id = await complaintAtCentre(serial);
      await Complaint.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { status: 'CLOSED', closedAt: new Date(), closedBy: c.world.admin._id } },
      );
      const rated = await request(app)
        .post(`/complaints/${id}/rating`)
        .set('Authorization', `Bearer ${c.admin}`)
        .send({ stars });
      expect(rated.status, JSON.stringify(rated.body)).toBe(200);
    }
    /* One left unrated does not pull the average down. */
    await complaintAtCentre('SN-RT-C');

    const after = await request(app)
      .get(`/service-centers/${c.world.center._id}/overview`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(after.body.ratings).toEqual({ average: 4.5, rated: 2 });
  });

  it('is Admin only, and says not found for an unknown centre', async () => {
    for (const bearer of [c.owner, c.tech]) {
      const res = await request(app)
        .get(`/service-centers/${c.world.center._id}/overview`)
        .set('Authorization', `Bearer ${bearer}`);
      expect(res.status).toBe(403);
    }

    for (const id of ['64b000000000000000000000', 'not-an-id']) {
      const res = await request(app)
        .get(`/service-centers/${id}/overview`)
        .set('Authorization', `Bearer ${c.admin}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('customer records are Admin only', () => {
  it('refuses the register, a record and its history to Owners and technicians', async () => {
    const paths = [
      '/customers',
      `/customers/${c.world.customer._id}`,
      `/customers/${c.world.customer._id}/history`,
    ];

    for (const bearer of [c.owner, c.tech]) {
      for (const path of paths) {
        const res = await request(app).get(path).set('Authorization', `Bearer ${bearer}`);
        expect(res.status, path).toBe(403);
      }
    }

    const admin = await request(app).get('/customers').set('Authorization', `Bearer ${c.admin}`);
    expect(admin.status).toBe(200);
  });

  it('finds a customer by mobile typed the way the screens show it', async () => {
    for (const typed of ['98111 11111', '+91 98111 11111', '098111-11111', '98111 1']) {
      const res = await request(app)
        .get('/customers')
        .query({ search: typed })
        .set('Authorization', `Bearer ${c.admin}`);
      expect(res.body.total, typed).toBe(1);
    }

    const byName = await request(app)
      .get('/customers')
      .query({ search: 'anita' })
      .set('Authorization', `Bearer ${c.admin}`);
    expect(byName.body.total).toBe(1);
  });
});

describe('serial history outside Admin', () => {
  it('shows a technician the unit they were sent to, without the owner details', async () => {
    const earlier = await complaintAtCentre('SN-UNIT-7');
    await Complaint.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(earlier) },
      { $set: { status: 'CLOSED', closedAt: new Date() } },
    );
    await complaintAtCentre('SN-UNIT-7', true);

    const res = await request(app)
      .get('/serial-history/SN-UNIT-7')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('Anita Sharma');
    expect(text).not.toContain('9811111111');
    expect(text).not.toContain('customerSnapshot');
    expect(text).not.toContain('closureHistory');

    const admin = await request(app)
      .get('/serial-history/SN-UNIT-7')
      .set('Authorization', `Bearer ${c.admin}`);
    expect(JSON.stringify(admin.body)).toContain('Anita Sharma');
  });

  it('says not found for a unit outside the caller’s own work', async () => {
    await complaintAtCentre('SN-SOMEONE-ELSE');

    /* The technician has no job on it; another centre's Owner has no complaint on it. */
    const tech = await request(app)
      .get('/serial-history/SN-SOMEONE-ELSE')
      .set('Authorization', `Bearer ${c.tech}`);
    expect(tech.status).toBe(404);

    const other = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'OTHER-02');
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      name: 'Other Owner',
      mobile: '9800000009',
      serviceCenterId: other._id,
    });
    const otherOwner = await token('9800000009');
    const owner = await request(app)
      .get('/serial-history/SN-SOMEONE-ELSE')
      .set('Authorization', `Bearer ${otherOwner}`);
    expect(owner.status).toBe(404);

    const unknown = await request(app)
      .get('/serial-history/NO-SUCH-UNIT')
      .set('Authorization', `Bearer ${c.tech}`);
    expect(unknown.status).toBe(404);
  });
});
