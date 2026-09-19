/**
 * Request schemas for reading the audit trail (spec section 17).
 */
import { z } from 'zod';
import { ACTIVITY_ACTIONS } from '../../models/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

export const listTimelineSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  /**
   * Generous by default.
   *
   * A timeline is read whole, and a reopened complaint accumulates dozens of
   * entries — paging through five at a time would make the story unreadable.
   * Still capped, because a complaint reopened many times has no natural
   * ceiling.
   */
  limit: z.coerce.number().int().min(1).max(500).default(200),
  action: z.enum(ACTIVITY_ACTIONS).optional(),
});

/**
 * Groups of system-log entries, as the Admin screen offers them.
 *
 * Kept on the server so the grouping is one decision, not a list of action
 * names every client must copy — and so a new action lands in its group
 * without a client release.
 */
export const AUDIT_CATEGORIES = ['sign-in', 'people', 'records', 'parts', 'happy-code', 'settings'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const listAuditSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: objectId.optional(),
  /** Naming an action is also how session renewals are asked for. */
  action: z.string().trim().max(80).optional(),
  actorId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Complaint activity across every complaint (Admin's audit log). */
export const listActivitySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /* One action or several, comma-separated — the screen filters by groups
     such as "visits" that span a few actions. */
  action: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(ACTIVITY_ACTIONS)).min(1))
    .optional(),
  actorId: objectId.optional(),
  /** As people type it: any case, surrounding spaces ignored. */
  complaintNumber: z.string().trim().toUpperCase().max(20).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type ListTimelineInput = z.infer<typeof listTimelineSchema>;
export type ListAuditInput = z.infer<typeof listAuditSchema>;
export type ListActivityInput = z.infer<typeof listActivitySchema>;
