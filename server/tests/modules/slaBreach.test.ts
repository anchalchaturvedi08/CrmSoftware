/**
 * An SLA breach is a fact about time, not about who has looked (section 14).
 *
 * Breaches were recorded only when somebody opened that one complaint after its
 * deadline. So the dashboards' "SLA breached" counted the complaints someone
 * happened to open — one, on a day four were overdue — a complaint closed late
 * without being opened in between was reported as on time, and once a breach
 * *was* recorded the list lost the "overdue by" figure altogether.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint } from '../../src/models/index.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

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
      description: 'Warm air.',
      priority: 'NORMAL',
      warrantyStatus: 'IN_WARRANTY',
      serviceCenterId: String(c.world.center._id),
    });
  return res.body.complaint.id as string;
}

/** Winds a complaint's resolution deadline into the past, as time would. */
const overdue = (id: string, hours = 3) =>
  Complaint.updateOne({ _id: id }, { $set: { 'sla.resolutionDueAt': hoursAgo(hours) } });

describe('breaches nobody has opened', () => {
  it('are counted on the dashboard', async () => {
    const late = await makeComplaint('SN-SLA-1');
    await makeComplaint('SN-SLA-2');
    await overdue(late);

    /* Deliberately no GET /complaints/:id in between. */
    const admin = await request(app).get('/dashboard').set('Authorization', `Bearer ${c.admin}`);
    const owner = await request(app).get('/dashboard').set('Authorization', `Bearer ${c.owner}`);

    expect(admin.body.kpis.slaBreached).toBe(1);
    expect(owner.body.kpis.slaBreached).toBe(1);
  });

  it('are counted in the service center report', async () => {
    const late = await makeComplaint('SN-SLA-3');
    await makeComplaint('SN-SLA-4');
    await overdue(late);

    const res = await request(app)
      .get('/reports/service-centers')
      .set('Authorization', `Bearer ${c.admin}`);

    const [centre] = res.body.tables.find((t: { key: string }) => t.key === 'byCenter').rows;
    expect(centre.slaBreached).toBe(1);
    expect(res.body.summary.find((s: { key: string }) => s.key === 'slaBreached').value).toBe(1);
  });

  it('do not look like fresh activity', async () => {
    const late = await makeComplaint('SN-SLA-5');
    await overdue(late);
    const before = (await Complaint.findById(late).lean().exec())!.updatedAt;

    await request(app).get('/dashboard').set('Authorization', `Bearer ${c.admin}`);

    /* Queues sort by how long a job has waited; recording a breach must not
       make a stale job look recently touched. */
    const after = (await Complaint.findById(late).lean().exec())!;
    expect(after.sla.state).toBe('BREACHED');
    expect(after.updatedAt.getTime()).toBe(before.getTime());
  });
});

describe('a breached complaint', () => {
  it('still reports how far overdue it is', async () => {
    const late = await makeComplaint('SN-SLA-6');
    await overdue(late, 5);

    /* Opening it records the breach — which used to blank the figure. */
    const detail = await request(app)
      .get(`/complaints/${late}`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(detail.body.complaint.sla.state).toBe('BREACHED');
    expect(detail.body.complaint.slaSnapshot.resolutionRemainingMs).toBeLessThan(-4 * 3_600_000);

    const list = await request(app).get('/complaints').set('Authorization', `Bearer ${c.admin}`);
    const row = list.body.items.find((item: { id: string }) => item.id === late);
    expect(row.slaSnapshot.resolutionRemainingMs).toBeLessThan(0);
  });
});

describe('closing late', () => {
  it('keeps the breach on record even if nobody opened the complaint', async () => {
    const id = await makeComplaint('SN-SLA-7');

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
      .send({ customerAvailability: 'CUSTOMER_AVAILABLE' });
    await request(app)
      .post(`/complaints/${id}/resolution`)
      .set('Authorization', `Bearer ${c.tech}`)
      .send({
        diagnosis: { problemFound: 'Pump seized' },
        workPerformed: { details: 'Replaced pump' },
        resolution: { result: 'Cooling restored' },
      });
    await request(app)
      .post(`/complaints/${id}/review-resolution`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ outcome: 'ACCEPTED' });
    const whatsapp = await request(app)
      .get(`/complaints/${id}/whatsapp`)
      .set('Authorization', `Bearer ${c.admin}`);
    await request(app)
      .post(`/complaints/${id}/verify-happy-code`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ code: whatsapp.body.happyCode });

    /* The deadline passes while the complaint waits for confirmation. */
    await overdue(id);

    const closed = await request(app)
      .post(`/complaints/${id}/close`)
      .set('Authorization', `Bearer ${c.admin}`);
    expect(closed.status).toBe(200);

    const after = (await Complaint.findById(id).lean().exec())!;
    expect(after.sla.state).toBe('COMPLETED');
    expect(after.sla.breachedAt).toBeTruthy();

    /* And the reports say it ran late. */
    const report = await request(app)
      .get('/reports/service-centers')
      .set('Authorization', `Bearer ${c.admin}`);
    const [centre] = report.body.tables.find((t: { key: string }) => t.key === 'byCenter').rows;
    expect(centre.slaBreached).toBe(1);
    /* Closed, but late: it must not count as closed within the SLA. */
    expect(centre.closedWithinSla).toBe(0);
  });
});
