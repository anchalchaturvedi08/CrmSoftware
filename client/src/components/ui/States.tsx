/**
 * Loading, empty and error states.
 *
 * Spec section 21 lists these explicitly — "Loading states", "Empty states",
 * "Error states", "Skeleton loaders where useful". They are components rather
 * than ad-hoc markup so every screen fails the same legible way instead of
 * each inventing its own blank space.
 */
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/format';
import { Button } from './Button';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Explains a failed request.
 *
 * Shows the server's own message when there is one — those are written to be
 * read by a person — and offers a retry, since most failures here are a
 * dropped connection rather than something the user did.
 */
const NO_CONNECTION = 'Could not reach the server. Check your internet connection and try again.';

/**
 * Whether a thrown value is the browser failing to reach the server at all.
 *
 * Browsers word it differently — "Failed to fetch" (Chrome), "NetworkError
 * when attempting to fetch resource" (Firefox), "Load failed" (Safari, which
 * is every iPhone) — but all throw a TypeError from `fetch`.
 */
export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError && /fetch|network|load failed/i.test(error.message)
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message =
    error instanceof ApiError
      ? error.message
      : isNetworkError(error)
        ? NO_CONNECTION
        : 'Something went wrong loading this.';

  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-red-50 text-red-500">
        <AlertTriangle className="size-5" />
      </div>
      <p className="text-sm font-semibold text-slate-900">Could not load this</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{message}</p>
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          icon={<RotateCw className="size-3.5" />}
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </div>
  );
}

/** Pulls a readable message out of any thrown value, for toasts. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (isNetworkError(error)) return NO_CONNECTION;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
