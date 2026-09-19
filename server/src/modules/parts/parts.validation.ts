/**
 * Request schemas for the parts module (spec section 11).
 */
import { z } from 'zod';
import { PART_REQUEST_STATUSES, type PartRequestStatus } from '../../models/enums.js';
import { PART_UNITS } from '../../models/parts.model.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

/* Quantities are whole units of a physical thing. */
const quantity = z.coerce
  .number()
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(10_000);

const nonNegative = z.coerce
  .number()
  .int('Must be a whole number')
  .min(0, 'Cannot be negative')
  .max(1_000_000);

/* ---- Part master ------------------------------------------------------- */

export const createPartSchema = z.object({
  name: z.string().trim().min(1, 'Part name is required').max(180),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]+$/, 'Code may use letters, digits, hyphen and underscore')
    .max(40),
  category: z.string().trim().max(120).optional(),
  unit: z.enum(PART_UNITS).default('PIECE'),
});

export const updatePartSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  /**
   * `null` (or an empty string) clears the category; leaving the key out keeps
   * it. The two had to be told apart: the Admin form omitted an emptied box,
   * so the server kept the old category while the screen said "updated".
   */
  category: z.string().trim().max(120).nullable().optional(),
  unit: z.enum(PART_UNITS).optional(),
  /* Section 17: no hard delete. Retiring a part is a flag. */
  isActive: z.boolean().optional(),
});

export const listPartsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
  /* `stringbool`: `coerce.boolean` reads "false" as true. */
  includeInactive: z.stringbool().default(false),
});

/* ---- Stock ------------------------------------------------------------- */

export const setStockSchema = z.object({
  partId: objectId,
  availableQuantity: nonNegative,
  minimumStock: nonNegative,
  /* Admin may act for any centre; an Owner's is taken from their own scope. */
  serviceCenterId: objectId.optional(),
});

export const adjustStockSchema = z.object({
  partId: objectId,
  /**
   * Signed change. Positive for a delivery, negative for a correction or
   * write-off. Separate from `setStock` because "we received 20 more" and
   * "the true count is 20" are different claims, and only one of them is
   * safe when two people are counting at once.
   */
  delta: z.coerce.number().int().min(-10_000).max(10_000),
  reason: z.string().trim().min(3, 'Please give a reason').max(500),
  serviceCenterId: objectId.optional(),
});

export const listStockSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  serviceCenterId: objectId.optional(),
  /** Section 16's low-stock report. */
  lowOnly: z.stringbool().default(false),
  search: z.string().trim().max(120).optional(),
});

/* ---- Requests ---------------------------------------------------------- */

export const createPartRequestSchema = z.object({
  partId: objectId,
  quantityRequested: quantity,
  reason: z.string().trim().max(1000).optional(),
});

/**
 * The statuses an Owner's decision can set (section 11, "Service Center
 * actions").
 *
 * `REQUESTED` is excluded: a decision cannot be "no decision", and allowing it
 * would let an Owner silently rewind a request they had already actioned.
 * Typed as the narrowed union so the service's per-decision timeline table
 * must name every one of them.
 */
export const DECISION_STATUSES = PART_REQUEST_STATUSES.filter(
  (status): status is Exclude<PartRequestStatus, 'REQUESTED'> => status !== 'REQUESTED',
);
export type PartRequestDecision = (typeof DECISION_STATUSES)[number];

/** An Owner's decision on a request. */
export const decidePartRequestSchema = z
  .object({
    status: z.enum(DECISION_STATUSES),
    quantityIssued: z.coerce.number().int().min(0).max(10_000).optional(),
    remarks: z.string().trim().max(1000).optional(),
  })
  .refine((data) => data.status !== 'ISSUED' || (data.quantityIssued ?? 0) > 0, {
    path: ['quantityIssued'],
    message: 'Issuing requires a quantity greater than zero',
  })
  .refine(
    (data) =>
      !['UNAVAILABLE', 'REJECTED'].includes(data.status) ||
      (data.remarks?.length ?? 0) >= 3,
    {
      path: ['remarks'],
      message: 'Please say why the request cannot be met',
    },
  );

export const listPartRequestsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * One status, or several separated by commas. The centre's waiting queue is
   * `REQUESTED,APPROVED` (`WAITING_REQUEST_STATUSES` in the service): an
   * approved request has not been issued yet, so it is still waiting.
   */
  status: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(PART_REQUEST_STATUSES)).min(1))
    .optional(),
  complaintId: objectId.optional(),
  partId: objectId.optional(),
});

/* ---- Usage ------------------------------------------------------------- */

export const recordUsageSchema = z.object({
  partId: objectId,
  quantity,
  remarks: z.string().trim().max(1000).optional(),
});

export type CreatePartInput = z.infer<typeof createPartSchema>;
export type UpdatePartInput = z.infer<typeof updatePartSchema>;
export type ListPartsInput = z.infer<typeof listPartsSchema>;
export type SetStockInput = z.infer<typeof setStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ListStockInput = z.infer<typeof listStockSchema>;
export type CreatePartRequestInput = z.infer<typeof createPartRequestSchema>;
export type DecidePartRequestInput = z.infer<typeof decidePartRequestSchema>;
export type ListPartRequestsInput = z.infer<typeof listPartRequestsSchema>;
export type RecordUsageInput = z.infer<typeof recordUsageSchema>;
