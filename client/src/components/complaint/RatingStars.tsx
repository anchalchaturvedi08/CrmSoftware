/**
 * Stars, for reading and for giving (DECISIONS.md section 31).
 *
 * Admin rates a service center's work once a complaint is closed, and the
 * centre reads that rating on the complaint and as an average on its
 * dashboard. Both live here so a rating looks the same everywhere it appears.
 *
 * Stars are decoration; the number beside them is the rating. A screen reader
 * is given "4 out of 5" rather than five icons to interpret, and the picker is
 * a real radio group, so it can be used from the keyboard with the arrow keys.
 */
import { Star } from 'lucide-react';
import { cn } from '@/lib/format';

export const MAX_STARS = 5;

const SIZES = { sm: 'size-3.5', md: 'size-4', lg: 'size-6' } as const;

/** A given rating, as filled and empty stars. Decorative by itself. */
export function Stars({
  value,
  size = 'sm',
  className,
}: {
  /** Whole or fractional: 4.3 fills four stars. */
  value: number;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-hidden>
      {Array.from({ length: MAX_STARS }, (_, index) => (
        <Star
          key={index}
          className={cn(
            SIZES[size],
            index < Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-slate-300',
          )}
        />
      ))}
    </span>
  );
}

/**
 * A rating in full: the stars, the number, and what it is worth in words.
 *
 * `count` turns it into an average — "4.3 of 5 from 12 rated complaints" —
 * which is how a centre's dashboard and the Admin's centre page read it.
 */
export function RatingValue({
  value,
  count,
  size = 'sm',
  className,
}: {
  value: number | null | undefined;
  count?: number;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return <span className={cn('text-sm text-slate-500', className)}>Not rated yet</span>;
  }

  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1);

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Stars value={value} size={size} />
      <span className="text-sm font-medium text-slate-900">
        {shown}
        <span className="font-normal text-slate-500">/{MAX_STARS}</span>
      </span>
      <span className="sr-only">
        {shown} out of {MAX_STARS}
        {count !== undefined && `, from ${count} rated ${count === 1 ? 'complaint' : 'complaints'}`}
      </span>
      {count !== undefined && (
        <span className="text-xs text-slate-500" aria-hidden>
          from {count} rated
        </span>
      )}
    </span>
  );
}

/** What each number means, so a rating is not one person's private scale. */
export const STAR_MEANING: Record<number, string> = {
  1: 'Poor — the customer was let down',
  2: 'Below expectations',
  3: 'Acceptable',
  4: 'Good',
  5: 'Excellent',
};

/** Choose a rating: five radio buttons, usable with the arrow keys. */
export function StarPicker({
  value,
  onChange,
  label = 'Rating',
}: {
  value: number | null;
  onChange: (stars: number) => void;
  label?: string;
}) {
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="flex items-center gap-1">
        {Array.from({ length: MAX_STARS }, (_, index) => {
          const stars = index + 1;
          const chosen = value !== null && stars <= value;
          return (
            <button
              key={stars}
              type="button"
              role="radio"
              aria-checked={value === stars}
              aria-label={`${stars} ${stars === 1 ? 'star' : 'stars'} — ${STAR_MEANING[stars]}`}
              /* One stop for the group: the arrow keys move within it. */
              tabIndex={value === stars || (value === null && stars === 1) ? 0 : -1}
              onClick={() => onChange(stars)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  onChange(Math.min(MAX_STARS, (value ?? 0) + 1));
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  onChange(Math.max(1, (value ?? MAX_STARS + 1) - 1));
                }
              }}
              className="rounded-md p-1 transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <Star
                className={cn('size-7', chosen ? 'fill-amber-400 text-amber-400' : 'text-slate-300')}
                aria-hidden
              />
            </button>
          );
        })}
        <span className="ml-2 text-sm text-slate-600" aria-hidden>
          {value === null ? 'Choose a rating' : `${value} of ${MAX_STARS}`}
        </span>
      </div>
      {value !== null && <p className="mt-1.5 text-sm text-slate-500">{STAR_MEANING[value]}</p>}
    </div>
  );
}
