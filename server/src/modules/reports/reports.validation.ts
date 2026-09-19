/**
 * Report filters (spec section 16).
 *
 * Section 16 lists the filters every report must support: date range, city,
 * territory, service center, technician, product, model, warranty, priority
 * and status. They are defined once here and shared by every report, so a
 * filter works the same way whichever report you apply it to.
 *
 * `territoryId` is what the interface now shows as "State"
 * (`report.filters.ts`'s `FILTER_LABELS`, DECISIONS.md section 32) — the
 * parameter name is unchanged so an existing filtered-report link keeps
 * working.
 */
import { z } from 'zod';
import { COMPLAINT_STATUSES, PRIORITIES, WARRANTY_STATUSES } from '../../models/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

/** The section 16 filter set. Every field optional; absent means unfiltered. */
export const reportFilterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cityId: objectId.optional(),
  territoryId: objectId.optional(),
  serviceCenterId: objectId.optional(),
  technicianId: objectId.optional(),
  productId: objectId.optional(),
  productModelId: objectId.optional(),
  warrantyStatus: z.enum(WARRANTY_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(COMPLAINT_STATUSES).optional(),
});
export type ReportFilterInput = z.infer<typeof reportFilterSchema>;

/**
 * Output format.
 *
 * `json` for the screen, `csv` and `xlsx` for the download section 16 asks
 * for. Kept as a query parameter rather than separate routes so a report and
 * its export can never drift apart — the same filters produce the same rows.
 */
export const reportFormatSchema = z.enum(['json', 'csv', 'xlsx']).default('json');

export const reportQuerySchema = reportFilterSchema.extend({
  format: reportFormatSchema,
  /* Exports are capped: an unbounded aggregation streamed into a spreadsheet
     is how a reporting endpoint takes a server down. */
  limit: z.coerce.number().int().min(1).max(10_000).default(5_000),
});
export type ReportQueryInput = z.infer<typeof reportQuerySchema>;

/** Which report to run, for the generic endpoint. */
export const REPORT_KINDS = [
  'complaints',
  'service-centers',
  'technicians',
  'products',
  'parts',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const dashboardQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /* Narrows only — `withScope` still puts the caller's own scope first, so an
     Owner passing another centre's id sees nothing rather than someone
     else's figures (core/scope.ts). */
  serviceCenterId: objectId.optional(),
});
export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;
