/**
 * The Admin audit log (spec sections 3.1 "View audit logs and timelines", 17).
 *
 * Everything section 17 lists has been recorded since the first modules
 * landed, but it could only be read one complaint at a time. These are the two
 * views Admin needs to answer "who did that, and when":
 *
 *  - **complaint activity** across every complaint, newest first;
 *  - **the system log** — sign-ins, record changes, stock, SLA settings,
 *    Happy Code views — in words a person can scan.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TEST_PASSWORD, makeServiceCenter, makeUser, seedWorld } from '../fixtures.js';

const app = createApp();

async function login(mobile: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
  owner: string;
  tech: string;
  ownerRefresh: string;
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  const owner = await login('9800000002');
  c = {
    world,
    admin: (await login('9800000001')).accessToken,
    owner: owner.accessToken,
    ownerRefresh: owner.refreshToken,
    tech: (await login('9800000003')).accessToken,
  };
});

const get = (path: string, token: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);
const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
  request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);

async function makeComplaint(serial: string): Promise<{ id: string; number: string }> {
  const res = await post('/complaints', c.admin, {
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
  expect(res.status).toBe(201);
  return { id: res.body.complaint.id as string, number: res.body.complaint.complaintNumber as string };
}

interface ActivityItem {
  action: string;
  actorName: string;
  at: string;
  complaint: { id: string; complaintNumber: string } | null;
}

/* ---- Complaint activity ------------------------------------------------- */

describe('complaint activity across every complaint', () => {
  it('lists it newest first, with the complaint each entry belongs to', async () => {
    const first = await makeComplaint('SN-AU-1');
    const second = await makeComplaint('SN-AU-2');
    expect(
      (await post(`/complaints/${first.id}/assign-technician`, c.owner, {
        technicianId: String(c.world.technician._id),
      })).status,
    ).toBe(200);

    const res = await get('/audit/activity', c.admin);

    expect(res.status).toBe(200);
    const items = res.body.items as ActivityItem[];
    /* The assignment happened last, so its entries lead. */
    expect(items[0]!.complaint).toEqual({ id: first.id, complaintNumber: first.number });
    expect(items.find((item) => item.action === 'TECHNICIAN_ASSIGNED')).toMatchObject({ actorName: 'Owner' });
    expect(items.some((item) => item.complaint?.complaintNumber === second.number)).toBe(true);

    const times = items.map((item) => new Date(item.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('filters by person, by action and by complaint number', async () => {
    const first = await makeComplaint('SN-AU-3');
    await makeComplaint('SN-AU-4');
    await post(`/complaints/${first.id}/assign-technician`, c.owner, {
      technicianId: String(c.world.technician._id),
    });

    const byOwner = await get(`/audit/activity?actorId=${String(c.world.owner._id)}`, c.admin);
    expect(byOwner.body.total).toBeGreaterThan(0);
    expect((byOwner.body.items as ActivityItem[]).every((item) => item.actorName === 'Owner')).toBe(true);

    const created = await get('/audit/activity?action=COMPLAINT_CREATED', c.admin);
    expect(created.body.total).toBe(2);

    /* Several at once, as the screen's grouped filters ask. */
    const either = await get('/audit/activity?action=COMPLAINT_CREATED,TECHNICIAN_ASSIGNED', c.admin);
    expect(either.body.total).toBe(3);

    const one = await get(`/audit/activity?complaintNumber=${first.number.toLowerCase()}`, c.admin);
    expect(one.body.total).toBeGreaterThan(0);
    expect((one.body.items as ActivityItem[]).every((item) => item.complaint?.id === first.id)).toBe(true);
  });

  it('finds nothing for a complaint number that does not exist, rather than everything', async () => {
    await makeComplaint('SN-AU-5');

    const res = await get('/audit/activity?complaintNumber=CMP-2020-999999', c.admin);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('filters by date', async () => {
    await makeComplaint('SN-AU-6');

    const later = new Date(Date.now() + 60_000).toISOString();
    const res = await get(`/audit/activity?from=${later}`, c.admin);

    expect(res.body.total).toBe(0);
  });

  it('is Admin only', async () => {
    for (const token of [c.owner, c.tech]) {
      expect((await get('/audit/activity', token)).status).toBe(403);
    }
  });

  it('records who a job moved from by name, not by database id', async () => {
    /* The new technician or centre was written by name, the previous one as
       an id — so the history read "6aa7f6… → Second Tech". */
    const complaint = await makeComplaint('SN-AU-7');
    const second = await makeUser({
      role: 'TECHNICIAN',
      mobile: '9800000004',
      name: 'Second Tech',
      serviceCenterId: c.world.center._id,
    });
    await post(`/complaints/${complaint.id}/assign-technician`, c.owner, {
      technicianId: String(c.world.technician._id),
    });
    const moved = await post(`/complaints/${complaint.id}/assign-technician`, c.owner, {
      technicianId: String(second._id),
      reason: 'Closer to the customer',
    });
    expect(moved.status).toBe(200);

    const technicians = await get('/audit/activity?action=TECHNICIAN_REASSIGNED', c.admin);
    expect(technicians.body.items[0]).toMatchObject({ oldValue: 'Technician', newValue: 'Second Tech' });

    const other = await makeComplaint('SN-AU-8');
    const otherCentre = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-02');
    const recentred = await post(`/complaints/${other.id}/assign-service-center`, c.admin, {
      serviceCenterId: String(otherCentre._id),
      reason: 'Wrong centre picked',
    });
    expect(recentred.status).toBe(200);

    const centres = await get('/audit/activity?action=SERVICE_CENTER_REASSIGNED', c.admin);
    expect(centres.body.items[0]).toMatchObject({
      oldValue: 'Service Center JAI-01',
      newValue: 'Service Center JAI-02',
    });
  });
});

/* ---- System log --------------------------------------------------------- */

interface AuditItem {
  action: string;
  entityType: string;
  entityName?: string;
  note?: string;
}

describe('the system log, readable', () => {
  it('names the record each entry is about', async () => {
    /* "SERVICE_CENTER_UPDATED 6aa7…" answers nothing; the name does. */
    const renamed = await request(app)
      .patch(`/service-centers/${String(c.world.center._id)}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Jaipur Main Service' });
    expect(renamed.status).toBe(200);

    const part = c.world.parts[0]!;
    expect(
      (await request(app)
        .put('/parts/stock')
        .set('Authorization', `Bearer ${c.owner}`)
        .send({ partId: String(part._id), availableQuantity: 5, minimumStock: 2 })).status,
    ).toBe(200);

    const centres = await get('/audit?entityType=ServiceCenter', c.admin);
    expect((centres.body.items as AuditItem[])[0]).toMatchObject({ entityName: 'Jaipur Main Service' });

    const stock = await get('/audit?entityType=PartStock', c.admin);
    const entry = (stock.body.items as AuditItem[])[0]!;
    expect(entry.entityName).toBe('Cooling Pad at Jaipur Main Service');
    /* The note named the centre by its database id. */
    expect(entry.note).not.toMatch(/[0-9a-f]{24}/);
  });

  it('uses one naming scheme for record changes', async () => {
    /* Updates were written as SERVICECENTER_UPDATED while creation was
       SERVICE_CENTER_CREATED, so filtering by action missed half of them. */
    await request(app)
      .patch(`/service-centers/${String(c.world.center._id)}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ notes: 'Renovated' });

    const res = await get('/audit?entityType=ServiceCenter', c.admin);

    expect((res.body.items as AuditItem[])[0]!.action).toBe('SERVICE_CENTER_UPDATED');
  });

  it('groups entries into categories', async () => {
    await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Audited', code: 'AUDITED' });
    await request(app).post('/auth/login').send({ mobile: '9800000002', password: 'wrong-password-1' });

    const signIns = await get('/audit?category=sign-in', c.admin);
    const signInActions = (signIns.body.items as AuditItem[]).map((item) => item.action);
    expect(signInActions).toEqual(expect.arrayContaining(['LOGIN_SUCCESS', 'LOGIN_FAILED_BAD_PASSWORD']));
    expect(signInActions.every((action) => /^(LOGIN|PASSWORD)_/.test(action))).toBe(true);

    const records = await get('/audit?category=records', c.admin);
    const recordTypes = (records.body.items as AuditItem[]).map((item) => item.entityType);
    expect(recordTypes).toContain('Territory');
    expect(recordTypes.every((type) => type !== 'User')).toBe(true);

    expect((await get('/audit?category=everything', c.admin)).status).toBe(400);
  });

  it('leaves out session renewals unless they are asked for', async () => {
    /* Every signed-in screen renews its session every few minutes; left in,
       they would bury everything else. They are still recorded. */
    expect((await request(app).post('/auth/refresh').send({ refreshToken: c.ownerRefresh })).status).toBe(200);

    const all = await get('/audit?limit=200', c.admin);
    expect((all.body.items as AuditItem[]).some((item) => item.action === 'TOKEN_REFRESHED')).toBe(false);

    const renewals = await get('/audit?action=TOKEN_REFRESHED', c.admin);
    expect(renewals.body.total).toBe(1);
  });
});
