/**
 * Request schemas for user management (spec sections 3.1, 3.2).
 */
import { z } from 'zod';
import { normalizeMobile } from '../../models/common/base.js';
import { ROLES } from '../../models/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

const mobile = z
  .string()
  .min(1, 'Mobile number is required')
  .transform(normalizeMobile)
  .refine((v) => /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

/**
 * An optional email that can also be *cleared*.
 *
 * An emptied field arrives as `""` (or `null`) and means "remove it", which is
 * why it becomes `null` here rather than being dropped: a form that left the
 * field out when empty used to report "updated" while the old address stayed.
 * A non-empty value must still be a real address.
 */
const clearableEmail = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim() || null : value),
    z.email('Email address is not valid').nullable(),
  )
  .optional();

export const createUserSchema = z.object({
  role: z.enum(ROLES),
  name: z.string().trim().min(1, 'Name is required').max(160),
  mobile,
  /* Empty means none, the same as leaving it out. */
  email: clearableEmail,

  /**
   * Required for Owner and Technician, forbidden for Admin — enforced in the
   * service, where the caller's own role is also known. An Owner never sends
   * this: their own centre is used.
   */
  serviceCenterId: objectId.optional(),

  /**
   * Optional. When omitted the server generates one and returns it once.
   *
   * Generating is the better path: it avoids an Owner choosing something
   * weak, and it is returned exactly once so there is no temptation to store
   * it anywhere. Either way `mustChangePassword` is set, so it works for a
   * single login (DECISIONS.md section 4.5).
   */
  temporaryPassword: z
    .string()
    .min(12, 'Temporary password must be at least 12 characters')
    .max(256)
    .optional(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160).optional(),
  /* Absent leaves it as it is; `""` or `null` removes it. */
  email: clearableEmail,
  /* Section 17: deactivation, never deletion. */
  isActive: z.boolean().optional(),
});

export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  role: z.enum(ROLES).optional(),
  serviceCenterId: objectId.optional(),
  /* `stringbool`: `coerce.boolean` reads "false" as true. */
  includeInactive: z.stringbool().default(false),
  search: z.string().trim().max(120).optional(),
});

/**
 * Resetting someone else's password.
 *
 * Deliberately has no "current password" field — the point is that the person
 * cannot get in. It issues a fresh temporary password and forces a change on
 * next login, and every use is audited.
 */
export const resetPasswordSchema = z.object({
  temporaryPassword: z.string().min(12).max(256).optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersInput = z.infer<typeof listUsersSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
