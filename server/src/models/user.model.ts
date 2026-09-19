/**
 * User — Admin, Service Center Owner and Technician in one collection.
 *
 * The spec's entity list names "Admin User" and "Technician" separately, but
 * all three roles authenticate identically with Mobile + Password (sections
 * 3.2, 3.3, and DECISIONS.md section 1 for Admin). Splitting them across
 * collections would mean three login paths, three places to get password
 * hashing right, and no single index guaranteeing a mobile number identifies
 * one person. One collection with a role discriminator avoids all of that.
 *
 * Scope lives here too: `serviceCenterId` is what section 3.2 ("scoped only to
 * their service center") and section 3.3 ("only assigned jobs") are enforced
 * against in the query layer.
 */
import { Schema, type Types } from 'mongoose';
import {
  activeFlagField,
  baseSchemaOptions,
  defineModel,
  mobileField,
  requiredName,
} from './common/base.js';
import { ROLES, type Role } from './enums.js';

export interface UserDoc {
  _id: Types.ObjectId;
  role: Role;
  name: string;
  mobile: string;
  /** scrypt hash. Never selected by default — see the schema note below. */
  passwordHash: string;
  email?: string;

  /**
   * Owning service center. Required for Owner and Technician, forbidden for
   * Admin, who is global. Enforced in the pre-validate hook below.
   */
  serviceCenterId?: Types.ObjectId;

  /**
   * Set when an Owner creates a technician with a temporary password, which
   * resolves the spec's silence on who sets the first one (DECISIONS.md
   * section 4.5). The auth layer refuses everything except the
   * change-password route while this is true.
   */
  mustChangePassword: boolean;

  isActive: boolean;
  lastLoginAt?: Date;

  /**
   * When the password last changed.
   *
   * Tokens issued before this instant are refused, which is how a password
   * change revokes sessions that are already out there. Comparing a token's
   * `iat` against this gives revocation without storing every refresh token —
   * and without it, changing a compromised password would leave the attacker's
   * existing refresh token valid for its full 30 days.
   */
  passwordChangedAt?: Date;

  /**
   * Brute-force protection. A ten-digit mobile number and a human-chosen
   * password are a guessable pair, and section 19 requires the backend to be
   * the real gate, so throttling lives on the record itself rather than only
   * in per-IP middleware an attacker can rotate around.
   */
  failedLoginAttempts: number;
  lockedUntil?: Date;

  /** Who created this account — Admin for owners, Owner for technicians. */
  createdBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    role: { type: String, required: true, enum: ROLES, index: true },
    name: requiredName(160),
    mobile: mobileField,

    /**
     * `select: false` means every query omits the hash unless it explicitly
     * asks for it. Only the login and change-password paths ever should — so
     * an accidental `User.find()` in a report or a response body cannot leak
     * password material.
     */
    passwordHash: { type: String, required: true, select: false },

    email: {
      type: String,
      required: false,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email address is not valid'],
    },

    serviceCenterId: {
      type: Schema.Types.ObjectId,
      ref: 'ServiceCenter',
      required: false,
      /* A new owner or technician may not be attached to a deactivated
         center. Existing rows are untouched — section 22 keeps history. */
      refActive: true,
    },

    mustChangePassword: { type: Boolean, required: true, default: false },
    ...activeFlagField,
    lastLoginAt: { type: Date, required: false },
    passwordChangedAt: { type: Date, required: false },
    failedLoginAttempts: { type: Number, required: true, default: 0, min: 0 },
    lockedUntil: { type: Date, required: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  baseSchemaOptions,
);

/**
 * Mobile is the login identifier, so it must identify exactly one account
 * across every role — an Owner and a Technician cannot share a number.
 */
userSchema.index({ mobile: 1 }, { unique: true });

/* Owner dashboards list their own technicians and their workload. */
userSchema.index({ serviceCenterId: 1, role: 1, isActive: 1 });

/**
 * Enforces the Admin/scoped-role split.
 *
 * A scoped user without a centre would see nothing; an Admin *with* one would
 * suggest a scope that the permission layer does not actually apply. Both are
 * bugs worth refusing at write time.
 */
userSchema.pre('validate', function enforceScopeForRole() {
  if (this.role === 'ADMIN') {
    if (this.serviceCenterId) {
      this.invalidate(
        'serviceCenterId',
        'Admin is global and must not be attached to a service center',
      );
    }
    return;
  }

  if (!this.serviceCenterId) {
    this.invalidate(
      'serviceCenterId',
      `${this.role} must belong to a service center`,
    );
  }
});

export const User = defineModel<UserDoc>('User', userSchema);
