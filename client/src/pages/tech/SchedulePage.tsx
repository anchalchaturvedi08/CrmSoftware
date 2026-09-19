/**
 * Schedule — every booked visit, by day (spec section 10).
 *
 * My Jobs answers "what now"; this answers "what is my week". So it is a plain
 * agenda: one heading per day, one row per visit, time first. A calendar grid
 * would put seven columns on a phone and a technician's day in a cell the size
 * of a fingernail.
 *
 * Missed visits — booked for a day that has passed and never started — lead
 * the list under their own heading rather than being mixed into history.
 */
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CalendarDays, ChevronRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { TechHeader } from '@/components/layout/TechLayout';
import { PriorityBadge } from '@/components/ui/Badge';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import type { Paged, VisitCard } from '@/lib/types';
import dayjs from 'dayjs';

interface Day {
  key: string;
  label: string;
  missed: boolean;
  visits: VisitCard[];
}

function dayLabel(date: dayjs.Dayjs): string {
  if (date.isSame(dayjs(), 'day')) return 'Today';
  if (date.isSame(dayjs().add(1, 'day'), 'day')) return 'Tomorrow';
  return date.format('dddd, D MMMM');
}

/** Groups visits (already in time order) under one heading per day. */
function byDay(visits: VisitCard[]): Day[] {
  const days: Day[] = [];
  const startOfToday = dayjs().startOf('day');

  for (const visit of visits) {
    const date = dayjs(visit.scheduledAt);
    const missed = date.isBefore(startOfToday);
    /* All missed visits share one heading: which past day matters less than
       the fact that they were missed. */
    const key = missed ? 'missed' : date.format('YYYY-MM-DD');

    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: missed ? 'Missed' : dayLabel(date), missed, visits: [] };
      days.push(day);
    }
    day.visits.push(visit);
  }

  return days;
}

export function SchedulePage() {
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['visits', 'schedule'],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', { query: { status: 'SCHEDULED', sort: 'asc', limit: 200 } }),
    refetchOnWindowFocus: true,
  });

  const days = data ? byDay(data.items.filter((visit) => visit.complaint)) : [];

  return (
    <>
      <TechHeader
        title="Schedule"
        subtitle={data ? `${data.total} booked ${data.total === 1 ? 'visit' : 'visits'}` : undefined}
        action={
          <button
            type="button"
            onClick={() => void refetch()}
            className="flex size-11 items-center justify-center rounded-full text-slate-500 active:bg-slate-100"
            aria-label="Refresh schedule"
          >
            <RefreshCw className={isFetching ? 'size-5 animate-spin' : 'size-5'} />
          </button>
        }
      />

      <div className="px-4 pb-6 pt-2">
        {!data && !error ? (
          <div className="mt-4 space-y-3" aria-busy aria-label="Loading schedule">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        ) : error && !data ? (
          <div className="mt-4 rounded-2xl bg-white">
            <ErrorState error={error} onRetry={() => void refetch()} />
          </div>
        ) : days.length === 0 ? (
          <div className="mt-16 flex flex-col items-center px-6 text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-brand-50 text-brand-700">
              <CalendarDays className="size-8" />
            </div>
            <p className="text-base font-semibold text-slate-900">Nothing booked</p>
            <p className="mt-1 text-sm text-slate-500">
              Visits your service center books for you will appear here.
            </p>
          </div>
        ) : (
          days.map((day) => (
            <section key={day.key} className="mt-5">
              <h2
                className={cn(
                  'mb-2 flex items-center gap-1.5 px-1 text-sm font-semibold',
                  day.missed ? 'text-rose-700' : 'text-slate-500',
                )}
              >
                {day.missed && <AlertCircle className="size-4" />}
                {day.label}
                <span className="ml-auto text-xs font-medium text-slate-400">
                  {day.visits.length} {day.visits.length === 1 ? 'visit' : 'visits'}
                </span>
              </h2>

              <ul className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                {day.visits.map((visit) => {
                  const complaint = visit.complaint!;
                  const urgent = complaint.priority === 'HIGH' || complaint.priority === 'CRITICAL';

                  return (
                    <li key={visit.id} className="border-b border-slate-100 last:border-0">
                      <Link
                        to={`/tech/jobs/${complaint.id}`}
                        className="flex min-h-[4.5rem] items-center gap-3 px-4 py-3 active:bg-slate-50"
                      >
                        <span
                          className={cn(
                            'tabular w-[4.5rem] shrink-0 text-sm font-semibold',
                            day.missed ? 'text-rose-700' : 'text-slate-900',
                          )}
                        >
                          {day.missed
                            ? dayjs(visit.scheduledAt).format('D MMM')
                            : dayjs(visit.scheduledAt).format('h:mm A')}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium text-slate-900">
                            {complaint.customerName}
                          </span>
                          <span className="block truncate text-sm text-slate-500">
                            {complaint.cityName} · {complaint.category}
                          </span>
                        </span>
                        {urgent && <PriorityBadge priority={complaint.priority} />}
                        <ChevronRight className="size-5 shrink-0 text-slate-300" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );
}
