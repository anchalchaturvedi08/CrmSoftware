/**
 * Request schemas for the complaint module (spec section 6.1).
 */
import { z } from 'zod';
import { normalizeMobile } from '../../models/common/base.js';
import { COMPLAINT_STATUSES, PRIORITIES, WARRANTY_STATUSES } from '../../models/enums.js';

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

const mobile = z
  .string()
  .min(1, 'Mobile number is required')
  .transform(normalizeMobile)
  .refine((v) => /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

const optionalMobile = z
  .string()
  .transform(normalizeMobile)
  .refine((v) => v === '' || /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a valid 10-digit Indian mobile number',
  })
  .optional();

const pincode = z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits');

/**
 * A city, either as an existing `cityId` or a typed `cityName` resolved
 * against `state` (DECISIONS.md section 32) — exactly one of the two.
 */
const cityFields = {
  cityId: objectId.optional(),
  cityName: z.string().trim().min(1, 'City name is required').max(120).optional(),
  state: z.string().trim().min(1, 'State is required').max(120),
} as const;

const exactlyOneCity = (data: { cityId?: string; cityName?: string }) =>
  Boolean(data.cityId) !== Boolean(data.cityName);
const exactlyOneCityIssue = {
  path: ['cityId'] as PropertyKey[],
  message: 'Provide either an existing cityId or a cityName, not both',
};

/** A customer being created inline with the complaint (Workflow A step 2). */
const newCustomerSchema = z
  .object({
    name: z.string().min(1, 'Customer name is required').max(160),
    mobile,
    alternateMobile: optionalMobile,
    email: z.email('Email address is not valid').optional(),
    address: z.string().min(1, 'Service address is required').max(500),
    ...cityFields,
    pincode,
    notes: z.string().max(2000).optional(),
  })
  .refine(exactlyOneCity, exactlyOneCityIssue);

/**
 * Where the service will happen (Workflow A step 8, "Confirm service address").
 *
 * The create screen always sends the address the Admin confirmed, whether that
 * is the customer's saved one or a different one for this complaint, so what
 * is saved is what was on screen. Omitted means the customer's saved address —
 * or, for a new customer, the address typed for them.
 */
const serviceAddressSchema = z
  .object({
    address: z.string().trim().min(1, 'Service address is required').max(500),
    ...cityFields,
    pincode,
  })
  .refine(exactlyOneCity, exactlyOneCityIssue);

export const createComplaintSchema = z
  .object({
    /* Either an existing customer or a new one — exactly one. */
    customerId: objectId.optional(),
    newCustomer: newCustomerSchema.optional(),

    productId: objectId,
    productModelId: objectId,
    serialNumber: z.string().min(1, 'Serial number is required').max(80),
    purchaseDate: z.coerce.date().optional(),

    category: z.string().min(1, 'Complaint category is required').max(120),
    description: z.string().min(1, 'Complaint description is required').max(5000),
    priority: z.enum(PRIORITIES).default('NORMAL'),

    /* Section 12: the complaint-level choice is authoritative, so it is
       required rather than defaulted from the product master. */
    warrantyStatus: z.enum(WARRANTY_STATUSES),
    warrantyNotes: z.string().max(1000).optional(),

    serviceAddress: serviceAddressSchema.optional(),

    /**
     * Optional, which is what makes `NEW` a reachable status
     * (DECISIONS.md section 4.1). Supplying it creates the complaint already
     * `ASSIGNED`; omitting it leaves Admin to choose later.
     */
    serviceCenterId: objectId.optional(),
  })
  .refine((data) => Boolean(data.customerId) !== Boolean(data.newCustomer), {
    path: ['customerId'],
    message: 'Provide either an existing customerId or a newCustomer, not both',
  });

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

/** Filters and paging for the complaint list (sections 9, 16). */
export const listComplaintsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  /* Section 19 requires pagination; the cap stops a client asking for
     everything and defeating the point. */
  limit: z.coerce.number().int().min(1).max(100).default(25),

  /**
   * One status, or several separated by commas — `ASSIGNED,REOPENED`.
   *
   * A work queue is usually more than one status ("needs a technician" is
   * both assigned and reopened), and one request beats one per status.
   */
  status: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(COMPLAINT_STATUSES)).min(1))
    .optional(),
  /**
   * `open=true`: only complaints still being worked — not closed, not
   * cancelled. The dashboards' "Open complaints", "Critical open" and a
   * technician's "Open jobs" count exactly this, so their links can list
   * exactly what they counted. `false` or absent does not filter.
   */
  open: z.stringbool().optional(),
  /**
   * `slaBreached=true`: open and past the resolution deadline right now — the
   * dashboards' "SLA breached" figure. `false` or absent does not filter.
   */
  slaBreached: z.stringbool().optional(),

  priority: z.enum(PRIORITIES).optional(),
  warrantyStatus: z.enum(WARRANTY_STATUSES).optional(),
  serviceCenterId: objectId.optional(),
  technicianId: objectId.optional(),
  cityId: objectId.optional(),
  productModelId: objectId.optional(),

  /**
   * Free text: the start of a complaint number or serial number, or a customer
   * mobile typed any way the screens show one ("98765 43210", "+91 98765…").
   */
  search: z.string().trim().max(120).optional(),

  /** Raised on or after / on or before these instants (ISO 8601). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),

  sort: z.enum(['createdAt', '-createdAt', 'priority', '-priority']).default('-createdAt'),
});
export type ListComplaintsInput = z.infer<typeof listComplaintsSchema>;

/**
 * Query for the section 8 recommendation list.
 *
 * The create-complaint screen may only have a typed city name and state at
 * this point, not yet a saved `cityId` — `cityName`+`state` is a read-only
 * alternative here (`recommendation.service.ts` looks up a matching city but
 * never creates one from a filter query).
 */
export const recommendationQuerySchema = z.object({
  pincode: z.string().regex(/^\d{6}$/).optional(),
  cityId: objectId.optional(),
  cityName: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(1).max(120).optional(),
  territoryId: objectId.optional(),
});
export type RecommendationQueryInput = z.infer<typeof recommendationQuerySchema>;
