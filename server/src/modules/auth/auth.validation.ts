/**
 * Request schemas for the auth module.
 *
 * Section 19 requires all input validated server-side. Validation lives beside
 * the module rather than in the controller so the same schema can be reused by
 * tests and, later, by any internal caller.
 */
import { z } from 'zod';
import { normalizeMobile } from '../../models/common/base.js';

/**
 * Minimum password policy.
 *
 * Deliberately length-led rather than a composition rule. Mandatory symbol
 * classes push people toward `Password1!` and its variants; length is the
 * property that actually resists guessing. Twelve characters is a reasonable
 * floor for staff accounts that grant access to customer records.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * The rule for any password being *set*. Exported so the seed script applies
 * exactly this rule to an Admin password supplied on the command line, rather
 * than a copy of it that could drift.
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(256, 'Password must be at most 256 characters');

/**
 * Mobile numbers are normalized before validation, so a user typing
 * `+91 98765 43210` is not rejected for punctuation the system can strip
 * itself.
 */
const mobile = z
  .string()
  .min(1, 'Mobile number is required')
  .transform(normalizeMobile)
  .refine((value) => /^[6-9]\d{9}$/.test(value), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

export const loginSchema = z.object({
  mobile,
  /* Not the `password` schema above: rejecting a short password at *login*
     with a policy message would tell an attacker the policy, and would also
     lock out an account whose password predates a policy change. Any
     non-empty string is accepted and then simply fails to verify. */
  password: z.string().min(1, 'Password is required').max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/** Sign-out names the session to end by its refresh token — see `postLogout`. */
export const logoutSchema = refreshSchema;
export type LogoutInput = z.infer<typeof logoutSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(256),
    newPassword: newPasswordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current one',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
