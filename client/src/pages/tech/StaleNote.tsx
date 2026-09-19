/**
 * A quiet note that a screen could not refresh what it is showing.
 *
 * A background refresh fails all the time in the field: the technician
 * switches back to the app in a stairwell with no signal. The query keeps the
 * data it had, but the screens used to treat any error as fatal and swap the
 * whole page for "Could not load this" — taking away the address, the phone
 * number and the Directions button, or a half-filled visit form.
 *
 * So a screen that has data keeps showing it, and this says, in one line, that
 * it may be out of date — with a retry, since the signal often comes back.
 */
import { CloudOff, RotateCw } from 'lucide-react';
import { cn } from '@/lib/format';

export function StaleNote({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 py-0.5 pl-4 pr-2 text-sm text-amber-900"
    >
      <CloudOff className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">Couldn’t refresh — showing saved info</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 font-semibold active:bg-amber-100 disabled:opacity-60"
      >
        <RotateCw className={cn('size-4', retrying && 'animate-spin')} aria-hidden />
        Retry
      </button>
    </div>
  );
}
