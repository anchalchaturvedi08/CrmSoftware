/**
 * How long a unit is still under warranty (DECISIONS.md section 32).
 *
 * Counted from the purchase date the complaint records, for as many months as
 * the product says — twelve unless the Products page sets something else, and
 * the number is snapshotted onto the complaint so a later change to the
 * product does not rewrite what an old job was told.
 *
 * This is a reading of the dates, not the decision: `warrantyStatus` on the
 * complaint is what Admin chose for *that job* (section 12) and remains what
 * billing follows. The two are shown side by side, and when they disagree the
 * screen says so rather than quietly preferring one.
 */
import dayjs from 'dayjs';

export const DEFAULT_WARRANTY_MONTHS = 12;

export interface WarrantyPeriod {
  /** When the warranty ends, from the purchase date. */
  endsAt: Date;
  months: number;
  inWarranty: boolean;
  /** Whole months left, 0 when it ends this month or has ended. */
  monthsLeft: number;
  daysLeft: number;
  /** "7 months left", "18 days left", "Ended 4 Jan 2026". */
  text: string;
}

/**
 * The warranty for a purchase, or null when no purchase date was recorded —
 * which is normal: section 12 lets Admin decide warranty without one.
 */
export function warrantyPeriod(
  purchaseDate: string | Date | null | undefined,
  months: number | null | undefined = DEFAULT_WARRANTY_MONTHS,
  now: Date = new Date(),
): WarrantyPeriod | null {
  if (!purchaseDate) return null;

  const start = dayjs(purchaseDate);
  if (!start.isValid()) return null;

  /* Nullish, not truthy: an explicit 0 (no factory warranty, e.g. a spare
     part) is a real span and must not fall back to the 12-month default. */
  const span = months ?? DEFAULT_WARRANTY_MONTHS;
  const end = start.add(span, 'month');
  const today = dayjs(now);

  const daysLeft = end.diff(today, 'day');
  const monthsLeft = Math.max(0, end.diff(today, 'month'));
  const inWarranty = end.isAfter(today);

  return {
    endsAt: end.toDate(),
    months: span,
    inWarranty,
    monthsLeft,
    daysLeft: Math.max(0, daysLeft),
    text: inWarranty
      ? monthsLeft >= 1
        ? `${monthsLeft} ${monthsLeft === 1 ? 'month' : 'months'} left`
        : `${Math.max(1, daysLeft)} ${daysLeft === 1 ? 'day' : 'days'} left`
      : `Ended ${end.format('D MMM YYYY')}`,
  };
}

/** "In warranty" or "Out of warranty", from the dates alone. */
export const warrantyLabel = (period: WarrantyPeriod | null): string =>
  period === null ? 'No purchase date' : period.inWarranty ? 'In warranty' : 'Out of warranty';
