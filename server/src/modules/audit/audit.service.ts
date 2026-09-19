/**
 * Reading the audit trail (spec section 17).
 *
 * Entries have been written since the first module landed; this is what reads
 * them back. Section 17 requires the complaint detail page to present its
 * activity "as a clear chronological timeline", and section 3.1 has Admin
 * "view audit logs and timelines" — an audit trail nobody can read is not an
 * audit trail.
 *
 * Two different things live here, matching the two collections:
 *
 *  - **Complaint activity** — one complaint's story, oldest first, visible to
 *    anyone who can see the complaint; and, for Admin, the same entries across
 *    every complaint, newest first.
 *  - **System audit log** — master-data edits, sign-ins, stock, SLA settings,
 *    Happy Code views. Admin only: it spans every service center, so scoping
 *    it per centre would be meaningless and showing it to an Owner would leak
 *    other centres' activity.
 */
import type { FilterQuery } from 'mongoose';
import { complaintScope, withScope } from '../../core/scope.js';
import { notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  AuditLog,
  City,
  Complaint,
  ComplaintActivity,
  Customer,
  Part,
  PartStock,
  Product,
  ProductModel,
  ServiceCenter,
  SlaRule,
  Territory,
  User,
  type AuditLogDoc,
  type ComplaintActivityDoc,
  type ComplaintDoc,
} from '../../models/index.js';
import { PRIORITY_LABELS } from '../reports/report.labels.js';
import type {
  AuditCategory,
  ListActivityInput,
  ListAuditInput,
  ListTimelineInput,
} from './audit.validation.js';

export interface TimelineEntry {
  id: string;
  action: string;
  actorName: string;
  actorRole: string;
  at: Date;
  visitId?: string;
  fieldChanged?: string;
  oldValue?: string;
  newValue?: string;
  note?: string;
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type TimelineResult = Page<TimelineEntry>;

const pageOf = <T>(items: T[], total: number, input: { page: number; limit: number }): Page<T> => ({
  items,
  total,
  page: input.page,
  limit: input.limit,
  totalPages: Math.max(1, Math.ceil(total / input.limit)),
});

function toTimelineEntry(row: ComplaintActivityDoc): TimelineEntry {
  return {
    id: String(row._id),
    action: row.action,
    actorName: row.actorName,
    actorRole: row.actorRole,
    at: row.createdAt,
    ...(row.visitId ? { visitId: String(row.visitId) } : {}),
    ...(row.fieldChanged ? { fieldChanged: row.fieldChanged } : {}),
    ...(row.oldValue ? { oldValue: row.oldValue } : {}),
    ...(row.newValue ? { newValue: row.newValue } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

const dateRange = (input: { from?: Date | undefined; to?: Date | undefined }) =>
  input.from || input.to
    ? {
        ...(input.from ? { $gte: input.from } : {}),
        ...(input.to ? { $lte: input.to } : {}),
      }
    : undefined;

/* ---- One complaint's timeline --------------------------------------------- */

/**
 * One complaint's timeline, oldest first.
 *
 * The complaint is loaded within the caller's scope first, so someone who
 * cannot see the complaint gets "not found" rather than an empty timeline that
 * would confirm it exists.
 */
export async function complaintTimeline(
  complaintId: string,
  input: ListTimelineInput,
  auth: AuthContext,
): Promise<TimelineResult> {
  const complaint = await Complaint.findOne(
    withScope<ComplaintDoc>(complaintScope(auth), { _id: complaintId }),
  )
    .select('_id')
    .lean()
    .exec();

  if (!complaint) throw notFound('Complaint not found');

  const filter: FilterQuery<ComplaintActivityDoc> = { complaintId };
  if (input.action) filter.action = input.action;

  const [rows, total] = await Promise.all([
    ComplaintActivity.find(filter)
      /* Oldest first: a timeline is read as a story, not a feed. */
      .sort({ createdAt: 1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<ComplaintActivityDoc[]>()
      .exec(),
    ComplaintActivity.countDocuments(filter).exec(),
  ]);

  return pageOf(rows.map(toTimelineEntry), total, input);
}

/* ---- Activity across every complaint (Admin) ------------------------------ */

export interface ActivityEntry extends TimelineEntry {
  complaint: { id: string; complaintNumber: string } | null;
}

/**
 * Every complaint's activity, newest first — "what has been happening".
 *
 * The route is Admin only. The same entries are each complaint's timeline;
 * this reads them the other way round, across complaints.
 */
export async function listActivity(input: ListActivityInput): Promise<Page<ActivityEntry>> {
  const filter: FilterQuery<ComplaintActivityDoc> = {};

  if (input.complaintNumber) {
    const complaint = await Complaint.findOne({ complaintNumber: input.complaintNumber })
      .select('_id')
      .lean()
      .exec();
    /* An unknown number finds nothing. Dropping the filter instead would
       answer a typo with every entry in the system. */
    if (!complaint) return pageOf([], 0, input);
    filter.complaintId = complaint._id;
  }

  if (input.action) {
    filter.action = input.action.length === 1 ? input.action[0]! : { $in: input.action };
  }
  if (input.actorId) filter.actorId = input.actorId;

  const created = dateRange(input);
  if (created) filter.createdAt = created;

  const [rows, total] = await Promise.all([
    ComplaintActivity.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<ComplaintActivityDoc[]>()
      .exec(),
    ComplaintActivity.countDocuments(filter).exec(),
  ]);

  const complaints = await Complaint.find({ _id: { $in: [...new Set(rows.map((row) => String(row.complaintId)))] } })
    .select('complaintNumber')
    .lean()
    .exec();
  const numberById = new Map(complaints.map((complaint) => [String(complaint._id), complaint.complaintNumber]));

  return pageOf(
    rows.map((row) => {
      const complaintNumber = numberById.get(String(row.complaintId));
      return {
        ...toTimelineEntry(row),
        complaint: complaintNumber ? { id: String(row.complaintId), complaintNumber } : null,
      };
    }),
    total,
    input,
  );
}

/* ---- System audit log (Admin) --------------------------------------------- */

export interface AuditEntry {
  id: string;
  at: Date;
  action: string;
  entityType: string;
  entityId?: string;
  /** The record's name, looked up now: "Jaipur Central Service", not an id. */
  entityName?: string;
  actorId?: string;
  actorName?: string;
  actorRole?: string;
  changes: Array<{ field: string; oldValue?: string; newValue?: string }>;
  note?: string;
  ipAddress?: string;
  userAgent?: string;
}

const SIGN_IN_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED_NO_ACCOUNT',
  'LOGIN_FAILED_BAD_PASSWORD',
  'LOGIN_FAILED_ACCOUNT_LOCKED',
  'LOGIN_BLOCKED_INACTIVE',
  'LOGIN_BLOCKED_LOCKED',
  'PASSWORD_CHANGED',
  'PASSWORD_CHANGE_FAILED',
];

const CATEGORY_FILTERS: Record<AuditCategory, FilterQuery<AuditLogDoc>> = {
  'sign-in': { action: { $in: SIGN_IN_ACTIONS } },
  /* Accounts created, edited, deactivated or given a new password by someone else. */
  people: { entityType: 'User', action: { $in: ['USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'PASSWORD_RESET'] } },
  records: { entityType: { $in: ['Territory', 'City', 'ServiceCenter', 'Product', 'ProductModel', 'Customer'] } },
  parts: { entityType: { $in: ['Part', 'PartStock'] } },
  'happy-code': { action: { $regex: /^HAPPY_CODE_/ } },
  settings: { entityType: 'SlaRule' },
};

/**
 * The system-wide audit log. Admin only.
 *
 * Newest first, unlike the complaint timeline: this is read to answer "what
 * just happened" or "who changed that", which is a search backwards from now.
 */
export async function listAudit(input: ListAuditInput, _auth: AuthContext): Promise<Page<AuditEntry>> {
  const conditions: Array<FilterQuery<AuditLogDoc>> = [];

  if (input.category) conditions.push(CATEGORY_FILTERS[input.category]);
  if (input.entityType) conditions.push({ entityType: input.entityType });
  if (input.entityId) conditions.push({ entityId: input.entityId });

  /* A signed-in screen renews its session every few minutes. Those entries
     stay in the log, but only appear when asked for by name — otherwise they
     bury everything a person is looking for. */
  conditions.push({ action: input.action ?? { $ne: 'TOKEN_REFRESHED' } });

  if (input.actorId) {
    /* Done by this person, or to their account — a failed sign-in has no
       actor yet, but it is still about them. */
    conditions.push({
      $or: [{ actorId: input.actorId }, { entityType: 'User', entityId: input.actorId }],
    });
  }

  const created = dateRange(input);
  if (created) conditions.push({ createdAt: created });

  const filter: FilterQuery<AuditLogDoc> = { $and: conditions };

  const [rows, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<AuditLogDoc[]>()
      .exec(),
    AuditLog.countDocuments(filter).exec(),
  ]);

  return pageOf(await describeEntries(rows), total, input);
}

/* ---- Names for ids -------------------------------------------------------- */

type Named =
  | 'User'
  | 'ServiceCenter'
  | 'City'
  | 'Territory'
  | 'Product'
  | 'ProductModel'
  | 'Customer'
  | 'Part'
  | 'PartStock'
  | 'SlaRule'
  | 'Complaint';

const NAMED = new Set<string>([
  'User',
  'ServiceCenter',
  'City',
  'Territory',
  'Product',
  'ProductModel',
  'Customer',
  'Part',
  'PartStock',
  'SlaRule',
  'Complaint',
]);

/** Changed fields that hold ids, and what they point at. */
const ID_FIELDS: Record<string, Named> = {
  cityId: 'City',
  servedCityIds: 'City',
  territoryId: 'Territory',
  serviceCenterId: 'ServiceCenter',
  productId: 'Product',
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Turns stored entries into readable ones: the record's current name, and
 * names in place of ids inside the changes ("Cities served: Jaipur, Ajmer").
 * One query per kind of record, whatever the page holds.
 */
async function describeEntries(rows: AuditLogDoc[]): Promise<AuditEntry[]> {
  const wanted = new Map<Named, Set<string>>();
  const want = (type: Named, id: string | undefined) => {
    if (!id || !OBJECT_ID.test(id)) return;
    if (!wanted.has(type)) wanted.set(type, new Set());
    wanted.get(type)!.add(id);
  };

  for (const row of rows) {
    if (NAMED.has(row.entityType)) want(row.entityType as Named, row.entityId ? String(row.entityId) : undefined);
    for (const change of row.changes) {
      const type = ID_FIELDS[change.field];
      if (!type) continue;
      for (const value of [change.oldValue, change.newValue]) {
        for (const id of (value ?? '').split(',')) want(type, id.trim());
      }
    }
  }

  const names = await lookUpNames(wanted);
  const nameOf = (type: Named, id: string) => names.get(`${type}:${id}`);

  /* "undefined" is what an empty field became when the change was written. */
  const readable = (field: string, value: string | undefined): string | undefined => {
    if (value === undefined || value === 'undefined' || value === 'null' || value === '') return undefined;
    const type = ID_FIELDS[field];
    if (!type) return value;
    return value
      .split(',')
      .map((id) => nameOf(type, id.trim()) ?? id.trim())
      .join(', ');
  };

  return rows.map((row) => {
    const entityId = row.entityId ? String(row.entityId) : undefined;
    const entityName = entityId && NAMED.has(row.entityType) ? nameOf(row.entityType as Named, entityId) : undefined;

    return {
      id: String(row._id),
      at: row.createdAt,
      action: row.action,
      entityType: row.entityType,
      ...(entityId ? { entityId } : {}),
      ...(entityName ? { entityName } : {}),
      ...(row.actorId ? { actorId: String(row.actorId) } : {}),
      ...(row.actorName ? { actorName: row.actorName } : {}),
      ...(row.actorRole ? { actorRole: row.actorRole } : {}),
      changes: row.changes.map((change) => {
        const oldValue = readable(change.field, change.oldValue);
        const newValue = readable(change.field, change.newValue);
        return {
          field: change.field,
          ...(oldValue !== undefined ? { oldValue } : {}),
          ...(newValue !== undefined ? { newValue } : {}),
        };
      }),
      ...(row.note ? { note: row.note } : {}),
      ...(row.ipAddress ? { ipAddress: row.ipAddress } : {}),
      ...(row.userAgent ? { userAgent: row.userAgent } : {}),
    };
  });
}

async function lookUpNames(wanted: Map<Named, Set<string>>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const put = (type: Named, id: unknown, name: string | undefined) => {
    if (name) names.set(`${type}:${String(id)}`, name);
  };

  await Promise.all(
    [...wanted].map(async ([type, idSet]) => {
      const ids = [...idSet];
      switch (type) {
        case 'User':
          for (const row of await User.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'ServiceCenter':
          for (const row of await ServiceCenter.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'City':
          for (const row of await City.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'Territory':
          for (const row of await Territory.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'Product':
          for (const row of await Product.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'ProductModel':
          for (const row of await ProductModel.find({ _id: { $in: ids } }).select('modelNumber').lean().exec()) {
            put(type, row._id, row.modelNumber);
          }
          return;
        case 'Customer':
          for (const row of await Customer.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'Part':
          for (const row of await Part.find({ _id: { $in: ids } }).select('name').lean().exec()) put(type, row._id, row.name);
          return;
        case 'Complaint':
          for (const row of await Complaint.find({ _id: { $in: ids } }).select('complaintNumber').lean().exec()) {
            put(type, row._id, row.complaintNumber);
          }
          return;
        case 'SlaRule':
          for (const row of await SlaRule.find({ _id: { $in: ids } }).select('priority').lean().exec()) {
            put(type, row._id, `${PRIORITY_LABELS[row.priority]} priority`);
          }
          return;
        case 'PartStock': {
          /* A stock row is a part at a centre, so it is named by both. */
          const stock = await PartStock.find({ _id: { $in: ids } }).select('partId serviceCenterId').lean().exec();
          const [parts, centres] = await Promise.all([
            Part.find({ _id: { $in: stock.map((row) => row.partId) } }).select('name').lean().exec(),
            ServiceCenter.find({ _id: { $in: stock.map((row) => row.serviceCenterId) } }).select('name').lean().exec(),
          ]);
          const partName = new Map(parts.map((part) => [String(part._id), part.name]));
          const centreName = new Map(centres.map((centre) => [String(centre._id), centre.name]));
          for (const row of stock) {
            const part = partName.get(String(row.partId));
            const centre = centreName.get(String(row.serviceCenterId));
            if (part) put(type, row._id, centre ? `${part} at ${centre}` : part);
          }
          return;
        }
      }
    }),
  );

  return names;
}
