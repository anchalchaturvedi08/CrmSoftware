/**
 * Request schemas for master data (spec section 25 Phase 2).
 */
import { z } from 'zod';
import { normalizeMobile } from '../../models/common/base.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

const code = (max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]+$/, 'Code may use letters, digits, hyphen and underscore')
    .max(max);

const mobile = z
  .string()
  .min(1, 'Mobile number is required')
  .transform(normalizeMobile)
  .refine((v) => /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

const pincode = z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits');

/** Paging and search, shared by every master list. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(120).optional(),
  /* `stringbool`, not `coerce.boolean`: the latter is `Boolean("false")`,
     which is true for any non-empty string (tests/modules/centerPortal). */
  includeInactive: z.stringbool().default(false),
});
export type ListQueryInput = z.infer<typeof listQuerySchema>;

/* ---- Territory --------------------------------------------------------- */

export const createTerritorySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  code: code(20),
  notes: z.string().trim().max(500).optional(),
});

export const updateTerritorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

/* ---- City -------------------------------------------------------------- */

export const createCitySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  state: z.string().trim().min(1, 'State is required').max(120),
  territoryId: objectId,
});

export const updateCitySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(1).max(120).optional(),
  territoryId: objectId.optional(),
  isActive: z.boolean().optional(),
});

export const listCitiesSchema = listQuerySchema.extend({
  territoryId: objectId.optional(),
  state: z.string().trim().max(120).optional(),
});
export type ListCitiesInput = z.infer<typeof listCitiesSchema>;

/* ---- Service center ---------------------------------------------------- */

const coordinates = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/**
 * A city named in the coverage list ("also serves these cities"), typed
 * rather than picked — resolved the same find-or-create way as the centre's
 * own city (`geography.resolve.ts`).
 */
const servedCityInput = z.object({
  name: z.string().trim().min(1, 'City name is required').max(120),
  state: z.string().trim().min(1, 'State is required').max(120),
});

/**
 * `territoryId` is deliberately not accepted here any more. A centre's
 * territory now follows its city one-for-one (`geography.resolve.ts` keeps
 * exactly one territory per state) and is always derived server-side from the
 * resolved `cityId`, so there is nothing left for a caller to choose — an
 * explicit value could only ever disagree with the city and never
 * legitimately differ from it.
 */
export const createServiceCenterSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(180),
    code: code(30),
    mobile,
    email: z.email('Email address is not valid').optional(),
    address: z.string().trim().min(1, 'Address is required').max(500),
    /* Either an existing city, or a typed name resolved against a state
       (DECISIONS.md section 32) — exactly one. */
    cityId: objectId.optional(),
    cityName: z.string().trim().min(1, 'City name is required').max(120).optional(),
    state: z.string().trim().min(1, 'State is required').max(120).optional(),
    pincode,
    /* Coverage feeds the section 8 recommendation; empty is valid, and simply
       means the centre only ever appears via its own city or territory.
       `servedCityIds` for existing cities, `servedCities` for typed ones —
       the service merges both into one list. */
    servedCityIds: z.array(objectId).max(200).default([]),
    servedCities: z.array(servedCityInput).max(200).optional(),
    servedPincodes: z.array(pincode).max(500).default([]),
    location: coordinates.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((data) => Boolean(data.cityId) !== Boolean(data.cityName), {
    path: ['cityId'],
    message: 'Provide either an existing cityId or a cityName, not both',
  })
  .refine((data) => !data.cityName || Boolean(data.state), {
    path: ['state'],
    message: 'State is required when providing a cityName',
  });

export const updateServiceCenterSchema = z
  .object({
    name: z.string().trim().min(1).max(180).optional(),
    mobile: mobile.optional(),
    email: z.email('Email address is not valid').optional(),
    address: z.string().trim().min(1).max(500).optional(),
    cityId: objectId.optional(),
    cityName: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().min(1).max(120).optional(),
    pincode: pincode.optional(),
    servedCityIds: z.array(objectId).max(200).optional(),
    servedCities: z.array(servedCityInput).max(200).optional(),
    servedPincodes: z.array(pincode).max(500).optional(),
    location: coordinates.optional(),
    notes: z.string().trim().max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => !(data.cityId && data.cityName), {
    path: ['cityId'],
    message: 'Provide either cityId or cityName, not both',
  });

export const listServiceCentersSchema = listQuerySchema.extend({
  cityId: objectId.optional(),
  territoryId: objectId.optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
});
export type ListServiceCentersInput = z.infer<typeof listServiceCentersSchema>;

/* ---- Product and model ------------------------------------------------- */

export const createProductSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(180),
  code: code(40),
  category: z.string().trim().max(120).optional(),
  /* Advisory only — section 12 keeps the complaint-level choice authoritative. */
  defaultWarrantyMonths: z.coerce.number().int().min(0).max(600).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  category: z.string().trim().max(120).optional(),
  defaultWarrantyMonths: z.coerce.number().int().min(0).max(600).optional(),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});

export const createProductModelSchema = z.object({
  productId: objectId,
  modelNumber: z.string().trim().toUpperCase().min(1, 'Model number is required').max(60),
  name: z.string().trim().max(180).optional(),
  defaultWarrantyMonths: z.coerce.number().int().min(0).max(600).optional(),
});

export const updateProductModelSchema = z.object({
  name: z.string().trim().max(180).optional(),
  defaultWarrantyMonths: z.coerce.number().int().min(0).max(600).optional(),
  isActive: z.boolean().optional(),
});

export const listProductModelsSchema = listQuerySchema.extend({
  productId: objectId.optional(),
});
export type ListProductModelsInput = z.infer<typeof listProductModelsSchema>;

/* ---- Customer ---------------------------------------------------------- */

export const createCustomerSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(160),
    mobile,
    alternateMobile: z
      .string()
      .transform(normalizeMobile)
      .refine((v) => v === '' || /^[6-9]\d{9}$/.test(v), {
        message: 'Enter a valid 10-digit Indian mobile number',
      })
      .optional(),
    email: z.email('Email address is not valid').optional(),
    address: z.string().trim().min(1, 'Address is required').max(500),
    /* Either an existing city, or a typed name resolved against `state`
       (DECISIONS.md section 32) — exactly one. */
    cityId: objectId.optional(),
    cityName: z.string().trim().min(1, 'City name is required').max(120).optional(),
    state: z.string().trim().min(1, 'State is required').max(120),
    pincode,
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => Boolean(data.cityId) !== Boolean(data.cityName), {
    path: ['cityId'],
    message: 'Provide either an existing cityId or a cityName, not both',
  });

/**
 * Strict on purpose.
 *
 * Zod strips unknown keys by default, which would mean a request asking to
 * change `mobile` parsed to `{}` and returned 200 — reporting success for a
 * change that never happened. A strict object rejects it instead, and catches
 * field-name typos in the bargain.
 */
export const updateCustomerSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160).optional(),
    alternateMobile: z
      .string()
      .transform(normalizeMobile)
      .refine((v) => v === '' || /^[6-9]\d{9}$/.test(v), {
        message: 'Enter a valid 10-digit Indian mobile number',
      })
      .optional(),
    email: z.email('Email address is not valid').optional(),
    address: z.string().trim().min(1).max(500).optional(),
    cityId: objectId.optional(),
    cityName: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().min(1).max(120).optional(),
    pincode: pincode.optional(),
    notes: z.string().trim().max(2000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => !(data.cityId && data.cityName), {
    path: ['cityId'],
    message: 'Provide either cityId or cityName, not both',
  });

/**
 * Mobile is deliberately absent from the update schema.
 *
 * It is the customer's identity (section 13's repeat-complaint history is
 * keyed on it) and it is snapshotted onto every complaint. Changing it would
 * silently split one person's history in two. A genuinely new number is a new
 * customer record, or a deliberate merge — neither is a field edit.
 */

export const listCustomersSchema = listQuerySchema.extend({
  cityId: objectId.optional(),
});
export type ListCustomersInput = z.infer<typeof listCustomersSchema>;

export type CreateTerritoryInput = z.infer<typeof createTerritorySchema>;
export type UpdateTerritoryInput = z.infer<typeof updateTerritorySchema>;
export type CreateCityInput = z.infer<typeof createCitySchema>;
export type UpdateCityInput = z.infer<typeof updateCitySchema>;
export type CreateServiceCenterInput = z.infer<typeof createServiceCenterSchema>;
export type UpdateServiceCenterInput = z.infer<typeof updateServiceCenterSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateProductModelInput = z.infer<typeof createProductModelSchema>;
export type UpdateProductModelInput = z.infer<typeof updateProductModelSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
