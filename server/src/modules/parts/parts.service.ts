/**
 * Parts, stock, requests and usage (spec section 11).
 *
 * ## The rule that shapes everything here
 *
 * Section 11: *"Stock is decremented only when usage is finalized according to
 * backend transaction rules."* So a `PartUsage` row starts life as the
 * technician's claim about what they fitted, and only finalising it moves
 * inventory — inside a transaction, alongside the timeline entry.
 *
 * One consequence worth stating plainly: between *issuing* a part and
 * *finalising* its usage, the parts are physically out of the store but still
 * counted in stock. That is what the spec asks for, and it is defensible —
 * a technician issued three and fitting one should not consume three. If the
 * company would rather stock reflect what has physically left the building,
 * that is a change to when the decrement fires, not to this structure.
 *
 * ## Why the decrement is a conditional update
 *
 * ```ts
 * findOneAndUpdate(
 *   { _id, availableQuantity: { $gte: quantity } },
 *   { $inc: { availableQuantity: -quantity } },
 * )
 * ```
 *
 * Reading the quantity, checking it in JavaScript and then writing would let
 * two concurrent finalisations both pass the check and drive stock negative.
 * Folding the check into the filter makes MongoDB do it atomically: a second
 * caller matches nothing and is told the stock is insufficient.
 */
import mongoose, { type ClientSession, type FilterQuery } from 'mongoose';
import { recordActivity, recordAudit, type Actor } from '../../core/audit.js';
import {
  complaintScope,
  partRequestScope,
  partStockScope,
  partUsageScope,
  withScope,
} from '../../core/scope.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  TERMINAL_STATUSES,
  type ActivityAction,
  type PartRequestStatus,
} from '../../models/enums.js';
import {
  Complaint,
  Part,
  PartRequest,
  PartStock,
  PartUsage,
  ServiceCenter,
  User,
  Visit,
  type ComplaintDoc,
  type PartDoc,
  type PartRequestDoc,
  type PartStockDoc,
  type PartUsageDoc,
} from '../../models/index.js';
import type {
  AdjustStockInput,
  CreatePartInput,
  CreatePartRequestInput,
  DecidePartRequestInput,
  ListPartRequestsInput,
  ListPartsInput,
  ListStockInput,
  PartRequestDecision,
  RecordUsageInput,
  SetStockInput,
  UpdatePartInput,
} from './parts.validation.js';

function actorFor(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

/**
 * Resolves which service center an operation applies to.
 *
 * An Owner is always their own; Admin must say which, because a global user
 * has no implicit centre and silently picking one would be a guess.
 */
function resolveCentre(auth: AuthContext, requested?: string): string {
  if (auth.role === 'ADMIN') {
    if (!requested) {
      throw badRequest('Specify which service center this applies to', [
        { field: 'serviceCenterId', message: 'Required for Admin' },
      ]);
    }
    return requested;
  }

  if (!auth.serviceCenterId) {
    throw forbidden('This account is not attached to a service center');
  }

  /* An Owner naming someone else's centre is refused rather than silently
     redirected to their own, so a mistake is visible. */
  if (requested && requested !== auth.serviceCenterId) {
    throw forbidden('You can only manage stock for your own service center');
  }

  return auth.serviceCenterId;
}

/* ---- Part master ------------------------------------------------------- */

export async function createPart(
  input: CreatePartInput,
  auth: AuthContext,
): Promise<PartDoc> {
  const existing = await Part.findOne({ code: input.code }).lean().exec();
  if (existing) {
    throw conflict(`A part with code ${input.code} already exists`);
  }

  const part = await Part.create({
    name: input.name,
    code: input.code,
    ...(input.category ? { category: input.category } : {}),
    unit: input.unit,
  });

  /* Section 17, as for every other master record. Without it the audit log
     showed a part's edits and retirement but never who added it. */
  await recordAudit({
    entityType: 'Part',
    entityId: String(part._id),
    action: 'PART_CREATED',
    actor: actorFor(auth),
    note: `${part.name} (${part.code})`,
  });

  return part;
}

export async function updatePart(
  id: string,
  input: UpdatePartInput,
  auth: AuthContext,
): Promise<PartDoc> {
  const part = await Part.findById(id).exec();
  if (!part) throw notFound('Part not found');

  const changes: Array<{ field: string; oldValue?: string; newValue?: string }> = [];

  for (const key of ['name', 'category', 'unit', 'isActive'] as const) {
    const value = input[key];
    if (value === undefined) continue;

    const before = part[key];

    /* An explicit clear (only `category` is optional, so only it can arrive
       as one). Unset rather than stored as "", so the part reads the same as
       one that never had a category. */
    if (value === null || value === '') {
      if (before === undefined || before === '') continue;
      changes.push({ field: key, oldValue: String(before) });
      part.set(key, undefined);
      continue;
    }

    if (String(before) === String(value)) continue;

    changes.push({ field: key, oldValue: String(before), newValue: String(value) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (part as any)[key] = value;
  }

  if (changes.length === 0) return part;

  await part.save();

  /* Section 17: master-data edits belong in the audit log even though they
     are not part of any one complaint's story. */
  await recordAudit({
    entityType: 'Part',
    entityId: String(part._id),
    action: input.isActive === false ? 'PART_DEACTIVATED' : 'PART_UPDATED',
    actor: actorFor(auth),
    changes,
  });

  return part;
}

export interface PagedParts {
  items: PartDoc[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export async function listParts(input: ListPartsInput): Promise<PagedParts> {
  const filter: FilterQuery<PartDoc> = {};

  /* Retired parts are hidden by default: they must not appear in a
     technician's picker, but reports still need to reach them. */
  if (!input.includeInactive) filter.isActive = true;
  if (input.category) filter.category = input.category;

  if (input.search) {
    const escaped = input.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ name: pattern }, { code: pattern }];
  }

  const [items, total] = await Promise.all([
    Part.find(filter)
      .sort({ name: 1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<PartDoc[]>()
      .exec(),
    Part.countDocuments(filter).exec(),
  ]);

  return {
    items,
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/* ---- Stock ------------------------------------------------------------- */

export interface StockRow {
  id: string;
  partId: string;
  partName: string;
  partCode: string;
  unit: string;
  serviceCenterId: string;
  availableQuantity: number;
  minimumStock: number;
  isLowStock: boolean;
  lastRestockedAt?: Date;
}

/**
 * Sets an absolute count, as after a physical stocktake.
 *
 * Never touches `lastRestockedAt` ("Last delivery" on screen). A count says
 * what is on the shelf, not that anything arrived: stamping it made a count
 * corrected downwards, or a changed reorder level, show today as the last
 * delivery. Deliveries are positive `adjustStock` calls.
 */
export async function setStock(
  input: SetStockInput,
  auth: AuthContext,
): Promise<PartStockDoc> {
  const centreId = resolveCentre(auth, input.serviceCenterId);

  const part = await Part.findById(input.partId).lean().exec();
  if (!part) throw notFound('Part not found');
  if (!part.isActive) {
    throw badRequest(`${part.name} is retired and cannot be stocked`);
  }

  const stock = await PartStock.findOneAndUpdate(
    { serviceCenterId: centreId, partId: input.partId },
    {
      $set: {
        availableQuantity: input.availableQuantity,
        minimumStock: input.minimumStock,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  /* By name: the note is read by a person, and an id tells them nothing. */
  const centre = await ServiceCenter.findById(centreId).select('name').lean().exec();

  await recordAudit({
    entityType: 'PartStock',
    entityId: String(stock._id),
    action: 'STOCK_SET',
    actor: actorFor(auth),
    changes: [
      { field: 'availableQuantity', newValue: String(input.availableQuantity) },
      { field: 'minimumStock', newValue: String(input.minimumStock) },
    ],
    note: `${part.name} at ${centre?.name ?? 'the service center'}`,
  });

  return stock;
}

/**
 * Applies a signed change to stock.
 *
 * Preferred over `setStock` for deliveries and corrections: `$inc` is atomic,
 * so two people recording separate deliveries at the same moment both land,
 * whereas two absolute writes would silently discard one.
 */
export async function adjustStock(
  input: AdjustStockInput,
  auth: AuthContext,
): Promise<PartStockDoc> {
  const centreId = resolveCentre(auth, input.serviceCenterId);

  const part = await Part.findById(input.partId).lean().exec();
  if (!part) throw notFound('Part not found');

  if (input.delta === 0) {
    throw badRequest('An adjustment of zero changes nothing');
  }

  /* A negative adjustment must not drive the count below zero, so the guard
     rides in the filter rather than a prior read. */
  const filter: FilterQuery<PartStockDoc> = {
    serviceCenterId: centreId,
    partId: input.partId,
    ...(input.delta < 0 ? { availableQuantity: { $gte: -input.delta } } : {}),
  };

  const stock = await PartStock.findOneAndUpdate(
    filter,
    {
      $inc: { availableQuantity: input.delta },
      /* A positive adjustment is a delivery (the centre's Receive button), and
         the only thing that moves the last-delivery date. */
      ...(input.delta > 0 ? { $set: { lastRestockedAt: new Date() } } : {}),
    },
    { new: true, upsert: input.delta > 0, setDefaultsOnInsert: true },
  ).exec();

  if (!stock) {
    const current = await PartStock.findOne({
      serviceCenterId: centreId,
      partId: input.partId,
    })
      .lean()
      .exec();

    throw conflict(
      `Not enough ${part.name} in stock. Available: ${current?.availableQuantity ?? 0}, ` +
      `requested reduction: ${-input.delta}`,
    );
  }

  await recordAudit({
    entityType: 'PartStock',
    entityId: String(stock._id),
    action: 'STOCK_ADJUSTED',
    actor: actorFor(auth),
    changes: [{ field: 'availableQuantity', newValue: String(stock.availableQuantity) }],
    note: `${input.delta > 0 ? '+' : ''}${input.delta} ${part.name}: ${input.reason}`,
  });

  return stock;
}

export interface PagedStock {
  items: StockRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Lists stock within the caller's scope.
 *
 * Low stock is evaluated with `$expr` comparing two fields rather than from a
 * stored flag, which would drift whenever a quantity changed without it.
 */
export async function listStock(
  input: ListStockInput,
  auth: AuthContext,
): Promise<PagedStock> {
  const scope = partStockScope(auth);
  if (scope === null) {
    /* Technicians request parts; they do not read inventory (section 11). */
    throw forbidden('You do not have access to stock levels');
  }

  const filter: FilterQuery<PartStockDoc> = {};
  if (input.serviceCenterId) filter.serviceCenterId = input.serviceCenterId;
  if (input.lowOnly) {
    filter.$expr = { $lte: ['$availableQuantity', '$minimumStock'] };
  }

  const scoped = withScope<PartStockDoc>(scope, filter);

  const [rows, total] = await Promise.all([
    PartStock.find(scoped)
      .populate<{ partId: PartDoc }>('partId')
      .sort({ availableQuantity: 1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .exec(),
    PartStock.countDocuments(scoped).exec(),
  ]);

  const items: StockRow[] = rows
    .filter((row) => {
      if (!input.search) return true;
      const part = row.partId;
      const term = input.search.toLowerCase();
      return (
        part.name.toLowerCase().includes(term) || part.code.toLowerCase().includes(term)
      );
    })
    .map((row) => ({
      id: String(row._id),
      partId: String(row.partId._id),
      partName: row.partId.name,
      partCode: row.partId.code,
      unit: row.partId.unit,
      serviceCenterId: String(row.serviceCenterId),
      availableQuantity: row.availableQuantity,
      minimumStock: row.minimumStock,
      isLowStock: row.availableQuantity <= row.minimumStock,
      ...(row.lastRestockedAt ? { lastRestockedAt: row.lastRestockedAt } : {}),
    }));

  return {
    items,
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/* ---- Requests ---------------------------------------------------------- */

/**
 * Requests still waiting on the centre: not yet issued, refused or withdrawn.
 *
 * `APPROVED` is one of them. Approving promises the part; issuing hands it
 * over. The centre's queue used to list only `REQUESTED`, so approving a
 * request took it out of sight with the part never issued. The dashboard's
 * "Requests waiting" means the same set.
 */
export const WAITING_REQUEST_STATUSES: readonly PartRequestStatus[] = ['REQUESTED', 'APPROVED'];

/**
 * Refuses new parts work on a closed or cancelled complaint.
 *
 * A request or a usage line on a finished job has no work to belong to, and a
 * usage line is what the centre later deducts from stock: taking one after
 * closure let stock go down against a job that was over. More work on it means
 * Admin reopening it first.
 */
function assertOpenForParts(complaint: Pick<ComplaintDoc, 'status'>, refused: string): void {
  if (complaint.status === 'CLOSED' || complaint.status === 'CANCELLED') {
    throw conflict(
      `This complaint is ${complaint.status === 'CLOSED' ? 'closed' : 'cancelled'}, so ${refused}. ` +
      'If it needs more work, Admin has to reopen it first.',
    );
  }
}

/** A technician asks their centre for a part (section 11). */
export async function createPartRequest(
  complaintId: string,
  input: CreatePartRequestInput,
  auth: AuthContext,
): Promise<PartRequestDoc> {
  const session = await mongoose.startSession();

  try {
    let created: PartRequestDoc | undefined;

    await session.withTransaction(async () => {
      /* Scoped: a technician can only raise a request against their own job. */
      const complaint = await Complaint.findOne({
        _id: complaintId,
        technicianId: auth.userId,
      })
        .session(session)
        .exec();

      if (!complaint) throw notFound('Complaint not found');
      assertOpenForParts(complaint, 'parts can no longer be requested for it');
      if (!complaint.serviceCenterId) {
        throw badRequest('This complaint has no service center yet');
      }

      const part = await Part.findById(input.partId).session(session).exec();
      if (!part) throw notFound('Part not found');
      if (!part.isActive) throw badRequest(`${part.name} is retired`);

      const visit = await Visit.findOne({
        complaintId: complaint._id,
        status: 'IN_PROGRESS',
      })
        .sort({ sequence: -1 })
        .session(session)
        .exec();

      const [request] = await PartRequest.create(
        [
          {
            complaintId: complaint._id,
            ...(visit ? { visitId: visit._id } : {}),
            serviceCenterId: complaint.serviceCenterId,
            partId: part._id,
            requestedBy: auth.userId,
            quantityRequested: input.quantityRequested,
            ...(input.reason ? { reason: input.reason } : {}),
            status: 'REQUESTED',
          },
        ],
        { session },
      );

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'PARTS_REQUESTED',
          actor: actorFor(auth),
          ...(visit ? { visitId: String(visit._id) } : {}),
          note: `${input.quantityRequested} x ${part.name}${input.reason ? ` - ${input.reason}` : ''}`,
        },
        session,
      );

      created = request!;
    });

    return created!;
  } finally {
    await session.endSession();
  }
}

/**
 * How each decision reads on the complaint timeline (section 17).
 *
 * Approvals, rejections and cancellations used to be recorded as another
 * "Parts requested", by the Owner. Keyed by every decision status, so a new
 * one does not compile until it says how it is recorded.
 */
const DECISION_ACTIVITY: Record<PartRequestDecision, { action: ActivityAction; verb: string }> = {
  APPROVED: { action: 'PARTS_REQUEST_APPROVED', verb: 'approved' },
  ISSUED: { action: 'PARTS_ISSUED', verb: 'issued' },
  UNAVAILABLE: { action: 'PARTS_MARKED_UNAVAILABLE', verb: 'marked unavailable' },
  REJECTED: { action: 'PARTS_REQUEST_REJECTED', verb: 'rejected' },
  CANCELLED: { action: 'PARTS_REQUEST_CANCELLED', verb: 'withdrawn' },
};

/**
 * Decisions that commit a part to the job, refused once it is closed or
 * cancelled: nothing should be promised or handed over for work that is
 * finished. Rejecting, cancelling or marking unavailable stay open, so a
 * request left waiting when the job ended can still be cleared from the queue.
 */
const COMMITS_A_PART: readonly PartRequestDecision[] = ['APPROVED', 'ISSUED'];

/**
 * The Owner's decision on a request.
 *
 * Issuing does **not** move stock — section 11 defers that to usage
 * finalisation. See the note at the top of this file.
 */
export async function decidePartRequest(
  requestId: string,
  input: DecidePartRequestInput,
  auth: AuthContext,
): Promise<PartRequestDoc> {
  const session = await mongoose.startSession();

  try {
    let updated: PartRequestDoc | undefined;

    await session.withTransaction(async () => {
      const request = await PartRequest.findOne(
        withScope<PartRequestDoc>(partRequestScope(auth), { _id: requestId }),
      )
        .session(session)
        .exec();

      if (!request) throw notFound('Part request not found');

      /**
       * The complaint must be the caller's now, not only the request.
       *
       * A request keeps the centre it was raised at. After Admin moved the
       * complaint to another centre, the old Owner could still decide it and
       * write to a timeline that is no longer theirs. Checked before anything
       * else, so the answer says nothing about the request's state either.
       */
      const complaint = await Complaint.findOne(
        withScope<ComplaintDoc>(complaintScope(auth), { _id: request.complaintId }),
      )
        .select('status')
        .session(session)
        .lean()
        .exec();

      if (!complaint) throw notFound('Part request not found');

      /* A decided request is settled. Reopening it would let an Owner rewrite
         a decision the technician has already acted on. */
      if (!WAITING_REQUEST_STATUSES.includes(request.status)) {
        throw conflict(`This request has already been marked ${request.status}`);
      }

      if (TERMINAL_STATUSES.includes(complaint.status) && COMMITS_A_PART.includes(input.status)) {
        throw conflict(
          `This complaint is ${complaint.status === 'CLOSED' ? 'closed' : 'cancelled'}, so no part can be ` +
          'approved or issued for it. You can still reject the request, cancel it or mark it unavailable.',
        );
      }

      const part = await Part.findById(request.partId).session(session).exec();
      const previous = request.status;

      request.status = input.status;
      request.decidedBy = new mongoose.Types.ObjectId(auth.userId);
      request.decidedAt = new Date();
      if (input.remarks) request.decisionRemarks = input.remarks;
      if (input.status === 'ISSUED') request.quantityIssued = input.quantityIssued ?? 0;

      await request.save({ session });

      const { action, verb } = DECISION_ACTIVITY[input.status];
      const quantity =
        input.status === 'ISSUED' ? request.quantityIssued : request.quantityRequested;

      await recordActivity(
        {
          complaintId: String(request.complaintId),
          action,
          actor: actorFor(auth),
          fieldChanged: 'partRequest.status',
          oldValue: previous,
          newValue: input.status,
          /* Read by a person: "Fan Motor x2 approved — fits the old model". */
          note:
            `${part?.name ?? 'Part'} x${quantity} ${verb}` +
            (quantity !== request.quantityRequested
              ? ` (${request.quantityRequested} requested)`
              : '') +
            (input.remarks ? ` — ${input.remarks}` : ''),
        },
        session,
      );

      updated = request;
    });

    return updated!;
  } finally {
    await session.endSession();
  }
}

/**
 * A request as the Owner's queue shows it.
 *
 * A request is only actionable once you know what part, for which job, asked
 * by whom — so those are joined in here, once per page, rather than left to
 * three lookups per row in the browser.
 */
export type PartRequestRow = PartRequestDoc & {
  part?: { name: string; code: string; unit: string };
  complaint?: {
    id: string;
    complaintNumber: string;
    customerName: string;
    status: ComplaintDoc['status'];
  };
  requestedByName?: string;
};

export interface PagedPartRequests {
  items: PartRequestRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

async function withRequestDetails(rows: PartRequestDoc[]): Promise<PartRequestRow[]> {
  if (rows.length === 0) return [];

  const unique = (values: unknown[]) => [...new Set(values.filter(Boolean).map(String))];

  const [parts, complaints, people] = await Promise.all([
    Part.find({ _id: { $in: unique(rows.map((row) => row.partId)) } })
      .select('name code unit')
      .lean<PartDoc[]>()
      .exec(),
    Complaint.find({ _id: { $in: unique(rows.map((row) => row.complaintId)) } })
      .select('complaintNumber customerSnapshot status')
      .lean<ComplaintDoc[]>()
      .exec(),
    User.find({ _id: { $in: unique(rows.map((row) => row.requestedBy)) } })
      .select('name')
      .lean()
      .exec(),
  ]);

  const partById = new Map(parts.map((part) => [String(part._id), part]));
  const complaintById = new Map(complaints.map((item) => [String(item._id), item]));
  const nameById = new Map(people.map((person) => [String(person._id), person.name]));

  return rows.map((row) => {
    const part = partById.get(String(row.partId));
    const complaint = complaintById.get(String(row.complaintId));
    const requestedByName = nameById.get(String(row.requestedBy));

    return Object.assign(row, {
      ...(part ? { part: { name: part.name, code: part.code, unit: part.unit } } : {}),
      ...(complaint
        ? {
            complaint: {
              id: String(complaint._id),
              complaintNumber: complaint.complaintNumber,
              customerName: complaint.customerSnapshot.name,
              status: complaint.status,
            },
          }
        : {}),
      ...(requestedByName ? { requestedByName } : {}),
    });
  });
}

export async function listPartRequests(
  input: ListPartRequestsInput,
  auth: AuthContext,
): Promise<PagedPartRequests> {
  const filter: FilterQuery<PartRequestDoc> = {};
  if (input.status) filter.status = { $in: input.status };
  if (input.complaintId) filter.complaintId = input.complaintId;
  if (input.partId) filter.partId = input.partId;

  const scoped = withScope<PartRequestDoc>(partRequestScope(auth), filter);

  const [rows, total] = await Promise.all([
    PartRequest.find(scoped)
      .sort({ createdAt: -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<PartRequestDoc[]>()
      .exec(),
    PartRequest.countDocuments(scoped).exec(),
  ]);

  return {
    items: await withRequestDetails(rows),
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/* ---- Usage ------------------------------------------------------------- */

/** Records what the technician says they fitted. Stock is untouched. */
export async function recordUsage(
  complaintId: string,
  input: RecordUsageInput,
  auth: AuthContext,
): Promise<PartUsageDoc> {
  const session = await mongoose.startSession();

  try {
    let created: PartUsageDoc | undefined;

    await session.withTransaction(async () => {
      const complaint = await Complaint.findOne({
        _id: complaintId,
        technicianId: auth.userId,
      })
        .session(session)
        .exec();

      if (!complaint) throw notFound('Complaint not found');
      assertOpenForParts(complaint, 'parts used can no longer be recorded on it');
      if (!complaint.serviceCenterId) {
        throw badRequest('This complaint has no service center yet');
      }

      const part = await Part.findById(input.partId).session(session).exec();
      if (!part) throw notFound('Part not found');

      const visit = await Visit.findOne({
        complaintId: complaint._id,
        status: { $in: ['IN_PROGRESS', 'COMPLETED'] },
      })
        .sort({ sequence: -1 })
        .session(session)
        .exec();

      if (!visit) {
        throw badRequest('Start a visit before recording parts used');
      }

      const [usage] = await PartUsage.create(
        [
          {
            complaintId: complaint._id,
            visitId: visit._id,
            serviceCenterId: complaint.serviceCenterId,
            partId: part._id,
            recordedBy: auth.userId,
            quantity: input.quantity,
            ...(input.remarks ? { remarks: input.remarks } : {}),
          },
        ],
        { session },
      );

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'PARTS_USED',
          actor: actorFor(auth),
          visitId: String(visit._id),
          note: `${input.quantity} x ${part.name} recorded (awaiting finalisation)`,
        },
        session,
      );

      created = usage!;
    });

    return created!;
  } finally {
    await session.endSession();
  }
}

export interface FinalizedUsage {
  usage: PartUsageDoc;
  remainingStock: number;
  isLowStock: boolean;
}

/**
 * Finalises usage and decrements stock, in one transaction.
 *
 * This is the operation section 11 means by "backend transaction rules", and
 * the reason the database runs as a replica set. If the decrement succeeded
 * but the usage record failed to update, the stock would be wrong with nothing
 * explaining why — and nobody would notice until a physical count months later.
 */
export async function finalizeUsage(
  usageId: string,
  auth: AuthContext,
): Promise<FinalizedUsage> {
  const session = await mongoose.startSession();

  try {
    let result: FinalizedUsage | undefined;

    await session.withTransaction(async () => {
      const usage = await PartUsage.findOne(
        withScope<PartUsageDoc>(partUsageScope(auth), { _id: usageId }),
      )
        .session(session)
        .exec();

      if (!usage) throw notFound('Part usage record not found');

      if (usage.finalizedAt) {
        /* Finalising twice would decrement twice. */
        throw conflict('This usage has already been finalised');
      }

      /**
       * After closure, only usage recorded before it closed.
       *
       * Admin can close a job while a part line is still unconfirmed. That part
       * was really fitted, so refusing would leave stock too high for good —
       * confirming it is bookkeeping, not new work. A line recorded after the
       * job ended is no part of the job (`recordUsage` now refuses to take
       * one) and must not reach stock.
       */
      const complaint = await Complaint.findById(usage.complaintId)
        .select('status closedAt cancelledAt')
        .session(session)
        .lean()
        .exec();

      if (!complaint) throw notFound('Complaint not found');

      if (TERMINAL_STATUSES.includes(complaint.status)) {
        const ended = complaint.status === 'CLOSED' ? 'closed' : 'cancelled';
        const endedAt = complaint.status === 'CLOSED' ? complaint.closedAt : complaint.cancelledAt;

        if (!endedAt || usage.createdAt.getTime() > endedAt.getTime()) {
          throw conflict(
            `This part was recorded after the complaint was ${ended}, so it cannot be deducted from stock`,
          );
        }
      }

      const part = await Part.findById(usage.partId).session(session).exec();

      /**
       * The conditional decrement. `availableQuantity: { $gte: quantity }` in
       * the filter means MongoDB checks and writes as one operation — two
       * concurrent finalisations cannot both pass and drive stock negative.
       */
      const stock = await PartStock.findOneAndUpdate(
        {
          serviceCenterId: usage.serviceCenterId,
          partId: usage.partId,
          availableQuantity: { $gte: usage.quantity },
        },
        { $inc: { availableQuantity: -usage.quantity } },
        { new: true, session },
      ).exec();

      if (!stock) {
        const current = await PartStock.findOne({
          serviceCenterId: usage.serviceCenterId,
          partId: usage.partId,
        })
          .session(session)
          .lean()
          .exec();

        throw conflict(
          `Not enough ${part?.name ?? 'stock'} at this service center. ` +
          `Available: ${current?.availableQuantity ?? 0}, needed: ${usage.quantity}`,
        );
      }

      usage.finalizedAt = new Date();
      usage.finalizedBy = new mongoose.Types.ObjectId(auth.userId);
      await usage.save({ session });

      await recordActivity(
        {
          complaintId: String(usage.complaintId),
          action: 'PARTS_USED',
          actor: actorFor(auth),
          visitId: String(usage.visitId),
          note:
            `${usage.quantity} x ${part?.name ?? 'part'} consumed. ` +
            `${stock.availableQuantity} left in stock.`,
        },
        session,
      );

      result = {
        usage,
        remainingStock: stock.availableQuantity,
        isLowStock: stock.availableQuantity <= stock.minimumStock,
      };
    });

    return result!;
  } finally {
    await session.endSession();
  }
}

export async function listUsage(
  complaintId: string,
  auth: AuthContext,
): Promise<PartUsageDoc[]> {
  return PartUsage.find(
    withScope<PartUsageDoc>(partUsageScope(auth), { complaintId }),
  )
    .sort({ createdAt: -1 })
    .lean<PartUsageDoc[]>()
    .exec();
}

/** Session-aware variant used by other modules inside their own transaction. */
export async function stockFor(
  serviceCenterId: string,
  partId: string,
  session?: ClientSession,
): Promise<PartStockDoc | null> {
  const query = PartStock.findOne({ serviceCenterId, partId });
  if (session) query.session(session);
  return query.lean<PartStockDoc>().exec();
}
