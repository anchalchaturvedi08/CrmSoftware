/**
 * Words for recorded events (spec section 17).
 *
 * The complaint timeline and Admin's audit log read the same records, so they
 * use the same words from here — "Resolution sent back" on one screen and
 * "Resolution rejected" on the other would read as two different events.
 */
import dayjs from 'dayjs';
import { STATUS_META, formatDateTime, humanize, type ComplaintStatus } from './format';

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  SERVICE_CENTER_OWNER: 'Service Center Owner',
  TECHNICIAN: 'Technician',
};

/* ---- Complaint activity ---------------------------------------------------- */

const ACTIVITY_LABEL: Record<string, string> = {
  COMPLAINT_CREATED: 'Complaint created',
  SERVICE_CENTER_SELECTED: 'Service center selected',
  SERVICE_CENTER_REASSIGNED: 'Service center changed',
  TECHNICIAN_ASSIGNED: 'Technician assigned',
  TECHNICIAN_REASSIGNED: 'Technician changed',
  VISIT_SCHEDULED: 'Visit scheduled',
  VISIT_RESCHEDULED: 'Visit rescheduled',
  VISIT_STARTED: 'Visit started',
  VISIT_CANCELLED: 'Visit cancelled',
  STATUS_CHANGED: 'Status changed',
  DIAGNOSIS_ADDED: 'Diagnosis added',
  WORK_RECORDED: 'Work recorded',
  PARTS_REQUESTED: 'Parts requested',
  PARTS_ISSUED: 'Parts issued',
  PARTS_USED: 'Parts used',
  PARTS_MARKED_UNAVAILABLE: 'Parts marked unavailable',
  PARTS_REQUEST_APPROVED: 'Part request approved',
  PARTS_REQUEST_REJECTED: 'Part request rejected',
  PARTS_REQUEST_CANCELLED: 'Part request withdrawn',
  ATTACHMENT_ADDED: 'Photo added',
  RESOLUTION_SUBMITTED: 'Resolution submitted',
  RESOLUTION_REJECTED: 'Resolution sent back',
  REVISIT_REQUIRED: 'Revisit required',
  ADMIN_CONFIRMATION_STARTED: 'Waiting for customer confirmation',
  HAPPY_CODE_VERIFIED: 'Happy Code verified',
  HAPPY_CODE_VERIFY_FAILED: 'Wrong Happy Code entered',
  HAPPY_CODE_VIEWED: 'Happy Code viewed',
  HAPPY_CODE_REGENERATED: 'New Happy Code issued',
  COMPLAINT_CLOSED: 'Complaint closed',
  SERVICE_CENTER_RATED: 'Service center rated',
  COMPLAINT_REOPENED: 'Complaint reopened',
  COMPLAINT_CANCELLED: 'Complaint cancelled',
};

interface ActivityLike {
  action: string;
  at: string;
  fieldChanged?: string | undefined;
  oldValue?: string | undefined;
  newValue?: string | undefined;
  complaint?: { id: string } | null;
}

export function activityLabel(entry: ActivityLike): string {
  /* Accepting a resolution is recorded under the submission's action; the
     status it moved to says which it was. */
  if (entry.action === 'RESOLUTION_SUBMITTED' && entry.newValue === 'ADMIN_CONFIRMATION') {
    return 'Resolution accepted';
  }
  return ACTIVITY_LABEL[entry.action] ?? humanize(entry.action);
}

/** Filters on the audit log, as groups of the actions above. */
export const ACTIVITY_GROUPS: ReadonlyArray<{ key: string; label: string; actions: string[] }> = [
  { key: 'created', label: 'Complaints created', actions: ['COMPLAINT_CREATED'] },
  {
    key: 'assignment',
    label: 'Assignments',
    actions: ['SERVICE_CENTER_SELECTED', 'SERVICE_CENTER_REASSIGNED', 'TECHNICIAN_ASSIGNED', 'TECHNICIAN_REASSIGNED'],
  },
  { key: 'visits', label: 'Visits', actions: ['VISIT_SCHEDULED', 'VISIT_RESCHEDULED', 'VISIT_STARTED', 'VISIT_CANCELLED'] },
  {
    key: 'work',
    label: 'Work and resolutions',
    actions: ['DIAGNOSIS_ADDED', 'WORK_RECORDED', 'ATTACHMENT_ADDED', 'RESOLUTION_SUBMITTED'],
  },
  {
    key: 'parts',
    label: 'Parts',
    actions: [
      'PARTS_REQUESTED',
      'PARTS_REQUEST_APPROVED',
      'PARTS_REQUEST_REJECTED',
      'PARTS_REQUEST_CANCELLED',
      'PARTS_ISSUED',
      'PARTS_USED',
      'PARTS_MARKED_UNAVAILABLE',
    ],
  },
  {
    key: 'review',
    label: 'Reviews and rework',
    actions: [
      'RESOLUTION_REJECTED',
      'REVISIT_REQUIRED',
      'ADMIN_CONFIRMATION_STARTED',
      'SERVICE_CENTER_RATED',
    ],
  },
  {
    key: 'happy-code',
    label: 'Happy Code',
    actions: ['HAPPY_CODE_VIEWED', 'HAPPY_CODE_VERIFIED', 'HAPPY_CODE_VERIFY_FAILED', 'HAPPY_CODE_REGENERATED'],
  },
  {
    key: 'closing',
    label: 'Closed, reopened, cancelled',
    actions: ['COMPLAINT_CLOSED', 'COMPLAINT_REOPENED', 'COMPLAINT_CANCELLED'],
  },
];

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** An old or new value, in words. */
export function activityValue(field: string | undefined, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (field === 'status') return STATUS_META[value as ComplaintStatus]?.label ?? humanize(value);
  if (field === 'scheduledAt' && dayjs(value).isValid()) return formatDateTime(value);
  if (field === 'partRequest.status') return humanize(value);
  /* Entries written before names were recorded hold an id; it means nothing
     to a reader, so it is described instead. */
  if (OBJECT_ID.test(value)) return field === 'technicianId' ? 'the previous technician' : 'the previous one';
  return value;
}

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z\b/g;

/**
 * A note as a person should read it. Older entries carried machine timestamps
 * ("scheduled for 2026-09-16T13:00:00.000Z"); those show as local dates.
 */
export function readableNote(note: string): string {
  return note.replace(ISO_INSTANT, (instant) => formatDateTime(instant));
}

/**
 * Hides the status changes that repeat an action.
 *
 * Each transition records the action ("Technician assigned") and, alongside
 * it, a separate "Status changed" with the same values, so the audit trail is
 * complete. Showing both doubles the list for no information. A status change
 * with no matching action — resuming work after parts arrived, say — is the
 * only record of that event, and stays.
 */
export function foldStatusChanges<T extends ActivityLike>(entries: T[]): T[] {
  const companions = entries.filter(
    (entry) => entry.action !== 'STATUS_CHANGED' && entry.fieldChanged === 'status',
  );

  return entries.filter((entry) => {
    if (entry.action !== 'STATUS_CHANGED') return true;
    const at = new Date(entry.at).getTime();
    return !companions.some(
      (other) =>
        other.oldValue === entry.oldValue &&
        other.newValue === entry.newValue &&
        (other.complaint?.id ?? null) === (entry.complaint?.id ?? null) &&
        Math.abs(new Date(other.at).getTime() - at) < 2_000,
    );
  });
}

/* ---- System log ------------------------------------------------------------ */

const SYSTEM_LABEL: Record<string, string> = {
  LOGIN_SUCCESS: 'Signed in',
  LOGIN_FAILED_BAD_PASSWORD: 'Sign-in failed: wrong password',
  LOGIN_FAILED_NO_ACCOUNT: 'Sign-in failed: no account with that number',
  LOGIN_FAILED_ACCOUNT_LOCKED: 'Account locked after failed sign-ins',
  LOGIN_BLOCKED_LOCKED: 'Sign-in refused: account locked',
  LOGIN_BLOCKED_INACTIVE: 'Sign-in refused: account deactivated',
  TOKEN_REFRESHED: 'Session renewed',
  PASSWORD_CHANGED: 'Password changed',
  PASSWORD_CHANGE_FAILED: 'Password change failed',
  PASSWORD_RESET: 'Password reset',
  USER_CREATED: 'Account created',
  USER_UPDATED: 'Account updated',
  USER_DEACTIVATED: 'Account deactivated',
  STOCK_SET: 'Stock count set',
  STOCK_ADJUSTED: 'Stock adjusted',
  SLA_RULE_UPDATED: 'SLA rule changed',
  HAPPY_CODE_VIEWED: 'Happy Code viewed',
  HAPPY_CODE_VERIFIED: 'Happy Code verified',
  HAPPY_CODE_VERIFY_FAILED: 'Wrong Happy Code entered',
};

export const ENTITY_LABEL: Record<string, string> = {
  Territory: 'Territory',
  City: 'City',
  ServiceCenter: 'Service center',
  Product: 'Product',
  ProductModel: 'Model',
  Customer: 'Customer',
  Part: 'Part',
  PartStock: 'Stock',
  SlaRule: 'SLA rule',
  User: 'Account',
  Complaint: 'Complaint',
};

export const SYSTEM_CATEGORIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'sign-in', label: 'Sign-ins and passwords' },
  { key: 'people', label: 'Accounts' },
  { key: 'records', label: 'Records (centers, cities, products, customers)' },
  { key: 'parts', label: 'Parts and stock' },
  { key: 'happy-code', label: 'Happy Code' },
  { key: 'settings', label: 'SLA settings' },
];

interface SystemLike {
  action: string;
  entityType: string;
  changes: Array<{ field: string; oldValue?: string; newValue?: string }>;
}

export function systemLabel(entry: SystemLike): string {
  if (entry.action === 'USER_UPDATED' && reactivated(entry)) return 'Account reactivated';
  const known = SYSTEM_LABEL[entry.action];
  if (known) return known;

  /* Record edits are named by what they touched; the stored action names are
     not uniform across older entries. */
  const noun = ENTITY_LABEL[entry.entityType] ?? humanize(entry.entityType);
  if (entry.action.endsWith('_CREATED')) return `${noun} created`;
  if (entry.action.endsWith('_DEACTIVATED')) return `${noun} deactivated`;
  if (entry.action.endsWith('_UPDATED')) return reactivated(entry) ? `${noun} reactivated` : `${noun} updated`;
  return humanize(entry.action);
}

const reactivated = (entry: SystemLike) =>
  entry.changes.some((change) => change.field === 'isActive' && change.newValue === 'true');

const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  code: 'Code',
  mobile: 'Mobile',
  alternateMobile: 'Alternate mobile',
  email: 'Email',
  address: 'Address',
  state: 'State',
  pincode: 'Pincode',
  cityId: 'City',
  territoryId: 'Territory',
  serviceCenterId: 'Service center',
  servedCityIds: 'Cities covered',
  servedPincodes: 'Pincodes covered',
  notes: 'Notes',
  isActive: 'Active',
  role: 'Role',
  category: 'Category',
  unit: 'Unit',
  productId: 'Product',
  modelNumber: 'Model number',
  defaultWarrantyMonths: 'Default warranty (months)',
  availableQuantity: 'In stock',
  minimumStock: 'Minimum',
  responseMinutes: 'First visit within',
  resolutionMinutes: 'Resolved within',
  pauseOnWaitingParts: 'Pause while waiting for parts',
  pauseOnRevisitRequired: 'Pause while revisit required',
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? humanize(field.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

export function systemValue(field: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return 'Yes';
  if (value === 'false') return 'No';
  if (field === 'role') return ROLE_LABEL[value] ?? humanize(value);
  /* Lists were stored comma-joined; a space makes them readable. */
  if (field === 'servedPincodes') return value.split(',').join(', ');
  /* SLA windows are stored in minutes and set in hours. */
  if ((field === 'responseMinutes' || field === 'resolutionMinutes') && /^\d+$/.test(value)) {
    const hours = Number(value) / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return value;
}
