/**
 * "Today" and "this year" are the company's, not the server's (core/time.ts).
 *
 * The bug: `setHours(0, 0, 0, 0)` and `getFullYear()` answer in the server
 * process's own timezone. The client operates in India, but a host usually
 * runs on UTC — where "visits today", "missed", a technician's visits-today
 * count and the technician app's Today/Upcoming all rolled over at 05:30 IST,
 * and a complaint raised just after midnight IST on 1 January got last year's
 * number.
 *
 * The integration tests below run with the process switched to **UTC**, the
 * way a typical server would run, so the old code fails them. They pin "now"
 * at 2026-09-16T20:00:00Z: still 16 September in UTC, but 01:30 on
 * 17 September in India.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { nextComplaintNumber } from '../../src/core/complaintNumber.js';
import {
  companyDate,
  companyDateBounds,
  companyDateKey,
  companyDayBounds,
  companyYear,
  parseDateKey,
  startOfCompanyDay,
} from '../../src/core/time.js';
import type { AuthContext } from '../../src/middleware/authenticate.js';
import { Visit } from '../../src/models/index.js';
import { dashboard } from '../../src/modules/reports/dashboard.service.js';
import { listUsers } from '../../src/modules/users/users.service.js';
import { myJobs } from '../../src/modules/visits/visits.service.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const iso = (date: Date) => date.toISOString();

/* ---- The helpers themselves -------------------------------------------- */

describe('company calendar helpers', () => {
  const IST = 'Asia/Kolkata';

  it('puts an evening UTC instant on the next day in India', () => {
    const instant = new Date('2026-09-16T20:00:00Z');

    expect(companyDate(instant, IST)).toEqual({ year: 2026, month: 9, day: 17 });
    expect(companyDateKey(instant, IST)).toBe('2026-09-17');
    expect(companyDateKey(instant, 'UTC')).toBe('2026-09-16');
  });

  it('bounds the Indian day at 18:30 UTC on either side', () => {
    const { start, end } = companyDayBounds(new Date('2026-09-16T20:00:00Z'), IST);

    expect(iso(start)).toBe('2026-09-16T18:30:00.000Z');
    expect(iso(end)).toBe('2026-09-17T18:30:00.000Z');
    expect(iso(startOfCompanyDay(new Date('2026-09-16T20:00:00Z'), IST))).toBe(iso(start));
  });

  it('keeps the last second before midnight on the earlier day', () => {
    const lastSecond = new Date('2026-09-16T18:29:59Z'); // 23:59:59 IST, 16 Sep
    const { start, end } = companyDayBounds(lastSecond, IST);

    expect(iso(start)).toBe('2026-09-15T18:30:00.000Z');
    expect(iso(end)).toBe('2026-09-16T18:30:00.000Z');
  });

  it('files an instant just after midnight on 1 January under the new year', () => {
    const tenPastMidnight = new Date('2026-12-31T18:40:00Z'); // 00:10 IST, 1 Jan 2027

    expect(companyYear(tenPastMidnight, IST)).toBe(2027);
    expect(companyYear(tenPastMidnight, 'UTC')).toBe(2026);
  });

  it('measures a day by the calendar across daylight-saving changes', () => {
    /* India has no daylight saving; the helpers must still be right where
       there is, because APP_TIMEZONE is configuration. */
    const spring = companyDateBounds({ year: 2026, month: 3, day: 8 }, 'America/New_York');
    expect(iso(spring.start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(spring.end)).toBe('2026-03-09T04:00:00.000Z'); // a 23-hour day

    const autumn = companyDateBounds({ year: 2026, month: 11, day: 1 }, 'America/New_York');
    expect(iso(autumn.start)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(autumn.end)).toBe('2026-11-02T05:00:00.000Z'); // a 25-hour day
  });

  it('starts a day whose midnight was skipped at the moment the clocks jumped', () => {
    /* Cuba springs forward at midnight: 23:59:59 is followed by 01:00. */
    const { start, end } = companyDateBounds({ year: 2026, month: 3, day: 8 }, 'America/Havana');

    expect(iso(start)).toBe('2026-03-08T05:00:00.000Z'); // 01:00 local
    expect(iso(end)).toBe('2026-03-09T04:00:00.000Z');
  });

  it('reads only real calendar dates', () => {
    expect(parseDateKey('2026-09-17')).toEqual({ year: 2026, month: 9, day: 17 });
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('17/09/2026')).toBeNull();
  });
});

/* ---- The screens that depend on them, on a UTC server ------------------- */

describe('on a server running in UTC', () => {
  /** 01:30 on 17 September in India; still 16 September in UTC. */
  const NOW = new Date('2026-09-16T20:00:00Z');

  const app = createApp();
  let world: Awaited<ReturnType<typeof seedWorld>>;
  let systemZone: string;

  beforeAll(() => {
    /* The expectations below are written in Indian time. */
    expect(config.APP_TIMEZONE, 'these tests assume APP_TIMEZONE=Asia/Kolkata').toBe('Asia/Kolkata');

    systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env['TZ'] = 'UTC';
  });

  afterAll(() => {
    /* Deleting TZ does not bring the system zone back; setting it does. */
    process.env['TZ'] = systemZone;
  });

  const token = async (mobile: string) =>
    (await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD })).body
      .accessToken as string;

  const authOf = (user: typeof world.owner): AuthContext => ({
    userId: String(user._id),
    role: user.role,
    name: user.name,
    ...(user.serviceCenterId ? { serviceCenterId: String(user.serviceCenterId) } : {}),
    mustChangePassword: false,
  });

  let admin: string;
  let owner: string;

  /** A complaint with a visit booked for the technician, moved to `scheduledAt`. */
  async function visitAt(serial: string, scheduledAt: string): Promise<string> {
    const created = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        customerId: String(world.customer._id),
        productId: String(world.product._id),
        productModelId: String(world.productModel._id),
        serialNumber: serial,
        category: 'Not cooling',
        description: 'Warm air.',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
        serviceCenterId: String(world.center._id),
      });
    const id = created.body.complaint.id as string;

    await request(app)
      .post(`/complaints/${id}/assign-technician`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ technicianId: String(world.technician._id) });
    const booked = await request(app)
      .post(`/complaints/${id}/visits`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() });
    expect(booked.status).toBe(201);

    /* Booking refuses past dates, so the visit is moved into place afterwards. */
    await Visit.updateOne({ _id: booked.body.visit.id }, { $set: { scheduledAt: new Date(scheduledAt) } });
    return booked.body.visit.id as string;
  }

  describe('visits', () => {
    let visits: Record<'missed' | 'afternoon' | 'evening' | 'tomorrow', string>;

    beforeEach(async () => {
      world = await seedWorld();
      admin = await token('9800000001');
      owner = await token('9800000002');
      visits = {
        /* 17:30 IST on 16 Sep — yesterday in India, "today" to a UTC clock. */
        missed: await visitAt('SN-TZ-1', '2026-09-16T12:00:00Z'),
        /* 15:30 and 20:30 IST on 17 Sep — today in India, "tomorrow" to UTC. */
        afternoon: await visitAt('SN-TZ-2', '2026-09-17T10:00:00Z'),
        evening: await visitAt('SN-TZ-3', '2026-09-17T15:00:00Z'),
        /* 00:30 IST on 18 Sep — tomorrow either way. */
        tomorrow: await visitAt('SN-TZ-4', '2026-09-17T19:00:00Z'),
      };
    });

    it("counts today's, upcoming and missed visits by the Indian day", async () => {
      const result = await dashboard({}, authOf(world.owner), NOW);

      expect(result.operations).toMatchObject({
        todaysVisits: 2,
        upcomingVisits: 1,
        missedVisits: 1,
      });
    });

    it("counts a technician's visits today by the Indian day", async () => {
      const page = await listUsers(
        { page: 1, limit: 25, role: 'TECHNICIAN', includeInactive: false },
        authOf(world.owner),
        NOW,
      );
      const row = page.items.find((user) => user.id === String(world.technician._id));

      expect(row?.workload?.visitsToday).toBe(2);
    });

    it("splits the technician's Today and Upcoming at Indian midnight", async () => {
      const jobs = await myJobs(authOf(world.technician), NOW);

      /* Today keeps the missed visit, oldest first (visits.service.ts). */
      expect(jobs.today.map((card) => card.id)).toEqual([visits.missed, visits.afternoon, visits.evening]);
      expect(jobs.upcoming.map((card) => card.id)).toEqual([visits.tomorrow]);
    });

    it('reads a calendar date on the schedule as an Indian day', async () => {
      const res = await request(app)
        .get('/visits')
        .query({ date: '2026-09-17' })
        .set('Authorization', `Bearer ${owner}`);

      expect(res.status).toBe(200);
      expect(res.body.items.map((card: { id: string }) => card.id).sort()).toEqual(
        [visits.afternoon, visits.evening].sort(),
      );

      const bogus = await request(app)
        .get('/visits')
        .query({ date: 'someday' })
        .set('Authorization', `Bearer ${owner}`);
      expect(bogus.status).toBe(400);
    });
  });

  it('numbers a complaint raised just after midnight on 1 January into the new year', async () => {
    const number = await nextComplaintNumber(null, new Date('2026-12-31T18:40:00Z'));

    expect(number).toBe('CMP-2027-000001');
  });
});
