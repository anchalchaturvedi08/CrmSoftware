/**
 * Reports (spec section 16).
 *
 * Five reports, matching the five headings section 16 lists: complaints,
 * service centre performance, technician performance, products, and parts.
 *
 * All of them run as aggregation pipelines rather than loading documents and
 * summing in JavaScript. A report over a year of complaints would otherwise
 * pull every record into memory to produce twenty rows — MongoDB can group
 * and count where the data already is.
 *
 * Every pipeline begins with the caller's scope. Section 3.2 restricts an
 * Owner to their own centre, and a report is not an exception: "centre
 * performance" for an Owner means *their* centre, not a league table of
 * everyone else's.
 *
 * ## What the dates mean
 *
 * The four complaint reports count **complaints raised in the date range, and
 * all the work done on them** — visits, rejections, parts. One rule for every
 * figure, so the numbers in a row always describe the same set of complaints.
 * The parts report counts **parts used and requested in the range**, because
 * stock is managed month by month; its stock levels are as they stand now.
 *
 * ## Revisits
 *
 * A revisit is resolved work that was sent back — by the service centre's
 * review, or by Admin after speaking to the customer. Each rejection is
 * credited to whoever submitted the rejected resolution, so a technician who
 * hands over a job keeps the record of the work they did on it.
 */
import type { PipelineStage } from 'mongoose';
import { complaintScope } from '../../core/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  City,
  Complaint,
  ComplaintActivity,
  Part,
  PartRequest,
  PartStock,
  PartUsage,
  ServiceCenter,
  Territory,
  User,
  Visit,
} from '../../models/index.js';
import { TERMINAL_STATUSES, WARRANTY_STATUSES } from '../../models/enums.js';
import { config } from '../../config/env.js';
import { buildTrend, complaintMatch, dateRange, oid } from './report.filters.js';
import {
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
  UNIT_LABELS,
  WARRANTY_LABELS,
} from './report.labels.js';
import type { Breakdown, ReportColumn, ReportResult, ReportRow } from './report.types.js';
import type { ReportFilterInput } from './reports.validation.js';

/* ---- Shared arithmetic ---------------------------------------------------- */

const HOUR = 3_600_000;

/**
 * Average hours to two decimals, or null when there is nothing to average.
 *
 * Two, not one: a tenth of an hour is six minutes, so a job closed in eight
 * minutes read as six. Screens turn short times into minutes and long ones
 * into days, so the extra digit never shows as clutter.
 */
const averageHours = (totalMs: number, count: number): number | null =>
  count > 0 ? Math.round((totalMs / count / HOUR) * 100) / 100 : null;

/** A whole-number percentage, or null when there is no denominator. */
const percent = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null;

/* ---- Shared pipeline expressions ------------------------------------------ */

const TERMINAL = [...TERMINAL_STATUSES];
const IS_CLOSED = { $eq: ['$status', 'CLOSED'] };
const IS_CANCELLED = { $eq: ['$status', 'CANCELLED'] };
const IS_OPEN = { $not: [{ $in: ['$status', TERMINAL] }] };
/* Ever breached, open or closed: a complaint closed late keeps its
   `breachedAt` (core/sla.ts `complete`). */
const WAS_BREACHED = { $gt: ['$sla.breachedAt', null] };
const CLOSED_WITHIN_SLA = { $and: [IS_CLOSED, { $not: [WAS_BREACHED] }] };
const WAS_REOPENED = { $gt: ['$reopenCount', 0] };

const countWhere = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });

/** Raised-to-closed time, summed over closed complaints. */
const CLOSE_MS = {
  $sum: {
    $cond: [
      { $and: [IS_CLOSED, { $gt: ['$closedAt', null] }] },
      { $subtract: ['$closedAt', '$createdAt'] },
      0,
    ],
  },
};

/** Resolutions submitted on a complaint, as a lookup that yields `[{ n }]`. */
const lookupResolutionCount = (as: string): PipelineStage.Lookup => ({
  $lookup: {
    from: Visit.collection.collectionName,
    localField: '_id',
    foreignField: 'complaintId',
    as,
    pipeline: [{ $match: { 'resolution.submittedAt': { $ne: null } } }, { $count: 'n' }],
  },
});

/** Times a complaint's resolution was sent back, as a lookup that yields `[{ n }]`. */
const lookupRejectionCount = (as: string): PipelineStage.Lookup => ({
  $lookup: {
    from: ComplaintActivity.collection.collectionName,
    localField: '_id',
    foreignField: 'complaintId',
    as,
    pipeline: [{ $match: { action: 'RESOLUTION_REJECTED' } }, { $count: 'n' }],
  },
});

const firstCount = (field: string) => ({ $ifNull: [{ $arrayElemAt: [`$${field}.n`, 0] }, 0] });

const COMPLAINT_DATES =
  'Counts complaints raised in the selected dates, and all the work done on them.';

/* ---- 1. Complaint reports ------------------------------------------------- */

interface ComplaintFacets {
  totals: Array<{
    total: number;
    open: number;
    closed: number;
    cancelled: number;
    breached: number;
    closedWithinSla: number;
    reopened: number;
    closeMs: number;
  }>;
  byStatus: Array<{ _id: keyof typeof STATUS_LABELS; value: number }>;
  byPriority: Array<{ _id: keyof typeof PRIORITY_LABELS; value: number }>;
  byWarranty: Array<{ _id: keyof typeof WARRANTY_LABELS; value: number }>;
  byCity: Array<{
    _id: unknown;
    cityName?: string;
    complaints: number;
    open: number;
    closed: number;
    cancelled: number;
    breached: number;
  }>;
  byDay: Array<{ _id: string; count: number }>;
}

/**
 * Complaint volume and breakdowns (section 16, "Complaint reports").
 *
 * One pass over the matched complaints produces every breakdown using
 * `$facet`; separate queries would scan the same documents six times.
 */
export async function complaintReport(
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<ReportResult> {
  const match = await complaintMatch(filter, auth);

  const [facets] = await Complaint.aggregate<ComplaintFacets>([
    { $match: match },
    /* Only what the facets read, so each branch carries small documents. */
    {
      $project: {
        status: 1,
        priority: 1,
        warrantyStatus: 1,
        createdAt: 1,
        closedAt: 1,
        reopenCount: 1,
        'sla.breachedAt': 1,
        'serviceAddress.cityId': 1,
        'serviceAddress.cityName': 1,
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              open: countWhere(IS_OPEN),
              closed: countWhere(IS_CLOSED),
              cancelled: countWhere(IS_CANCELLED),
              breached: countWhere(WAS_BREACHED),
              closedWithinSla: countWhere(CLOSED_WITHIN_SLA),
              reopened: countWhere(WAS_REOPENED),
              closeMs: CLOSE_MS,
            },
          },
        ],
        byStatus: [
          { $group: { _id: '$status', value: { $sum: 1 } } },
          { $sort: { value: -1, _id: 1 } },
        ],
        byPriority: [{ $group: { _id: '$priority', value: { $sum: 1 } } }],
        byWarranty: [{ $group: { _id: '$warrantyStatus', value: { $sum: 1 } } }],
        byCity: [
          {
            $group: {
              /* By id, so a renamed city stays one row. */
              _id: '$serviceAddress.cityId',
              cityName: { $max: '$serviceAddress.cityName' },
              complaints: { $sum: 1 },
              open: countWhere(IS_OPEN),
              closed: countWhere(IS_CLOSED),
              cancelled: countWhere(IS_CANCELLED),
              breached: countWhere(WAS_BREACHED),
            },
          },
        ],
        byDay: [
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt',
                  timezone: config.APP_TIMEZONE,
                },
              },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  const totals = facets?.totals[0] ?? {
    total: 0,
    open: 0,
    closed: 0,
    cancelled: 0,
    breached: 0,
    closedWithinSla: 0,
    reopened: 0,
    closeMs: 0,
  };

  /* Cities and their territories, as they stand today. */
  const cityIds = (facets?.byCity ?? []).map((row) => row._id).filter(Boolean);
  const cities = await City.find({ _id: { $in: cityIds } })
    .select('name territoryId')
    .lean()
    .exec();
  const territories = await Territory.find({ _id: { $in: cities.map((city) => city.territoryId) } })
    .select('name')
    .lean()
    .exec();
  const cityById = new Map(cities.map((city) => [String(city._id), city]));
  const territoryById = new Map(territories.map((territory) => [String(territory._id), territory]));

  const cityRows = (facets?.byCity ?? [])
    .map((row) => {
      const city = cityById.get(String(row._id));
      const territory = city ? territoryById.get(String(city.territoryId)) : undefined;
      return {
        city: city?.name ?? row.cityName ?? 'Unknown',
        territory: territory?.name ?? null,
        complaints: row.complaints,
        open: row.open,
        closed: row.closed,
        cancelled: row.cancelled,
        closureRate: percent(row.closed, row.complaints),
        slaBreached: row.breached,
      };
    })
    .sort((a, b) => b.complaints - a.complaints || a.city.localeCompare(b.city));

  const territoryTotals = new Map<string, number>();
  for (const row of cityRows) {
    const name = row.territory ?? 'No territory';
    territoryTotals.set(name, (territoryTotals.get(name) ?? 0) + row.complaints);
  }

  const find = <K extends string>(rows: Array<{ _id: K; value: number }> | undefined, key: K) =>
    rows?.find((row) => row._id === key)?.value ?? 0;

  const breakdowns: Breakdown[] = [
    {
      key: 'byStatus',
      title: 'By status',
      labelHeader: 'Status',
      valueHeader: 'Complaints',
      items: (facets?.byStatus ?? []).map((row) => ({
        key: row._id,
        label: STATUS_LABELS[row._id] ?? row._id,
        value: row.value,
      })),
    },
    {
      key: 'byPriority',
      title: 'By priority',
      labelHeader: 'Priority',
      valueHeader: 'Complaints',
      items: PRIORITY_ORDER.map((priority) => ({
        key: priority,
        label: PRIORITY_LABELS[priority],
        value: find(facets?.byPriority, priority),
      })),
    },
    {
      key: 'byWarranty',
      title: 'By warranty',
      labelHeader: 'Warranty',
      valueHeader: 'Complaints',
      items: WARRANTY_STATUSES.map((status) => ({
        key: status,
        label: WARRANTY_LABELS[status],
        value: find(facets?.byWarranty, status),
      })),
    },
    {
      key: 'byTerritory',
      title: 'By territory',
      labelHeader: 'Territory',
      valueHeader: 'Complaints',
      items: [...territoryTotals]
        .map(([label, value]) => ({ key: label, label, value }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
    },
  ];

  return {
    title: 'Complaint report',
    dateBasis: COMPLAINT_DATES,
    summary: [
      { key: 'total', label: 'Complaints', value: totals.total, format: 'number' },
      { key: 'open', label: 'Open', value: totals.open, format: 'number' },
      { key: 'closed', label: 'Closed', value: totals.closed, format: 'number' },
      { key: 'cancelled', label: 'Cancelled', value: totals.cancelled, format: 'number' },
      {
        key: 'avgCloseHours',
        label: 'Avg. time to close',
        value: averageHours(totals.closeMs, totals.closed),
        format: 'hours',
      },
      {
        key: 'closedWithinSla',
        label: 'Closed within SLA',
        value: percent(totals.closedWithinSla, totals.closed),
        format: 'percent',
      },
      { key: 'slaBreached', label: 'SLA breached', value: totals.breached, format: 'number' },
      { key: 'reopened', label: 'Reopened', value: totals.reopened, format: 'number' },
      {
        key: 'repeatRate',
        label: 'Repeat rate',
        value: percent(totals.reopened, totals.total),
        format: 'percent',
      },
    ],
    breakdowns,
    trend: buildTrend(facets?.byDay ?? [], filter, {
      title: 'Complaints raised over time',
      valueHeader: 'Complaints',
    }),
    tables: [
      {
        key: 'byCity',
        title: 'By city',
        columns: [
          { key: 'city', header: 'City', format: 'text', width: 22 },
          { key: 'territory', header: 'Territory', format: 'text', width: 22 },
          { key: 'complaints', header: 'Complaints', format: 'number', width: 12 },
          { key: 'open', header: 'Open', format: 'number', width: 10 },
          { key: 'closed', header: 'Closed', format: 'number', width: 10 },
          { key: 'cancelled', header: 'Cancelled', format: 'number', width: 11 },
          { key: 'closureRate', header: 'Closure rate', format: 'percent', width: 17 },
          { key: 'slaBreached', header: 'SLA breached', format: 'number', width: 14 },
        ],
        rows: cityRows,
        total: cityRows.length,
      },
    ],
  };
}

/* ---- 2. Service centre performance ---------------------------------------- */

interface CenterGroup {
  _id: unknown;
  complaints: number;
  open: number;
  closed: number;
  closedWithinSla: number;
  breached: number;
  reopened: number;
  closeMs: number;
  submitted: number;
  sentBack: number;
  /** Sum of stars over rated complaints, so the average can be weighted when summed across centres. */
  ratingSum: number;
  rated: number;
}

export async function serviceCenterReport(
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<ReportResult> {
  const match = await complaintMatch(filter, auth);

  const groups = await Complaint.aggregate<CenterGroup>([
    { $match: match },
    {
      $project: {
        serviceCenterId: 1,
        status: 1,
        createdAt: 1,
        closedAt: 1,
        reopenCount: 1,
        'sla.breachedAt': 1,
        'serviceRating.stars': 1,
      },
    },
    lookupResolutionCount('resolutions'),
    lookupRejectionCount('rejections'),
    {
      $group: {
        _id: '$serviceCenterId',
        complaints: { $sum: 1 },
        open: countWhere(IS_OPEN),
        closed: countWhere(IS_CLOSED),
        closedWithinSla: countWhere(CLOSED_WITHIN_SLA),
        breached: countWhere(WAS_BREACHED),
        reopened: countWhere(WAS_REOPENED),
        closeMs: CLOSE_MS,
        submitted: { $sum: firstCount('resolutions') },
        sentBack: { $sum: firstCount('rejections') },
        /**
         * DECISIONS.md section 31. Grouped by the complaint's own centre like
         * every other column on this row, and that is the centre that earned
         * the rating: a rating only sits on a closed complaint, closed
         * complaints cannot be moved, and reopening files the rating into the
         * closure history (`reopenComplaint`). No centre is credited — or
         * blamed — for another's stars.
         */
        ratingSum: { $sum: { $ifNull: ['$serviceRating.stars', 0] } },
        rated: countWhere({ $gt: ['$serviceRating.stars', null] }),
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  const assigned = groups.filter((group) => group._id);
  const unassigned = groups.find((group) => !group._id)?.complaints ?? 0;

  const centres = await ServiceCenter.find({ _id: { $in: assigned.map((group) => group._id) } })
    .select('name code')
    .lean()
    .exec();
  const centreById = new Map(centres.map((centre) => [String(centre._id), centre]));

  const rows = assigned
    .map((group) => {
      const centre = centreById.get(String(group._id));
      return {
        serviceCenter: centre?.name ?? 'Unknown',
        code: centre?.code ?? '',
        complaints: group.complaints,
        open: group.open,
        closed: group.closed,
        avgCloseHours: averageHours(group.closeMs, group.closed),
        slaBreached: group.breached,
        closedWithinSla: percent(group.closedWithinSla, group.closed),
        resolutionsSubmitted: group.submitted,
        sentBack: group.sentBack,
        revisitRate: percent(group.sentBack, group.submitted),
        reopened: group.reopened,
        avgRating: group.rated > 0 ? Math.round((group.ratingSum / group.rated) * 10) / 10 : null,
        rated: group.rated,
        /* Carried for the weighted summary total below; not a column — see
           `report.types.ts`: a row may hold keys its table does not show. */
        ratingSum: group.ratingSum,
      };
    })
    .sort((a, b) => b.complaints - a.complaints || a.serviceCenter.localeCompare(b.serviceCenter));

  const sum = (
    key: 'complaints' | 'open' | 'slaBreached' | 'resolutionsSubmitted' | 'sentBack' | 'rated' | 'ratingSum',
  ) => rows.reduce((total, row) => total + row[key], 0);

  /* One decimal, weighted by how many complaints each centre had rated — not
     an average of the per-centre averages, which would let a centre with one
     five-star rating outweigh one with fifty ratings averaging four. */
  const avgRating = sum('rated') > 0 ? Math.round((sum('ratingSum') / sum('rated')) * 10) / 10 : null;

  return {
    title: 'Service center performance',
    dateBasis: COMPLAINT_DATES,
    summary: [
      { key: 'centers', label: 'Service centers', value: rows.length, format: 'number' },
      { key: 'complaints', label: 'Complaints', value: sum('complaints'), format: 'number' },
      { key: 'open', label: 'Open', value: sum('open'), format: 'number' },
      { key: 'slaBreached', label: 'SLA breached', value: sum('slaBreached'), format: 'number' },
      {
        key: 'revisitRate',
        label: 'Revisit rate',
        value: percent(sum('sentBack'), sum('resolutionsSubmitted')),
        format: 'percent',
      },
      /* DECISIONS.md section 31. `SummaryItem.format` (report.types.ts, not
         owned by this stream) has no 'decimal' option; 'number' is the
         closest fit and adds no misleading unit to the label. */
      { key: 'avgRating', label: 'Avg. rating', value: avgRating, format: 'decimal' },
      /* Only Admin assigns centres, so only Admin is shown the queue. */
      ...(auth.role === 'ADMIN'
        ? [
            {
              key: 'unassigned',
              label: 'Waiting for a service center',
              value: unassigned,
              format: 'number' as const,
            },
          ]
        : []),
    ],
    breakdowns: [],
    tables: [
      {
        key: 'byCenter',
        title: 'By service center',
        columns: [
          { key: 'serviceCenter', header: 'Service center', format: 'text', width: 28 },
          { key: 'code', header: 'Code', format: 'text', width: 10 },
          { key: 'complaints', header: 'Complaints', format: 'number', width: 12 },
          { key: 'open', header: 'Open', format: 'number', width: 9 },
          { key: 'closed', header: 'Closed', format: 'number', width: 9 },
          { key: 'avgCloseHours', header: 'Avg. time to close', format: 'hours', width: 26 },
          { key: 'slaBreached', header: 'SLA breached', format: 'number', width: 14 },
          { key: 'closedWithinSla', header: 'Closed within SLA', format: 'percent', width: 22 },
          { key: 'resolutionsSubmitted', header: 'Resolutions submitted', format: 'number', width: 22 },
          { key: 'sentBack', header: 'Sent back', format: 'number', width: 11 },
          { key: 'revisitRate', header: 'Revisit rate', format: 'percent', width: 17 },
          { key: 'reopened', header: 'Reopened', format: 'number', width: 11 },
          { key: 'avgRating', header: 'Avg. rating', format: 'decimal', width: 14 },
          { key: 'rated', header: 'Rated', format: 'number', width: 9 },
        ],
        rows,
        total: rows.length,
      },
    ],
  };
}

/* ---- 3. Technician performance -------------------------------------------- */

interface TechnicianGroup {
  _id: unknown;
  assigned: number;
  open: number;
  closed: number;
  closeMs: number;
  visits: number;
  submitted: number;
  sentBack: number;
  parts: number;
}

/**
 * Technician performance (section 16).
 *
 * Built from the complaint side in one pipeline: each matched complaint
 * contributes an "assigned" event for its current technician, one event per
 * completed visit for whoever made it, one per rejection for whoever submitted
 * the rejected resolution, and one per finalised part for whoever fitted it.
 * Grouping those events by technician gives every column at once, all about
 * the same complaints.
 */
export async function technicianReport(
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<ReportResult> {
  /* The technician filter picks the row, not the complaints. Filtering
     complaints to a technician's *current* jobs would drop the visits they
     made on jobs since handed to someone else. */
  const { technicianId, ...rest } = filter;
  const match = await complaintMatch(rest, auth);

  const groups = await Complaint.aggregate<TechnicianGroup>([
    { $match: match },
    { $project: { technicianId: 1, status: 1, createdAt: 1, closedAt: 1 } },
    {
      $lookup: {
        from: Visit.collection.collectionName,
        localField: '_id',
        foreignField: 'complaintId',
        as: 'visits',
        pipeline: [
          { $match: { status: 'COMPLETED' } },
          { $project: { _id: 0, technicianId: 1, submittedAt: '$resolution.submittedAt' } },
        ],
      },
    },
    {
      $lookup: {
        from: ComplaintActivity.collection.collectionName,
        localField: '_id',
        foreignField: 'complaintId',
        as: 'rejections',
        pipeline: [{ $match: { action: 'RESOLUTION_REJECTED' } }, { $project: { _id: 0, createdAt: 1 } }],
      },
    },
    {
      $lookup: {
        from: PartUsage.collection.collectionName,
        localField: '_id',
        foreignField: 'complaintId',
        as: 'parts',
        pipeline: [
          { $match: { finalizedAt: { $ne: null } } },
          { $project: { _id: 0, recordedBy: 1, quantity: 1 } },
        ],
      },
    },
    {
      $project: {
        events: {
          $concatArrays: [
            {
              $cond: [
                { $gt: ['$technicianId', null] },
                [
                  {
                    technician: '$technicianId',
                    assigned: 1,
                    open: { $cond: [IS_OPEN, 1, 0] },
                    closed: { $cond: [IS_CLOSED, 1, 0] },
                    closeMs: {
                      $cond: [
                        { $and: [IS_CLOSED, { $gt: ['$closedAt', null] }] },
                        { $subtract: ['$closedAt', '$createdAt'] },
                        0,
                      ],
                    },
                  },
                ],
                [],
              ],
            },
            {
              $map: {
                input: '$visits',
                as: 'visit',
                in: {
                  technician: '$$visit.technicianId',
                  visits: 1,
                  submitted: { $cond: [{ $gt: ['$$visit.submittedAt', null] }, 1, 0] },
                },
              },
            },
            {
              $map: {
                input: '$rejections',
                as: 'rejection',
                in: {
                  /* Whoever submitted the latest resolution before the
                     rejection: that is the work that was sent back. */
                  technician: {
                    $getField: {
                      field: 'technicianId',
                      input: {
                        $reduce: {
                          input: '$visits',
                          initialValue: null,
                          in: {
                            $cond: [
                              {
                                $and: [
                                  { $gt: ['$$this.submittedAt', null] },
                                  { $lte: ['$$this.submittedAt', '$$rejection.createdAt'] },
                                  {
                                    $or: [
                                      { $eq: ['$$value', null] },
                                      { $gt: ['$$this.submittedAt', '$$value.submittedAt'] },
                                    ],
                                  },
                                ],
                              },
                              '$$this',
                              '$$value',
                            ],
                          },
                        },
                      },
                    },
                  },
                  sentBack: 1,
                },
              },
            },
            {
              $map: {
                input: '$parts',
                as: 'part',
                in: { technician: '$$part.recordedBy', parts: '$$part.quantity' },
              },
            },
          ],
        },
      },
    },
    { $unwind: '$events' },
    { $match: { 'events.technician': { $ne: null } } },
    {
      $group: {
        _id: '$events.technician',
        assigned: { $sum: { $ifNull: ['$events.assigned', 0] } },
        open: { $sum: { $ifNull: ['$events.open', 0] } },
        closed: { $sum: { $ifNull: ['$events.closed', 0] } },
        closeMs: { $sum: { $ifNull: ['$events.closeMs', 0] } },
        visits: { $sum: { $ifNull: ['$events.visits', 0] } },
        submitted: { $sum: { $ifNull: ['$events.submitted', 0] } },
        sentBack: { $sum: { $ifNull: ['$events.sentBack', 0] } },
        parts: { $sum: { $ifNull: ['$events.parts', 0] } },
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  const wanted = technicianId ? groups.filter((group) => String(group._id) === technicianId) : groups;

  const users = await User.find({ _id: { $in: wanted.map((group) => group._id) } })
    .select('name mobile serviceCenterId')
    .lean()
    .exec();
  const userById = new Map(users.map((user) => [String(user._id), user]));

  const centres = await ServiceCenter.find({ _id: { $in: users.map((user) => user.serviceCenterId).filter(Boolean) } })
    .select('name')
    .lean()
    .exec();
  const centreById = new Map(centres.map((centre) => [String(centre._id), centre.name]));

  const rows = wanted
    .map((group) => {
      const user = userById.get(String(group._id));
      return {
        technician: user?.name ?? 'Unknown',
        mobile: user?.mobile ?? '',
        serviceCenter: user?.serviceCenterId ? (centreById.get(String(user.serviceCenterId)) ?? null) : null,
        jobsAssigned: group.assigned,
        openJobs: group.open,
        closed: group.closed,
        visitsCompleted: group.visits,
        resolutionsSubmitted: group.submitted,
        sentBack: group.sentBack,
        revisitRate: percent(group.sentBack, group.submitted),
        avgCloseHours: averageHours(group.closeMs, group.closed),
        partsUsed: group.parts,
      };
    })
    .sort(
      (a, b) =>
        b.jobsAssigned - a.jobsAssigned ||
        b.visitsCompleted - a.visitsCompleted ||
        a.technician.localeCompare(b.technician),
    );

  const sum = (key: 'jobsAssigned' | 'visitsCompleted' | 'resolutionsSubmitted' | 'sentBack') =>
    rows.reduce((total, row) => total + row[key], 0);

  const columns: ReportColumn[] = [
    { key: 'technician', header: 'Technician', format: 'text', width: 24 },
    { key: 'mobile', header: 'Mobile', format: 'text', width: 13 },
    /* An Owner's technicians are all their own; the column would repeat one name. */
    ...(auth.role === 'ADMIN'
      ? [{ key: 'serviceCenter', header: 'Service center', format: 'text' as const, width: 26 }]
      : []),
    { key: 'jobsAssigned', header: 'Jobs assigned', format: 'number', width: 14 },
    { key: 'openJobs', header: 'Open jobs', format: 'number', width: 11 },
    { key: 'closed', header: 'Closed', format: 'number', width: 9 },
    { key: 'visitsCompleted', header: 'Visits completed', format: 'number', width: 17 },
    { key: 'resolutionsSubmitted', header: 'Resolutions submitted', format: 'number', width: 22 },
    { key: 'sentBack', header: 'Sent back', format: 'number', width: 11 },
    { key: 'revisitRate', header: 'Revisit rate', format: 'percent', width: 17 },
    { key: 'avgCloseHours', header: 'Avg. time to close', format: 'hours', width: 26 },
    { key: 'partsUsed', header: 'Parts used', format: 'number', width: 12 },
  ];

  return {
    title: 'Technician performance',
    dateBasis: COMPLAINT_DATES,
    summary: [
      { key: 'technicians', label: 'Technicians', value: rows.length, format: 'number' },
      { key: 'jobsAssigned', label: 'Jobs assigned', value: sum('jobsAssigned'), format: 'number' },
      { key: 'visitsCompleted', label: 'Visits completed', value: sum('visitsCompleted'), format: 'number' },
      {
        key: 'resolutionsSubmitted',
        label: 'Resolutions submitted',
        value: sum('resolutionsSubmitted'),
        format: 'number',
      },
      { key: 'sentBack', label: 'Sent back', value: sum('sentBack'), format: 'number' },
      {
        key: 'revisitRate',
        label: 'Revisit rate',
        value: percent(sum('sentBack'), sum('resolutionsSubmitted')),
        format: 'percent',
      },
    ],
    breakdowns: [],
    tables: [{ key: 'byTechnician', title: 'By technician', columns, rows, total: rows.length }],
  };
}

/* ---- 4. Product reports --------------------------------------------------- */

/** How many repeat units a report lists; the count above it stays exact. */
const REPEAT_UNIT_LIMIT = 500;

interface ProductFacets {
  byModel: Array<{
    _id: { productName: string; modelNumber: string };
    complaints: number;
    inWarranty: number;
    reopened: number;
    units: number;
  }>;
  byCategory: Array<{ _id: string; value: number }>;
  unitStats: Array<{ units: number; repeat: number }>;
  repeatUnits: Array<{
    _id: string;
    complaints: number;
    latestId: unknown;
    latestNumber: string;
    latestAt: Date;
    productName: string;
    modelNumber: string;
  }>;
}

export async function productReport(
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<ReportResult> {
  const match = await complaintMatch(filter, auth);

  const [facets] = await Complaint.aggregate<ProductFacets>([
    { $match: match },
    {
      $project: {
        serialNumber: 1,
        complaintNumber: 1,
        createdAt: 1,
        category: 1,
        warrantyStatus: 1,
        reopenCount: 1,
        productSnapshot: 1,
      },
    },
    {
      $facet: {
        byModel: [
          {
            $group: {
              /* Grouped on the snapshot, so a renamed product does not
                 scatter its own history across two rows. */
              _id: {
                productName: '$productSnapshot.productName',
                modelNumber: '$productSnapshot.modelNumber',
              },
              complaints: { $sum: 1 },
              inWarranty: countWhere({ $eq: ['$warrantyStatus', 'IN_WARRANTY'] }),
              reopened: countWhere(WAS_REOPENED),
              /* Distinct units, which is what separates "one bad cooler"
                 from "a bad batch" — section 16's "repeat issue patterns". */
              units: { $addToSet: '$serialNumber' },
            },
          },
          { $project: { complaints: 1, inWarranty: 1, reopened: 1, units: { $size: '$units' } } },
        ],
        byCategory: [
          { $group: { _id: '$category', value: { $sum: 1 } } },
          { $sort: { value: -1, _id: 1 } },
        ],
        unitStats: [
          { $group: { _id: '$serialNumber', complaints: { $sum: 1 } } },
          {
            $group: {
              _id: null,
              units: { $sum: 1 },
              repeat: countWhere({ $gt: ['$complaints', 1] }),
            },
          },
        ],
        /* Section 16's "serial number history": the units that keep coming
           back, with their latest complaint to open. */
        repeatUnits: [
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$serialNumber',
              complaints: { $sum: 1 },
              latestId: { $first: '$_id' },
              latestNumber: { $first: '$complaintNumber' },
              latestAt: { $first: '$createdAt' },
              productName: { $first: '$productSnapshot.productName' },
              modelNumber: { $first: '$productSnapshot.modelNumber' },
            },
          },
          { $match: { complaints: { $gt: 1 } } },
          { $sort: { complaints: -1, latestAt: -1 } },
          { $limit: REPEAT_UNIT_LIMIT },
        ],
      },
    },
  ])
    .option({ allowDiskUse: true })
    .exec();

  const modelRows = (facets?.byModel ?? [])
    .map((row) => ({
      product: row._id.productName,
      model: row._id.modelNumber,
      complaints: row.complaints,
      unitsAffected: row.units,
      complaintsPerUnit: row.units > 0 ? Math.round((row.complaints / row.units) * 10) / 10 : null,
      inWarranty: row.inWarranty,
      outOfWarranty: row.complaints - row.inWarranty,
      reopened: row.reopened,
    }))
    .sort((a, b) => b.complaints - a.complaints || a.model.localeCompare(b.model));

  const repeatRows: ReportRow[] = (facets?.repeatUnits ?? []).map((row) => ({
    serialNumber: row._id,
    product: row.productName,
    model: row.modelNumber,
    complaints: row.complaints,
    latestComplaintNumber: row.latestNumber,
    latestComplaintAt: new Date(row.latestAt).toISOString(),
    latestComplaintId: String(row.latestId),
  }));

  const stats = facets?.unitStats[0] ?? { units: 0, repeat: 0 };
  const complaints = modelRows.reduce((total, row) => total + row.complaints, 0);

  return {
    title: 'Product and model report',
    dateBasis: COMPLAINT_DATES,
    summary: [
      { key: 'models', label: 'Models with complaints', value: modelRows.length, format: 'number' },
      { key: 'complaints', label: 'Complaints', value: complaints, format: 'number' },
      { key: 'unitsAffected', label: 'Units affected', value: stats.units, format: 'number' },
      { key: 'repeatUnits', label: 'Units with repeat complaints', value: stats.repeat, format: 'number' },
    ],
    breakdowns: [
      {
        key: 'byCategory',
        title: 'Most common issues',
        labelHeader: 'Issue',
        valueHeader: 'Complaints',
        items: (facets?.byCategory ?? []).map((row) => ({ key: row._id, label: row._id, value: row.value })),
      },
    ],
    tables: [
      {
        key: 'byModel',
        title: 'By model',
        columns: [
          { key: 'product', header: 'Product', format: 'text', width: 26 },
          { key: 'model', header: 'Model', format: 'text', width: 16 },
          { key: 'complaints', header: 'Complaints', format: 'number', width: 12 },
          { key: 'unitsAffected', header: 'Units affected', format: 'number', width: 15 },
          { key: 'complaintsPerUnit', header: 'Complaints per unit', format: 'decimal', width: 20 },
          { key: 'inWarranty', header: 'In warranty', format: 'number', width: 13 },
          { key: 'outOfWarranty', header: 'Out of warranty', format: 'number', width: 16 },
          { key: 'reopened', header: 'Reopened', format: 'number', width: 11 },
        ],
        rows: modelRows,
        total: modelRows.length,
      },
      {
        key: 'repeatUnits',
        title: 'Units with repeat complaints',
        columns: [
          { key: 'serialNumber', header: 'Serial number', format: 'text', width: 20 },
          { key: 'product', header: 'Product', format: 'text', width: 26 },
          { key: 'model', header: 'Model', format: 'text', width: 16 },
          { key: 'complaints', header: 'Complaints', format: 'number', width: 12 },
          { key: 'latestComplaintNumber', header: 'Latest complaint', format: 'text', width: 18 },
          { key: 'latestComplaintAt', header: 'Raised on', format: 'date', width: 14 },
        ],
        rows: repeatRows,
        total: stats.repeat,
        ...(stats.repeat > repeatRows.length ? { truncated: true } : {}),
      },
    ],
  };
}

/* ---- 5. Parts reports ----------------------------------------------------- */

interface Counted {
  _id: unknown;
  used?: number;
  jobs?: number;
  requested?: number;
  unavailable?: number;
}

interface UsageFacets {
  totals: Array<{ used: number; jobs: number }>;
  byPart: Counted[];
  byCenter: Counted[];
  byTechnician: Counted[];
}

interface StockFacets {
  totals: Array<{ lowItems: number }>;
  byPart: Array<{ _id: unknown; inStock: number; lowAt: number }>;
  byCenter: Array<{ _id: unknown; lowItems: number }>;
}

interface RequestFacets {
  totals: Array<{ requested: number; unavailable: number }>;
  byPart: Counted[];
  byCenter: Counted[];
  byTechnician: Counted[];
}

/** Quantity and distinct jobs, grouped on one field — or on nothing, for the totals. */
const usageBy = (field: string | null): PipelineStage.FacetPipelineStage[] => [
  { $group: { _id: field, used: { $sum: '$quantity' }, jobs: { $addToSet: '$complaintId' } } },
  { $project: { used: 1, jobs: { $size: '$jobs' } } },
];

const requestsBy = (field: string | null): PipelineStage.FacetPipelineStage[] => [
  { $group: { _id: field, requested: { $sum: '$requested' }, unavailable: { $sum: '$unavailable' } } },
];

export async function partsReport(
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<ReportResult> {
  /* Every parts collection carries `serviceCenterId`, so the complaint scope
     applies as it is; a centre filter narrows it, never widens it. */
  const centre: Record<string, unknown>[] = [];
  const scope = complaintScope(auth);
  if (Object.keys(scope).length > 0) centre.push(scope);
  if (filter.serviceCenterId) centre.push({ serviceCenterId: oid(filter.serviceCenterId) });

  const all = (extra: Record<string, unknown>[] = []) => {
    const conditions = [...centre, ...extra];
    return conditions.length > 0 ? { $and: conditions } : {};
  };

  const range = dateRange(filter);
  const technician = filter.technicianId ? oid(filter.technicianId) : undefined;

  /* A date expression for fields read inside `$cond`. */
  const inRange = (field: string) => {
    const bounds: unknown[] = [];
    if (filter.from) bounds.push({ $gte: [field, filter.from] });
    if (filter.to) bounds.push({ $lte: [field, filter.to] });
    return bounds.length > 0 ? { $and: bounds } : true;
  };

  const [[usage], [stock], [requests]] = await Promise.all([
    PartUsage.aggregate<UsageFacets>([
      {
        $match: all([
          { finalizedAt: { $ne: null, ...(range ?? {}) } },
          ...(technician ? [{ recordedBy: technician }] : []),
        ]),
      },
      {
        $facet: {
          totals: usageBy(null),
          byPart: usageBy('$partId'),
          byCenter: usageBy('$serviceCenterId'),
          byTechnician: usageBy('$recordedBy'),
        },
      },
    ]).exec(),
    /* Stock is as it stands now: neither the dates nor a technician change it. */
    PartStock.aggregate<StockFacets>([
      { $match: all() },
      {
        $project: {
          partId: 1,
          serviceCenterId: 1,
          availableQuantity: 1,
          low: { $cond: [{ $lte: ['$availableQuantity', '$minimumStock'] }, 1, 0] },
        },
      },
      {
        $facet: {
          totals: [{ $group: { _id: null, lowItems: { $sum: '$low' } } }],
          byPart: [{ $group: { _id: '$partId', inStock: { $sum: '$availableQuantity' }, lowAt: { $sum: '$low' } } }],
          byCenter: [{ $group: { _id: '$serviceCenterId', lowItems: { $sum: '$low' } } }],
        },
      },
    ]).exec(),
    PartRequest.aggregate<RequestFacets>([
      { $match: all(technician ? [{ requestedBy: technician }] : []) },
      {
        $project: {
          partId: 1,
          serviceCenterId: 1,
          requestedBy: 1,
          /* Requested in the range; marked unavailable in the range. */
          requested: { $cond: [inRange('$createdAt'), 1, 0] },
          unavailable: {
            $cond: [{ $and: [{ $eq: ['$status', 'UNAVAILABLE'] }, inRange('$decidedAt')] }, 1, 0],
          },
        },
      },
      { $match: { $or: [{ requested: 1 }, { unavailable: 1 }] } },
      {
        $facet: {
          totals: requestsBy(null),
          byPart: requestsBy('$partId'),
          byCenter: requestsBy('$serviceCenterId'),
          byTechnician: requestsBy('$requestedBy'),
        },
      },
    ]).exec(),
  ]);

  const keyed = <T extends { _id: unknown }>(rows: T[] | undefined) =>
    new Map((rows ?? []).map((row) => [String(row._id), row]));

  /* ---- By part ---- */
  const usageByPart = keyed(usage?.byPart);
  const stockByPart = keyed(stock?.byPart);
  const requestsByPart = keyed(requests?.byPart);
  const partIds = [...new Set([...usageByPart.keys(), ...stockByPart.keys(), ...requestsByPart.keys()])];

  const parts = await Part.find({ _id: { $in: partIds.map(oid) } }).select('name code unit').lean().exec();
  const partById = new Map(parts.map((part) => [String(part._id), part]));
  const isOwner = auth.role === 'SERVICE_CENTER_OWNER';

  const partRows = partIds
    .map((id) => {
      const part = partById.get(id);
      const lowAt = stockByPart.get(id)?.lowAt ?? 0;
      return {
        part: part?.name ?? 'Unknown',
        code: part?.code ?? '',
        unit: part ? UNIT_LABELS[part.unit] : '',
        used: usageByPart.get(id)?.used ?? 0,
        jobs: usageByPart.get(id)?.jobs ?? 0,
        inStock: stockByPart.get(id)?.inStock ?? 0,
        /* An Owner has one centre, so "how many centres are low" is a yes or no. */
        ...(isOwner ? { lowStock: lowAt > 0 ? 'Yes' : '' } : { lowStockAt: lowAt }),
        requested: requestsByPart.get(id)?.requested ?? 0,
        unavailable: requestsByPart.get(id)?.unavailable ?? 0,
      };
    })
    .sort((a, b) => b.used - a.used || b.requested - a.requested || a.part.localeCompare(b.part));

  /* ---- By centre (Admin) ---- */
  const usageByCenter = keyed(usage?.byCenter);
  const stockByCenter = keyed(stock?.byCenter);
  const requestsByCenter = keyed(requests?.byCenter);
  const centreIds = [...new Set([...usageByCenter.keys(), ...stockByCenter.keys(), ...requestsByCenter.keys()])];
  const centres = isOwner
    ? []
    : await ServiceCenter.find({ _id: { $in: centreIds.map(oid) } }).select('name').lean().exec();
  const centreName = new Map(centres.map((row) => [String(row._id), row.name]));

  const centreRows = isOwner
    ? []
    : centreIds
        .map((id) => ({
          serviceCenter: centreName.get(id) ?? 'Unknown',
          used: usageByCenter.get(id)?.used ?? 0,
          jobs: usageByCenter.get(id)?.jobs ?? 0,
          lowStockItems: stockByCenter.get(id)?.lowItems ?? 0,
          requested: requestsByCenter.get(id)?.requested ?? 0,
          unavailable: requestsByCenter.get(id)?.unavailable ?? 0,
        }))
        .sort((a, b) => b.used - a.used || a.serviceCenter.localeCompare(b.serviceCenter));

  /* ---- By technician ---- */
  const usageByTech = keyed(usage?.byTechnician);
  const requestsByTech = keyed(requests?.byTechnician);
  const techIds = [...new Set([...usageByTech.keys(), ...requestsByTech.keys()])];
  const technicians = await User.find({ _id: { $in: techIds.map(oid) } }).select('name').lean().exec();
  const techName = new Map(technicians.map((user) => [String(user._id), user.name]));

  const technicianRows = techIds
    .map((id) => ({
      technician: techName.get(id) ?? 'Unknown',
      used: usageByTech.get(id)?.used ?? 0,
      jobs: usageByTech.get(id)?.jobs ?? 0,
      requested: requestsByTech.get(id)?.requested ?? 0,
      unavailable: requestsByTech.get(id)?.unavailable ?? 0,
    }))
    .sort((a, b) => b.used - a.used || b.requested - a.requested || a.technician.localeCompare(b.technician));

  const usageTotals = usage?.totals[0] ?? { used: 0, jobs: 0 };
  const requestTotals = requests?.totals[0] ?? { requested: 0, unavailable: 0 };

  return {
    title: 'Parts report',
    dateBasis: 'Counts parts used and requested in the selected dates. Stock is as it stands now.',
    summary: [
      { key: 'partsUsed', label: 'Parts used', value: usageTotals.used, format: 'number' },
      { key: 'jobsWithParts', label: 'Jobs using parts', value: usageTotals.jobs, format: 'number' },
      { key: 'lowStockItems', label: 'Low stock items', value: stock?.totals[0]?.lowItems ?? 0, format: 'number' },
      { key: 'requested', label: 'Part requests', value: requestTotals.requested, format: 'number' },
      {
        key: 'unavailableRequests',
        label: 'Marked unavailable',
        value: requestTotals.unavailable,
        format: 'number',
      },
    ],
    breakdowns: [],
    tables: [
      {
        key: 'byPart',
        title: 'By part',
        columns: [
          { key: 'part', header: 'Part', format: 'text', width: 26 },
          { key: 'code', header: 'Code', format: 'text', width: 12 },
          { key: 'unit', header: 'Unit', format: 'text', width: 10 },
          { key: 'used', header: 'Used', format: 'number', width: 9 },
          { key: 'jobs', header: 'Jobs', format: 'number', width: 9 },
          { key: 'inStock', header: 'In stock', format: 'number', width: 10 },
          isOwner
            ? { key: 'lowStock', header: 'Low on stock', format: 'text', width: 14 }
            : { key: 'lowStockAt', header: 'Centers low on stock', format: 'number', width: 21 },
          { key: 'requested', header: 'Requested', format: 'number', width: 11 },
          { key: 'unavailable', header: 'Unavailable', format: 'number', width: 13 },
        ],
        rows: partRows,
        total: partRows.length,
      },
      ...(isOwner
        ? []
        : [
            {
              key: 'byCenter',
              title: 'By service center',
              columns: [
                { key: 'serviceCenter', header: 'Service center', format: 'text' as const, width: 28 },
                { key: 'used', header: 'Parts used', format: 'number' as const, width: 12 },
                { key: 'jobs', header: 'Jobs', format: 'number' as const, width: 9 },
                { key: 'lowStockItems', header: 'Low stock items', format: 'number' as const, width: 16 },
                { key: 'requested', header: 'Requested', format: 'number' as const, width: 11 },
                { key: 'unavailable', header: 'Unavailable', format: 'number' as const, width: 13 },
              ],
              rows: centreRows,
              total: centreRows.length,
            },
          ]),
      {
        key: 'byTechnician',
        title: 'By technician',
        columns: [
          { key: 'technician', header: 'Technician', format: 'text', width: 24 },
          { key: 'used', header: 'Parts used', format: 'number', width: 12 },
          { key: 'jobs', header: 'Jobs', format: 'number', width: 9 },
          { key: 'requested', header: 'Requested', format: 'number', width: 11 },
          { key: 'unavailable', header: 'Unavailable', format: 'number', width: 13 },
        ],
        rows: technicianRows,
        total: technicianRows.length,
      },
    ],
  };
}
