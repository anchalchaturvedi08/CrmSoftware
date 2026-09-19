/**
 * Display helpers shared by every screen.
 *
 * Kept together so a status reads the same way on the dashboard, the list and
 * the detail page — spec section 21 asks for "clear priority/status colors"
 * and a consistent system, which means one mapping, not three.
 */
import { clsx, type ClassValue } from 'clsx';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { twMerge } from 'tailwind-merge';
import type { CustomerAvailability } from './types';

dayjs.extend(relativeTime);

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type ComplaintStatus =
  | 'NEW'
  | 'ASSIGNED'
  | 'TECHNICIAN_ASSIGNED'
  | 'VISIT_SCHEDULED'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_PARTS'
  | 'REVISIT_REQUIRED'
  | 'RESOLUTION_SUBMITTED'
  | 'ADMIN_CONFIRMATION'
  | 'CLOSED'
  | 'REOPENED'
  | 'CANCELLED';

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

/**
 * Status presentation.
 *
 * Colour is grouped by *what the status asks of someone*, so the list scans:
 * blues and violets are routing, amber is active work, orange and rose are
 * blocked or failed, teal and cyan are waiting on a review, green is done.
 * Label text always accompanies the colour — colour alone would fail anyone
 * who cannot tell them apart.
 */
export const STATUS_META: Record<
  ComplaintStatus,
  { label: string; className: string; dot: string }
> = {
  NEW: { label: 'New', className: 'bg-sky-50 text-sky-700 ring-sky-600/20', dot: 'bg-sky-500' },
  ASSIGNED: {
    label: 'Assigned',
    className: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
    dot: 'bg-indigo-500',
  },
  TECHNICIAN_ASSIGNED: {
    label: 'Technician assigned',
    className: 'bg-violet-50 text-violet-700 ring-violet-600/20',
    dot: 'bg-violet-500',
  },
  VISIT_SCHEDULED: {
    label: 'Visit scheduled',
    className: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    dot: 'bg-blue-500',
  },
  IN_PROGRESS: {
    label: 'In progress',
    className: 'bg-amber-50 text-amber-800 ring-amber-600/25',
    dot: 'bg-amber-500',
  },
  WAITING_FOR_PARTS: {
    label: 'Waiting for parts',
    className: 'bg-orange-50 text-orange-800 ring-orange-600/25',
    dot: 'bg-orange-500',
  },
  REVISIT_REQUIRED: {
    label: 'Revisit required',
    className: 'bg-rose-50 text-rose-700 ring-rose-600/20',
    dot: 'bg-rose-500',
  },
  RESOLUTION_SUBMITTED: {
    label: 'Resolution submitted',
    className: 'bg-cyan-50 text-cyan-800 ring-cyan-600/25',
    dot: 'bg-cyan-500',
  },
  ADMIN_CONFIRMATION: {
    label: 'Admin confirmation',
    className: 'bg-teal-50 text-teal-800 ring-teal-600/25',
    dot: 'bg-teal-500',
  },
  CLOSED: {
    label: 'Closed',
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    dot: 'bg-emerald-500',
  },
  REOPENED: {
    label: 'Reopened',
    className: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-600/20',
    dot: 'bg-fuchsia-500',
  },
  CANCELLED: {
    label: 'Cancelled',
    className: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    dot: 'bg-slate-400',
  },
};

export const PRIORITY_META: Record<Priority, { label: string; className: string }> = {
  LOW: { label: 'Low', className: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  NORMAL: { label: 'Normal', className: 'bg-blue-50 text-blue-700 ring-blue-600/20' },
  HIGH: { label: 'High', className: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
  CRITICAL: { label: 'Critical', className: 'bg-red-50 text-red-700 ring-red-600/25' },
};

/** Why a visit ended with no work on it, in plain words. */
export const NO_WORK_REASON: Record<Exclude<CustomerAvailability, 'CUSTOMER_AVAILABLE'>, string> = {
  CUSTOMER_UNAVAILABLE: 'Nobody was home',
  RESCHEDULE_REQUIRED: 'Customer asked for another day',
  OTHER: 'No work done',
};

export const WARRANTY_LABEL: Record<string, string> = {
  IN_WARRANTY: 'In warranty',
  OUT_OF_WARRANTY: 'Out of warranty',
};

/** Title-cases an enum value no mapping above covers. */
export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .split('_')
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Dates render in the browser's local zone.
 *
 * The server stores UTC and the company operates in one timezone
 * (`APP_TIMEZONE`, Asia/Kolkata), which is where its staff's browsers are.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dayjs(value).format('D MMM YYYY');
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dayjs(value).format('D MMM YYYY, h:mm A');
}

export function fromNow(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dayjs(value).fromNow();
}

/** Remaining SLA time, e.g. "3h 20m left" or "2h overdue". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';

  const overdue = ms < 0;
  const total = Math.abs(ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);

  const text =
    hours >= 48
      ? `${Math.floor(hours / 24)}d ${hours % 24}h`
      : hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m`;

  return overdue ? `${text} overdue` : `${text} left`;
}

/** Formats a stored 10-digit mobile for reading aloud: 98765 43210. */
export function formatMobile(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length === 10 ? `${value.slice(0, 5)} ${value.slice(5)}` : value;
}
