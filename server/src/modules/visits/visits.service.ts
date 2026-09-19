/**
 * Visit listing and schedule management (spec sections 9, 10).
 *
 * Section 9 wants a centre-level calendar: today's visits, upcoming visits,
 * who is assigned. Section 10 wants the technician's "My Jobs" and "Schedule"
 * screens, which it describes as buckets — today, upcoming, pending, revisit,
 * completed history.
 *
 * `myJobs` returns all of those buckets in one response rather than making a
 * phone on a patchy connection issue five requests. That is the difference
 * between a field app that feels instant and one that does not.
 */
import mongoose, { type FilterQuery } from 'mongoose';
import { recordActivity, type Actor } from '../../core/audit.js';
import { complaintScope, visitScope, withScope } from '../../core/scope.js';
import { companyDateBounds, companyDayBounds } from '../../core/time.js';
import { badRequest, forbidden, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  Complaint,
  ServiceCenter,
  User,
  Visit,
  type ComplaintDoc,
  type VisitDoc,
} from '../../models/index.js';
import type { ListVisitsInput, RescheduleVisitInput } from './visits.validation.js';

function actorFor(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

/**
 * A booked visit the caller may change — reschedule or cancel.
 *
 * Two scopes, both required. `visitScope` checks the visit's own centre, but a
 * visit keeps the centre it was booked under: when Admin moves the complaint to
 * another centre, the old Owner would still pass that check and could move or
 * call off a visit, writing onto a complaint that is no longer theirs. So the
 * complaint must also be within `complaintScope`. Either failing is "not
 * found", as everywhere else, so nothing is confirmed about someone else's work.
 */
export async function findManageableVisit(id: string, auth: AuthContext) {
  const visit = await Visit.findOne(withScope<VisitDoc>(visitScope(auth), { _id: id })).exec();
  if (!visit) throw notFound('Visit not found');

  const complaintInScope = await Complaint.exists(
    withScope<ComplaintDoc>(complaintScope(auth), { _id: visit.complaintId }),
  ).exec();
  if (!complaintInScope) throw notFound('Visit not found');

  return visit;
}

/**
 * A visit with the complaint context a list needs.
 *
 * Denormalised into the response rather than left to the client to fetch: a
 * job card shows the customer, the product and the address, and five visits
 * would otherwise mean five extra round trips from a phone.
 */
export interface VisitCard {
  id: string;
  sequence: number;
  status: string;
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /* Why a completed visit may have no work on it — history should not read
     "nobody home" as a finished repair. */
  customerAvailability?: string;
  availabilityNote?: string;
  resolutionResult?: string;
  technicianId: string;
  serviceCenterId: string;
  /** On schedule listings, so a screen spanning centres needs no lookups. */
  technicianName?: string;
  serviceCenterName?: string;
  complaint: {
    id: string;
    complaintNumber: string;
    status: string;
    priority: string;
    category: string;
    customerName: string;
    customerMobile: string;
    address: string;
    cityName: string;
    pincode: string;
    productName: string;
    modelNumber: string;
    serialNumber: string;
    warrantyStatus: string;
  } | null;
}

interface PopulatedVisit extends Omit<VisitDoc, 'complaintId'> {
  complaintId: ComplaintDoc | mongoose.Types.ObjectId;
}

function toCard(visit: PopulatedVisit): VisitCard {
  const complaint =
    visit.complaintId && typeof visit.complaintId === 'object' && 'complaintNumber' in visit.complaintId
      ? (visit.complaintId as ComplaintDoc)
      : null;

  return {
    id: String(visit._id),
    sequence: visit.sequence,
    status: visit.status,
    scheduledAt: visit.scheduledAt,
    ...(visit.startedAt ? { startedAt: visit.startedAt } : {}),
    ...(visit.completedAt ? { completedAt: visit.completedAt } : {}),
    ...(visit.customerAvailability ? { customerAvailability: visit.customerAvailability } : {}),
    ...(visit.availabilityNote ? { availabilityNote: visit.availabilityNote } : {}),
    ...(visit.resolution?.result ? { resolutionResult: visit.resolution.result } : {}),
    technicianId: String(visit.technicianId),
    serviceCenterId: String(visit.serviceCenterId),
    complaint: complaint
      ? {
          id: String(complaint._id),
          complaintNumber: complaint.complaintNumber,
          status: complaint.status,
          priority: complaint.priority,
          category: complaint.category,
          customerName: complaint.customerSnapshot.name,
          customerMobile: complaint.customerSnapshot.mobile,
          address: complaint.serviceAddress.address,
          cityName: complaint.serviceAddress.cityName,
          pincode: complaint.serviceAddress.pincode,
          productName: complaint.productSnapshot.productName,
          modelNumber: complaint.productSnapshot.modelNumber,
          serialNumber: complaint.serialNumber,
          warrantyStatus: complaint.warrantyStatus,
        }
      : null,
  };
}

const COMPLAINT_FIELDS =
  'complaintNumber status priority category customerSnapshot serviceAddress ' +
  'productSnapshot serialNumber warrantyStatus';

export interface PagedVisits {
  items: VisitCard[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * The schedule, within the caller's scope.
 *
 * An Owner sees their centre's; a technician sees their own; Admin sees all.
 * Scoping is by *visit*, so a technician keeps the trips they made even after
 * a complaint is reassigned away from them.
 */
export async function listVisits(
  input: ListVisitsInput,
  auth: AuthContext,
): Promise<PagedVisits> {
  const filter: FilterQuery<VisitDoc> = {};

  if (input.status) {
    filter.status = input.status.length === 1 ? input.status[0]! : { $in: input.status };
  }
  if (input.complaintId) filter.complaintId = input.complaintId;
  if (input.technicianId) filter.technicianId = input.technicianId;
  if (input.serviceCenterId) filter.serviceCenterId = input.serviceCenterId;

  if (input.date) {
    /* A single company-timezone day, which is what a calendar view asks for. */
    const { start, end } = companyDateBounds(input.date);
    filter.scheduledAt = { $gte: start, $lt: end };
  } else if (input.from || input.to) {
    filter.scheduledAt = {
      ...(input.from ? { $gte: input.from } : {}),
      ...(input.to ? { $lte: input.to } : {}),
    };
  }

  const scoped = withScope<VisitDoc>(visitScope(auth), filter);

  const [rows, total] = await Promise.all([
    Visit.find(scoped)
      .populate<{ complaintId: ComplaintDoc }>('complaintId', COMPLAINT_FIELDS)
      .sort({ [input.orderBy]: input.sort === 'asc' ? 1 : -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<PopulatedVisit[]>()
      .exec(),
    Visit.countDocuments(scoped).exec(),
  ]);

  return {
    items: await withNames(rows.map(toCard)),
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/**
 * Adds who is going and for which centre, looked up once per page.
 *
 * Admin's schedule spans every centre. A screen resolving names from its own
 * technician list would stop at that list's page size, so the names travel
 * with the visits — two small queries, whatever the page holds.
 */
async function withNames(cards: VisitCard[]): Promise<VisitCard[]> {
  if (cards.length === 0) return cards;

  const technicianIds = [...new Set(cards.map((card) => card.technicianId))];
  const centreIds = [...new Set(cards.map((card) => card.serviceCenterId))];

  const [technicians, centres] = await Promise.all([
    User.find({ _id: { $in: technicianIds } }).select('name').lean().exec(),
    ServiceCenter.find({ _id: { $in: centreIds } }).select('name').lean().exec(),
  ]);
  const technicianName = new Map(technicians.map((user) => [String(user._id), user.name]));
  const centreName = new Map(centres.map((centre) => [String(centre._id), centre.name]));

  return cards.map((card) => ({
    ...card,
    ...(technicianName.has(card.technicianId) ? { technicianName: technicianName.get(card.technicianId)! } : {}),
    ...(centreName.has(card.serviceCenterId) ? { serviceCenterName: centreName.get(card.serviceCenterId)! } : {}),
  }));
}

/**
 * One visit, with its complaint populated.
 *
 * The return type is inferred rather than annotated `VisitDoc`: populating
 * replaces `complaintId` with the document itself, so the annotation would be
 * a lie that only a cast could hide.
 */
export async function getVisit(id: string, auth: AuthContext) {
  const visit = await Visit.findOne(withScope<VisitDoc>(visitScope(auth), { _id: id }))
    .populate<{ complaintId: ComplaintDoc }>('complaintId', COMPLAINT_FIELDS)
    .exec();

  if (!visit) throw notFound('Visit not found');
  return visit;
}

/**
 * The technician's home screen, exactly as section 10 lays it out.
 */
export interface MyJobs {
  today: VisitCard[];
  upcoming: VisitCard[];
  inProgress: VisitCard[];
  /** Complaints sent back for a revisit, awaiting a new visit being scheduled. */
  revisitRequired: VisitCard[];
  completed: VisitCard[];
  counts: {
    today: number;
    upcoming: number;
    inProgress: number;
    revisitRequired: number;
  };
}

/**
 * `now` is a parameter so the Today / Upcoming split can be tested at a fixed
 * instant.
 */
export async function myJobs(auth: AuthContext, now: Date = new Date()): Promise<MyJobs> {
  if (auth.role !== 'TECHNICIAN') {
    /* Owners and Admin have the schedule view; this screen is the technician's
       own queue and its buckets only make sense for one person. */
    throw forbidden('This view is for technicians. Use the visit schedule instead.');
  }

  /* Today ends at the company's midnight, not the server's — on a UTC host
     tomorrow morning's visits showed as today's until 05:30 IST. */
  const { end } = companyDayBounds(now);
  const technicianId = new mongoose.Types.ObjectId(auth.userId);

  const load = async (filter: FilterQuery<VisitDoc>, limit: number, ascending = true) =>
    (
      await Visit.find({ technicianId, ...filter })
        .populate<{ complaintId: ComplaintDoc }>('complaintId', COMPLAINT_FIELDS)
        .sort({ scheduledAt: ascending ? 1 : -1 })
        .limit(limit)
        .lean<PopulatedVisit[]>()
        .exec()
    ).map(toCard);

  const [today, upcoming, inProgress, completed] = await Promise.all([
    /* Today includes anything missed on an earlier day. Bounding this at the
       start of today would drop an unstarted visit out of every bucket at
       midnight — the job most in need of attention, silently gone. Ascending
       order puts the missed ones first. */
    load({ status: 'SCHEDULED', scheduledAt: { $lt: end } }, 50),
    load({ status: 'SCHEDULED', scheduledAt: { $gte: end } }, 50),
    load({ status: 'IN_PROGRESS' }, 20),
    /* History, newest first — the one bucket read backwards from now. */
    load({ status: 'COMPLETED' }, 30, false),
  ]);

  /**
   * Revisit is a *complaint* state, not a visit one: the work has been sent
   * back but the Owner has not scheduled the return trip yet. Surfaced here so
   * a technician can see it coming rather than being surprised by a job
   * appearing tomorrow.
   */
  const revisitComplaints = await Complaint.find({
    technicianId,
    status: 'REVISIT_REQUIRED',
  })
    .select(`${COMPLAINT_FIELDS} serviceCenterId`)
    .lean<ComplaintDoc[]>()
    .exec();

  const revisitRequired: VisitCard[] = revisitComplaints.map((complaint) => ({
    id: '',
    sequence: 0,
    status: 'REVISIT_REQUIRED',
    scheduledAt: complaint.updatedAt,
    technicianId: auth.userId,
    serviceCenterId: complaint.serviceCenterId ? String(complaint.serviceCenterId) : '',
    complaint: {
      id: String(complaint._id),
      complaintNumber: complaint.complaintNumber,
      status: complaint.status,
      priority: complaint.priority,
      category: complaint.category,
      customerName: complaint.customerSnapshot.name,
      customerMobile: complaint.customerSnapshot.mobile,
      address: complaint.serviceAddress.address,
      cityName: complaint.serviceAddress.cityName,
      pincode: complaint.serviceAddress.pincode,
      productName: complaint.productSnapshot.productName,
      modelNumber: complaint.productSnapshot.modelNumber,
      serialNumber: complaint.serialNumber,
      warrantyStatus: complaint.warrantyStatus,
    },
  }));

  return {
    today,
    upcoming,
    inProgress,
    revisitRequired,
    completed,
    counts: {
      today: today.length,
      upcoming: upcoming.length,
      inProgress: inProgress.length,
      revisitRequired: revisitRequired.length,
    },
  };
}

/**
 * Moves a scheduled visit (section 9).
 *
 * Only a `SCHEDULED` visit can move. One in progress or completed is a record
 * of what actually happened, and section 22 requires that to survive — a
 * later trip is a new visit, not an edit of the old one.
 */
export async function rescheduleVisit(
  id: string,
  input: RescheduleVisitInput,
  auth: AuthContext,
): Promise<VisitDoc> {
  const visit = await findManageableVisit(id, auth);

  if (visit.status !== 'SCHEDULED') {
    throw badRequest(
      `This visit is ${visit.status.toLowerCase().replace(/_/g, ' ')} and cannot be moved. ` +
      'Schedule a new visit instead.',
    );
  }

  if (input.scheduledAt.getTime() < Date.now() - 60_000) {
    throw badRequest('A visit cannot be scheduled in the past', [
      { field: 'scheduledAt', message: 'Choose a future date and time' },
    ]);
  }

  const previous = visit.scheduledAt;

  visit.rescheduleHistory.push({
    previousScheduledAt: previous,
    newScheduledAt: input.scheduledAt,
    rescheduledBy: new mongoose.Types.ObjectId(auth.userId),
    rescheduledAt: new Date(),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  visit.scheduledAt = input.scheduledAt;

  await visit.save();

  await recordActivity({
    complaintId: String(visit.complaintId),
    action: 'VISIT_RESCHEDULED',
    actor: actorFor(auth),
    visitId: String(visit._id),
    fieldChanged: 'scheduledAt',
    oldValue: previous.toISOString(),
    newValue: input.scheduledAt.toISOString(),
    note: input.reason,
  });

  return visit;
}

/* Cancelling a visit lives in workflow.service.ts (`cancelScheduledVisit`),
   because calling off the only booked visit changes the complaint's status.
   Its route checks `findManageableVisit` first. */
