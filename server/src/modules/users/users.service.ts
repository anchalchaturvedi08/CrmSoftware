/**
 * User and technician management (spec sections 3.1, 3.2, 9).
 *
 * ## Who may create whom
 *
 * Section 3.2 gives an Owner exactly one creation power: technicians for their
 * own centre. Admin creates everyone. A technician creates nobody. That table
 * is expressed once, in `CREATION_RIGHTS`, rather than as scattered `if`s —
 * so widening it later is a visible, deliberate edit.
 *
 * ## Deactivation is not deletion
 *
 * Rule 17 forbids hard deletion of operational records. Deactivating a
 * technician keeps every visit, timeline entry and part usage they ever
 * touched; it only stops them logging in and taking new work.
 *
 * Section 9 adds a requirement that is easy to miss: *"If technician is
 * deactivated with active jobs: existing jobs remain in history. Service
 * Center Owner must reassign active jobs."* So deactivation reports the open
 * jobs it has just stranded, rather than leaving the Owner to discover them.
 */
import { randomBytes } from 'node:crypto';
import mongoose, { type FilterQuery } from 'mongoose';
import { recordAudit, type Actor } from '../../core/audit.js';
import { hashPassword } from '../../core/password.js';
import { userScope, withScope } from '../../core/scope.js';
import { mobilePattern, searchPattern } from '../../core/search.js';
import { companyDayBounds } from '../../core/time.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  Complaint,
  ServiceCenter,
  User,
  Visit,
  type UserDoc,
} from '../../models/index.js';
import type { Role } from '../../models/enums.js';
import { OPEN_COMPLAINT } from '../complaints/complaint.service.js';
import type {
  CreateUserInput,
  ListUsersInput,
  ResetPasswordInput,
  UpdateUserInput,
} from './users.validation.js';

function actorFor(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

/**
 * Which roles each role may create (section 3).
 *
 * Allow-list only. A role absent from a list cannot be created by that caller,
 * which is what stops an Owner minting themselves a second Admin.
 */
const CREATION_RIGHTS: Record<Role, readonly Role[]> = {
  ADMIN: ['ADMIN', 'SERVICE_CENTER_OWNER', 'TECHNICIAN'],
  SERVICE_CENTER_OWNER: ['TECHNICIAN'],
  TECHNICIAN: [],
};

/**
 * A readable, high-entropy temporary password.
 *
 * base64url over 15 bytes is ~120 bits and has no characters that a person
 * reading it down a phone line will confuse or a shell will mangle.
 */
function generateTemporaryPassword(): string {
  return randomBytes(15).toString('base64url');
}

/** What a caller is allowed to see of a user. Never includes the hash. */
export interface PublicUser {
  id: string;
  role: Role;
  name: string;
  mobile: string;
  email?: string;
  serviceCenterId?: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
}

function present(user: UserDoc): PublicUser {
  return {
    id: String(user._id),
    role: user.role,
    name: user.name,
    mobile: user.mobile,
    ...(user.email ? { email: user.email } : {}),
    ...(user.serviceCenterId ? { serviceCenterId: String(user.serviceCenterId) } : {}),
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
    createdAt: user.createdAt,
  };
}

export interface CreatedUser {
  user: PublicUser;
  /** Returned **once**. Only a scrypt hash is stored, so it cannot be re-read. */
  temporaryPassword: string;
}

export async function createUser(
  input: CreateUserInput,
  auth: AuthContext,
): Promise<CreatedUser> {
  const allowed = CREATION_RIGHTS[auth.role];
  if (!allowed.includes(input.role)) {
    throw forbidden(
      allowed.length === 0
        ? 'You cannot create user accounts'
        : `You can only create: ${allowed.join(', ')}`,
    );
  }

  /* Which centre the new account belongs to. */
  let serviceCenterId: string | undefined;

  if (input.role === 'ADMIN') {
    if (input.serviceCenterId) {
      throw badRequest('An Admin is global and has no service center', [
        { field: 'serviceCenterId', message: 'Not applicable for Admin' },
      ]);
    }
  } else if (auth.role === 'SERVICE_CENTER_OWNER') {
    /* An Owner's technicians are always their own — the request cannot say
       otherwise, so there is nothing to spoof. */
    if (!auth.serviceCenterId) {
      throw forbidden('This account is not attached to a service center');
    }
    if (input.serviceCenterId && input.serviceCenterId !== auth.serviceCenterId) {
      throw forbidden('You can only create technicians for your own service center');
    }
    serviceCenterId = auth.serviceCenterId;
  } else {
    if (!input.serviceCenterId) {
      throw badRequest('A service center is required for this role', [
        { field: 'serviceCenterId', message: 'Required' },
      ]);
    }

    const centre = await ServiceCenter.findById(input.serviceCenterId).lean().exec();
    if (!centre) throw notFound('That service center does not exist');
    if (!centre.isActive) {
      throw badRequest(`${centre.name} is deactivated and cannot take new staff`);
    }

    serviceCenterId = input.serviceCenterId;
  }

  /* Mobile is the login identifier, so a clash is a real conflict rather than
     something to resolve silently. */
  const existing = await User.findOne({ mobile: input.mobile }).lean().exec();
  if (existing) {
    throw conflict('An account already exists with that mobile number');
  }

  const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();

  const user = await User.create({
    role: input.role,
    name: input.name,
    mobile: input.mobile,
    /* `null` (an empty field) means no email, as does leaving it out. */
    ...(input.email ? { email: input.email } : {}),
    passwordHash: await hashPassword(temporaryPassword),
    ...(serviceCenterId ? { serviceCenterId } : {}),
    /* DECISIONS.md 4.5: the first password is temporary by construction, so a
       password the creator knows cannot keep working indefinitely. */
    mustChangePassword: true,
    createdBy: auth.userId,
  });

  await recordAudit({
    entityType: 'User',
    entityId: String(user._id),
    action: 'USER_CREATED',
    actor: actorFor(auth),
    note: `${input.role} ${input.name} (${input.mobile})`,
  });

  return { user: present(user), temporaryPassword };
}

/** How much work a technician is carrying (section 9, "technician workload"). */
export interface Workload {
  /**
   * Complaints assigned to them that are not closed or cancelled — the
   * complaint list's `open=true`, so `?technicianId=…&open=true` lists these.
   */
  openJobs: number;
  /** Visits booked for them today (company timezone) and not yet started. */
  visitsToday: number;
}

export type UserListItem = PublicUser & { workload?: Workload };

export interface PagedUsers {
  items: UserListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Workload for the technicians on a page, in two grouped counts.
 *
 * Section 9 asks the Owner to "view technician workload" before assigning, and
 * a number beside each name is what makes the choice an informed one.
 */
async function workloadFor(users: UserDoc[], now: Date): Promise<Map<string, Workload>> {
  const ids = users.filter((user) => user.role === 'TECHNICIAN').map((user) => user._id);
  const result = new Map<string, Workload>();
  if (ids.length === 0) return result;

  /* The company's day, not the server's (core/time.ts). */
  const { start, end } = companyDayBounds(now);

  const [jobs, visits] = await Promise.all([
    Complaint.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { $and: [{ technicianId: { $in: ids } }, OPEN_COMPLAINT] } },
      { $group: { _id: '$technicianId', count: { $sum: 1 } } },
    ]).exec(),
    Visit.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      {
        $match: {
          technicianId: { $in: ids },
          status: 'SCHEDULED',
          scheduledAt: { $gte: start, $lt: end },
        },
      },
      { $group: { _id: '$technicianId', count: { $sum: 1 } } },
    ]).exec(),
  ]);

  for (const id of ids) result.set(String(id), { openJobs: 0, visitsToday: 0 });
  for (const row of jobs) result.get(String(row._id))!.openJobs = row.count;
  for (const row of visits) result.get(String(row._id))!.visitsToday = row.count;

  return result;
}

/**
 * Lists users within the caller's scope.
 *
 * `userScope` already limits an Owner to technicians at their own centre and a
 * technician to their own record, so nothing here needs to re-check it.
 *
 * `now` is a parameter so "visits today" can be tested at a fixed instant.
 */
export async function listUsers(
  input: ListUsersInput,
  auth: AuthContext,
  now: Date = new Date(),
): Promise<PagedUsers> {
  const filter: FilterQuery<UserDoc> = {};

  if (input.role) filter.role = input.role;
  if (input.serviceCenterId) filter.serviceCenterId = input.serviceCenterId;
  if (!input.includeInactive) filter.isActive = true;

  if (input.search) {
    /* A mobile typed the way the screens show it ("98765 43210", "+91 …")
       is reduced to digits before matching the stored ten (core/search.ts). */
    filter.$or = [{ name: searchPattern(input.search) }, { mobile: mobilePattern(input.search) }];
  }

  const scoped = withScope<UserDoc>(userScope(auth), filter);

  const [items, total] = await Promise.all([
    User.find(scoped)
      .sort({ name: 1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .exec(),
    User.countDocuments(scoped).exec(),
  ]);

  const workload = await workloadFor(items, now);

  return {
    items: items.map((user) => {
      const load = workload.get(String(user._id));
      return load ? { ...present(user), workload: load } : present(user);
    }),
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

export async function getUser(id: string, auth: AuthContext): Promise<PublicUser> {
  const user = await User.findOne(withScope<UserDoc>(userScope(auth), { _id: id })).exec();
  if (!user) throw notFound('User not found');
  return present(user);
}

/** A complaint still needing work, blocking a clean deactivation. */
export interface OpenJob {
  complaintId: string;
  complaintNumber: string;
  status: string;
}

export interface UpdatedUser {
  user: PublicUser;
  /**
   * Populated when a technician was just deactivated while holding open jobs.
   *
   * Section 9 requires the Owner to reassign them. Returning the list makes
   * that actionable instead of something to go looking for.
   */
  openJobsNeedingReassignment?: OpenJob[];
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  auth: AuthContext,
): Promise<UpdatedUser> {
  const user = await User.findOne(withScope<UserDoc>(userScope(auth), { _id: id })).exec();
  if (!user) throw notFound('User not found');

  /* Locking yourself out is almost never intended, and recovering needs
     another Admin — so it is refused rather than confirmed. */
  if (input.isActive === false && String(user._id) === auth.userId) {
    throw badRequest('You cannot deactivate your own account');
  }

  const changes: Array<{ field: string; oldValue?: string; newValue?: string }> = [];
  const wasActive = user.isActive;

  if (input.name !== undefined && input.name !== user.name) {
    changes.push({ field: 'name', oldValue: user.name, newValue: input.name });
    user.name = input.name;
  }

  /**
   * Email is optional, so it can be removed as well as changed: `null` (an
   * emptied field) unsets it. Compared in lower case, as it is stored, so
   * retyping the same address in capitals is not recorded as a change.
   */
  if (input.email !== undefined) {
    const next = input.email === null ? undefined : input.email.toLowerCase();
    if (next !== user.email) {
      changes.push({
        field: 'email',
        ...(user.email ? { oldValue: user.email } : {}),
        ...(next ? { newValue: next } : {}),
      });
      user.email = next;
    }
  }

  if (input.isActive !== undefined && input.isActive !== user.isActive) {
    changes.push({
      field: 'isActive',
      oldValue: String(user.isActive),
      newValue: String(input.isActive),
    });
    user.isActive = input.isActive;
  }

  if (changes.length === 0) return { user: present(user) };

  await user.save();

  await recordAudit({
    entityType: 'User',
    entityId: String(user._id),
    action: input.isActive === false ? 'USER_DEACTIVATED' : 'USER_UPDATED',
    actor: actorFor(auth),
    changes,
  });

  /* Section 9's reassignment requirement. */
  if (wasActive && user.isActive === false && user.role === 'TECHNICIAN') {
    const openJobs = await Complaint.find({ $and: [{ technicianId: user._id }, OPEN_COMPLAINT] })
      .select('complaintNumber status')
      .lean()
      .exec();

    if (openJobs.length > 0) {
      return {
        user: present(user),
        openJobsNeedingReassignment: openJobs.map((job) => ({
          complaintId: String(job._id),
          complaintNumber: job.complaintNumber,
          status: job.status,
        })),
      };
    }
  }

  return { user: present(user) };
}

/**
 * Issues a fresh temporary password for someone who cannot get in.
 *
 * `passwordChangedAt` is stamped, which revokes every token already issued to
 * them — otherwise a session opened by whoever had the old password would
 * survive the reset.
 */
export async function resetPassword(
  id: string,
  input: ResetPasswordInput,
  auth: AuthContext,
): Promise<{ user: PublicUser; temporaryPassword: string }> {
  const user = await User.findOne(withScope<UserDoc>(userScope(auth), { _id: id })).exec();
  if (!user) throw notFound('User not found');

  if (String(user._id) === auth.userId) {
    throw badRequest('Use change-password to set your own password');
  }

  const temporaryPassword = input.temporaryPassword ?? generateTemporaryPassword();

  user.passwordHash = await hashPassword(temporaryPassword);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = true;
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;

  await user.save();

  await recordAudit({
    entityType: 'User',
    entityId: String(user._id),
    action: 'PASSWORD_RESET',
    actor: actorFor(auth),
    note: `Temporary password issued for ${user.name}. Existing sessions revoked.`,
  });

  return { user: present(user), temporaryPassword };
}
