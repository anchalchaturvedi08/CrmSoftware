/**
 * Technician app shell (spec sections 4, 10, 21).
 *
 * Section 10 is blunt about this one: "The technician experience must feel
 * like a mobile field-service app, not a complex admin dashboard." Section 4
 * limits the navigation to four items. Section 21 asks for bottom navigation,
 * large action buttons and minimal typing.
 *
 * So: a bottom tab bar within thumb reach, one column, touch targets of at
 * least 48px — the size a gloved or dirty thumb can hit on the first try — and
 * nothing on screen that is not about the job in hand.
 *
 * On a desktop browser it renders as a phone-width column, so what you see
 * when checking it is what the technician gets.
 */
import { CalendarDays, ClipboardList, History, UserRound, ArrowLeft } from 'lucide-react';
import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { ScreenErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Skeleton } from '@/components/ui/States';
import { cn } from '@/lib/format';

const TABS = [
  { to: '/tech', label: 'My Jobs', icon: ClipboardList, end: true },
  { to: '/tech/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/tech/history', label: 'History', icon: History },
  { to: '/tech/profile', label: 'Profile', icon: UserRound },
] as const;

export function TechLayout() {
  return (
    <div className="flex min-h-full justify-center bg-slate-200/60">
      <div className="relative flex min-h-full w-full max-w-md flex-col bg-slate-50 shadow-xl shadow-slate-900/5">
        {/* Room for the tab bar and the phone's own gesture area beneath it. */}
        <div className="flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
          {/* Screens load lazily (App.tsx); the tab bar stays while they do,
              and stays if the download fails, so there is always a way on. */}
          <ScreenErrorBoundary className="min-h-[60dvh] justify-center">
            <Suspense
              fallback={
                <div className="space-y-3 p-4" aria-busy aria-label="Loading">
                  <Skeleton className="h-12 rounded-xl" />
                  <Skeleton className="h-40 rounded-2xl" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ScreenErrorBoundary>
        </div>

        <nav
          aria-label="Technician"
          className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-md border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        >
          <ul className="grid grid-cols-4">
            {TABS.map((tab) => (
              <li key={tab.to}>
                <NavLink
                  to={tab.to}
                  {...('end' in tab ? { end: true } : {})}
                  className={({ isActive }) =>
                    cn(
                      'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors',
                      isActive ? 'text-brand-700' : 'text-slate-500 active:bg-slate-50',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <tab.icon className={cn('size-6', isActive && 'stroke-[2.25]')} aria-hidden />
                      {tab.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

/**
 * The top bar each screen renders for itself.
 *
 * Per-screen rather than in the layout, because the job and visit screens
 * need a back button and their own title while the tab screens do not.
 */
export function TechHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A path to go back to, or `true` to go back in history. */
  back?: string | true;
  action?: ReactNode;
}) {
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="flex min-h-14 items-center gap-1 px-2 py-2">
        {back && (
          <button
            type="button"
            onClick={() => (back === true ? navigate(-1) : navigate(back))}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-slate-600 active:bg-slate-100"
            aria-label="Back"
          >
            <ArrowLeft className="size-6" />
          </button>
        )}
        <div className={cn('min-w-0 flex-1', !back && 'px-3')}>
          <h1 className="truncate text-lg font-semibold leading-tight text-slate-900">{title}</h1>
          {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0 pr-1">{action}</div>}
      </div>
    </header>
  );
}
