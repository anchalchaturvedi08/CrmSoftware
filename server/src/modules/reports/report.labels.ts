/**
 * Words and dates for reports.
 *
 * A report is read by people, and a saved spreadsheet is read weeks later by
 * someone who never saw the screen. So stored values become the words the
 * screens use ("In progress", not `IN_PROGRESS`), and dates are written in the
 * company's own timezone rather than UTC — a complaint raised at 1 a.m. in
 * Jaipur belongs to that day, not the day before.
 *
 * The status wording matches `client/src/lib/format.ts`, so the page and its
 * download say the same thing.
 */
import { config } from '../../config/env.js';
import type { ComplaintStatus, Priority, WarrantyStatus } from '../../models/enums.js';
import type { PartUnit } from '../../models/parts.model.js';

export const STATUS_LABELS: Record<ComplaintStatus, string> = {
  NEW: 'New',
  ASSIGNED: 'Assigned',
  TECHNICIAN_ASSIGNED: 'Technician assigned',
  VISIT_SCHEDULED: 'Visit scheduled',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_PARTS: 'Waiting for parts',
  REVISIT_REQUIRED: 'Revisit required',
  RESOLUTION_SUBMITTED: 'Resolution submitted',
  ADMIN_CONFIRMATION: 'Admin confirmation',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  CANCELLED: 'Cancelled',
};

/** Most urgent first — priority is a scale, so it is always shown in order. */
export const PRIORITY_ORDER: readonly Priority[] = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

export const PRIORITY_LABELS: Record<Priority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  NORMAL: 'Normal',
  LOW: 'Low',
};

export const WARRANTY_LABELS: Record<WarrantyStatus, string> = {
  IN_WARRANTY: 'In warranty',
  OUT_OF_WARRANTY: 'Out of warranty',
};

export const UNIT_LABELS: Record<PartUnit, string> = {
  PIECE: 'Piece',
  SET: 'Set',
  METER: 'Meter',
  LITRE: 'Litre',
  KILOGRAM: 'Kilogram',
};

/* ---- Dates ---------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* `en-CA` formats as YYYY-MM-DD, which is what makes the key sortable. */
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: config.APP_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** The company-timezone calendar date of an instant, as `2026-09-16`. */
export function dayKey(date: Date): string {
  return dayKeyFormat.format(date);
}

/** `16 Sep 2026`. Built by hand: some ICU versions abbreviate September as "Sept". */
export function formatDay(date: Date): string {
  const [year, month, day] = dayKey(date).split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** `16 Sep 2026, 3:05 PM`. */
export function formatDateTime(date: Date): string {
  /* Newer ICU puts a narrow no-break space before AM/PM, which some
     spreadsheet fonts draw as a box. */
  return `${formatDay(date)}, ${timeFormat.format(date).replace(/ /g, ' ')}`;
}

/** Labels for a trend key: `16 Sep` (a day, or the Monday of a week), `Sep 2026` or `2026`. */
export function periodLabel(key: string, unit: 'day' | 'week' | 'month' | 'year'): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number?, number?];
  if (unit === 'year' || month === undefined) return String(year);
  if (unit === 'month' || day === undefined) return `${MONTHS[month - 1]} ${year}`;
  return `${day} ${MONTHS[month - 1]}`;
}
