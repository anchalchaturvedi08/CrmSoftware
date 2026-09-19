/**
 * Query scoping.
 *
 * Spec section 19: "Restrict complaint queries by service_center_id /
 * technician_id." Section 3.2 scopes an Owner to their own centre; section 3.3
 * scopes a Technician to their own jobs.
 *
 * Every scoped query in the application goes through this file. That is the
 * whole point — scoping written inline at each call site is scoping that gets
 * forgotten at one of them, and the one that is forgotten is a data leak
 * across service centers rather than a visible bug.
 *
 * ## Why `$and` and not a spread
 *
 * Combining a scope with a caller's filter by spreading is unsafe:
 *
 *     { ...scope, ...callerFilter }   // callerFilter can overwrite the scope
 *
 * If the caller supplies `serviceCenterId`, the later spread wins and the
 * scope evaporates — a request parameter would decide which centre's data
 * comes back. `$and` cannot be overridden by a duplicate key, so
 * `withScope` is the only sanctioned way to merge the two.
 */
import type { FilterQuery } from 'mongoose';
import mongoose from 'mongoose';
import { forbidden } from '../http/errors.js';
import type { AuthContext } from '../middleware/authenticate.js';

/** An empty scope means unrestricted, which is Admin only. */
type Scope = Record<string, unknown>;

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

/**
 * Combines a scope with a caller-supplied filter so the scope always wins.
 */
export function withScope<T>(
  scope: Scope,
  filter: FilterQuery<T> = {},
): FilterQuery<T> {
  const hasScope = Object.keys(scope).length > 0;
  const hasFilter = Object.keys(filter).length > 0;

  if (!hasScope) return filter;
  if (!hasFilter) return scope as FilterQuery<T>;

  return { $and: [scope, filter] } as FilterQuery<T>;
}

/**
 * Scope for complaints.
 *
 * A Technician is scoped by *current* assignment, which is what section 3.3
 * says ("see only assigned jobs"). One consequence worth knowing: reassigning
 * a job removes the previous technician's access to that complaint. Their own
 * work is not lost — it stays on the `Visit` records, which `visitScope`
 * keeps visible to them, and on the timeline for the Owner and Admin.
 */
export function complaintScope(auth: AuthContext): Scope {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return { serviceCenterId: toObjectId(requireCenter(auth)) };
    case 'TECHNICIAN':
      return { technicianId: toObjectId(auth.userId) };
    default:
      /* An unhandled role must deny, not permit. */
      throw forbidden('You do not have permission to do that');
  }
}

/**
 * Scope for visits.
 *
 * Technicians are scoped to visits they were assigned, which is what gives
 * them the "Completed history" screen in section 10 even for a complaint
 * later reassigned to someone else.
 */
export function visitScope(auth: AuthContext): Scope {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return { serviceCenterId: toObjectId(requireCenter(auth)) };
    case 'TECHNICIAN':
      return { technicianId: toObjectId(auth.userId) };
    default:
      throw forbidden('You do not have permission to do that');
  }
}

/**
 * Scope for attachments (section 19: "Restrict attachment access").
 *
 * A technician sees only what they uploaded. Photos from another technician's
 * visit to the same complaint are not theirs to browse.
 */
export function attachmentScope(auth: AuthContext): Scope {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return { serviceCenterId: toObjectId(requireCenter(auth)) };
    case 'TECHNICIAN':
      return { uploadedBy: toObjectId(auth.userId) };
    default:
      throw forbidden('You do not have permission to do that');
  }
}

/** Scope for part requests. A technician sees the ones they raised. */
export function partRequestScope(auth: AuthContext): Scope {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return { serviceCenterId: toObjectId(requireCenter(auth)) };
    case 'TECHNICIAN':
      return { requestedBy: toObjectId(auth.userId) };
    default:
      throw forbidden('You do not have permission to do that');
  }
}

/** Scope for recorded part usage. */
export function partUsageScope(auth: AuthContext): Scope {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return { serviceCenterId: toObjectId(requireCenter(auth)) };
    case 'TECHNICIAN':
      return { recordedBy: toObjectId(auth.userId) };
    default:
      throw forbidden('You do not have permission to do that');
  }
}

/**
 * Scope for stock.
 *
 * Stock is per centre (section 11) and is the Owner's to manage. A technician
 * requests parts rather than reading inventory, so they get no scope here —
 * `null` means the caller has no business with this collection at all, which
 * is different from an empty scope meaning "everything".
 */
export function partStockScope(auth: AuthContext): Scope | null {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return { serviceCenterId: toObjectId(requireCenter(auth)) };
    case 'TECHNICIAN':
      return null;
    default:
      return null;
  }
}

/**
 * Scope for user records.
 *
 * An Owner manages technicians for their own centre (section 3.2) and must not
 * see or edit another centre's staff, or any Admin. A Technician can reach
 * only their own record.
 */
export function userScope(auth: AuthContext): Scope {
  switch (auth.role) {
    case 'ADMIN':
      return {};
    case 'SERVICE_CENTER_OWNER':
      return {
        serviceCenterId: toObjectId(requireCenter(auth)),
        role: 'TECHNICIAN',
      };
    case 'TECHNICIAN':
      return { _id: toObjectId(auth.userId) };
    default:
      throw forbidden('You do not have permission to do that');
  }
}

/**
 * Fails closed when a scoped role has no centre.
 *
 * The `User` model enforces this at write time, so reaching here without one
 * is a data inconsistency. Returning `{}` would quietly promote that
 * inconsistency into Admin-level visibility.
 */
function requireCenter(auth: AuthContext): string {
  if (!auth.serviceCenterId) {
    throw forbidden('This account is not attached to a service center');
  }
  return auth.serviceCenterId;
}
