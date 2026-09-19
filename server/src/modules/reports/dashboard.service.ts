/**
 * Dashboards (spec sections 5.1 and 9).
 *
 * Section 5.1 lists ten KPI cards and nine breakdowns for Admin. Section 9
 * lists eleven panels for the service centre. Both are served from one place,
 * because they are the same counts with a different scope applied — an Owner's
 * "open complaints" is their centre's, an Admin's is everyone's.
 *
 * The whole thing is **one aggregation** using `$facet`, not eleven queries.
 * A dashboard that fires a dozen round trips on every page load is how a
 * landing screen ends up feeling slow, and every panel here counts the same
 * collection.
 */
import mongoose, { type PipelineStage } from 'mongoose';
import { complaintScope, withScope } from '../../core/scope.js';
import { companyDayBounds } from '../../core/time.js';
import { forbidden } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { Complaint, PartRequest, PartStock, User, Visit } from '../../models/index.js';
import type { PartRequestStatus } from '../../models/enums.js';
import {
  OPEN_COMPLAINT,
  SLA_BREACHED,
  raisedBetween,
} from '../complaints/complaint.service.js';
import type { DashboardQueryInput } from './reports.validation.js';

const oid = (value: string) => new mongoose.Types.ObjectId(value);

/**
 * Part requests still waiting on the centre: not yet answered, or approved but
 * not yet handed over.
 *
 * An approved request is still a technician waiting for a part. Counting only
 * `REQUESTED` dropped it from "Requests waiting" the moment it was approved,
 * which is exactly when it is easiest to forget. The Parts page's Waiting tab
 * uses the same two statuses.
 */
export const WAITING_PART_REQUEST_STATUSES: readonly PartRequestStatus[] = ['REQUESTED', 'APPROVED'];

/** Counts a status within the facet, as a one-liner. */
const countWhere = (condition: Record<string, unknown>): PipelineStage.FacetPipelineStage[] => [
  { $match: condition },
  { $count: 'count' },
];

const firstCount = (facet: Array<{ count: number }> | undefined): number =>
  facet?.[0]?.count ?? 0;

/** The ten KPI cards from section 5.1. */
export interface Kpis {
  totalOpen: number;
  newComplaints: number;
  inProgress: number;
  waitingForParts: number;
  revisitRequired: number;
  resolutionSubmitted: number;
  adminConfirmationPending: number;
  closed: number;
  slaBreached: number;
  critical: number;
}

/**
 * The centre-rating figures (DECISIONS.md section 31), over whatever the
 * dashboard is already scoped and dated to.
 */
export interface Ratings {
  /** One decimal place; null when nothing in scope has been rated yet. */
  average: number | null;
  rated: number;
  /** Closed, in scope, and still waiting for Admin to rate it. */
  closedUnrated: number;
}

/** The nine breakdowns from section 5.1. */
export interface Breakdowns {
  byStatus: Array<{ label: string; count: number }>;
  byPriority: Array<{ label: string; count: number }>;
  byCity: Array<{ label: string; count: number }>;
  byServiceCenter: Array<{ label: string; count: number }>;
  byModel: Array<{ label: string; count: number }>;
  byWarranty: Array<{ label: string; count: number }>;
  repeatComplaints: { repeat: number; first: number };
  slaPerformance: { met: number; breached: number; paused: number };
  technicianWorkload: Array<{ label: string; count: number }>;
}

export interface DashboardResult {
  kpis: Kpis;
  breakdowns: Breakdowns;
  ratings: Ratings;
  /** Section 9's centre panels. Present for Owner and Admin. */
  operations?: {
    /** Days are company-timezone days (`APP_TIMEZONE`), whatever the server's own clock. */
    todaysVisits: number;
    upcomingVisits: number;
    /** Booked for an earlier day and never started — each needs a call. */
    missedVisits: number;
    pendingReview: number;
    /** Requested or approved, not yet issued — see `WAITING_PART_REQUEST_STATUSES`. */
    pendingPartRequests: number;
    lowStockParts: number;
    activeTechnicians: number;
  };
  generatedAt: Date;
}

const asLabels = (
  rows: Array<{ _id: unknown; count: number }> | undefined,
): Array<{ label: string; count: number }> =>
  (rows ?? []).map((row) => ({
    label: row._id === null || row._id === undefined ? 'Unassigned' : String(row._id),
    count: row.count,
  }));

/**
 * Builds the dashboard for whoever is asking.
 *
 * A technician has no dashboard: section 10 gives them "My Jobs", which is a
 * work queue rather than a management view, and it is served by
 * `visits.myJobs`.
 *
 * Every tile is counted with the complaint list's own definitions
 * (`OPEN_COMPLAINT`, `SLA_BREACHED`, `raisedBetween` in complaint.service.ts),
 * so a tile's link — `?open=true`, `?slaBreached=true`, `?priority=CRITICAL&open=true`,
 * with the same dates — lists exactly the complaints it counted.
 *
 * `now` is a parameter so the day boundaries can be tested at a fixed instant.
 */
export async function dashboard(
  query: DashboardQueryInput,
  auth: AuthContext,
  now: Date = new Date(),
): Promise<DashboardResult> {
  if (auth.role === 'TECHNICIAN') {
    throw forbidden('Technicians see their work queue at /visits/my-jobs');
  }

  /**
   * `serviceCenterId` only ever narrows: it is folded into the same filter as
   * the date range, so it goes through `withScope` exactly like every other
   * one, and an Owner naming another centre still sees only their own
   * (`core/scope.ts`).
   */
  const filter: Record<string, unknown> = { ...(raisedBetween(query.from, query.to) ?? {}) };
  if (query.serviceCenterId) filter['serviceCenterId'] = oid(query.serviceCenterId);

  const match: PipelineStage.Match = {
    $match: withScope(complaintScope(auth), filter),
  };

  const [facets] = await Complaint.aggregate([
    match,
    {
      $facet: {
        /* --- KPI cards (section 5.1) --------------------------------- */
        totalOpen: countWhere(OPEN_COMPLAINT),
        newComplaints: countWhere({ status: 'NEW' }),
        inProgress: countWhere({ status: 'IN_PROGRESS' }),
        waitingForParts: countWhere({ status: 'WAITING_FOR_PARTS' }),
        revisitRequired: countWhere({ status: 'REVISIT_REQUIRED' }),
        resolutionSubmitted: countWhere({ status: 'RESOLUTION_SUBMITTED' }),
        adminConfirmation: countWhere({ status: 'ADMIN_CONFIRMATION' }),
        closed: countWhere({ status: 'CLOSED' }),
        /* Open and running late right now; closed-late jobs show in the
           SLA performance breakdown instead. */
        slaBreached: countWhere(SLA_BREACHED),
        critical: countWhere({ $and: [{ priority: 'CRITICAL' }, OPEN_COMPLAINT] }),

        /* --- Breakdowns (section 5.1) -------------------------------- */
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
        byWarranty: [{ $group: { _id: '$warrantyStatus', count: { $sum: 1 } } }],
        byCity: [
          { $group: { _id: '$serviceAddress.cityName', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 15 },
        ],
        byModel: [
          { $group: { _id: '$productSnapshot.modelNumber', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 15 },
        ],
        byCenter: [
          { $group: { _id: '$serviceCenterId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 15 },
          {
            $lookup: {
              from: 'servicecenters',
              localField: '_id',
              foreignField: '_id',
              as: 'centre',
            },
          },
          { $unwind: { path: '$centre', preserveNullAndEmptyArrays: true } },
          { $project: { _id: '$centre.name', count: 1 } },
        ],
        byTechnician: [
          { $match: { $and: [OPEN_COMPLAINT, { technicianId: { $ne: null } }] } },
          { $group: { _id: '$technicianId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
          {
            $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'tech' },
          },
          { $unwind: { path: '$tech', preserveNullAndEmptyArrays: true } },
          { $project: { _id: '$tech.name', count: 1 } },
        ],
        repeats: [
          {
            $group: {
              _id: null,
              repeat: { $sum: { $cond: [{ $gt: ['$reopenCount', 0] }, 1, 0] } },
              first: { $sum: { $cond: [{ $eq: ['$reopenCount', 0] }, 1, 0] } },
            },
          },
        ],
        sla: [
          {
            $group: {
              _id: null,
              /* Ever breached, including closed late (core/sla.ts `complete`). */
              breached: { $sum: { $cond: [{ $gt: ['$sla.breachedAt', null] }, 1, 0] } },
              paused: { $sum: { $cond: [{ $eq: ['$sla.state', 'PAUSED'] }, 1, 0] } },
              total: { $sum: 1 },
            },
          },
        ],

        /**
         * Centre ratings (DECISIONS.md section 31).
         *
         * Scoped like every other figure here, by the complaint's own
         * `serviceCenterId`, and that is also the centre that earned the
         * rating: a rating only ever sits on a closed complaint, closed
         * complaints cannot be moved, and reopening files the rating away
         * into the closure history (`reopenComplaint`). So no centre can be
         * shown another centre's stars.
         */
        ratedSum: [
          { $match: { 'serviceRating.stars': { $exists: true } } },
          { $group: { _id: null, sum: { $sum: '$serviceRating.stars' }, count: { $sum: 1 } } },
        ],
        closedUnrated: countWhere({
          status: 'CLOSED',
          'serviceRating.stars': { $exists: false },
        }),
      },
    },
  ]).exec();

  const sla = facets?.sla?.[0] ?? { breached: 0, paused: 0, total: 0 };
  const repeats = facets?.repeats?.[0] ?? { repeat: 0, first: 0 };
  const ratedSum = facets?.ratedSum?.[0] ?? { sum: 0, count: 0 };

  const result: DashboardResult = {
    kpis: {
      totalOpen: firstCount(facets?.totalOpen),
      newComplaints: firstCount(facets?.newComplaints),
      inProgress: firstCount(facets?.inProgress),
      waitingForParts: firstCount(facets?.waitingForParts),
      revisitRequired: firstCount(facets?.revisitRequired),
      resolutionSubmitted: firstCount(facets?.resolutionSubmitted),
      adminConfirmationPending: firstCount(facets?.adminConfirmation),
      closed: firstCount(facets?.closed),
      slaBreached: firstCount(facets?.slaBreached),
      critical: firstCount(facets?.critical),
    },
    breakdowns: {
      byStatus: asLabels(facets?.byStatus),
      byPriority: asLabels(facets?.byPriority),
      byCity: asLabels(facets?.byCity),
      byServiceCenter: asLabels(facets?.byCenter),
      byModel: asLabels(facets?.byModel),
      byWarranty: asLabels(facets?.byWarranty),
      repeatComplaints: { repeat: repeats.repeat, first: repeats.first },
      slaPerformance: {
        met: Math.max(0, sla.total - sla.breached - sla.paused),
        breached: sla.breached,
        paused: sla.paused,
      },
      technicianWorkload: asLabels(facets?.byTechnician),
    },
    ratings: {
      average: ratedSum.count > 0 ? Math.round((ratedSum.sum / ratedSum.count) * 10) / 10 : null,
      rated: ratedSum.count,
      closedUnrated: firstCount(facets?.closedUnrated),
    },
    generatedAt: new Date(),
  };

  /* --- Section 9's operational panels --------------------------------- */
  /* An Owner is always their own centre, whatever they pass; Admin has no
     centre of their own, so `query.serviceCenterId` is the only way this
     panel narrows for them — the same "narrows only" filter already applied
     to the KPIs and ratings above via `filter`. */
  const centreId =
    auth.role === 'SERVICE_CENTER_OWNER' ? auth.serviceCenterId : query.serviceCenterId;
  const centreMatch = centreId ? { serviceCenterId: oid(centreId) } : {};
  /* The company's day, not the server's: on a UTC host a server-local
     midnight rolled "today" over at 05:30 IST (core/time.ts). */
  const { start, end } = companyDayBounds(now);

  const [todaysVisits, upcomingVisits, missedVisits, pendingRequests, stockRows, technicians] =
    await Promise.all([
      Visit.countDocuments({
        ...centreMatch,
        status: 'SCHEDULED',
        scheduledAt: { $gte: start, $lt: end },
      }).exec(),
      Visit.countDocuments({
        ...centreMatch,
        status: 'SCHEDULED',
        scheduledAt: { $gte: end },
      }).exec(),
      /* Counted separately rather than folded into today's: "3 visits today"
         should not quietly include last Tuesday's no-show. */
      Visit.countDocuments({
        ...centreMatch,
        status: 'SCHEDULED',
        scheduledAt: { $lt: start },
      }).exec(),
      PartRequest.countDocuments({
        ...centreMatch,
        status: { $in: [...WAITING_PART_REQUEST_STATUSES] },
      }).exec(),
      /* Low stock compares two fields, so it needs `$expr` rather than a
         plain count — and it stays derived rather than a stored flag. */
      PartStock.countDocuments({
        ...centreMatch,
        $expr: { $lte: ['$availableQuantity', '$minimumStock'] },
      }).exec(),
      User.countDocuments({
        role: 'TECHNICIAN',
        isActive: true,
        ...(centreId ? { serviceCenterId: oid(centreId) } : {}),
      }).exec(),
    ]);

  result.operations = {
    todaysVisits,
    upcomingVisits,
    missedVisits,
    /* Section 9: "Resolution submissions pending review". */
    pendingReview: result.kpis.resolutionSubmitted,
    pendingPartRequests: pendingRequests,
    lowStockParts: stockRows,
    activeTechnicians: technicians,
  };

  return result;
}
