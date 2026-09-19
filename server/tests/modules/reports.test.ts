/**
 * Reports and dashboards (spec sections 5.1, 9, 16).
 *
 * The most important test in this file is the formula-injection one. Every
 * field in these reports is user input — customer names, addresses, complaint
 * descriptions — and a spreadsheet executes a cell that starts with `=`. An
 * export feature is the easiest place in a CRM to hand someone a working
 * payload without noticing.
 *
 * The rest check that the numbers mean what their labels say. A report that
 * silently ignores a filter, or counts one technician's rejected work against
 * another, is worse than no report: someone acts on it.
 */
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { safeCell, toCsv } from '../../src/modules/reports/export.service.js';
import { buildTrend } from '../../src/modules/reports/report.filters.js';
import { Complaint } from '../../src/models/index.js';
import {
  TEST_PASSWORD,
  makeCity,
  makeServiceCenter,
  makeTerritory,
  makeUser,
  seedWorld,
} from '../fixtures.js';

const app = createApp();
const tomorrow = () => new Date(Date.now() + 24 * 3_600_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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

/* ---- Helpers ------------------------------------------------------------ */

interface ReportBody {
  summary: Array<{ key: string; value: number | null }>;
  breakdowns: Array<{ key: string; items: Array<{ key: string; label: string; value: number }> }>;
  tables: Array<{
    key: string;
    columns: Array<{ key: string; header: string }>;
    rows: Array<Record<string, unknown>>;
    total: number;
    truncated?: boolean;
  }>;
  trend?: { unit: string; points: Array<{ key: string; label: string; value: number }> };
  filters: Array<{ label: string; value: string }>;
  ignoredFilters: Array<{ key: string; label: string }>;
}

const stat = (body: ReportBody, key: string) => body.summary.find((s) => s.key === key)?.value;
const table = (body: ReportBody, key: string) => body.tables.find((t) => t.key === key);
const rowsOf = (body: ReportBody, key: string) => table(body, key)?.rows ?? [];
const itemsOf = (body: ReportBody, key: string) =>
  body.breakdowns.find((b) => b.key === key)?.items ?? [];

async function report(kind: string, auth: string, query = ''): Promise<ReportBody> {
  const res = await request(app)
    .get(`/reports/${kind}${query ? `?${query}` : ''}`)
    .set('Authorization', `Bearer ${auth}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ReportBody;
}

const post = (path: string, auth: string, body: Record<string, unknown> = {}) =>
  request(app).post(path).set('Authorization', `Bearer ${auth}`).send(body);

async function makeComplaint(
  serial: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
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
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.complaint.id as string;
}

async function assign(id: string, technicianId: string): Promise<void> {
  const res = await post(`/complaints/${id}/assign-technician`, c.owner, { technicianId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Books a visit and has the technician start it: the complaint is IN_PROGRESS. */
async function startVisit(id: string, techToken: string): Promise<void> {
  expect((await post(`/complaints/${id}/visits`, c.owner, { scheduledAt: tomorrow() })).status).toBe(201);
  const started = await post(`/complaints/${id}/start-visit`, techToken, {
    customerAvailability: 'CUSTOMER_AVAILABLE',
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
}

async function submitResolution(id: string, techToken: string): Promise<void> {
  const res = await post(`/complaints/${id}/resolution`, techToken, {
    diagnosis: { problemFound: 'Pump seized' },
    workPerformed: { details: 'Replaced pump' },
    resolution: { result: 'Cooling restored' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function sendBack(id: string): Promise<void> {
  const res = await post(`/complaints/${id}/review-resolution`, c.owner, {
    outcome: 'REVISIT_REQUIRED',
    reason: 'Customer says it still blows warm air',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function acceptAndClose(id: string): Promise<void> {
  expect((await post(`/complaints/${id}/review-resolution`, c.owner, { outcome: 'ACCEPTED' })).status).toBe(200);
  const whatsapp = await request(app)
    .get(`/complaints/${id}/whatsapp`)
    .set('Authorization', `Bearer ${c.admin}`);
  expect((await post(`/complaints/${id}/verify-happy-code`, c.admin, { code: whatsapp.body.happyCode })).status).toBe(200);
  expect((await post(`/complaints/${id}/close`, c.admin)).status).toBe(200);
}

async function secondTechnician(): Promise<{ id: string; token: string }> {
  const user = await makeUser({
    role: 'TECHNICIAN',
    mobile: '9800000004',
    name: 'Second Tech',
    serviceCenterId: c.world.center._id,
  });
  return { id: String(user._id), token: await token('9800000004') };
}

async function setStock(code: string, availableQuantity: number, minimumStock: number): Promise<string> {
  const part = c.world.parts.find((p) => p.code === code)!;
  const res = await request(app)
    .put('/parts/stock')
    .set('Authorization', `Bearer ${c.owner}`)
    .send({ partId: String(part._id), availableQuantity, minimumStock });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(part._id);
}

/* ---- The one that matters --------------------------------------------- */

describe('spreadsheet formula injection', () => {
  it('neutralises every character a spreadsheet would execute', () => {
    /**
     * A cell beginning `=`, `+`, `-`, `@`, tab or CR is a *formula*, not text.
     * `=cmd|'/c calc'!A1` in a customer name is a working payload the moment
     * someone opens the export.
     */
    const payloads = [
      '=cmd|\'/c calc\'!A1',
      '+1+1',
      '-1+1',
      '@SUM(1+1)',
      '\t=1+1',
      '\r=1+1',
      '=HYPERLINK("http://evil.test","click")',
    ];

    for (const payload of payloads) {
      const rendered = safeCell(payload);
      expect(rendered.startsWith("'"), `payload: ${JSON.stringify(payload)}`).toBe(true);
    }
  });

  it('leaves ordinary text alone', () => {
    for (const value of ['Anita Sharma', '4 Lake View', 'CMP-2026-000001', '302001']) {
      expect(safeCell(value)).toBe(value);
    }
  });

  it('escapes quotes and newlines so a row cannot be broken', () => {
    const csv = toCsv({
      title: 'Test',
      meta: [],
      summary: [],
      breakdowns: [],
      tables: [
        {
          key: 'notes',
          title: 'Notes',
          columns: [{ key: 'note', header: 'Note', format: 'text' }],
          rows: [{ note: 'He said "it\'s broken",\nthen left' }],
          total: 1,
        },
      ],
    });

    /* Quoted and doubled, so the value stays inside one cell. */
    expect(csv).toContain('"He said ""it\'s broken"",');
  });

  it('carries the protection into the real CSV export', async () => {
    /* A complaint category is free text typed by a person, and the products
       report prints it — so the payload goes through the whole stack. */
    await makeComplaint('SN-INJ', { category: '=cmd|\'/c calc\'!A1' });

    const res = await request(app)
      .get('/reports/products?format=csv')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain("'=cmd");
    /* Nothing in the file may begin a line or a cell with a bare `=`. */
    expect(res.text).not.toMatch(/(^|,)=/m);
  });
});

/* ---- Complaint report --------------------------------------------------- */

describe('complaint report (section 16)', () => {
  it('summarises totals, closures and the repeat rate', async () => {
    await makeComplaint('SN-R1');
    await makeComplaint('SN-R2', { priority: 'CRITICAL' });

    const body = await report('complaints', c.admin);

    expect(stat(body, 'total')).toBe(2);
    expect(stat(body, 'open')).toBe(2);
    expect(stat(body, 'closed')).toBe(0);
    expect(stat(body, 'repeatRate')).toBe(0);
    /* Nothing has closed, so there is no time-to-close to report — a zero
       would claim instant repairs. */
    expect(stat(body, 'avgCloseHours')).toBeNull();

    const [city] = rowsOf(body, 'byCity');
    expect(city).toMatchObject({ city: 'Jaipur', territory: 'Territory NORTH', complaints: 2 });
  });

  it('applies the section 16 date filter', async () => {
    await makeComplaint('SN-R3');

    const body = await report('complaints', c.admin, `from=${tomorrow()}`);

    expect(stat(body, 'total')).toBe(0);
  });

  it('applies the priority filter', async () => {
    await makeComplaint('SN-R4', { priority: 'CRITICAL' });
    await makeComplaint('SN-R5', { priority: 'LOW' });

    const body = await report('complaints', c.admin, 'priority=CRITICAL');

    expect(stat(body, 'total')).toBe(1);
  });

  it('applies the territory filter', async () => {
    /* Section 16 lists territory as a filter. It used to be accepted and then
       ignored, so a territory report quietly showed every territory. */
    const south = await makeTerritory('SOUTH');
    const udaipur = await makeCity(south._id, 'Udaipur');

    await makeComplaint('SN-T1');
    await makeComplaint('SN-T2', {
      serviceAddress: {
        address: '1 Lake Road',
        cityId: String(udaipur._id),
        state: 'Rajasthan',
        pincode: '313001',
      },
    });

    const southern = await report('complaints', c.admin, `territoryId=${String(south._id)}`);
    expect(stat(southern, 'total')).toBe(1);
    expect(rowsOf(southern, 'byCity').map((r) => r['city'])).toEqual(['Udaipur']);

    const northern = await report('complaints', c.admin, `territoryId=${String(c.world.territory._id)}`);
    expect(stat(northern, 'total')).toBe(1);

    expect(itemsOf(await report('complaints', c.admin), 'byTerritory')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Territory NORTH', value: 1 }),
        expect.objectContaining({ label: 'Territory SOUTH', value: 1 }),
      ]),
    );
  });

  it('does not count a cancelled complaint as open', async () => {
    await makeComplaint('SN-C1');
    const cancelled = await makeComplaint('SN-C2');
    expect((await post(`/complaints/${cancelled}/cancel`, c.admin, { reason: 'Raised twice' })).status).toBe(200);

    const body = await report('complaints', c.admin);

    expect(stat(body, 'open')).toBe(1);
    expect(stat(body, 'cancelled')).toBe(1);
    expect(rowsOf(body, 'byCity')[0]).toMatchObject({ complaints: 2, open: 1, closed: 0, cancelled: 1 });
  });

  it('lists every priority in order, including those with no complaints', async () => {
    await makeComplaint('SN-P1', { priority: 'HIGH' });

    const body = await report('complaints', c.admin);

    expect(itemsOf(body, 'byPriority').map((i) => [i.key, i.value])).toEqual([
      ['CRITICAL', 0],
      ['HIGH', 1],
      ['NORMAL', 0],
      ['LOW', 0],
    ]);
    expect(itemsOf(body, 'byStatus')[0]).toMatchObject({ key: 'ASSIGNED', label: 'Assigned', value: 1 });
  });

  it('plots complaints over time with the empty days filled in', async () => {
    await makeComplaint('SN-D1');

    const body = await report('complaints', c.admin, `from=${daysAgo(3)}`);

    /* Three days back to today is four days. A trend that skipped the quiet
       days would draw them closer together than they were. */
    expect(body.trend?.unit).toBe('day');
    expect(body.trend?.points).toHaveLength(4);
    expect(body.trend?.points.map((p) => p.value)).toEqual([0, 0, 0, 1]);
  });

  it('reports time to close, closures within SLA and breaches', async () => {
    const closed = await makeComplaint('SN-S1');
    await assign(closed, String(c.world.technician._id));
    await startVisit(closed, c.tech);
    await submitResolution(closed, c.tech);
    await acceptAndClose(closed);

    const late = await makeComplaint('SN-S2');
    await Complaint.updateOne(
      { _id: late },
      { $set: { 'sla.resolutionDueAt': new Date(Date.now() - 3_600_000) } },
    );

    const body = await report('complaints', c.admin);

    expect(stat(body, 'closed')).toBe(1);
    expect(stat(body, 'avgCloseHours')).toBeGreaterThanOrEqual(0);
    /* The one closed complaint closed in time; the late one is still open. */
    expect(stat(body, 'closedWithinSla')).toBe(100);
    expect(stat(body, 'slaBreached')).toBe(1);
  });

  it('caps a table at the requested limit and says so', async () => {
    const south = await makeTerritory('SOUTH');
    const udaipur = await makeCity(south._id, 'Udaipur');
    await makeComplaint('SN-L1');
    await makeComplaint('SN-L2', {
      serviceAddress: { address: '1 Lake Road', cityId: String(udaipur._id), state: 'Rajasthan', pincode: '313001' },
    });

    const body = await report('complaints', c.admin, 'limit=1');

    expect(table(body, 'byCity')).toMatchObject({ total: 2, truncated: true });
    expect(rowsOf(body, 'byCity')).toHaveLength(1);
  });
});

describe('trend periods', () => {
  const labels = { title: 'Complaints raised over time', valueHeader: 'Complaints' };
  const now = new Date('2026-09-17T06:00:00Z'); // a Thursday

  it('groups about three months by week, each starting on a Monday', () => {
    /* By month, "last 90 days" would open with a bar holding a few days of
       June, which reads as a quiet month. */
    const trend = buildTrend(
      [
        { _id: '2026-06-20', count: 2 },
        { _id: '2026-09-14', count: 3 },
        { _id: '2026-09-17', count: 1 },
      ],
      { from: new Date('2026-06-19T18:30:00Z') }, // 20 Jun in India, a Saturday
      labels,
      now,
    );

    expect(trend.unit).toBe('week');
    expect(trend.points[0]).toMatchObject({ key: '2026-06-15', value: 2 });
    expect(trend.points.at(-1)).toMatchObject({ key: '2026-09-14', label: '14 Sep', value: 4 });
    expect(trend.points.every((point) => new Date(`${point.key}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  it('groups a year by month', () => {
    const trend = buildTrend(
      [{ _id: '2026-01-05', count: 1 }],
      { from: new Date('2025-12-31T18:30:00Z') }, // 1 Jan in India
      labels,
      now,
    );

    expect(trend.unit).toBe('month');
    expect(trend.points.map((point) => point.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(trend.points[0]).toMatchObject({ label: 'Jan 2026', value: 1 });
  });
});

/* ---- Service centres ---------------------------------------------------- */

describe('service center report (section 16)', () => {
  it('reports volume and open work per centre', async () => {
    await makeComplaint('SN-SC1');

    const body = await report('service-centers', c.admin);

    expect(rowsOf(body, 'byCenter')[0]).toMatchObject({
      serviceCenter: 'Service Center JAI-01',
      complaints: 1,
      open: 1,
      closed: 0,
      /* Nothing closed yet, so no rate — "100%" would be a claim. */
      closedWithinSla: null,
    });
  });

  it('measures the revisit rate from work that was sent back', async () => {
    /* A revisit is resolved work the centre or Admin rejected. It used to be
       measured by reopened complaints, which is a different thing — a job
       sent back three times and then closed counted as no revisits at all. */
    const id = await makeComplaint('SN-SC2');
    await assign(id, String(c.world.technician._id));
    await startVisit(id, c.tech);
    await submitResolution(id, c.tech);
    await sendBack(id);
    await startVisit(id, c.tech);
    await submitResolution(id, c.tech);

    const body = await report('service-centers', c.admin);

    expect(rowsOf(body, 'byCenter')[0]).toMatchObject({
      resolutionsSubmitted: 2,
      sentBack: 1,
      revisitRate: 50,
    });
  });

  it('tells Admin how many complaints still have no centre', async () => {
    await makeComplaint('SN-SC3');
    await makeComplaint('SN-SC4', { serviceCenterId: undefined });

    const body = await report('service-centers', c.admin);

    expect(stat(body, 'unassigned')).toBe(1);
  });

  /* DECISIONS.md section 31: Admin's rating of the centre's work. */
  describe('avgRating and rated columns', () => {
    async function closeAndRate(id: string, stars: number): Promise<void> {
      await Complaint.updateOne({ _id: id }, { $set: { status: 'CLOSED', closedAt: new Date() } });
      const rated = await post(`/complaints/${id}/rating`, c.admin, { stars });
      expect(rated.status, JSON.stringify(rated.body)).toBe(200);
    }

    it('averages the stars a centre has been given, one decimal, weighted by how many are rated', async () => {
      const a = await makeComplaint('SN-SC5');
      const b = await makeComplaint('SN-SC6');
      const c1 = await makeComplaint('SN-SC7');
      await closeAndRate(a, 4);
      await closeAndRate(b, 5);
      await closeAndRate(c1, 5);

      const body = await report('service-centers', c.admin);

      /* (4 + 5 + 5) / 3 = 4.666... -> 4.7 */
      expect(rowsOf(body, 'byCenter')[0]).toMatchObject({ avgRating: 4.7, rated: 3 });
      expect(stat(body, 'avgRating')).toBe(4.7);
    });

    it('reads the average as null, and rated as 0, when nothing has been rated', async () => {
      await makeComplaint('SN-SC8');

      const body = await report('service-centers', c.admin);

      expect(rowsOf(body, 'byCenter')[0]).toMatchObject({ avgRating: null, rated: 0 });
      expect(stat(body, 'avgRating')).toBeNull();
    });

    it('leaves an unrated complaint out of the average, alongside a rated one', async () => {
      const rated = await makeComplaint('SN-SC9');
      await makeComplaint('SN-SC10'); // left open, and unrated
      await closeAndRate(rated, 3);

      const body = await report('service-centers', c.admin);

      expect(rowsOf(body, 'byCenter')[0]).toMatchObject({ avgRating: 3, rated: 1, complaints: 2 });
    });

    it('carries the columns into the CSV export', async () => {
      const id = await makeComplaint('SN-SC11');
      await closeAndRate(id, 5);

      const res = await request(app)
        .get('/reports/service-centers?format=csv')
        .set('Authorization', `Bearer ${c.admin}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Avg. rating');
      expect(res.text).toContain('Rated');
    });
  });
});

/* ---- Technicians -------------------------------------------------------- */

describe('technician report (section 16)', () => {
  it('reports jobs assigned', async () => {
    const id = await makeComplaint('SN-TE1');
    await assign(id, String(c.world.technician._id));

    const body = await report('technicians', c.admin);

    expect(rowsOf(body, 'byTechnician')[0]).toMatchObject({ technician: 'Technician', jobsAssigned: 1 });
  });

  it('credits each visit, and each rejection, to the technician who did the work', async () => {
    const second = await secondTechnician();
    const id = await makeComplaint('SN-TE2');

    await assign(id, String(c.world.technician._id));
    await startVisit(id, c.tech);
    await submitResolution(id, c.tech);
    await sendBack(id);

    /* The Owner gives the revisit to someone else, who gets it right. */
    await assign(id, second.id);
    await startVisit(id, second.token);
    await submitResolution(id, second.token);

    const rows = rowsOf(await report('technicians', c.admin), 'byTechnician');
    const first = rows.find((r) => r['technician'] === 'Technician');
    const other = rows.find((r) => r['technician'] === 'Second Tech');

    /* The first technician is no longer assigned, but the rejected work was
       theirs — before, they vanished from the report altogether. */
    expect(first).toMatchObject({
      jobsAssigned: 0,
      visitsCompleted: 1,
      resolutionsSubmitted: 1,
      sentBack: 1,
      revisitRate: 100,
    });
    expect(other).toMatchObject({
      jobsAssigned: 1,
      visitsCompleted: 1,
      resolutionsSubmitted: 1,
      sentBack: 0,
      revisitRate: 0,
    });
  });

  it('counts visits only on complaints inside the date range', async () => {
    const old = await makeComplaint('SN-TE3');
    await assign(old, String(c.world.technician._id));
    await startVisit(old, c.tech);
    await submitResolution(old, c.tech);
    /* Straight to the collection: Mongoose treats `createdAt` as immutable
       and would silently drop the change. */
    await Complaint.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(old) },
      { $set: { createdAt: new Date(daysAgo(60)) } },
    );

    const recent = await makeComplaint('SN-TE4');
    await assign(recent, String(c.world.technician._id));
    await startVisit(recent, c.tech);
    await submitResolution(recent, c.tech);

    /* Jobs were counted for the range but visits for all time, so a monthly
       report mixed this month's jobs with last year's visits. */
    const body = await report('technicians', c.admin, `from=${daysAgo(30)}`);

    expect(rowsOf(body, 'byTechnician')[0]).toMatchObject({
      jobsAssigned: 1,
      visitsCompleted: 1,
      resolutionsSubmitted: 1,
    });
  });

  it('reports the parts each technician used', async () => {
    const partId = await setStock('PAD-01', 10, 2);
    const id = await makeComplaint('SN-TE5');
    await assign(id, String(c.world.technician._id));
    await startVisit(id, c.tech);

    const used = await post(`/complaints/${id}/part-usage`, c.tech, { partId, quantity: 3 });
    expect(used.status).toBe(201);
    expect((await post(`/parts/usage/${used.body.usage.id}/finalize`, c.owner)).status).toBe(200);

    const body = await report('technicians', c.admin);

    expect(rowsOf(body, 'byTechnician')[0]).toMatchObject({ partsUsed: 3 });
  });
});

/* ---- Products ----------------------------------------------------------- */

describe('product report (section 16)', () => {
  it('counts affected units per model, not just complaints', async () => {
    /* Section 16's "repeat issue patterns": two complaints on one unit is a
       different signal from two complaints on two units. */
    await makeComplaint('SN-SAME');
    await makeComplaint('SN-SAME');
    await makeComplaint('SN-OTHER');

    const body = await report('products', c.admin);

    expect(rowsOf(body, 'byModel')[0]).toMatchObject({
      product: 'Desert Cooler 50L',
      model: 'DC50-X',
      complaints: 3,
      unitsAffected: 2,
      complaintsPerUnit: 1.5,
    });
  });

  it('lists the units that keep coming back, newest complaint first', async () => {
    /* Section 16's "serial number history". */
    await makeComplaint('SN-SAME');
    const latest = await makeComplaint('SN-SAME');
    await makeComplaint('SN-OTHER');

    const body = await report('products', c.admin);

    expect(stat(body, 'repeatUnits')).toBe(1);
    const rows = rowsOf(body, 'repeatUnits');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serialNumber: 'SN-SAME', complaints: 2, latestComplaintId: latest });
  });

  it('shows the most common issues', async () => {
    await makeComplaint('SN-I1', { category: 'Not cooling' });
    await makeComplaint('SN-I2', { category: 'Not cooling' });
    await makeComplaint('SN-I3', { category: 'Water leakage' });

    const body = await report('products', c.admin);

    expect(itemsOf(body, 'byCategory')[0]).toMatchObject({ label: 'Not cooling', value: 2 });
  });
});

/* ---- Parts -------------------------------------------------------------- */

describe('parts report (section 16)', () => {
  it('reports stock and low stock to the Owner', async () => {
    await setStock('PAD-01', 2, 5);

    const body = await report('parts', c.owner);

    const row = rowsOf(body, 'byPart').find((r) => r['code'] === 'PAD-01');
    expect(row).toMatchObject({ inStock: 2, lowStock: 'Yes' });
    expect(stat(body, 'lowStockItems')).toBe(1);
  });

  it('tells Admin how many centres are low on each part', async () => {
    await setStock('PAD-01', 2, 5);

    const row = rowsOf(await report('parts', c.admin), 'byPart').find((r) => r['code'] === 'PAD-01');

    expect(row).toMatchObject({ inStock: 2, lowStockAt: 1 });
  });

  it('reports consumption by part, technician and centre, within the dates', async () => {
    const partId = await setStock('PAD-01', 10, 2);
    const id = await makeComplaint('SN-PT1');
    await assign(id, String(c.world.technician._id));
    await startVisit(id, c.tech);
    const used = await post(`/complaints/${id}/part-usage`, c.tech, { partId, quantity: 3 });
    expect((await post(`/parts/usage/${used.body.usage.id}/finalize`, c.owner)).status).toBe(200);

    const body = await report('parts', c.admin);

    expect(stat(body, 'partsUsed')).toBe(3);
    expect(rowsOf(body, 'byPart').find((r) => r['code'] === 'PAD-01')).toMatchObject({ used: 3, jobs: 1 });
    expect(rowsOf(body, 'byTechnician')[0]).toMatchObject({ technician: 'Technician', used: 3, jobs: 1 });
    expect(rowsOf(body, 'byCenter')[0]).toMatchObject({ serviceCenter: 'Service Center JAI-01', used: 3 });

    const later = await report('parts', c.admin, `from=${tomorrow()}`);
    expect(stat(later, 'partsUsed')).toBe(0);
  });

  it('counts part requests and the ones marked unavailable', async () => {
    const partId = await setStock('PUMP-01', 0, 1);
    const id = await makeComplaint('SN-PT2');
    await assign(id, String(c.world.technician._id));
    await startVisit(id, c.tech);

    const requested = await post(`/complaints/${id}/part-requests`, c.tech, { partId, quantityRequested: 1 });
    expect(requested.status).toBe(201);
    const decided = await post(`/parts/requests/${requested.body.request.id}/decide`, c.owner, {
      status: 'UNAVAILABLE',
      remarks: 'Supplier is out of stock',
    });
    expect(decided.status).toBe(200);

    const body = await report('parts', c.admin);

    expect(stat(body, 'unavailableRequests')).toBe(1);
    expect(rowsOf(body, 'byPart').find((r) => r['code'] === 'PUMP-01')).toMatchObject({
      requested: 1,
      unavailable: 1,
    });
  });

  it('says which filters it does not use', async () => {
    const body = await report('parts', c.admin, 'priority=HIGH');

    expect(body.ignoredFilters.map((f) => f.key)).toEqual(['priority']);
  });
});

/* ---- Scope -------------------------------------------------------------- */

describe('report scoping and permissions', () => {
  it('limits an owner to their own service centre', async () => {
    await makeComplaint('SN-S1');

    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-60',
    );
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000061',
      serviceCenterId: otherCentre._id,
    });

    /* "Centre performance" for an Owner means *their* centre, not a league
       table of everyone else's. */
    const theirs = await report('service-centers', await token('9800000061'));
    expect(rowsOf(theirs, 'byCenter')).toHaveLength(0);

    const ours = await report('service-centers', c.owner);
    expect(rowsOf(ours, 'byCenter')).toHaveLength(1);
    /* An Owner has nothing to assign, so the Admin-only figure is absent. */
    expect(stat(ours, 'unassigned')).toBeUndefined();
  });

  it('cannot be widened by supplying another centre in the filter', async () => {
    await makeComplaint('SN-S2');

    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-61',
    );

    /* Scope and filter combine with $and, so the filter narrows rather than
       replaces. */
    const body = await report('complaints', c.owner, `serviceCenterId=${String(otherCentre._id)}`);
    expect(stat(body, 'total')).toBe(0);
  });

  it('gives a technician no reports at all', async () => {
    const res = await request(app)
      .get('/reports/complaints')
      .set('Authorization', `Bearer ${c.tech}`);

    expect(res.status).toBe(403);
  });

  it('rejects an unknown report name', async () => {
    const res = await request(app)
      .get('/reports/../../etc/passwd')
      .set('Authorization', `Bearer ${c.admin}`);

    /* The name is matched against a fixed table, never used to build a query. */
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/* ---- Export ------------------------------------------------------------- */

describe('export formats (section 16)', () => {
  it('produces a CSV with headers and a download filename', async () => {
    await makeComplaint('SN-E1');

    const res = await request(app)
      .get('/reports/complaints?format=csv')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="complaint-report-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.text).toContain('City,Territory,Complaints,Open,Closed,Cancelled,Closure rate (%),SLA breached');
    /* A BOM, so Excel reads UTF-8 rather than mangling a non-ASCII name. */
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
  });

  it('puts the summary and every breakdown into the download, not just one table', async () => {
    /* The screen shows totals and breakdowns; a download holding only the
       city table would disagree with the page it came from. */
    await makeComplaint('SN-E2');

    const res = await request(app)
      .get('/reports/complaints?format=csv')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.text).toContain('Complaints,1');
    expect(res.text).toContain('Status,Complaints');
    expect(res.text).toContain('Assigned,1');
    expect(res.text).toContain('Priority,Complaints');
  });

  it('produces a real xlsx file with a sheet per table and numbers as numbers', async () => {
    await makeComplaint('SN-E3');

    const res = await request(app)
      .get('/reports/complaints?format=xlsx')
      .set('Authorization', `Bearer ${c.admin}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    /* XLSX is a zip: the first two bytes are PK. */
    const body = res.body as Buffer;
    expect(body.subarray(0, 2).toString()).toBe('PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(body as unknown as ArrayBuffer);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    expect(names).toEqual(expect.arrayContaining(['Summary', 'By city']));

    /* A count stored as text sorts "10" before "9" and cannot be summed. */
    const byCity = workbook.getWorksheet('By city')!;
    const header = byCity.getRow(1).values as unknown[];
    const complaintsColumn = header.indexOf('Complaints');
    expect(complaintsColumn).toBeGreaterThan(0);
    expect(typeof byCity.getRow(2).getCell(complaintsColumn).value).toBe('number');
  });

  it('writes the filters in force into the exported file, by name', async () => {
    await makeComplaint('SN-E4');

    const res = await request(app)
      .get(`/reports/complaints?format=csv&priority=NORMAL&cityId=${String(c.world.city._id)}`)
      .set('Authorization', `Bearer ${c.admin}`);

    /* A saved export should explain itself weeks later: what was filtered,
       and who produced it — in words, not database identifiers. The fixture
       Admin is named 'Admin'. */
    expect(res.text).toContain('Priority,Normal');
    expect(res.text).toContain('City,Jaipur');
    expect(res.text).toContain('Generated by,Admin');
    expect(res.text).not.toContain(String(c.world.city._id));
  });
});

/* ---- Dashboards -------------------------------------------------------- */

describe('dashboard (sections 5.1, 9)', () => {
  it('returns all ten KPI cards from section 5.1', async () => {
    await makeComplaint('SN-D1');
    await makeComplaint('SN-D2', { priority: 'CRITICAL' });

    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);

    for (const card of [
      'totalOpen',
      'newComplaints',
      'inProgress',
      'waitingForParts',
      'revisitRequired',
      'resolutionSubmitted',
      'adminConfirmationPending',
      'closed',
      'slaBreached',
      'critical',
    ]) {
      expect(res.body.kpis, `missing KPI: ${card}`).toHaveProperty(card);
    }

    expect(res.body.kpis.totalOpen).toBe(2);
    expect(res.body.kpis.critical).toBe(1);
  });

  it('returns all nine breakdowns from section 5.1', async () => {
    await makeComplaint('SN-D3');

    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${c.admin}`);

    for (const chart of [
      'byStatus',
      'byPriority',
      'byCity',
      'byServiceCenter',
      'byModel',
      'byWarranty',
      'repeatComplaints',
      'slaPerformance',
      'technicianWorkload',
    ]) {
      expect(res.body.breakdowns, `missing breakdown: ${chart}`).toHaveProperty(chart);
    }

    expect(res.body.breakdowns.byCity[0]).toEqual({ label: 'Jaipur', count: 1 });
  });

  it('returns the section 9 operational panels', async () => {
    const id = await makeComplaint('SN-D4');
    await assign(id, String(c.world.technician._id));
    await post(`/complaints/${id}/visits`, c.owner, { scheduledAt: tomorrow() });

    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${c.owner}`);

    expect(res.body.operations.upcomingVisits).toBe(1);
    expect(res.body.operations.activeTechnicians).toBe(1);
  });

  it('scopes an owner to their own centre', async () => {
    await makeComplaint('SN-D5');

    const otherCentre = await makeServiceCenter(
      c.world.city._id,
      c.world.territory._id,
      'JAI-62',
    );
    await makeUser({
      role: 'SERVICE_CENTER_OWNER',
      mobile: '9800000063',
      serviceCenterId: otherCentre._id,
    });

    const theirs = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${await token('9800000063')}`);

    expect(theirs.body.kpis.totalOpen).toBe(0);
  });

  it('sends a technician to their work queue instead', async () => {
    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${c.tech}`);

    /* Section 10 gives them "My Jobs", which is a queue, not a management
       view — and the message says where to find it. */
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/my-jobs/);
  });

  it('counts a breached SLA', async () => {
    const id = await makeComplaint('SN-D6');

    /* Wind the deadline into the past; breach is derived on read. */
    await Complaint.updateOne(
      { _id: id },
      { $set: { 'sla.resolutionDueAt': new Date(Date.now() - 3_600_000) } },
    );
    await request(app)
      .get(`/complaints/${id}`)
      .set('Authorization', `Bearer ${c.admin}`);

    const res = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.body.kpis.slaBreached).toBe(1);
  });
});
