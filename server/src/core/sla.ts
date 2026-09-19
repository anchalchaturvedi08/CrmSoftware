/**
 * SLA computation (spec section 14).
 *
 * Section 14 sets out the shape: the clock starts at complaint creation, the
 * resolution clock ends at final Admin closure, windows are configurable, and
 * `WAITING_FOR_PARTS` / `REVISIT_REQUIRED` *may* pause it "if this behavior is
 * enabled in configuration".
 *
 * ## Due dates are frozen at creation
 *
 * A complaint stores its own `responseDueAt` and `resolutionDueAt` rather than
 * recomputing them from the current rule. Tightening the policy next month
 * must not retroactively breach work that was delivered on time under the old
 * one — an SLA report that changes its own history is worthless.
 *
 * ## Paused time is accumulated, not subtracted from a countdown
 *
 * `pausedTotalMs` accumulates and is added back when computing remaining time.
 * Storing a decremented countdown instead would mean a restart, a clock change
 * or a missed tick silently corrupts it.
 *
 * Pausing ships **disabled** (DECISIONS.md section 5, item 4): a paused clock
 * makes breach figures look better without any service actually improving, so
 * enabling it should be a deliberate choice.
 */
import type { Priority, SlaState } from '../models/enums.js';
import type { SlaTracking } from '../models/index.js';
import { Complaint, SlaRule, type SlaRuleDoc } from '../models/index.js';
import { AppError } from '../http/errors.js';

const MINUTE_MS = 60_000;

/** Loads the rule for a priority, or explains that seeding has not run. */
export async function ruleFor(priority: Priority): Promise<SlaRuleDoc> {
  const rule = await SlaRule.findOne({ priority }).lean().exec();

  if (!rule) {
    /* Section 14 makes these data, not constants, so a missing rule is a
       setup problem rather than something to silently default around —
       inventing a window here would produce SLA figures nobody configured. */
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      `No SLA rule is configured for ${priority} priority. ` +
      'Run `npm run seed --workspace server` to load the defaults.',
    );
  }

  return rule;
}

/** Builds the initial SLA block for a new complaint. */
export function startTracking(rule: SlaRuleDoc, createdAt: Date): SlaTracking {
  return {
    responseDueAt: new Date(createdAt.getTime() + rule.responseMinutes * MINUTE_MS),
    resolutionDueAt: new Date(
      createdAt.getTime() + rule.resolutionMinutes * MINUTE_MS,
    ),
    state: 'RUNNING',
    pausedTotalMs: 0,
  };
}

/**
 * Whether the clock should pause in a given status.
 *
 * Read per complaint from its rule, falling back to the environment defaults,
 * so the behaviour stays configurable as section 14 requires.
 */
export function shouldPause(
  rule: Pick<SlaRuleDoc, 'pauseOnWaitingParts' | 'pauseOnRevisitRequired'>,
  status: string,
): boolean {
  if (status === 'WAITING_FOR_PARTS') return rule.pauseOnWaitingParts;
  if (status === 'REVISIT_REQUIRED') return rule.pauseOnRevisitRequired;
  return false;
}

/** Marks the clock paused, if it is not already. */
export function pause(sla: SlaTracking, at: Date = new Date()): SlaTracking {
  if (sla.state !== 'RUNNING') return sla;
  return { ...sla, state: 'PAUSED', pausedAt: at };
}

/**
 * Resumes a paused clock, banking the time spent paused.
 */
export function resume(sla: SlaTracking, at: Date = new Date()): SlaTracking {
  if (sla.state !== 'PAUSED' || !sla.pausedAt) return sla;

  const bankedMs = Math.max(0, at.getTime() - sla.pausedAt.getTime());
  const { pausedAt: _discarded, ...rest } = sla;

  return {
    ...rest,
    state: 'RUNNING',
    pausedTotalMs: sla.pausedTotalMs + bankedMs,
  };
}

/** Records the first response, which stops the response clock. */
export function markResponded(sla: SlaTracking, at: Date = new Date()): SlaTracking {
  if (sla.respondedAt) return sla;
  return { ...sla, respondedAt: at };
}

/** Completes the resolution clock at final closure (section 14). */
export function complete(sla: SlaTracking, at: Date = new Date()): SlaTracking {
  /* The breach is checked here too, not left to whether anyone happened to
     open the complaint after its deadline — otherwise a late closure would be
     recorded as on time. */
  const settled = applyBreach(sla.state === 'PAUSED' ? resume(sla, at) : sla, at);

  return {
    ...settled,
    state: 'COMPLETED',
    completedAt: at,
    /* A complaint closed after its deadline stays breached. Closing does not
       erase the fact that it ran late. */
    ...(settled.breachedAt ? { breachedAt: settled.breachedAt } : {}),
  };
}

/** A read-only view of where a complaint stands against its SLA. */
export interface SlaSnapshot {
  state: SlaState;
  responseDueAt: Date;
  resolutionDueAt: Date;
  /** Milliseconds left; negative once overdue. Null while paused or done. */
  resolutionRemainingMs: number | null;
  responseRemainingMs: number | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
}

/**
 * Evaluates a complaint's SLA position.
 *
 * Paused time is added to the deadline rather than deducted from what is left,
 * which keeps the arithmetic a single subtraction against stored stamps.
 */
export function snapshot(sla: SlaTracking, now: Date = new Date()): SlaSnapshot {
  /* While paused, the clock stands still at the moment it stopped. */
  const effectiveNow =
    sla.state === 'PAUSED' && sla.pausedAt ? sla.pausedAt : now;

  const reference = sla.completedAt ?? effectiveNow;
  const allowancePausedMs = sla.pausedTotalMs;

  const resolutionDeadline = sla.resolutionDueAt.getTime() + allowancePausedMs;
  const responseDeadline = sla.responseDueAt.getTime() + allowancePausedMs;

  const responseAt = sla.respondedAt?.getTime() ?? reference.getTime();

  const responseRemaining = responseDeadline - responseAt;
  const resolutionRemaining = resolutionDeadline - reference.getTime();

  /* A breached complaint is still open and still running late; "how late" is
     the figure that matters most, so it is not blanked. */
  const inFlight = sla.state === 'RUNNING' || sla.state === 'BREACHED';

  return {
    state: sla.state,
    responseDueAt: new Date(responseDeadline),
    resolutionDueAt: new Date(resolutionDeadline),
    responseRemainingMs: inFlight || sla.respondedAt ? responseRemaining : null,
    resolutionRemainingMs: inFlight ? resolutionRemaining : null,
    responseBreached: responseRemaining < 0,
    resolutionBreached: resolutionRemaining < 0,
  };
}

/**
 * Returns the tracking block with `BREACHED` applied if the deadline has
 * passed. Called when a complaint is read or swept, so breach state is derived
 * from stamps rather than depending on a background job having run.
 */
export function applyBreach(sla: SlaTracking, now: Date = new Date()): SlaTracking {
  if (sla.state !== 'RUNNING' || sla.breachedAt) return sla;

  const { resolutionBreached } = snapshot(sla, now);
  if (!resolutionBreached) return sla;

  return { ...sla, state: 'BREACHED', breachedAt: now };
}

/**
 * Records every breach that has happened, in one update.
 *
 * `applyBreach` covers a single complaint as it is read. Counts across many
 * complaints — the dashboards and reports — would otherwise only see the
 * breaches someone happened to open, so they call this first. It is one
 * indexed update: the `sla.resolutionDueAt` pre-filter narrows to complaints
 * that could possibly be late before the paused-time arithmetic runs.
 *
 * `updatedAt` is left alone. Work queues sort by how long a job has waited,
 * and recording a breach is not activity on the job.
 */
export async function sweepBreaches(now: Date = new Date()): Promise<number> {
  const result = await Complaint.updateMany(
    {
      'sla.state': 'RUNNING',
      'sla.resolutionDueAt': { $lt: now },
      /* A cancelled complaint is no longer owed a resolution. */
      status: { $nin: ['CLOSED', 'CANCELLED'] },
      $expr: {
        $lt: [{ $add: ['$sla.resolutionDueAt', { $ifNull: ['$sla.pausedTotalMs', 0] }] }, now],
      },
    },
    { $set: { 'sla.state': 'BREACHED', 'sla.breachedAt': now } },
    { timestamps: false },
  ).exec();

  return result.modifiedCount;
}
