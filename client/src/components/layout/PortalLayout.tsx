/**
 * The desktop portal shell, shared by Admin and the Service Center
 * (spec sections 4 and 21).
 *
 * Section 21 describes both the same way — left sidebar, top bar, search —
 * and differs only in what the navigation holds. So there is one shell and
 * each portal supplies its navigation, its search target and its quick action.
 * Desktop-first, but the sidebar collapses into a drawer below `lg` so a
 * portal still works on a tablet at a service counter.
 */
import { LogOut, Menu, Search, ShieldCheck, X, type LucideIcon } from 'lucide-react';
import { Suspense, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { ScreenErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Skeleton } from '@/components/ui/States';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/format';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export interface NavGroup {
  heading?: string;
  items: NavItem[];
}

export interface PortalConfig {
  /** Accessible name for the navigation, e.g. "Admin". */
  name: string;
  /** Shown under the product name in the sidebar. */
  subtitle: ReactNode;
  nav: NavGroup[];
  /** The complaint list the top-bar search lands on. */
  searchPath: string;
  /** Shown under the user's name. */
  roleLabel: string;
  /** One quick action in the top bar, if the portal has one. */
  action?: ReactNode;
}

function Sidebar({ config, onNavigate }: { config: PortalConfig; onNavigate?: () => void }) {
  return (
    <nav className="flex h-full flex-col bg-sidebar text-slate-300" aria-label={config.name}>
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
          <ShieldCheck className="size-4.5" />
        </div>
        <div className="min-w-0 leading-tight">
          <p className="text-sm font-semibold text-white">Cooler CRM</p>
          <p className="truncate text-xs text-slate-400">{config.subtitle}</p>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {config.nav.map((group, index) => (
          <div key={group.heading ?? index}>
            {group.heading && (
              <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {group.heading}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    {...(item.end ? { end: true } : {})}
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                    className={({ isActive }) =>
                      cn(
                        'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-sidebar-active text-white'
                          : 'text-slate-400 hover:bg-sidebar-hover hover:text-slate-100',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          className={cn(
                            'size-4 shrink-0',
                            isActive ? 'text-brand-500' : 'text-slate-500 group-hover:text-slate-300',
                          )}
                        />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

export function PortalLayout({ config }: { config: PortalConfig }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');

  /**
   * Search (section 21). Sends the term to the complaint list, which searches
   * complaint number, serial number and customer mobile — the three things
   * someone actually has in hand when a customer calls.
   */
  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    if (!term) return;
    navigate(`${config.searchPath}?search=${encodeURIComponent(term)}`);
  };

  const initials = (user?.name ?? '?')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full">
      {/* Fixed sidebar on desktop. */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="fixed inset-y-0 w-64">
          <Sidebar config={config} />
        </div>
      </aside>

      {/* Drawer below lg. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-slate-900/50"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 w-64">
            <Sidebar config={config} onNavigate={() => setDrawerOpen(false)} />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-3 top-4 rounded-md p-1 text-slate-400 hover:text-white"
              aria-label="Close menu"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            className="-ml-1 rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>

          <form onSubmit={onSearch} className="relative max-w-md flex-1" role="search">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search complaint no., serial no. or mobile"
              aria-label="Search complaints"
              className="h-9 w-full rounded-lg border-0 bg-slate-100 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </form>

          <div className="ml-auto flex items-center gap-3">
            {config.action && <div className="hidden sm:block">{config.action}</div>}

            <div className="flex items-center gap-2.5 border-l border-slate-200 pl-3">
              <div className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
                {initials}
              </div>
              <div className="hidden leading-tight md:block">
                <p className="text-sm font-medium text-slate-900">{user?.name}</p>
                <p className="text-xs text-slate-500">{config.roleLabel}</p>
              </div>
              <button
                type="button"
                onClick={logout}
                className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {/* Screens load lazily (App.tsx); the sidebar, header, search and
              sign-out stay mounted and usable while they do, and if the
              download fails, so there is always a way to another page. */}
          <ScreenErrorBoundary>
            <Suspense
              fallback={
                <div className="space-y-4" aria-busy aria-label="Loading">
                  <Skeleton className="h-8 w-56" />
                  <Skeleton className="h-64 rounded-xl" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ScreenErrorBoundary>
        </main>
      </div>
    </div>
  );
}
