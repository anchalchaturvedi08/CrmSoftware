/**
 * Settings (spec section 4, Admin navigation).
 *
 * Section 4 names the page without saying what belongs on it. Two things do:
 *
 *  - **Your account**, including changing your own password — which Admin
 *    otherwise had no screen for.
 *  - **The rules in force**: when an account locks, how long a device stays
 *    signed in, how many Happy Code tries a complaint gets, how large a photo
 *    may be. Admin is who staff call when they are locked out, so the numbers
 *    come from the server's configuration, not from help text that can drift.
 *
 * The rules are read-only here. Loosening sign-in lockout from a web page
 * would let one stolen Admin session weaken sign-in for everyone.
 */
import { useQuery } from '@tanstack/react-query';
import { Camera, Clock, KeyRound, ShieldCheck, Smartphone, Timer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardHeader, Detail, PageHeader } from '@/components/ui/Card';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMobile } from '@/lib/format';
import type { SystemSettings } from '@/lib/types';

/** "15 minutes", "12 hours", "30 days". */
function duration(minutes: number | null): string | null {
  if (minutes === null) return null;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes >= 1_440 && minutes % 1_440 === 0) return plural(minutes / 1_440, 'day');
  if (minutes >= 60 && minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(Math.round(minutes), 'minute');
}

/** India Standard Time reads better than its zone name. */
const ZONE_NAMES: Record<string, string> = { 'Asia/Kolkata': 'India Standard Time' };

export function SettingsPage() {
  const { user } = useAuth();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SystemSettings>('/settings'),
    staleTime: 5 * 60_000,
  });

  const rules = settings.data;
  const staySignedIn = rules ? duration(rules.signIn.staySignedInMinutes) : null;

  return (
    <>
      <PageHeader title="Settings" description="Your account, and the rules the system runs by." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Your account" />
          <dl className="grid gap-4 px-5 py-5 sm:grid-cols-2">
            <Detail label="Name">{user?.name ?? '—'}</Detail>
            <Detail label="Mobile (for signing in)">
              <span className="tabular">{formatMobile(user?.mobile)}</span>
            </Detail>
            <Detail label="Role">Administrator</Detail>
          </dl>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-5 py-4">
            <Link
              to="/admin/settings/password"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            >
              <KeyRound className="size-4" aria-hidden />
              Change password
            </Link>
            <p className="text-sm text-slate-500">You will be signed out everywhere afterwards.</p>
          </div>
        </Card>

        {settings.error && !rules ? (
          <Card>
            <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
          </Card>
        ) : !rules ? (
          <Card>
            <div className="space-y-3 p-5" aria-busy aria-label="Loading settings">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          </Card>
        ) : (
          <Card>
            <CardHeader title="Signing in" />
            <ul className="divide-y divide-slate-100">
              <Rule icon={<KeyRound className="size-4" />}>
                Passwords need at least <strong>{rules.signIn.passwordMinLength} characters</strong>. A few words
                together work well.
              </Rule>
              <Rule icon={<ShieldCheck className="size-4" />}>
                After <strong>{rules.signIn.maxFailedAttempts} wrong passwords</strong>, an account locks for{' '}
                <strong>{duration(rules.signIn.lockoutMinutes)}</strong>.
                <span className="mt-1 block text-slate-500">
                  To unlock someone sooner, reset their password from{' '}
                  <Link to="/admin/technicians" className="font-medium text-brand-700 hover:underline">
                    Technicians &amp; Users
                  </Link>
                  .
                </span>
              </Rule>
              {staySignedIn && (
                <Rule icon={<Smartphone className="size-4" />}>
                  A device stays signed in for up to <strong>{staySignedIn}</strong> without signing in again.
                  Changing a password signs that person out everywhere.
                </Rule>
              )}
            </ul>
          </Card>
        )}

        {rules && (
          <>
            <Card>
              <CardHeader title="Complaints" />
              <ul className="divide-y divide-slate-100">
                <Rule icon={<ShieldCheck className="size-4" />}>
                  Happy Codes have <strong>{rules.happyCode.digits} digits</strong>. After{' '}
                  <strong>{rules.happyCode.maxAttempts} wrong tries</strong> the code locks, and a new one can be
                  issued from the complaint.
                </Rule>
                <Rule icon={<Timer className="size-4" />}>
                  Response and resolution targets are set per priority on the{' '}
                  <Link to="/admin/sla" className="font-medium text-brand-700 hover:underline">
                    SLA page
                  </Link>
                  .
                </Rule>
                <Rule icon={<Camera className="size-4" />}>
                  Photos from technicians can be up to <strong>{rules.attachments.maxFileMb} MB</strong> each.
                </Rule>
              </ul>
            </Card>

            <Card>
              <CardHeader title="Time" />
              <ul className="divide-y divide-slate-100">
                <Rule icon={<Clock className="size-4" />}>
                  Dates and times are shown in <strong>{ZONE_NAMES[rules.timezone] ?? rules.timezone}</strong>, and
                  reports count days in it.
                </Rule>
              </ul>
            </Card>
          </>
        )}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        These rules come from the server’s configuration and change when the server is restarted with new values.
      </p>
    </>
  );
}

function Rule({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 px-5 py-4 text-sm text-slate-700">
      <span className="mt-0.5 shrink-0 text-slate-400" aria-hidden>
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}
