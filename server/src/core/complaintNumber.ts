/**
 * Complaint number generation (spec section 6.2).
 *
 * Format: `CMP-2026-000001`. Section 6.2 also says what *not* to do — "Do not
 * rely on customer phone number or serial number as the complaint identifier"
 * — which is why this is an independent sequence rather than anything derived
 * from the complaint's contents.
 *
 * The sequence restarts each calendar year, so the counter is scoped per year.
 */
import type { ClientSession } from 'mongoose';
import { nextSequence } from '../models/index.js';
import { companyYear } from './time.js';

const PREFIX = 'CMP';
const SEQUENCE_DIGITS = 6;

/** The counter key for a given year. */
export function counterScope(year: number): string {
  return `complaint:${year}`;
}

export function formatComplaintNumber(year: number, sequence: number): string {
  return `${PREFIX}-${year}-${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`;
}

/**
 * Mints the next complaint number.
 *
 * **Always pass the surrounding transaction's session.** Two reasons:
 *
 *  - the increment is atomic, so concurrent creations get distinct numbers
 *    rather than both reading the same count and colliding;
 *  - if the complaint insert then fails, the increment rolls back with it and
 *    the number is returned to the pool instead of leaving a permanent gap in
 *    the sequence.
 *
 * The year comes from the server clock, never a client-supplied date —
 * otherwise a wrong timezone or a crafted request could mint numbers into the
 * wrong year's sequence. It is read in the company timezone, not the server's:
 * a complaint raised at 00:10 IST on 1 January belongs to the new year even
 * when the server runs on UTC, where it is still 31 December.
 */
export async function nextComplaintNumber(
  session: ClientSession | null = null,
  now: Date = new Date(),
): Promise<string> {
  const year = companyYear(now);
  const sequence = await nextSequence(counterScope(year), session);

  return formatComplaintNumber(year, sequence);
}
