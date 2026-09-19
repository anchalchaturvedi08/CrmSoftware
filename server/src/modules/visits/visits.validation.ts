/**
 * Request schemas for the visits module (spec sections 9, 10).
 */
import { z } from 'zod';
import { companyDate, parseDateKey, type CalendarDate } from '../../core/time.js';
import { VISIT_STATUSES } from '../../models/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

/**
 * A calendar day in the company timezone: `2026-09-17`, or any instant, which
 * means the company day it falls on.
 *
 * Coercing `2026-09-17` to a `Date` gives UTC midnight, which is 05:30 in
 * India; a day built from that and the server's own midnight was whichever
 * day the server's timezone said, not the one asked for.
 */
const calendarDay = z
  .string()
  .trim()
  .transform((value, ctx): CalendarDate => {
    const date = parseDateKey(value);
    if (date) return date;

    const instant = new Date(value);
    if (/\d/.test(value) && !Number.isNaN(instant.getTime())) return companyDate(instant);

    ctx.addIssue({ code: 'custom', message: 'Use a date like 2026-09-17' });
    return z.NEVER;
  });

export const listVisitsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /* One status, or several separated by commas — `COMPLETED,CANCELLED` is
     "visits that are over", which the schedule's history view asks for. */
  status: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(VISIT_STATUSES)).min(1))
    .optional(),
  /* One complaint's visits, for the technician's job screen. Still scoped by
     role, so a technician only ever gets their own. */
  complaintId: objectId.optional(),
  technicianId: objectId.optional(),
  serviceCenterId: objectId.optional(),
  /** A single company-timezone day, for a calendar view. Takes precedence over from/to. */
  date: calendarDay.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /* Ascending by default: a schedule is read forwards. */
  sort: z.enum(['asc', 'desc']).default('asc'),
  /* A schedule is ordered by when visits are booked; history by when they
     finished, which can differ by days. */
  orderBy: z.enum(['scheduledAt', 'completedAt']).default('scheduledAt'),
});

export const rescheduleVisitSchema = z.object({
  scheduledAt: z.coerce.date(),
  reason: z.string().trim().min(3, 'Please give a reason').max(1000).optional(),
});

export const cancelVisitSchema = z.object({
  reason: z.string().trim().min(3, 'Please give a reason').max(1000),
});

export type ListVisitsInput = z.infer<typeof listVisitsSchema>;
export type RescheduleVisitInput = z.infer<typeof rescheduleVisitSchema>;
export type CancelVisitInput = z.infer<typeof cancelVisitSchema>;
