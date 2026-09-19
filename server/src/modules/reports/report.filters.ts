/**
 * Report filters (spec section 16) and the date trend.
 *
 * Section 16 lists ten filters. Four reports are about complaints and honour
 * all of them; the parts report is about stock movements, which have no
 * priority or warranty, so it honours only the ones that mean something for
 * a part. Rather than silently ignoring the rest, the report says which ones
 * it did not use — a filter that appears to work but does nothing is how
 * someone ends up acting on the wrong numbers.
 */
import mongoose from 'mongoose';
import { complaintScope } from '../../core/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  City,
  Product,
  ProductModel,
  ServiceCenter,
  Territory,
  User,
} from '../../models/index.js';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  WARRANTY_LABELS,
  dayKey,
  formatDay,
  periodLabel,
} from './report.labels.js';
import type { Trend } from './report.types.js';
import type { ReportFilterInput, ReportKind } from './reports.validation.js';

export const oid = (value: string) => new mongoose.Types.ObjectId(value);

type FilterKey = keyof ReportFilterInput;

/**
 * Every section 16 filter, in the order a person reads them.
 *
 * `territoryId` reads as "State" (DECISIONS.md section 32): territories are
 * now exactly one per state, created on demand, and the word "Territory"
 * never appears in the interface any more. The query parameter itself stays
 * `territoryId` — nothing that already links to a filtered report with that
 * parameter in the URL breaks.
 */
export const FILTER_LABELS: Record<FilterKey, string> = {
  from: 'From',
  to: 'To',
  cityId: 'City',
  territoryId: 'State',
  serviceCenterId: 'Service center',
  technicianId: 'Technician',
  productId: 'Product',
  productModelId: 'Model',
  warrantyStatus: 'Warranty',
  priority: 'Priority',
  status: 'Status',
};

const ALL_FILTERS = Object.keys(FILTER_LABELS) as FilterKey[];

/** Which filters each report honours. */
export const REPORT_FILTERS: Record<ReportKind, readonly FilterKey[]> = {
  complaints: ALL_FILTERS,
  'service-centers': ALL_FILTERS,
  technicians: ALL_FILTERS,
  products: ALL_FILTERS,
  parts: ['from', 'to', 'serviceCenterId', 'technicianId'],
};

/** Filters that were supplied but that this report does not use. */
export function ignoredFilters(
  kind: ReportKind,
  filter: ReportFilterInput,
): Array<{ key: FilterKey; label: string }> {
  const used = new Set(REPORT_FILTERS[kind]);
  return ALL_FILTERS.filter((key) => filter[key] !== undefined && !used.has(key)).map((key) => ({
    key,
    label: FILTER_LABELS[key],
  }));
}

/** A `$gte`/`$lte` range for the date filter, or undefined when there is none. */
export function dateRange(filter: ReportFilterInput): Record<string, Date> | undefined {
  if (!filter.from && !filter.to) return undefined;
  return {
    ...(filter.from ? { $gte: filter.from } : {}),
    ...(filter.to ? { $lte: filter.to } : {}),
  };
}

/**
 * The `$match` for complaint-based reports: the caller's scope and the
 * section 16 filters.
 *
 * Scope and filters combine with `$and` for the same reason query scoping does
 * (see `core/scope.ts`): a `serviceCenterId` in the query must narrow an
 * Owner's result, never replace the restriction.
 */
export async function complaintMatch(
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<Record<string, unknown>> {
  const conditions: Record<string, unknown>[] = [];

  const scope = complaintScope(auth);
  if (Object.keys(scope).length > 0) conditions.push(scope);

  const created = dateRange(filter);
  if (created) conditions.push({ createdAt: created });

  if (filter.cityId) conditions.push({ 'serviceAddress.cityId': oid(filter.cityId) });

  if (filter.territoryId) {
    /* A complaint records its city, not its territory, so a territory means
       the cities it holds today. A territory with no cities matches nothing,
       which is the truth rather than an error. */
    const cityIds = await City.find({ territoryId: oid(filter.territoryId) })
      .distinct('_id')
      .exec();
    conditions.push({ 'serviceAddress.cityId': { $in: cityIds } });
  }

  if (filter.serviceCenterId) conditions.push({ serviceCenterId: oid(filter.serviceCenterId) });
  if (filter.technicianId) conditions.push({ technicianId: oid(filter.technicianId) });
  if (filter.productId) conditions.push({ productId: oid(filter.productId) });
  if (filter.productModelId) conditions.push({ productModelId: oid(filter.productModelId) });
  if (filter.warrantyStatus) conditions.push({ warrantyStatus: filter.warrantyStatus });
  if (filter.priority) conditions.push({ priority: filter.priority });
  if (filter.status) conditions.push({ status: filter.status });

  return conditions.length > 0 ? { $and: conditions } : {};
}

/**
 * The filters in force, in words, for the top of an exported file.
 *
 * Identifiers are resolved to names: "City: Jaipur" explains a saved
 * spreadsheet; "cityId: 6aa7…" does not.
 */
export async function describeFilters(
  kind: ReportKind,
  filter: ReportFilterInput,
  auth: AuthContext,
): Promise<Array<{ label: string; value: string }>> {
  const lines: Array<{ label: string; value: string }> = [];

  /* An Owner's report is always their own centre's, filter or not. */
  if (auth.role === 'SERVICE_CENTER_OWNER' && auth.serviceCenterId) {
    const own = await ServiceCenter.findById(auth.serviceCenterId).select('name').lean().exec();
    lines.push({ label: 'Service center', value: own?.name ?? 'Your service center' });
  }

  const nameOf = async (key: FilterKey, id: string): Promise<string | undefined> => {
    switch (key) {
      case 'cityId':
        return (await City.findById(id).select('name').lean().exec())?.name;
      case 'territoryId':
        return (await Territory.findById(id).select('name').lean().exec())?.name;
      case 'serviceCenterId':
        return (await ServiceCenter.findById(id).select('name').lean().exec())?.name;
      case 'technicianId':
        return (await User.findById(id).select('name').lean().exec())?.name;
      case 'productId':
        return (await Product.findById(id).select('name').lean().exec())?.name;
      case 'productModelId':
        return (await ProductModel.findById(id).select('modelNumber').lean().exec())?.modelNumber;
      default:
        return undefined;
    }
  };

  for (const key of REPORT_FILTERS[kind]) {
    const value = filter[key];
    if (value === undefined) continue;

    let text: string;
    if (value instanceof Date) text = formatDay(value);
    else if (key === 'priority') text = PRIORITY_LABELS[value as keyof typeof PRIORITY_LABELS];
    else if (key === 'warrantyStatus') text = WARRANTY_LABELS[value as keyof typeof WARRANTY_LABELS];
    else if (key === 'status') text = STATUS_LABELS[value as keyof typeof STATUS_LABELS];
    else text = (await nameOf(key, String(value))) ?? 'Unknown';

    lines.push({ label: FILTER_LABELS[key], value: text });
  }

  return lines;
}

/* ---- Trend -------------------------------------------------------------- */

const DAY = 86_400_000;

/** Milliseconds for a `YYYY-MM-DD` key, treated as a plain calendar date. */
const keyTime = (key: string): number => {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
};

/** The Monday on or before a `YYYY-MM-DD` key. Weeks start on Monday. */
const mondayOf = (key: string): string => {
  const time = keyTime(key);
  const sinceMonday = (new Date(time).getUTCDay() + 6) % 7;
  return new Date(time - sinceMonday * DAY).toISOString().slice(0, 10);
};

/**
 * Complaints per period, from per-day counts.
 *
 * The grain follows the span: days up to about two months, weeks up to six,
 * months up to three years, then years — enough bars to show a shape, never so
 * many that they turn to noise. Weeks exist for "last 90 days": by month, its
 * first bar would hold a few days and look like a quiet month.
 *
 * Empty periods are filled in with zero; a trend that skips the quiet days
 * draws them closer together than they were. Periods are walked as calendar
 * dates rather than by adding hours to an instant, so the result does not
 * depend on daylight-saving rules.
 */
export function buildTrend(
  dayCounts: ReadonlyArray<{ _id: string; count: number }>,
  filter: ReportFilterInput,
  labels: { title: string; valueHeader: string },
  now = new Date(),
): Trend {
  const counts = new Map(dayCounts.map((row) => [row._id, row.count]));
  const empty: Trend = { ...labels, unit: 'day', points: [] };

  const startKey = filter.from ? dayKey(filter.from) : [...counts.keys()].sort()[0];
  if (!startKey) return empty;

  /* A range running into the future stops at today: tomorrow has no
     complaints yet, and a row of zeros would look like a collapse. */
  const endKey = dayKey(filter.to && filter.to < now ? filter.to : now);
  if (endKey < startKey) return empty;

  const span = (keyTime(endKey) - keyTime(startKey)) / DAY;
  const unit: Trend['unit'] =
    span <= 62 ? 'day' : span <= 184 ? 'week' : span <= 1_096 ? 'month' : 'year';

  const periodOf = (key: string): string =>
    unit === 'day' ? key : unit === 'week' ? mondayOf(key) : key.slice(0, unit === 'month' ? 7 : 4);

  /* Sum the day counts into the chosen grain. */
  const totals = new Map<string, number>();
  for (const [key, count] of counts) {
    const period = periodOf(key);
    totals.set(period, (totals.get(period) ?? 0) + count);
  }

  const keys: string[] = [];
  if (unit === 'day' || unit === 'week') {
    const step = unit === 'day' ? DAY : 7 * DAY;
    for (let time = keyTime(periodOf(startKey)); time <= keyTime(endKey); time += step) {
      keys.push(new Date(time).toISOString().slice(0, 10));
    }
  } else {
    const [startYear, startMonth] = startKey.split('-').map(Number) as [number, number];
    const [endYear, endMonth] = endKey.split('-').map(Number) as [number, number];
    if (unit === 'month') {
      for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth); ) {
        keys.push(`${year}-${String(month).padStart(2, '0')}`);
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
    } else {
      for (let year = startYear; year <= endYear; year += 1) keys.push(String(year));
    }
  }

  return {
    ...labels,
    unit,
    points: keys.map((key) => ({ key, label: periodLabel(key, unit), value: totals.get(key) ?? 0 })),
  };
}
