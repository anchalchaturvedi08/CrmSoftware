/**
 * Profile (spec section 4: the technician's fourth tab).
 *
 * Deliberately small: who is signed in, their service center with a way to
 * call it, change password, sign out. The call button earns its place — "ring
 * the office" is the most common thing a technician does that is not a job.
 */
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight, KeyRound, LogOut, Phone, UserRound } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { TechHeader } from '@/components/layout/TechLayout';
import { Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMobile } from '@/lib/format';
import type { Paged, ServiceCenter } from '@/lib/types';

export function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  /* There is no single-centre endpoint; the directory is small and cached. */
  const centres = useQuery({
    queryKey: ['service-centers', 'directory'],
    queryFn: () => api<Paged<ServiceCenter>>('/service-centers', { query: { limit: 200 } }),
    enabled: Boolean(user?.serviceCenterId),
    staleTime: 60 * 60_000,
  });

  const centre = centres.data?.items.find((item) => item.id === user?.serviceCenterId);

  if (!user) return null;

  return (
    <>
      <TechHeader title="Profile" />

      <div className="space-y-4 px-4 pb-6 pt-4">
        <div className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <UserRound className="size-7" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-slate-900">{user.name}</p>
            <p className="tabular text-sm text-slate-500">{formatMobile(user.mobile)}</p>
            <p className="text-sm text-slate-500">Technician</p>
          </div>
        </div>

        {user.serviceCenterId && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <div className="flex items-start gap-3 p-4">
              <Building2 className="mt-0.5 size-5 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Your service center
                </p>
                {!centres.data && !centres.error ? (
                  <Skeleton className="mt-1.5 h-5 w-40" />
                ) : centre ? (
                  <>
                    <p className="mt-0.5 text-[15px] font-medium text-slate-900">{centre.name}</p>
                    <p className="text-sm text-slate-500">{centre.address}</p>
                  </>
                ) : (
                  <p className="mt-0.5 text-sm text-slate-500">Details unavailable</p>
                )}
              </div>
            </div>
            {centre && (
              <a
                href={`tel:+91${centre.mobile}`}
                className="flex h-14 items-center justify-center gap-2 border-t border-slate-100 text-base font-semibold text-brand-700 active:bg-slate-50"
              >
                <Phone className="size-5" />
                Call {formatMobile(centre.mobile)}
              </a>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <Link
            to="/tech/profile/password"
            className="flex min-h-14 items-center gap-3 px-4 active:bg-slate-50"
          >
            <KeyRound className="size-5 text-slate-400" />
            <span className="flex-1 text-[15px] font-medium text-slate-900">Change password</span>
            <ChevronRight className="size-5 text-slate-300" />
          </Link>
        </div>

        <button
          type="button"
          onClick={() => {
            logout();
            navigate('/login', { replace: true });
          }}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-white text-base font-semibold text-rose-700 shadow-sm ring-1 ring-slate-200 active:bg-rose-50"
        >
          <LogOut className="size-5" />
          Sign out
        </button>
      </div>
    </>
  );
}
