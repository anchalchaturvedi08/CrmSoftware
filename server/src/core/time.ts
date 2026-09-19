/**
 * The company's calendar (spec section 19, "Time").
 *
 * Timestamps are stored in UTC, but "today", "this year" and a date typed as
 * `2026-09-17` mean the company's own timezone (`APP_TIMEZONE`, Asia/Kolkata).
 * `Date#setHours` and `Date#getFullYear` answer in the *server's* timezone
 * instead, which is only the same thing while the server happens to run in
 * India. On a UTC host "visits today" rolled over at 05:30 IST, and a complaint
 * raised at 00:10 IST on 1 January was numbered into the previous year.
 *
 * Everything here goes through `Intl`, which carries the timezone database, so
 * no date library is needed. Days are found by calendar date, never by adding
 * 24 hours: in a timezone with daylight saving a day can be 23 or 25 hours
 * long, and a clock change can even skip midnight altogether.
 */
import { config } from '../config/env.js';

/** A calendar date. `month` runs 1-12, as people write it. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per timezone: building an `Intl.DateTimeFormat` is the slow part. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      /* h23, not hour12: false — some ICU builds write midnight as "24". */
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

/** What a clock on the wall in `timeZone` reads at an instant. */
function wallClock(instant: number, timeZone: string): WallClock {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields['year']!,
    month: fields['month']!,
    day: fields['day']!,
    hour: fields['hour']!,
    minute: fields['minute']!,
    second: fields['second']!,
  };
}

/** How far the timezone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  /* The formatter has no milliseconds, so compare whole seconds. */
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
}

/** The calendar date an instant falls on, in the company timezone. */
export function companyDate(instant: Date = new Date(), timeZone = config.APP_TIMEZONE): CalendarDate {
  const { year, month, day } = wallClock(instant.getTime(), timeZone);
  return { year, month, day };
}

/** The company-timezone year of an instant — what a complaint number is filed under. */
export function companyYear(instant: Date = new Date(), timeZone = config.APP_TIMEZONE): number {
  return companyDate(instant, timeZone).year;
}

/** `2026-09-17` for the company-timezone date of an instant. */
export function companyDateKey(instant: Date = new Date(), timeZone = config.APP_TIMEZONE): string {
  return formatDateKey(companyDate(instant, timeZone));
}

export function formatDateKey({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Reads `2026-09-17`; null for anything else, including a date that does not exist. */
export function parseDateKey(key: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  /* Date.UTC rolls 31 February over into March; a real date survives the trip. */
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/**
 * The instant a calendar date begins in the company timezone.
 *
 * Normally its midnight. Midnight can occur twice when clocks go back across
 * it, and then the day began at the first one. It can also not occur at all,
 * when clocks spring forward across it — then the day began at the jump.
 */
export function startOfCompanyDate(date: CalendarDate, timeZone = config.APP_TIMEZONE): Date {
  const wallMidnight = Date.UTC(date.year, date.month - 1, date.day);

  /* Any offset change near this midnight is seen by sampling a day either side. */
  const offsets = [
    ...new Set([
      offsetAt(wallMidnight - DAY_MS, timeZone),
      offsetAt(wallMidnight, timeZone),
      offsetAt(wallMidnight + DAY_MS, timeZone),
    ]),
  ];

  const midnights = offsets
    .map((offset) => wallMidnight - offset)
    .filter((instant) => {
      const wall = wallClock(instant, timeZone);
      return (
        wall.year === date.year &&
        wall.month === date.month &&
        wall.day === date.day &&
        wall.hour === 0 &&
        wall.minute === 0 &&
        wall.second === 0
      );
    });

  if (midnights.length > 0) return new Date(Math.min(...midnights));

  /* Skipped midnight: the clocks jumped at what would have been midnight on the
     earlier (smaller) offset. */
  return new Date(wallMidnight - Math.min(...offsets));
}

/** The calendar date after `date`. */
function nextDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/**
 * A calendar date as a half-open interval: `start <= t < end`.
 *
 * `end` is the start of the next date, not `start` + 24 hours, so a day that is
 * 23 or 25 hours long is still exactly one day.
 */
export function companyDateBounds(
  date: CalendarDate,
  timeZone = config.APP_TIMEZONE,
): { start: Date; end: Date } {
  return {
    start: startOfCompanyDate(date, timeZone),
    end: startOfCompanyDate(nextDate(date), timeZone),
  };
}

/** The company-timezone day an instant falls in, as `start <= t < end`. */
export function companyDayBounds(
  instant: Date = new Date(),
  timeZone = config.APP_TIMEZONE,
): { start: Date; end: Date } {
  return companyDateBounds(companyDate(instant, timeZone), timeZone);
}

/** When today began, in the company timezone. */
export function startOfCompanyDay(instant: Date = new Date(), timeZone = config.APP_TIMEZONE): Date {
  return companyDayBounds(instant, timeZone).start;
}
