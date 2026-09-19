/**
 * My Jobs — the technician's home screen (spec section 10).
 *
 * Section 10 names the buckets: today, upcoming, pending, revisit, completed.
 * They are ordered here by what needs acting on first, not by the spec's list
 * order: a job already in progress is the one the technician is standing in
 * front of, so it comes before anything scheduled.
 *
 * Completed history lives on its own tab rather than at the bottom of this
 * list, so this screen stays a short answer to "what do I do next".
 *
 * Everything arrives in one request (`/visits/my-jobs`) — on patchy mobile
 * data, five requests for one screen is the difference between instant and
 * a spinner.
 */
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck2, RefreshCw, RotateCcw, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { TechHeader } from '@/components/layout/TechLayout';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { MyJobs } from '@/lib/types';
import dayjs from 'dayjs';
import { JobCard } from './JobCard';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function Section({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2.5 flex items-center gap-2 px-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {title}
        <span className="ml-auto rounded-full bg-slate-200/80 px-2 py-0.5 text-xs font-semibold text-slate-700">
          {count}
        </span>
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function MyJobsPage() {
  const { user } = useAuth();

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['my-jobs'],
    queryFn: () => api<MyJobs>('/visits/my-jobs'),
    /* A technician switching back to the app after a call should see current
       work without having to think about refreshing. */
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });

  const firstName = user?.name.split(' ')[0] ?? '';
  const nothing =
    data &&
    data.inProgress.length === 0 &&
    data.today.length === 0 &&
    data.revisitRequired.length === 0 &&
    data.upcoming.length === 0;

  return (
    <>
      <TechHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
        subtitle={dayjs().format('dddd, D MMMM')}
        action={
          <button
            type="button"
            onClick={() => void refetch()}
            className="flex size-11 items-center justify-center rounded-full text-slate-500 active:bg-slate-100"
            aria-label="Refresh jobs"
          >
            <RefreshCw className={isFetching ? 'size-5 animate-spin' : 'size-5'} />
          </button>
        }
      />

      <div className="px-4 pb-6 pt-4">
        {/* No data and no error is loading — or a request waiting to retry.
            Never "no jobs": that would be a claim the app cannot yet make. */}
        {!data && !error ? (
          <div className="space-y-3" aria-busy aria-label="Loading jobs">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : error && !data ? (
          <div className="rounded-2xl bg-white">
            <ErrorState error={error} onRetry={() => void refetch()} />
          </div>
        ) : data ? (
          <>
            {/* At-a-glance counts. */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Today', value: data.counts.today },
                { label: 'In progress', value: data.counts.inProgress },
                { label: 'Upcoming', value: data.counts.upcoming },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl bg-white p-3 text-center shadow-sm ring-1 ring-slate-200">
                  <p className="text-2xl font-semibold text-slate-900">{item.value}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{item.label}</p>
                </div>
              ))}
            </div>

            {nothing && (
              <div className="mt-10 flex flex-col items-center px-6 text-center">
                <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                  <CalendarCheck2 className="size-8" />
                </div>
                <p className="text-base font-semibold text-slate-900">No jobs right now</p>
                <p className="mt-1 text-sm text-slate-500">
                  New visits appear here as soon as your service center schedules them.
                </p>
              </div>
            )}

            {data.inProgress.length > 0 && (
              <Section title="In progress" count={data.inProgress.length} icon={<Wrench className="size-4" />}>
                {data.inProgress.map((visit) => (
                  <JobCard key={visit.id} visit={visit} emphasis />
                ))}
              </Section>
            )}

            {data.today.length > 0 && (
              <Section title="Today" count={data.today.length} icon={<CalendarCheck2 className="size-4" />}>
                {data.today.map((visit) => (
                  <JobCard key={visit.id} visit={visit} />
                ))}
              </Section>
            )}

            {data.revisitRequired.length > 0 && (
              <Section
                title="Sent back for revisit"
                count={data.revisitRequired.length}
                icon={<RotateCcw className="size-4" />}
              >
                {data.revisitRequired.map((visit) => (
                  <JobCard key={visit.complaint?.id ?? visit.id} visit={visit} />
                ))}
              </Section>
            )}

            {data.upcoming.length > 0 && (
              <Section title="Upcoming" count={data.upcoming.length} icon={<CalendarCheck2 className="size-4" />}>
                {data.upcoming.map((visit) => (
                  <JobCard key={visit.id} visit={visit} />
                ))}
              </Section>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
