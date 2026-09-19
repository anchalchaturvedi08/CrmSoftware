/**
 * One service center on one page (DECISIONS.md section 29).
 *
 * Admin's Service Centers list gives a line per centre. Opening one answers
 * what an Admin actually asks about a centre: how to reach it and where it
 * works, who works there and how busy each person is, what is open and
 * overdue, what is booked, and what stock is running low.
 *
 * Performance figures are deliberately not computed here. The page asks the
 * Service centers report for them, filtered to this centre, so they are the
 * Reports page's numbers by construction rather than a second calculation
 * that could drift from it.
 */
import mongoose, { type Types } from 'mongoose';
import { notFound } from '../../http/errors.js';
import {
  City,
  Complaint,
  Part,
  PartRequest,
  PartStock,
  ServiceCenter,
  Territory,
  User,
  Visit,
} from '../../models/index.js';
import { TERMINAL_STATUSES, type ComplaintStatus, type Priority } from '../../models/enums.js';

/** Enough to act on; each list links to the full one. */
const OPEN_COMPLAINTS_SHOWN = 10;
const VISITS_SHOWN = 8;
const LOW_STOCK_SHOWN = 10;

/** Part requests still needing the Owner: not yet issued, refused or withdrawn. */
const WAITING_REQUEST_STATUSES = ['REQUESTED', 'APPROVED'];

interface StaffMember {
  id: string;
  name: string;
  mobile: string;
  email?: string;
  isActive: boolean;
  lastLoginAt?: Date;
  mustChangePassword: boolean;
}

export async function serviceCenterOverview(id: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Service center not found');

  const centre = await ServiceCenter.findById(id).lean().exec();
  if (!centre) throw notFound('Service center not found');

  const centreId = centre._id;
  const open = { serviceCenterId: centreId, status: { $nin: TERMINAL_STATUSES } };
  const now = new Date();

  const [
    cities,
    territory,
    staff,
    statusCounts,
    overdue,
    latestOpen,
    jobsByTechnician,
    scheduledVisits,
    missedVisits,
    upcomingVisits,
    stock,
    waitingRequests,
    ratingTotals,
  ] = await Promise.all([
    City.find({ _id: { $in: [centre.cityId, ...(centre.servedCityIds ?? [])] } })
      .select('name state isActive')
      .lean()
      .exec(),
    Territory.findById(centre.territoryId).select('name code isActive').lean().exec(),
    User.find({ serviceCenterId: centreId, role: { $in: ['SERVICE_CENTER_OWNER', 'TECHNICIAN'] } })
      .select('name mobile email role isActive lastLoginAt mustChangePassword')
      .sort({ name: 1 })
      .lean()
      .exec(),
    Complaint.aggregate<{ _id: ComplaintStatus; count: number }>([
      { $match: open },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec(),
    /* The same definition as the dashboard's "SLA breached" tile. */
    Complaint.countDocuments({ ...open, 'sla.state': 'BREACHED' }).exec(),
    /* Most urgent first: the soonest resolution deadline, overdue ones leading. */
    Complaint.find(open)
      .select(
        'complaintNumber status priority technicianId customerSnapshot.name ' +
          'serviceAddress.cityName sla.resolutionDueAt sla.state createdAt',
      )
      .sort({ 'sla.resolutionDueAt': 1 })
      .limit(OPEN_COMPLAINTS_SHOWN)
      .lean()
      .exec(),
    Complaint.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { ...open, technicianId: { $ne: null } } },
      { $group: { _id: '$technicianId', count: { $sum: 1 } } },
    ]).exec(),
    Visit.countDocuments({ serviceCenterId: centreId, status: 'SCHEDULED' }).exec(),
    Visit.countDocuments({ serviceCenterId: centreId, status: 'SCHEDULED', scheduledAt: { $lt: now } }).exec(),
    /* Missed ones first, then the next ones due — both still need someone. */
    Visit.find({ serviceCenterId: centreId, status: 'SCHEDULED' })
      .select('complaintId technicianId scheduledAt sequence')
      .sort({ scheduledAt: 1 })
      .limit(VISITS_SHOWN)
      .lean()
      .exec(),
    PartStock.find({ serviceCenterId: centreId })
      .select('partId availableQuantity minimumStock')
      .lean()
      .exec(),
    PartRequest.countDocuments({
      serviceCenterId: centreId,
      status: { $in: WAITING_REQUEST_STATUSES },
    }).exec(),
    /* Every rating the centre has ever been given, for the page's heading.
       All-time rather than the Performance card's period: the heading names
       the centre, not a month (DECISIONS.md section 31). */
    Complaint.aggregate<{ sum: number; count: number }>([
      { $match: { serviceCenterId: centreId, 'serviceRating.stars': { $exists: true } } },
      { $group: { _id: null, sum: { $sum: '$serviceRating.stars' }, count: { $sum: 1 } } },
    ]).exec(),
  ]);

  const rated = ratingTotals[0]?.count ?? 0;
  const ratingAverage = rated > 0 ? Math.round(((ratingTotals[0]?.sum ?? 0) / rated) * 10) / 10 : null;

  /* ---- Names ------------------------------------------------------------ */

  const cityById = new Map(cities.map((city) => [String(city._id), city]));
  const staffById = new Map(staff.map((member) => [String(member._id), member]));

  /* A complaint's technician normally works here; anyone else (moved since)
     is looked up rather than shown as a blank. */
  const unknownTechnicians = [
    ...new Set(
      [...latestOpen.map((c) => c.technicianId), ...upcomingVisits.map((v) => v.technicianId)]
        .filter((techId): techId is Types.ObjectId => Boolean(techId))
        .map(String)
        .filter((techId) => !staffById.has(techId)),
    ),
  ];
  const [elsewhere, visitComplaints] = await Promise.all([
    unknownTechnicians.length
      ? User.find({ _id: { $in: unknownTechnicians } }).select('name').lean().exec()
      : Promise.resolve([]),
    upcomingVisits.length
      ? Complaint.find({ _id: { $in: upcomingVisits.map((v) => v.complaintId) } })
          .select('complaintNumber customerSnapshot.name serviceAddress.cityName')
          .lean()
          .exec()
      : Promise.resolve([]),
  ]);
  const technicianName = (techId: unknown): string | null => {
    if (!techId) return null;
    const key = String(techId);
    return staffById.get(key)?.name ?? elsewhere.find((u) => String(u._id) === key)?.name ?? null;
  };
  const complaintById = new Map(visitComplaints.map((c) => [String(c._id), c]));

  /* ---- Stock ------------------------------------------------------------ */

  const lowRows = stock
    .filter((row) => row.availableQuantity <= row.minimumStock)
    .sort((a, b) => a.availableQuantity - a.minimumStock - (b.availableQuantity - b.minimumStock));
  const lowParts = lowRows.length
    ? await Part.find({ _id: { $in: lowRows.slice(0, LOW_STOCK_SHOWN).map((row) => row.partId) } })
        .select('name code unit')
        .lean()
        .exec()
    : [];
  const partById = new Map(lowParts.map((part) => [String(part._id), part]));

  /* ---- Shape ------------------------------------------------------------ */

  const jobs = new Map(jobsByTechnician.map((row) => [String(row._id), row.count]));
  const member = (user: (typeof staff)[number]): StaffMember => ({
    id: String(user._id),
    name: user.name,
    mobile: user.mobile,
    ...(user.email ? { email: user.email } : {}),
    isActive: user.isActive,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
    mustChangePassword: user.mustChangePassword,
  });

  const ownCity = cityById.get(String(centre.cityId));
  const count = (status: ComplaintStatus) => statusCounts.find((row) => row._id === status)?.count ?? 0;

  return {
    center: {
      id: String(centre._id),
      name: centre.name,
      code: centre.code,
      mobile: centre.mobile,
      ...(centre.email ? { email: centre.email } : {}),
      address: centre.address,
      pincode: centre.pincode,
      cityId: String(centre.cityId),
      territoryId: String(centre.territoryId),
      servedCityIds: (centre.servedCityIds ?? []).map(String),
      servedPincodes: centre.servedPincodes ?? [],
      ...(centre.notes ? { notes: centre.notes } : {}),
      isActive: centre.isActive,
      createdAt: centre.createdAt,
      updatedAt: centre.updatedAt,
      city: ownCity ? { name: ownCity.name, state: ownCity.state } : null,
      territory: territory ? { name: territory.name, code: territory.code } : null,
      /* Its own city is covered anyway; older records list it again. */
      servedCities: (centre.servedCityIds ?? [])
        .filter((cityId) => String(cityId) !== String(centre.cityId))
        .map((cityId) => cityById.get(String(cityId)))
        .filter((city): city is NonNullable<typeof city> => Boolean(city))
        .map((city) => ({ id: String(city._id), name: city.name, state: city.state, isActive: city.isActive }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },

    staff: {
      owners: staff.filter((user) => user.role === 'SERVICE_CENTER_OWNER').map(member),
      technicians: staff
        .filter((user) => user.role === 'TECHNICIAN')
        .map((user) => ({ ...member(user), openJobs: jobs.get(String(user._id)) ?? 0 }))
        /* Active people first, the busiest at the top. */
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.openJobs - a.openJobs || a.name.localeCompare(b.name)),
    },

    complaints: {
      open: statusCounts.reduce((total, row) => total + row.count, 0),
      overdue,
      /* Sent here, but nobody at the centre has picked a technician yet. */
      waitingForTechnician: count('ASSIGNED') + count('REOPENED'),
      byStatus: statusCounts
        .map((row) => ({ status: row._id, count: row.count }))
        .sort((a, b) => b.count - a.count),
      mostUrgent: latestOpen.map((complaint) => ({
        id: String(complaint._id),
        complaintNumber: complaint.complaintNumber,
        status: complaint.status,
        priority: complaint.priority as Priority,
        customerName: complaint.customerSnapshot?.name ?? '',
        cityName: complaint.serviceAddress?.cityName ?? '',
        technicianName: technicianName(complaint.technicianId),
        resolutionDueAt: complaint.sla?.resolutionDueAt ?? null,
        slaState: complaint.sla?.state ?? null,
        breached: complaint.sla?.state === 'BREACHED',
        createdAt: complaint.createdAt,
      })),
    },

    visits: {
      scheduled: scheduledVisits,
      missed: missedVisits,
      next: upcomingVisits.map((visit) => {
        const complaint = complaintById.get(String(visit.complaintId));
        return {
          id: String(visit._id),
          complaintId: String(visit.complaintId),
          complaintNumber: complaint?.complaintNumber ?? '',
          customerName: complaint?.customerSnapshot?.name ?? '',
          cityName: complaint?.serviceAddress?.cityName ?? '',
          technicianName: technicianName(visit.technicianId),
          scheduledAt: visit.scheduledAt,
          sequence: visit.sequence,
          missed: visit.scheduledAt < now,
        };
      }),
    },

    ratings: { average: ratingAverage, rated },

    stock: {
      tracked: stock.length,
      low: lowRows.length,
      waitingRequests,
      lowItems: lowRows.slice(0, LOW_STOCK_SHOWN).map((row) => {
        const part = partById.get(String(row.partId));
        return {
          partId: String(row.partId),
          name: part?.name ?? 'Part',
          code: part?.code ?? '',
          unit: part?.unit ?? 'PIECE',
          available: row.availableQuantity,
          minimum: row.minimumStock,
        };
      }),
    },
  };
}

export type ServiceCenterOverview = Awaited<ReturnType<typeof serviceCenterOverview>>;
