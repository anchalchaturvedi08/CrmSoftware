/**
 * Report filters, kept in the address bar (spec section 16).
 *
 * The chosen report, dates and filters live in the URL rather than in
 * component state, so a filtered report survives a refresh and can be
 * bookmarked or sent to a colleague — "this month's High priority complaints
 * in Jaipur" is one link.
 */
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router';
import type { ReportKind } from '@/lib/types';

export type Portal = 'admin' | 'center';

export const REPORTS: ReadonlyArray<{ kind: ReportKind; label: string; adminOnly?: boolean }> = [
  { kind: 'complaints', label: 'Complaints' },
  /* An Owner has one centre; a table of one row adds nothing the other
     reports do not already show. */
  { kind: 'service-centers', label: 'Service centers', adminOnly: true },
  { kind: 'technicians', label: 'Technicians' },
  { kind: 'products', label: 'Products' },
  { kind: 'parts', label: 'Parts' },
];

export const DATE_PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Choose dates' },
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number]['key'];

export type FilterKey =
  | 'serviceCenterId'
  | 'technicianId'
  | 'cityId'
  | 'territoryId'
  | 'productId'
  | 'productModelId'
  | 'priority'
  | 'warrantyStatus'
  | 'status';

export const FILTER_KEYS: readonly FilterKey[] = [
  'serviceCenterId',
  'technicianId',
  'territoryId',
  'cityId',
  'productId',
  'productModelId',
  'priority',
  'warrantyStatus',
  'status',
];

export const FILTER_LABELS: Record<FilterKey, string> = {
  serviceCenterId: 'Service center',
  technicianId: 'Technician',
  territoryId: 'State',
  cityId: 'City',
  productId: 'Product',
  productModelId: 'Model',
  priority: 'Priority',
  warrantyStatus: 'Warranty',
  status: 'Status',
};

/**
 * Which filters each report honours — the same table as the server's
 * `REPORT_FILTERS` (server/src/modules/reports/report.filters.ts). Parts have
 * no priority, warranty or product, so those filters are not offered there.
 */
const REPORT_FILTERS: Record<ReportKind, readonly FilterKey[]> = {
  complaints: FILTER_KEYS,
  'service-centers': FILTER_KEYS,
  technicians: FILTER_KEYS,
  products: FILTER_KEYS,
  parts: ['serviceCenterId', 'technicianId'],
};

/** The instants a preset covers. "Last 7 days" is today and the six before it. */
export function dateRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
  now = dayjs(),
): { from?: string; to?: string } {
  switch (preset) {
    case '7d':
      return { from: now.subtract(6, 'day').startOf('day').toISOString() };
    case '30d':
      return { from: now.subtract(29, 'day').startOf('day').toISOString() };
    case '90d':
      return { from: now.subtract(89, 'day').startOf('day').toISOString() };
    case 'month':
      return { from: now.startOf('month').toISOString() };
    case 'last-month': {
      const last = now.subtract(1, 'month');
      return { from: last.startOf('month').toISOString(), to: last.endOf('month').toISOString() };
    }
    case 'year':
      return { from: now.startOf('year').toISOString() };
    case 'all':
      return {};
    case 'custom':
      return {
        ...(customFrom ? { from: dayjs(customFrom).startOf('day').toISOString() } : {}),
        ...(customTo ? { to: dayjs(customTo).endOf('day').toISOString() } : {}),
      };
  }
}

/** "18 Aug – 17 Sep 2026", for the line under the filters. */
export function describeRange(range: { from?: string; to?: string }, now = dayjs()): string {
  if (!range.from && !range.to) return 'All dates';
  const end = range.to ? dayjs(range.to) : now;
  if (!range.from) return `Up to ${end.format('D MMM YYYY')}`;
  const start = dayjs(range.from);
  if (start.isSame(end, 'day')) return end.format('D MMM YYYY');
  const startFormat = start.isSame(end, 'year') ? 'D MMM' : 'D MMM YYYY';
  return `${start.format(startFormat)} – ${end.format('D MMM YYYY')}`;
}

export function useReportParams(portal: Portal) {
  const [params, setParams] = useSearchParams();

  const available = REPORTS.filter((report) => portal === 'admin' || !report.adminOnly);
  const requested = params.get('report');
  const kind = available.find((report) => report.kind === requested)?.kind ?? 'complaints';

  const preset: DatePreset = DATE_PRESETS.find((p) => p.key === params.get('range'))?.key ?? '30d';
  const customFrom = params.get('from') ?? '';
  const customTo = params.get('to') ?? '';

  const values = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, params.get(key) ?? '']),
  ) as Record<FilterKey, string>;
  /* An Owner's reports are their own centre's; the server enforces it too. */
  if (portal === 'center') values.serviceCenterId = '';

  const applicable = REPORT_FILTERS[kind].filter((key) => portal === 'admin' || key !== 'serviceCenterId');
  const range = dateRange(preset, customFrom, customTo);

  const query: Record<string, string> = { ...range };
  for (const key of applicable) {
    if (values[key]) query[key] = values[key];
  }

  /** Filters still set from another report that this one does not use. */
  const notApplied = FILTER_KEYS.filter((key) => values[key] && !applicable.includes(key));
  const activeCount = applicable.filter((key) => values[key]).length;

  /** Applies several changes at once; an empty value removes the parameter. */
  const update = (changes: Partial<Record<string, string>>, options: { push?: boolean } = {}) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      /* Switching report is a place worth going back to; nudging a filter is not. */
      { replace: !options.push },
    );
  };

  return {
    available,
    kind,
    preset,
    customFrom,
    customTo,
    values,
    applicable,
    range,
    query,
    notApplied,
    activeCount,
    update,
  };
}
