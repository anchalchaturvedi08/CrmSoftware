/**
 * Dashboard chart primitives.
 *
 * Built in plain HTML rather than a charting library. Every chart on the
 * dashboard is a labelled bar list, a meter or a segmented bar — forms where
 * crisp text, exact alignment and accessibility matter more than axes, and
 * where an SVG library would only add label collisions to fix.
 *
 * ## The rules these follow, and why
 *
 *  - **One hue for magnitude.** A bar list compares amounts across categories
 *    with no inherent order, so every bar is the same colour. Colouring bars
 *    by category would double-encode what the length already says and spend
 *    the only free channel on nothing.
 *  - **Text never wears the data colour.** Labels and values stay in ink; an
 *    identity cue, where there is one, is a small dot *beside* the text.
 *  - **Every value is visible without hovering.** Hover adds the share of the
 *    total, but never gates a number — a touchscreen has no hover at all.
 *  - **Thin marks, 4px rounded at the data end, square at the baseline.**
 *
 * The colours were checked with the palette validator rather than by eye.
 * Brand teal passes every check on the card surface. For the SLA bar, green
 * beside red failed colour-blind separation outright (ΔE 4.1, deutan) — "met"
 * and "breached" would have been indistinguishable to roughly one man in
 * twenty — so "met" uses teal (ΔE 11.0 against red, passing).
 */
import type { LucideIcon } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/format';

/** Validated fills. */
export const VIZ = {
  bar: '#0d9488',
  track: '#ccfbf1',
  met: '#0d9488',
  paused: '#cbd5e1',
  breached: '#d03b3b',
} as const;

const percent = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

/* ---- Stat tile --------------------------------------------------------- */

/**
 * A single headline number.
 *
 * Proportional figures, not tabular: equal-width digits make a standalone
 * `121` look loose at display size. `tone` marks tiles that are bad news when
 * non-zero, and pairs the colour with an icon so it is never colour alone.
 */
export function StatTile({
  label,
  value,
  display,
  icon: Icon,
  tone = 'default',
  hint,
  onClick,
}: {
  label: string;
  /** Null when there is nothing to measure; shown as a dash. */
  value: number | null;
  /** Replaces the formatted number, e.g. "45%" or "3.2 days". */
  display?: string;
  icon: LucideIcon;
  tone?: 'default' | 'alert';
  hint?: string;
  onClick?: () => void;
}) {
  const alert = tone === 'alert' && (value ?? 0) > 0;
  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'group flex flex-col rounded-[var(--radius-card)] border bg-white p-4 text-left transition-shadow',
        alert ? 'border-red-200' : 'border-slate-200/80',
        onClick && 'hover:shadow-md focus-visible:shadow-md',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-slate-500">{label}</span>
        <Icon
          className={cn('size-4 shrink-0', alert ? 'text-red-500' : 'text-slate-400')}
          aria-hidden
        />
      </div>
      <span
        className={cn(
          'mt-2 text-[28px] font-semibold leading-none tracking-tight',
          alert ? 'text-red-600' : 'text-slate-900',
        )}
      >
        {display ?? (value === null ? '—' : value.toLocaleString('en-IN'))}
      </span>
      {hint && <span className="mt-1.5 text-xs text-slate-500">{hint}</span>}
    </Tag>
  );
}

/* ---- Bar list ---------------------------------------------------------- */

export interface BarDatum {
  label: string;
  count: number;
  /** Optional identity cue shown as a dot beside the label — e.g. a status. */
  dotClassName?: string;
  /** Replaces the label text, e.g. with a human-readable status name. */
  display?: ReactNode;
}

/**
 * Horizontal bars, one hue, sorted by the caller.
 *
 * Bars are scaled to the largest value rather than the total, so a list with
 * one dominant category still shows the differences among the rest.
 */
export function BarList({
  data,
  emptyText = 'Nothing to show yet',
  limit,
}: {
  data: BarDatum[];
  emptyText?: string;
  limit?: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const rows = limit ? data.slice(0, limit) : data;
  const hidden = limit ? Math.max(0, data.length - limit) : 0;
  const max = Math.max(0, ...rows.map((row) => row.count));
  const total = data.reduce((sum, row) => sum + row.count, 0);

  if (rows.length === 0 || total === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">{emptyText}</p>;
  }

  return (
    <div>
      <ul className="space-y-3" role="list">
        {rows.map((row) => {
          const width = max > 0 ? (row.count / max) * 100 : 0;
          const share = percent(row.count, total);
          const active = hovered === row.label;
          const dimmed = hovered !== null && !active;

          return (
            <li
              key={row.label}
              onMouseEnter={() => setHovered(row.label)}
              onMouseLeave={() => setHovered(null)}
              className={cn('transition-opacity', dimmed && 'opacity-45')}
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2 text-slate-700">
                  {row.dotClassName && (
                    <span className={cn('size-2 shrink-0 rounded-full', row.dotClassName)} aria-hidden />
                  )}
                  <span className="truncate">{row.display ?? row.label}</span>
                </span>
                <span className="tabular shrink-0 font-medium text-slate-900">
                  {row.count.toLocaleString('en-IN')}
                  {/* The share appears on hover as a supplement; the count is
                      always visible, so nothing depends on hovering. */}
                  <span
                    className={cn(
                      'ml-1.5 text-xs font-normal text-slate-500 transition-opacity',
                      active ? 'opacity-100' : 'opacity-0',
                    )}
                  >
                    {share}%
                  </span>
                </span>
              </div>
              <div
                className="h-2 w-full"
                role="img"
                aria-label={`${row.label}: ${row.count} (${share}%)`}
              >
                {row.count > 0 && (
                  <div
                    className="h-full rounded-r-[4px]"
                    style={{
                      /* A floor keeps a small non-zero value visible as a
                         mark rather than vanishing into the baseline. */
                      width: `max(${width}%, 4px)`,
                      backgroundColor: VIZ.bar,
                    }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          +{hidden} more not shown
        </p>
      )}
    </div>
  );
}

/* ---- Meter ------------------------------------------------------------- */

/**
 * One share of a whole.
 *
 * Used where the alternative would be a two-slice pie. The track is a lighter
 * step of the same ramp, so the unfilled part still reads as part of the
 * measure rather than as empty space.
 */
export function Meter({
  label,
  part,
  whole,
  partLabel,
  restLabel,
}: {
  label: string;
  part: number;
  whole: number;
  partLabel: string;
  restLabel: string;
}) {
  const share = percent(part, whole);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <span className="text-2xl font-semibold tracking-tight text-slate-900">{share}%</span>
      </div>

      <div
        className="mt-3 h-2.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: VIZ.track }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share}
        aria-label={`${label}: ${share}%`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${share}%`, backgroundColor: VIZ.bar }}
        />
      </div>

      <div className="mt-3 flex justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: VIZ.bar }} aria-hidden />
          {partLabel} <span className="tabular font-medium text-slate-700">{part.toLocaleString('en-IN')}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: VIZ.track }} aria-hidden />
          {restLabel}{' '}
          <span className="tabular font-medium text-slate-700">
            {(whole - part).toLocaleString('en-IN')}
          </span>
        </span>
      </div>
    </div>
  );
}

/* ---- Segmented bar ----------------------------------------------------- */

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  icon: LucideIcon;
}

/**
 * Part-to-whole across a few states, with the legend carrying the numbers.
 *
 * Segments are separated by a 2px gap in the surface colour rather than a
 * drawn border. Every segment has an icon, a label and its count in the
 * legend — required here, because the paused colour is deliberately a light
 * neutral that falls below 3:1 against white, and a colour that weak must
 * never carry meaning on its own.
 */
export function SegmentBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const visible = segments.filter((segment) => segment.value > 0);

  if (total === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">No complaints in this period</p>;
  }

  return (
    <div>
      <div className="flex h-3 w-full gap-[2px]" role="img" aria-label={
        segments.map((s) => `${s.label} ${s.value}`).join(', ')
      }>
        {visible.map((segment, index) => (
          <div
            key={segment.key}
            className={cn(
              'h-full',
              index === 0 && 'rounded-l-full',
              index === visible.length - 1 && 'rounded-r-full',
            )}
            style={{
              width: `${(segment.value / total) * 100}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>

      {/**
        * A vertical list, not a row of columns.
        *
        * The first version laid the legend out three across, which truncated
        * "On track / Paused / Breached" to "O… / P… / B…" once the card sat in
        * a one-third-width column at laptop sizes — a label clipped by its own
        * container. A list row has the full card width for the label and can
        * never truncate it, whatever column the card lands in.
        */}
      <ul className="mt-4 space-y-2.5" role="list">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-slate-600">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: segment.color }}
                aria-hidden
              />
              <segment.icon className="size-3.5 shrink-0 text-slate-400" aria-hidden />
              {segment.label}
            </span>
            <span className="tabular font-semibold text-slate-900">
              {segment.value.toLocaleString('en-IN')}
              <span className="ml-1.5 inline-block w-9 text-right text-xs font-normal text-slate-500">
                {percent(segment.value, total)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- Column chart ------------------------------------------------------ */

export interface ColumnDatum {
  key: string;
  label: string;
  value: number;
}

/** Round axis steps — 1, 2, 5 or 10 times a power of ten — for whole counts. */
function countTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/** At most this many period labels under the axis, so they never collide on a phone. */
const MAX_X_LABELS = 6;

/**
 * Counts per period, one hue, oldest on the left.
 *
 * Columns rather than a line: each period is its own count, and on most days
 * there are none — a line would draw a mountain range out of zeros. Columns
 * are capped at 24px with a 2px gap, rounded 4px at the data end and square
 * at the baseline.
 *
 * Every value is reachable without a mouse: the chart takes focus, the arrow
 * keys step through the periods, and the readout is announced. A tap does the
 * same on a phone. The report download carries every value as well.
 */
export function ColumnChart({
  data,
  title,
  valueLabel,
  emptyText = 'Nothing in these dates',
}: {
  data: ColumnDatum[];
  title: string;
  /** Plural noun for the readout, e.g. "complaints". */
  valueLabel: string;
  emptyText?: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const max = Math.max(0, ...data.map((point) => point.value));
  if (data.length === 0 || max === 0) {
    return <p className="py-10 text-center text-sm text-slate-500">{emptyText}</p>;
  }

  const ticks = countTicks(max);
  const top = ticks[ticks.length - 1]!;
  const every = Math.ceil(data.length / MAX_X_LABELS);
  const current = active === null ? null : data[active];

  const move = (event: KeyboardEvent) => {
    const last = data.length - 1;
    const index = active ?? last;
    const next =
      event.key === 'ArrowLeft' ? Math.max(0, index - 1)
      : event.key === 'ArrowRight' ? Math.min(last, index + 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <div>
      <div
        className="flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-4"
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read each period.`}
        onFocus={() => setActive((index) => index ?? data.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={move}
        onMouseLeave={() => setActive(null)}
      >
        {/* Y axis: round numbers, recessive. */}
        <div className="relative h-48 w-8 shrink-0" aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick}
              className="tabular absolute right-2 translate-y-1/2 text-[11px] leading-none text-slate-400"
              style={{ bottom: `${(tick / top) * 100}%` }}
            >
              {tick.toLocaleString('en-IN')}
            </span>
          ))}
        </div>

        <div className="relative h-48 flex-1 border-b border-slate-200">
          {/* Hairline gridlines, above the baseline. */}
          {ticks.slice(1).map((tick) => (
            <div
              key={tick}
              className="absolute inset-x-0 border-t border-slate-100"
              style={{ bottom: `${(tick / top) * 100}%` }}
              aria-hidden
            />
          ))}

          <div className="absolute inset-0 flex items-end gap-[2px]">
            {data.map((point, index) => (
              /* The whole column slot is the hit target, not just the bar. */
              <div
                key={point.key}
                className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
                onMouseEnter={() => setActive(index)}
                onClick={() => setActive(index)}
                aria-hidden
              >
                {point.value > 0 && (
                  <div
                    className={cn(
                      'w-full max-w-6 rounded-t-[4px] transition-opacity',
                      active !== null && active !== index && 'opacity-45',
                    )}
                    style={{ height: `max(${(point.value / top) * 100}%, 2px)`, backgroundColor: VIZ.bar }}
                  />
                )}
              </div>
            ))}
          </div>

          {current && active !== null && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-1.5 text-xs shadow-lg"
              style={{
                left: `${((active + 0.5) / data.length) * 100}%`,
                bottom: `calc(${(current.value / top) * 100}% + 8px)`,
              }}
            >
              <span className="tabular font-semibold text-white">{current.value.toLocaleString('en-IN')}</span>
              <span className="ml-1.5 text-slate-300">{current.label}</span>
            </div>
          )}
        </div>
      </div>

      {/* Period labels, counted back from the latest so the newest is always named. */}
      <div className="relative ml-8 mt-2 h-4" aria-hidden>
        {data.map((point, index) => {
          if ((data.length - 1 - index) % every !== 0) return null;
          const first = index === 0;
          const last = index === data.length - 1;
          return (
            <span
              key={point.key}
              className="absolute whitespace-nowrap text-[11px] leading-none text-slate-500"
              style={
                last
                  ? { right: 0 }
                  : first
                    ? { left: 0 }
                    : { left: `${((index + 0.5) / data.length) * 100}%`, transform: 'translateX(-50%)' }
              }
            >
              {point.label}
            </span>
          );
        })}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {current ? `${current.label}: ${current.value} ${valueLabel}` : ''}
      </p>
    </div>
  );
}
