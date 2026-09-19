/**
 * Error boundary for the lazily loaded screens.
 *
 * Each portal's screens are a separate download (App.tsx), shown inside a
 * `Suspense` in the layout. Suspense only covers *waiting* for that download.
 * When it fails — a phone that lost signal just after an update, before the
 * new screens arrived — the error has nowhere to go, React unmounts the whole
 * app, and a technician is left looking at a white page with no way out.
 *
 * This catches it and says what happened in plain words, with one button.
 *
 * ## "Try again" reloads when a download failed
 *
 * `React.lazy` remembers a failed import and throws the same error on every
 * later render, so re-rendering can never recover it; only a fresh page load
 * asks for the file again. Any other error — a fault on one screen — is first
 * retried by re-rendering, which keeps everything else the app holds.
 *
 * The boundary also clears when the address changes, so the tab bar, the
 * sidebar or the back button always lead out of a broken screen.
 */
import { AlertTriangle, RotateCw, WifiOff } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { cn } from '@/lib/format';
import { Button } from './Button';

/**
 * How browsers and Vite word a lazily loaded file that did not arrive:
 * Chrome "Failed to fetch dynamically imported module", Firefox "error loading
 * dynamically imported module", Safari "Importing a module script failed",
 * Vite "Unable to preload CSS".
 */
const DOWNLOAD_FAILED =
  /dynamically imported module|importing a module script failed|unable to preload css/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && DOWNLOAD_FAILED.test(error.message);
}

interface BoundaryProps {
  children: ReactNode;
  /** A change clears a caught error. */
  resetKey: unknown;
  className?: string | undefined;
}

interface BoundaryState {
  /** Any value can be thrown, including `undefined`, so the flag is separate. */
  failed: boolean;
  error: unknown;
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, error };
  }

  override componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, error: undefined });
    }
  }

  private readonly retry = () => {
    if (isChunkLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ failed: false, error: undefined });
  };

  override render() {
    if (!this.state.failed) return this.props.children;

    const download = isChunkLoadError(this.state.error);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

    return (
      <div
        role="alert"
        className={cn('flex flex-col items-center px-6 py-14 text-center', this.props.className)}
      >
        <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          {download || offline ? <WifiOff className="size-7" /> : <AlertTriangle className="size-7" />}
        </div>
        <p className="text-lg font-semibold text-slate-900">Couldn’t load this screen</p>
        <p className="mt-1 max-w-xs text-[15px] text-slate-600">
          {download || offline
            ? 'Check your internet connection, then try again.'
            : 'Something went wrong on this screen. Try again, and if it keeps happening, reload the app.'}
        </p>
        <Button
          size="lg"
          className="mt-6 h-12 min-w-44 text-base"
          icon={<RotateCw className="size-5" />}
          onClick={this.retry}
        >
          Try again
        </Button>
        {!download && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 min-h-11 px-4 text-sm font-medium text-brand-700"
          >
            Reload the app
          </button>
        )}
      </div>
    );
  }
}

/**
 * Wraps a layout's `Suspense`, clearing itself on navigation.
 *
 * `className` styles the message's container, so it can sit inside a phone
 * column or fill a desktop page.
 */
export function ScreenErrorBoundary({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { pathname } = useLocation();

  return (
    <Boundary resetKey={pathname} className={className}>
      {children}
    </Boundary>
  );
}
