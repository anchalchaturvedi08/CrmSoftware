/**
 * Complaint business rules (spec section 6, Workflow A).
 *
 * ## Creation runs in one transaction
 *
 * Minting the number, writing the complaint and appending the first timeline
 * entry either all happen or none do. Without that:
 *
 *  - a failed insert after a successful `$inc` burns a complaint number,
 *    leaving a permanent gap in a sequence auditors read as "one is missing";
 *  - a complaint could exist with no `COMPLAINT_CREATED` entry, which section
 *    17 requires and which is the only record of who raised it.
 *
 * This is the reason the database runs as a replica set at all.
 *
 * ## Snapshots
 *
 * Customer, product and address are copied onto the complaint, not merely
 * referenced. Rule 15 says an old complaint must never be overwritten, and
 * section 22 requires history to survive master-data edits. If the customer
 * later moves house, a complaint closed last year must still show where the
 * technician actually went.
 */
import mongoose, { type ClientSession, type FilterQuery } from 'mongoose';
import { recordActivity, recordAudit, type Actor } from '../../core/audit.js';
import { nextComplaintNumber } from '../../core/complaintNumber.js';
import { decryptHappyCode, issueHappyCode } from '../../core/happyCode.js';
import { complaintScope, withScope } from '../../core/scope.js';
import { escapeRegex, mobileSearchDigits } from '../../core/search.js';
import { applyBreach, ruleFor, startTracking, sweepBreaches } from '../../core/sla.js';
import { buildWhatsAppLink, type WhatsAppLink } from '../../core/whatsapp.js';
import { AppError, badRequest, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { TERMINAL_STATUSES } from '../../models/enums.js';
import {
  City,
  Complaint,
  Customer,
  Product,
  ProductModel,
  ServiceCenter,
  User,
  Visit,
  type CityDoc,
  type ComplaintDoc,
  type VisitDoc,
} from '../../models/index.js';
import { resolveCity, resolveState } from '../masters/geography.resolve.js';
import type {
  CreateComplaintInput,
  ListComplaintsInput,
} from './complaint.validation.js';

/* ---- Creation ---------------------------------------------------------- */

/**
 * Resolves the customer, creating one inline when the Admin entered a new
 * person rather than picking an existing record.
 */
async function resolveCustomer(
  input: CreateComplaintInput,
  actor: Actor,
  session: ClientSession,
) {
  if (input.customerId) {
    const existing = await Customer.findById(input.customerId)
      .session(session)
      .exec();

    if (!existing) throw notFound('That customer no longer exists');
    return existing;
  }

  const details = input.newCustomer!;

  /**
   * A mobile number already on file belongs to that customer — section 13's
   * repeat-complaint history is keyed on it, so a second record is never made.
   *
   * It is refused rather than quietly reused. Reusing put the stored name and
   * address on the complaint while the Admin had typed different ones, and the
   * technician went to the old address. The create screen now checks the
   * number as it is typed and offers to switch to the existing customer, so
   * this only fires when that check was skipped or raced — and then the Admin
   * is told whose number it is, rather than being given data they never saw.
   */
  const existing = await Customer.findOne({ mobile: details.mobile })
    .session(session)
    .exec();

  if (existing) {
    const whose = existing.isActive ? existing.name : `${existing.name} (deactivated customer)`;
    throw new AppError(
      409,
      'CONFLICT',
      `This mobile number belongs to ${whose}. Choose them as an existing customer ` +
        'instead of adding a new one — you can still use a different service address.',
      { issues: [{ field: 'newCustomer.mobile', message: `This mobile belongs to ${whose}` }] },
    );
  }

  /* Same canonical value in both places, so the new customer's own `state`
     and the city it points at can never disagree (DECISIONS.md section 32). */
  const state = resolveState(details.state, 'newCustomer.state');
  const city = await resolveCity(
    { cityId: details.cityId, cityName: details.cityName, state },
    { cityIdField: 'newCustomer.cityId', cityNameField: 'newCustomer.cityName', stateField: 'newCustomer.state' },
    session,
  );

  const [created] = await Customer.create(
    [
      {
        name: details.name,
        mobile: details.mobile,
        ...(details.alternateMobile ? { alternateMobile: details.alternateMobile } : {}),
        ...(details.email ? { email: details.email } : {}),
        address: details.address,
        cityId: city._id,
        state,
        pincode: details.pincode,
        ...(details.notes ? { notes: details.notes } : {}),
        createdBy: actor.userId,
      },
    ],
    { session },
  );

  return created!;
}

export interface CreateComplaintResult {
  complaint: ComplaintDoc;
  /**
   * The plaintext Happy Code, returned **once** at creation so the caller can
   * decide whether to surface the WhatsApp action immediately. It is not
   * stored in plaintext and cannot be read back except through the audited
   * `/whatsapp` route.
   */
  happyCode: string;
}

export async function createComplaint(
  input: CreateComplaintInput,
  auth: AuthContext,
): Promise<CreateComplaintResult> {
  const actor: Actor = { userId: auth.userId, role: auth.role, name: auth.name };

  const session = await mongoose.startSession();

  try {
    let result: CreateComplaintResult | undefined;

    await session.withTransaction(async () => {
      /* --- Validate the catalog selections ------------------------------ */
      const product = await Product.findById(input.productId).session(session).exec();
      if (!product) throw notFound('That product no longer exists');

      const productModel = await ProductModel.findById(input.productModelId)
        .session(session)
        .exec();
      if (!productModel) throw notFound('That model no longer exists');

      /* A model from a different product line would produce a complaint whose
         own snapshot contradicts itself. */
      if (String(productModel.productId) !== String(product._id)) {
        throw badRequest('That model does not belong to the selected product', [
          { field: 'productModelId', message: 'Model does not match the product' },
        ]);
      }

      const customer = await resolveCustomer(input, actor, session);

      /* --- Service address: explicit, or the customer's own ------------- */
      let city: CityDoc;
      let addressSource: { address: string; state: string; pincode: string };

      if (input.serviceAddress) {
        const state = resolveState(input.serviceAddress.state, 'serviceAddress.state');
        city = await resolveCity(
          {
            cityId: input.serviceAddress.cityId,
            cityName: input.serviceAddress.cityName,
            state,
          },
          {
            cityIdField: 'serviceAddress.cityId',
            cityNameField: 'serviceAddress.cityName',
            stateField: 'serviceAddress.state',
          },
          session,
        );
        addressSource = { address: input.serviceAddress.address, state, pincode: input.serviceAddress.pincode };
      } else {
        const found = await City.findById(customer.cityId).session(session).exec();
        if (!found) throw notFound('That city no longer exists');
        city = found;
        addressSource = { address: customer.address, state: customer.state, pincode: customer.pincode };
      }

      /* --- Optional service center (absent => status NEW) --------------- */
      let serviceCenterName: string | undefined;
      if (input.serviceCenterId) {
        const center = await ServiceCenter.findById(input.serviceCenterId)
          .session(session)
          .exec();

        if (!center) throw notFound('That service center no longer exists');

        /* Section 8: a deactivated centre keeps its history but takes no new
           work. The model's `refActive` guard enforces this too; checking here
           produces a message that names the centre. */
        if (!center.isActive) {
          throw badRequest(`${center.name} is deactivated and cannot take new complaints`, [
            { field: 'serviceCenterId', message: 'This service center is inactive' },
          ]);
        }

        serviceCenterName = center.name;
      }

      /* --- Number, code, SLA -------------------------------------------- */
      const now = new Date();
      const complaintNumber = await nextComplaintNumber(session, now);
      const happy = issueHappyCode();
      const slaRule = await ruleFor(input.priority);

      /* The model's own warranty when it has one, else the product's
         (DECISIONS.md section 32). Computed once so the snapshot below can
         use a nullish check — 0 (no factory warranty) is a real value, not
         "unset". */
      const warrantyMonthsSnapshot =
        productModel.defaultWarrantyMonths ?? product.defaultWarrantyMonths;

      const [complaint] = await Complaint.create(
        [
          {
            complaintNumber,
            customerId: customer._id,
            productId: product._id,
            productModelId: productModel._id,
            serialNumber: input.serialNumber,
            ...(input.purchaseDate ? { purchaseDate: input.purchaseDate } : {}),

            category: input.category,
            description: input.description,
            priority: input.priority,
            warrantyStatus: input.warrantyStatus,
            ...(input.warrantyNotes ? { warrantyNotes: input.warrantyNotes } : {}),

            /* Snapshots — see the note at the top of this file. */
            serviceAddress: {
              address: addressSource.address,
              cityId: city._id,
              cityName: city.name,
              state: addressSource.state,
              pincode: addressSource.pincode,
            },
            customerSnapshot: {
              name: customer.name,
              mobile: customer.mobile,
              ...(customer.alternateMobile
                ? { alternateMobile: customer.alternateMobile }
                : {}),
            },
            productSnapshot: {
              productName: product.name,
              modelNumber: productModel.modelNumber,
              /* The model's own warranty when it has one, else the product's
                 (DECISIONS.md section 32). A nullish check (not truthy) so an
                 explicit 0 — no factory warranty, e.g. a spare part — is kept
                 rather than treated as "not set" and dropped. */
              ...(warrantyMonthsSnapshot !== undefined
                ? { warrantyMonths: warrantyMonthsSnapshot }
                : {}),
            },

            ...(input.serviceCenterId ? { serviceCenterId: input.serviceCenterId } : {}),
            status: input.serviceCenterId ? 'ASSIGNED' : 'NEW',

            happyCodeSecret: happy.secret,
            happyCode: happy.meta,
            sla: startTracking(slaRule, now),

            createdBy: actor.userId,
          },
        ],
        { session },
      );

      const created = complaint!;

      await recordActivity(
        {
          complaintId: String(created._id),
          action: 'COMPLAINT_CREATED',
          actor,
          note: `Complaint ${complaintNumber} raised for ${customer.name}`,
        },
        session,
      );

      /* A centre chosen at creation is still a selection, and section 17
         wants it on the timeline as its own event. */
      if (input.serviceCenterId) {
        await recordActivity(
          {
            complaintId: String(created._id),
            action: 'SERVICE_CENTER_SELECTED',
            actor,
            fieldChanged: 'serviceCenterId',
            newValue: serviceCenterName ?? String(input.serviceCenterId),
            note: 'Selected by Admin at creation',
          },
          session,
        );
      }

      result = { complaint: created, happyCode: happy.code };
    });

    /* withTransaction only resolves after a successful commit. */
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ---- Reading ----------------------------------------------------------- */

/** The parts of a visit a list row needs. */
export interface VisitSummary {
  id: string;
  sequence: number;
  status: VisitDoc['status'];
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  customerAvailability?: VisitDoc['customerAvailability'];
  availabilityNote?: string;
}

/**
 * A complaint as a list shows it.
 *
 * Section 9's complaint list asks for the technician and the visit date, which
 * live on other records. They are joined here, once per page, rather than
 * leaving a table to make a request per row.
 */
export type ComplaintListItem = ComplaintDoc & {
  technicianName?: string;
  /** The visit booked or under way, if any. */
  currentVisit?: VisitSummary;
  /** The most recent visit of any kind — says why a job stalled. */
  lastVisit?: VisitSummary;
};

export interface PagedComplaints {
  items: ComplaintListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function summariseVisit(visit: VisitDoc): VisitSummary {
  return {
    id: String(visit._id),
    sequence: visit.sequence,
    status: visit.status,
    scheduledAt: visit.scheduledAt,
    ...(visit.startedAt ? { startedAt: visit.startedAt } : {}),
    ...(visit.completedAt ? { completedAt: visit.completedAt } : {}),
    ...(visit.customerAvailability ? { customerAvailability: visit.customerAvailability } : {}),
    ...(visit.availabilityNote ? { availabilityNote: visit.availabilityNote } : {}),
  };
}

/** Adds technician names and visit summaries to a page of complaints. */
async function withAssignmentDetails(items: ComplaintDoc[]): Promise<ComplaintListItem[]> {
  if (items.length === 0) return [];

  const technicianIds = [
    ...new Set(items.flatMap((item) => (item.technicianId ? [String(item.technicianId)] : []))),
  ];

  const [technicians, visits] = await Promise.all([
    technicianIds.length > 0
      ? User.find({ _id: { $in: technicianIds } }).select('name').lean().exec()
      : Promise.resolve([]),
    Visit.find({ complaintId: { $in: items.map((item) => item._id) } })
      .select(
        'complaintId sequence status scheduledAt startedAt completedAt customerAvailability availabilityNote',
      )
      .sort({ sequence: -1 })
      .lean<VisitDoc[]>()
      .exec(),
  ]);

  const nameById = new Map(technicians.map((user) => [String(user._id), user.name]));

  /* Newest first, so the first match per complaint is its latest visit. */
  const visitsByComplaint = new Map<string, VisitDoc[]>();
  for (const visit of visits) {
    const key = String(visit.complaintId);
    const list = visitsByComplaint.get(key) ?? [];
    list.push(visit);
    visitsByComplaint.set(key, list);
  }

  return items.map((item) => {
    const own = visitsByComplaint.get(String(item._id)) ?? [];
    const current = own.find((visit) => visit.status === 'SCHEDULED' || visit.status === 'IN_PROGRESS');
    const last = own[0];
    const technicianName = item.technicianId ? nameById.get(String(item.technicianId)) : undefined;

    return Object.assign(item, {
      ...(technicianName ? { technicianName } : {}),
      ...(current ? { currentVisit: summariseVisit(current) } : {}),
      ...(last ? { lastVisit: summariseVisit(last) } : {}),
    });
  });
}

/* ---- What the counts and the lists mean ---------------------------------
 *
 * A dashboard tile opens the list of what it counted, so the tile and the list
 * must share one definition. These are those definitions; the dashboard
 * (`reports/dashboard.service.ts`) and technician workload
 * (`users/users.service.ts`) count with the same ones.
 */

/** "Open": still being worked — not closed and not cancelled. */
export const OPEN_COMPLAINT: FilterQuery<ComplaintDoc> = {
  status: { $nin: [...TERMINAL_STATUSES] },
};

/**
 * "SLA breached": open and past the resolution deadline right now.
 *
 * Closed-late work is not here; it shows in the SLA performance breakdown. The
 * open condition matters for cancelled complaints, which keep whatever SLA
 * state they had when they were called off.
 */
export const SLA_BREACHED: FilterQuery<ComplaintDoc> = {
  'sla.state': 'BREACHED',
  status: { $nin: [...TERMINAL_STATUSES] },
};

/** Raised between two instants, both inclusive; null when neither is given. */
export function raisedBetween(from?: Date, to?: Date): FilterQuery<ComplaintDoc> | null {
  if (!from && !to) return null;
  return {
    createdAt: {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    },
  };
}

/**
 * The search box (section 13): the start of a complaint number or serial
 * number, or a customer mobile.
 *
 * A mobile is shown grouped ("98765 43210") and so typed grouped, or with +91,
 * while it is stored as ten bare digits — so it is reduced to its digits
 * first. It stays a *prefix* match like the other two: matching digits
 * anywhere in the number would pull unrelated customers into a search for a
 * numeric serial number. Everything is escaped, so a pasted value cannot
 * become an expensive or hostile pattern.
 */
function searchFilter(term: string): FilterQuery<ComplaintDoc> {
  const prefix = new RegExp(`^${escapeRegex(term)}`, 'i');
  const branches: FilterQuery<ComplaintDoc>[] = [
    { complaintNumber: prefix },
    { serialNumber: prefix },
  ];

  const digits = mobileSearchDigits(term);
  if (digits) {
    branches.push({ 'customerSnapshot.mobile': new RegExp(`^${escapeRegex(digits)}`) });
  }

  return { $or: branches };
}

/**
 * The list's filters as one query, before scope.
 *
 * Built as a list of conditions joined with `$and`, so two filters on the same
 * field — `status=CLOSED` with `open=true` — both apply instead of the second
 * silently replacing the first.
 */
export function complaintListFilter(query: ListComplaintsInput): FilterQuery<ComplaintDoc> {
  const conditions: FilterQuery<ComplaintDoc>[] = [];

  if (query.status) {
    conditions.push({
      status: query.status.length === 1 ? query.status[0] : { $in: query.status },
    });
  }
  if (query.open) conditions.push(OPEN_COMPLAINT);
  if (query.slaBreached) conditions.push(SLA_BREACHED);
  if (query.priority) conditions.push({ priority: query.priority });
  if (query.warrantyStatus) conditions.push({ warrantyStatus: query.warrantyStatus });
  if (query.serviceCenterId) conditions.push({ serviceCenterId: query.serviceCenterId });
  if (query.technicianId) conditions.push({ technicianId: query.technicianId });
  if (query.cityId) conditions.push({ 'serviceAddress.cityId': query.cityId });
  if (query.productModelId) conditions.push({ productModelId: query.productModelId });

  const raised = raisedBetween(query.from, query.to);
  if (raised) conditions.push(raised);

  if (query.search) conditions.push(searchFilter(query.search));

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0]!;
  return { $and: conditions };
}

/**
 * Lists complaints within the caller's scope.
 *
 * The scope is applied through `withScope`, which combines with `$and` so a
 * caller-supplied `serviceCenterId` filter narrows the result rather than
 * replacing the restriction (see `core/scope.ts`).
 */
export async function listComplaints(
  query: ListComplaintsInput,
  auth: AuthContext,
): Promise<PagedComplaints> {
  /* Breaches are recorded before they are filtered on, as the dashboard does
     before counting them (core/sla.ts) — otherwise a job that ran late since
     anyone last looked would be counted on the tile and missing from its list. */
  if (query.slaBreached) await sweepBreaches();

  const scoped = withScope<ComplaintDoc>(complaintScope(auth), complaintListFilter(query));

  const sort: Record<string, 1 | -1> = query.sort.startsWith('-')
    ? { [query.sort.slice(1)]: -1 }
    : { [query.sort]: 1 };

  const [rows, total] = await Promise.all([
    Complaint.find(scoped)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<ComplaintDoc[]>()
      .exec(),
    Complaint.countDocuments(scoped).exec(),
  ]);

  return {
    items: await withAssignmentDetails(rows),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

/**
 * Fetches one complaint within the caller's scope.
 *
 * Out-of-scope reads return 404, not 403. Saying "forbidden" would confirm
 * that a complaint with that id exists, letting one service center probe for
 * another's workload.
 */
export async function getComplaint(
  id: string,
  auth: AuthContext,
): Promise<ComplaintDoc> {
  const scoped = withScope<ComplaintDoc>(complaintScope(auth), { _id: id });

  const complaint = await Complaint.findOne(scoped).exec();
  if (!complaint) throw notFound('Complaint not found');

  /* Breach state is derived on read, so SLA figures are correct whether or not
     a background sweep has run recently. */
  const withBreach = applyBreach(complaint.sla);
  if (withBreach !== complaint.sla) {
    complaint.sla = withBreach;
    await complaint.save();
  }

  return complaint;
}

/* ---- WhatsApp helper (sections 6.4, 15) -------------------------------- */

export interface WhatsAppLinkResult {
  link: WhatsAppLink;
  /** Present only when the link is available. */
  happyCode?: string;
}

/**
 * Builds the WhatsApp deep link for a complaint, decrypting the Happy Code.
 *
 * This is the **only** route that reads a Happy Code back, which is why it is
 * Admin-only and audited on every call. The code is the gate on closure, so
 * each viewing is an event worth having a record of — who looked, and when.
 *
 * Nothing here claims the message was sent. Section 6.4: "Never claim that the
 * message was delivered/read." Pressing send is a human action we cannot
 * observe.
 */
export async function getWhatsAppLink(
  id: string,
  auth: AuthContext,
): Promise<WhatsAppLinkResult> {
  const actor: Actor = { userId: auth.userId, role: auth.role, name: auth.name };

  const scoped = withScope<ComplaintDoc>(complaintScope(auth), { _id: id });

  /* `happyCodeSecret` is select:false, so it must be asked for explicitly. */
  const complaint = await Complaint.findOne(scoped)
    .select('+happyCodeSecret')
    .exec();

  if (!complaint) throw notFound('Complaint not found');

  if (!complaint.happyCodeSecret) {
    throw badRequest(
      'This complaint has no Happy Code stored. It needs to be regenerated.',
    );
  }

  const centre = complaint.serviceCenterId
    ? await ServiceCenter.findById(complaint.serviceCenterId).lean().exec()
    : null;

  const happyCode = decryptHappyCode(complaint.happyCodeSecret);

  const link = buildWhatsAppLink({
    customerName: complaint.customerSnapshot.name,
    customerMobile: complaint.customerSnapshot.mobile,
    complaintNumber: complaint.complaintNumber,
    productName: complaint.productSnapshot.productName,
    modelNumber: complaint.productSnapshot.modelNumber,
    happyCode,
    serviceCenterName: centre?.name,
  });

  /**
   * Record the view whether or not the link could be built — an Admin who
   * looked at the code still looked at it.
   *
   * Written with `updateOne` rather than `save()` on purpose. `save()`
   * re-validates the whole document, so a complaint carrying legacy data that
   * no longer passes validation — an imported customer snapshot with no
   * mobile number, say — would fail on a field this operation never touched.
   * Stamping an audit field must not be able to fail because of something
   * unrelated. It also avoids two concurrent views overwriting each other's
   * view of the rest of the document.
   */
  await Complaint.updateOne(
    { _id: complaint._id },
    {
      $set: {
        'happyCode.lastViewedAt': new Date(),
        'happyCode.lastViewedBy': new mongoose.Types.ObjectId(auth.userId),
      },
    },
  ).exec();

  await recordActivity({
    complaintId: String(complaint._id),
    action: 'HAPPY_CODE_VIEWED',
    actor,
    note: link.available
      ? 'Viewed to send the WhatsApp message'
      : `Viewed, but WhatsApp is unavailable: ${link.reason}`,
  });

  await recordAudit({
    entityType: 'Complaint',
    entityId: String(complaint._id),
    action: 'HAPPY_CODE_VIEWED',
    actor,
    note: `Happy Code read for ${complaint.complaintNumber}`,
  });

  return {
    link,
    ...(link.available ? { happyCode } : {}),
  };
}
