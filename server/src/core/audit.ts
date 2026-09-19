/**
 * Audit recording (spec section 17).
 *
 * Two entry points, matching the two collections:
 *
 *  - `recordActivity` writes to a complaint's timeline — the chronological
 *    story shown on the complaint detail page.
 *  - `recordAudit` writes to the system-wide log: master-data edits, logins,
 *    Happy Code views.
 *
 * ## Failure behaviour, and why it differs between the two
 *
 * `recordActivity` **throws**. A timeline entry is part of the state change
 * that produced it: closing a complaint without recording who closed it is not
 * a partial success, it is a corrupted record. Passing the surrounding
 * transaction's session means the entry and the change commit together or not
 * at all.
 *
 * `recordAudit` **swallows** its errors and logs them. It records things that
 * happen around the edges — a failed login, a report export — where refusing
 * the whole operation because the log write failed would be the worse outcome.
 * A login that works but goes unlogged beats a login that cannot happen.
 */
import type { ClientSession } from 'mongoose';
import type { Request } from 'express';
import { logger } from '../config/logger.js';
import { AuditLog, ComplaintActivity } from '../models/index.js';
import type { ActivityAction, Role } from '../models/enums.js';
import type { AuthContext } from '../middleware/authenticate.js';

/** The acting user, as recorded on the entry. */
export interface Actor {
  userId: string;
  role: Role;
  /** Snapshotted so a later rename cannot rewrite who did the work. */
  name: string;
}

export function actorFrom(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

export interface ActivityInput {
  complaintId: string;
  action: ActivityAction;
  actor: Actor;
  visitId?: string;
  fieldChanged?: string;
  oldValue?: string;
  newValue?: string;
  note?: string;
}

/**
 * Appends an entry to a complaint's timeline.
 *
 * Always pass the ambient `session` when inside a transaction, so the entry
 * shares the fate of the change it describes.
 */
export async function recordActivity(
  input: ActivityInput,
  session?: ClientSession | null,
): Promise<void> {
  await ComplaintActivity.create(
    [
      {
        complaintId: input.complaintId,
        action: input.action,
        actorId: input.actor.userId,
        actorRole: input.actor.role,
        actorName: input.actor.name,
        ...(input.visitId ? { visitId: input.visitId } : {}),
        ...(input.fieldChanged ? { fieldChanged: input.fieldChanged } : {}),
        ...(input.oldValue !== undefined ? { oldValue: input.oldValue } : {}),
        ...(input.newValue !== undefined ? { newValue: input.newValue } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    ],
    session ? { session } : {},
  );
}

export interface AuditInput {
  entityType: string;
  entityId?: string;
  action: string;
  /** Absent for events with no authenticated user, such as a failed login. */
  actor?: Actor;
  changes?: Array<{ field: string; oldValue?: string; newValue?: string }>;
  note?: string;
  /** Request context, for tracing an action to its source. */
  request?: Pick<Request, 'ip' | 'headers'>;
}

/**
 * Writes a system-wide audit entry. Never throws — see the note above.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const userAgent = input.request?.headers['user-agent'];

    await AuditLog.create({
      entityType: input.entityType,
      ...(input.entityId ? { entityId: input.entityId } : {}),
      action: input.action,
      ...(input.actor
        ? {
            actorId: input.actor.userId,
            actorRole: input.actor.role,
            actorName: input.actor.name,
          }
        : {}),
      changes: input.changes ?? [],
      ...(input.note ? { note: input.note } : {}),
      ...(input.request?.ip ? { ipAddress: input.request.ip } : {}),
      ...(typeof userAgent === 'string' ? { userAgent: userAgent.slice(0, 400) } : {}),
    });
  } catch (err) {
    /* Losing an audit line is bad; failing the user's request because of it
       is worse. Log loudly so the gap is at least visible. */
    logger.error(
      { err, action: input.action, entityType: input.entityType },
      'failed to write audit log entry',
    );
  }
}
