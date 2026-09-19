/**
 * SLA rules (spec section 14).
 *
 * Section 14 closes with "SLA should be configurable, not hard-coded", and
 * section 19 repeats it. So the response and resolution windows live in the
 * database, one row per priority, editable by Admin.
 *
 * The spec's suggested defaults are seeded, not compiled in:
 *
 *   | Priority | Response | Resolution |
 *   |----------|----------|------------|
 *   | LOW      | 24h      | 72h        |
 *   | NORMAL   | 8h       | 48h        |
 *   | HIGH     | 4h       | 24h        |
 *   | CRITICAL | 2h       | 8h         |
 *
 * Windows are stored in **minutes** rather than hours. Hours are what the spec
 * writes and what the UI will show, but a stricter SLA later ("respond in 30
 * minutes") should be a data change, not a schema migration.
 *
 * Editing a rule affects only complaints created afterwards. A complaint
 * computes its own `responseDueAt` and `resolutionDueAt` at creation and
 * stores them, so tightening the policy cannot retroactively breach work that
 * was on time under the old one.
 */
import { Schema, type Types } from 'mongoose';
import { baseSchemaOptions, defineModel, optionalText } from './common/base.js';
import { PRIORITIES, type Priority } from './enums.js';

export interface SlaRuleDoc {
  _id: Types.ObjectId;
  priority: Priority;

  /** Minutes from creation until a first response is due. */
  responseMinutes: number;
  /** Minutes from creation until final Admin closure is due (section 14). */
  resolutionMinutes: number;

  /**
   * Whether the clock pauses in these states.
   *
   * Section 14 permits pausing "if this behavior is enabled in
   * configuration". Both ship disabled (DECISIONS.md section 5, item 4),
   * because a paused clock makes breach numbers look better without any
   * service actually improving — that should be an explicit choice.
   */
  pauseOnWaitingParts: boolean;
  pauseOnRevisitRequired: boolean;

  notes?: string;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const slaRuleSchema = new Schema<SlaRuleDoc>(
  {
    priority: { type: String, required: true, enum: PRIORITIES },

    responseMinutes: { type: Number, required: true, min: 1 },
    resolutionMinutes: { type: Number, required: true, min: 1 },

    pauseOnWaitingParts: { type: Boolean, required: true, default: false },
    pauseOnRevisitRequired: { type: Boolean, required: true, default: false },

    notes: optionalText(1000),
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  },
  baseSchemaOptions,
);

/* Exactly one rule per priority. */
slaRuleSchema.index({ priority: 1 }, { unique: true });

/**
 * A resolution window shorter than its response window would be
 * contradictory — the complaint would be late to resolve before it was even
 * late to answer.
 */
slaRuleSchema.pre('validate', function checkWindowOrder() {
  if (
    typeof this.responseMinutes === 'number' &&
    typeof this.resolutionMinutes === 'number' &&
    this.resolutionMinutes < this.responseMinutes
  ) {
    this.invalidate(
      'resolutionMinutes',
      'Resolution window cannot be shorter than the response window',
    );
  }
});

export const SlaRule = defineModel<SlaRuleDoc>('SlaRule', slaRuleSchema);

/** The spec's section 14 defaults, in minutes, for seeding. */
export const DEFAULT_SLA_RULES: ReadonlyArray<{
  priority: Priority;
  responseMinutes: number;
  resolutionMinutes: number;
}> = [
  { priority: 'LOW', responseMinutes: 24 * 60, resolutionMinutes: 72 * 60 },
  { priority: 'NORMAL', responseMinutes: 8 * 60, resolutionMinutes: 48 * 60 },
  { priority: 'HIGH', responseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  { priority: 'CRITICAL', responseMinutes: 2 * 60, resolutionMinutes: 8 * 60 },
];
