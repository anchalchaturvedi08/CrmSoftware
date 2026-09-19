/**
 * SLA rule routes (spec section 14).
 *
 * Section 14 closes with "SLA should be configurable, not hard-coded", and
 * section 19 repeats it. The engine already reads these from the database;
 * this is what lets Admin change them without a re-seed.
 *
 * **Editing a rule affects only complaints created afterwards.** Each
 * complaint computes and stores its own due dates at creation, so tightening
 * the policy cannot retroactively breach work that was delivered on time under
 * the old one. An SLA report that rewrites its own history is worthless.
 */
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../../core/audit.js';
import { notFound } from '../../http/errors.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';
import { adminOnly, requirePasswordChanged } from '../../middleware/authorize.js';
import { PRIORITIES } from '../../models/enums.js';
import { SlaRule } from '../../models/index.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * Windows are accepted in **hours**, which is how section 14 writes them and
 * how anyone configuring this thinks about them. They are stored in minutes,
 * so a stricter target later ("respond within 30 minutes") is a data change
 * rather than a schema migration. Fractions are allowed for that reason.
 */
const updateSlaSchema = z
  .object({
    responseHours: z.coerce.number().positive().max(720).optional(),
    resolutionHours: z.coerce.number().positive().max(2160).optional(),
    pauseOnWaitingParts: z.boolean().optional(),
    pauseOnRevisitRequired: z.boolean().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine(
    (data) =>
      data.responseHours !== undefined ||
      data.resolutionHours !== undefined ||
      data.pauseOnWaitingParts !== undefined ||
      data.pauseOnRevisitRequired !== undefined ||
      data.notes !== undefined,
    { message: 'Nothing to change' },
  );

const toHours = (minutes: number): number => Number((minutes / 60).toFixed(2));

const getRules = handler(async (req, res) => {
  requireAuth(req);

  const rules = await SlaRule.find().lean().exec();

  /* Ordered by severity rather than alphabetically, so the table reads the way
     section 14 presents it. */
  const ordered = PRIORITIES.map((priority) =>
    rules.find((rule) => rule.priority === priority),
  ).filter((rule): rule is NonNullable<typeof rule> => Boolean(rule));

  res.status(200).json({
    items: ordered.map((rule) => ({
      id: String(rule._id),
      priority: rule.priority,
      responseHours: toHours(rule.responseMinutes),
      resolutionHours: toHours(rule.resolutionMinutes),
      responseMinutes: rule.responseMinutes,
      resolutionMinutes: rule.resolutionMinutes,
      pauseOnWaitingParts: rule.pauseOnWaitingParts,
      pauseOnRevisitRequired: rule.pauseOnRevisitRequired,
      ...(rule.notes ? { notes: rule.notes } : {}),
      updatedAt: rule.updatedAt,
    })),
    /* Pause switches are read when a complaint goes on hold or is sent back,
       so they reach open complaints too; the time limits do not (pre-launch
       review found the old wording promised both). */
    note:
      'New time limits apply to complaints created afterwards, and to a complaint when it is reopened. ' +
      'Pause settings apply from the next time any open complaint goes on hold or is sent back.',
  });
});

const patchRule = handler(async (req, res) => {
  const auth = requireAuth(req);
  const priority = String(req.params['priority']).toUpperCase();

  const parsed = PRIORITIES.find((p) => p === priority);
  if (!parsed) throw notFound(`No SLA rule for priority '${priority}'`);

  const input = updateSlaSchema.parse(req.body);

  const rule = await SlaRule.findOne({ priority: parsed }).exec();
  if (!rule) throw notFound(`No SLA rule is configured for ${parsed}`);

  const changes: Array<{ field: string; oldValue?: string; newValue?: string }> = [];

  if (input.responseHours !== undefined) {
    const minutes = Math.round(input.responseHours * 60);
    if (minutes !== rule.responseMinutes) {
      changes.push({
        field: 'responseMinutes',
        oldValue: String(rule.responseMinutes),
        newValue: String(minutes),
      });
      rule.responseMinutes = minutes;
    }
  }

  if (input.resolutionHours !== undefined) {
    const minutes = Math.round(input.resolutionHours * 60);
    if (minutes !== rule.resolutionMinutes) {
      changes.push({
        field: 'resolutionMinutes',
        oldValue: String(rule.resolutionMinutes),
        newValue: String(minutes),
      });
      rule.resolutionMinutes = minutes;
    }
  }

  for (const flag of ['pauseOnWaitingParts', 'pauseOnRevisitRequired'] as const) {
    const value = input[flag];
    if (value === undefined || value === rule[flag]) continue;
    changes.push({ field: flag, oldValue: String(rule[flag]), newValue: String(value) });
    rule[flag] = value;
  }

  if (input.notes !== undefined && input.notes !== rule.notes) {
    changes.push({ field: 'notes', oldValue: rule.notes, newValue: input.notes });
    rule.notes = input.notes;
  }

  if (changes.length > 0) {
    rule.updatedBy = auth.userId as unknown as typeof rule.updatedBy;
    /* The model refuses a resolution window shorter than its response window,
       which would mean a complaint is late to resolve before it is late to
       answer. */
    await rule.save();

    await recordAudit({
      entityType: 'SlaRule',
      entityId: String(rule._id),
      action: 'SLA_RULE_UPDATED',
      actor: { userId: auth.userId, role: auth.role, name: auth.name },
      changes,
      note: `${parsed} priority`,
    });
  }

  res.status(200).json({
    rule: {
      id: String(rule._id),
      priority: rule.priority,
      responseHours: toHours(rule.responseMinutes),
      resolutionHours: toHours(rule.resolutionMinutes),
      pauseOnWaitingParts: rule.pauseOnWaitingParts,
      pauseOnRevisitRequired: rule.pauseOnRevisitRequired,
    },
    changed: changes.length > 0,
    note:
      'New time limits apply to complaints created from now on. ' +
      'Pause settings apply from the next time any open complaint goes on hold or is sent back.',
  });
});

export const slaRouter = Router();

slaRouter.use(authenticate, requirePasswordChanged);

/* Readable by everyone: a complaint list shows SLA status, so the portals need
   to know what the targets are. */
slaRouter.get('/', getRules);
slaRouter.patch('/:priority', adminOnly, patchRule);
