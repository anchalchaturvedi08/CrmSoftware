/**
 * Visits / Schedule (spec sections 4 and 9, "Visit management").
 *
 * Section 9: schedule, reschedule, view calendar/list, track visit status,
 * view technician assignment. The Service Center portal sees its own centre;
 * Admin sees every centre, with a centre filter and the centre named on each
 * visit. The server scopes the data either way — this page only chooses what
 * to offer.
 *
 * It is an agenda — one heading per day, a row per visit — rather than a
 * month grid. A day is a handful of visits per technician, and a grid would
 * bury the customer, the address and the technician in cells too small to
 * hold them, which are the three things being checked.
 *
 * Two things are pulled out beside the agenda because they need a decision
 * today: who is **on site right now**, and visits that were **missed** —
 * booked for a day that has passed and never started. "Past 7 days" shows how
 * recent visits ended, so a run of "nobody home" is visible, not buried in
 * each complaint's history.
 */
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { AlertTriangle, CalendarDays, CheckCircle2, MapPin, UserX, Wrench, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useServiceCenters } from '@/components/records/Records';
import { Badge, PriorityBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, PageHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { NO_WORK_REASON, cn, fromNow } from '@/lib/format';
import type { Paged, User, VisitCard } from '@/lib/types';
import { CancelVisitDialog, RescheduleVisitDialog } from './VisitDialogs';

export type SchedulePortal = 'admin' | 'center';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'all', label: 'All upcoming' },
  { key: 'missed', label: 'Missed' },
  { key: 'past', label: 'Past 7 days' },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

/** The booked-time window each range covers. */
function bounds(range: RangeKey): { from?: string; to?: string } {
  const today = dayjs().startOf('day');
  switch (range) {
    case 'today':
      return { from: today.toISOString(), to: today.endOf('day').toISOString() };
    case 'tomorrow':
      return { from: today.add(1, 'day').toISOString(), to: today.add(1, 'day').endOf('day').toISOString() };
    case 'week':
      return { from: today.toISOString(), to: today.add(6, 'day').endOf('day').toISOString() };
    case 'all':
      return { from: today.toISOString() };
    case 'missed':
      /* Anything still booked before today started. */
      return { to: today.subtract(1, 'millisecond').toISOString() };
    case 'past':
      return { from: today.subtract(6, 'day').toISOString(), to: today.endOf('day').toISOString() };
  }
}

function dayHeading(date: dayjs.Dayjs): string {
  if (date.isSame(dayjs(), 'day')) return 'Today';
  if (date.isSame(dayjs().add(1, 'day'), 'day')) return 'Tomorrow';
  if (date.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Yesterday';
  return date.format('dddd, D MMMM');
}

/** Rows a single request returns; beyond this the page asks for a narrower filter. */
const PAGE_LIMIT = 200;

const SELECT =
  'h-9 max-w-[240px] rounded-lg border-0 bg-white pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600';

export function VisitSchedule({ portal }: { portal: SchedulePortal }) {
  const [params, setParams] = useSearchParams();
  const range = (RANGES.find((r) => r.key === params.get('range'))?.key ?? 'today') as RangeKey;
  const serviceCenterId = portal === 'admin' ? (params.get('serviceCenterId') ?? '') : '';
  const technicianId = params.get('technicianId') ?? '';
  const past = range === 'past';

  const [moving, setMoving] = useState<VisitCard | null>(null);
  const [cancelling, setCancelling] = useState<VisitCard | null>(null);

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
  };

  /* Scoped by the server: an Owner gets their own technicians, Admin everyone's. */
  const technicians = useQuery({
    queryKey: ['technicians', 'all'],
    queryFn: () =>
      api<Paged<User>>('/users', { query: { role: 'TECHNICIAN', limit: 100, includeInactive: true } }),
  });
  const centres = useServiceCenters({ includeInactive: true });

  const technicianOptions = (technicians.data?.items ?? [])
    .filter((technician) => !serviceCenterId || technician.serviceCenterId === serviceCenterId)
    .sort((a, b) => a.name.localeCompare(b.name));

  const scope = {
    ...(serviceCenterId ? { serviceCenterId } : {}),
    ...(technicianId ? { technicianId } : {}),
  };

  const agenda = useQuery({
    queryKey: ['visits', 'agenda', range, scope],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', {
        query: {
          status: past ? 'COMPLETED,CANCELLED' : 'SCHEDULED',
          ...bounds(range),
          ...scope,
          /* A schedule reads forwards; history reads back from today. */
          sort: past ? 'desc' : 'asc',
          limit: PAGE_LIMIT,
        },
      }),
  });

  const onSite = useQuery({
    queryKey: ['visits', 'on-site', scope],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', {
        query: { status: 'IN_PROGRESS', ...scope, sort: 'desc', limit: 50 },
      }),
  });

  /* Missed visits are always counted, whatever range is open, so they cannot
     hide behind "Today". */
  const missed = useQuery({
    queryKey: ['visits', 'missed-count', scope],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', {
        query: { status: 'SCHEDULED', ...bounds('missed'), ...scope, limit: 1 },
      }),
  });

  /* Group by day, in the order the server returned. */
  const days: Array<{ key: string; label: string; visits: VisitCard[] }> = [];
  for (const visit of agenda.data?.items ?? []) {
    const date = dayjs(visit.scheduledAt);
    const key = date.format('YYYY-MM-DD');
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: dayHeading(date), visits: [] };
      days.push(day);
    }
    day.visits.push(visit);
  }

  const missedCount = missed.data?.total ?? 0;
  const total = agenda.data?.total ?? 0;
  const shown = agenda.data?.items.length ?? 0;

  return (
    <>
      <PageHeader
        title="Visits / Schedule"
        description={
          agenda.data
            ? `${total} ${total === 1 ? 'visit' : 'visits'}${portal === 'admin' && !serviceCenterId ? ' across all service centers' : ''}`
            : portal === 'admin'
              ? 'Every service center’s visits'
              : undefined
        }
      />

      {/* One filter row. */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {/* Six buttons do not fit a phone, and a scrolled strip hides the one
            that is selected — so a phone gets the same choice as a list. */}
        <select
          value={range}
          onChange={(event) => update({ range: event.target.value === 'today' ? '' : event.target.value })}
          aria-label="Which visits"
          className={cn(SELECT, 'sm:hidden')}
        >
          {RANGES.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
              {option.key === 'missed' && missedCount > 0 ? ` (${missedCount})` : ''}
            </option>
          ))}
        </select>

        <div className="hidden max-w-full overflow-x-auto sm:block">
          <div className="inline-flex rounded-lg bg-white p-1 ring-1 ring-slate-200" role="radiogroup" aria-label="Which visits">
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={range === option.key}
                onClick={() => update({ range: option.key === 'today' ? '' : option.key })}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  range === option.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {option.label}
                {option.key === 'missed' && missedCount > 0 && (
                  <span
                    className={cn(
                      'tabular rounded-full px-1.5 text-xs font-semibold',
                      range === 'missed' ? 'bg-white text-red-700' : 'bg-red-100 text-red-700',
                    )}
                  >
                    {missedCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {portal === 'admin' && (
          <select
            value={serviceCenterId}
            /* A technician belongs to one centre, so a new centre clears them. */
            onChange={(event) => update({ serviceCenterId: event.target.value, technicianId: '' })}
            aria-label="Filter by service center"
            className={SELECT}
          >
            <option value="">All service centers</option>
            {[...(centres.data?.items ?? [])]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.name}
                  {centre.isActive ? '' : ' (inactive)'}
                </option>
              ))}
          </select>
        )}

        <select
          value={technicianId}
          onChange={(event) => update({ technicianId: event.target.value })}
          aria-label="Filter by technician"
          className={SELECT}
        >
          <option value="">All technicians</option>
          {technicianOptions.map((technician) => (
            <option key={technician.id} value={technician.id}>
              {technician.name}
              {technician.isActive ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---- Agenda ---------------------------------------------------- */}
        <div className="space-y-6 lg:col-span-2">
          {agenda.error && !agenda.data ? (
            <Card>
              <ErrorState error={agenda.error} onRetry={() => void agenda.refetch()} />
            </Card>
          ) : !agenda.data ? (
            <Card>
              <div className="space-y-3 p-5" aria-busy aria-label="Loading visits">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            </Card>
          ) : days.length === 0 ? (
            <Card>
              <EmptyState
                icon={<CalendarDays className="size-5" />}
                title={range === 'missed' ? 'No missed visits' : past ? 'No visits in the past 7 days' : 'No visits booked'}
                description={
                  range === 'missed'
                    ? 'Every booked visit was started on its day.'
                    : past
                      ? 'Finished and cancelled visits will show here.'
                      : portal === 'admin'
                        ? 'Service centers book visits from a complaint once a technician is assigned.'
                        : 'Book visits from a complaint once a technician is assigned.'
                }
              />
            </Card>
          ) : (
            <>
              {days.map((day) => (
                <Card key={day.key} className={cn(range === 'missed' && 'border-red-200')}>
                  <CardHeader
                    title={day.label}
                    description={`${day.visits.length} ${day.visits.length === 1 ? 'visit' : 'visits'}`}
                  />
                  <ul className="divide-y divide-slate-100">
                    {day.visits.map((visit) => (
                      <VisitRow
                        key={visit.id}
                        visit={visit}
                        portal={portal}
                        missed={range === 'missed'}
                        onMove={past ? undefined : () => setMoving(visit)}
                        onCancel={past ? undefined : () => setCancelling(visit)}
                      />
                    ))}
                  </ul>
                </Card>
              ))}
              {total > shown && (
                <p className="text-sm text-slate-500">
                  Showing the first {shown} of {total} visits. Choose a
                  {portal === 'admin' ? ' service center or' : ''} technician to see the rest.
                </p>
              )}
            </>
          )}
        </div>

        {/* ---- Side: now and needs attention ----------------------------- */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="On site now" />
            {!onSite.data && !onSite.error ? (
              <div className="p-5">
                <Skeleton className="h-10" />
              </div>
            ) : (onSite.data?.items ?? []).length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500">No technician is on a visit right now.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {onSite.data!.items.map((visit) => (
                  <li key={visit.id}>
                    <Link
                      to={visit.complaint ? `/${portal}/complaints/${visit.complaint.id}` : `/${portal}/visits`}
                      className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"
                    >
                      <Wrench className="size-4 shrink-0 text-amber-600" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-900">
                          {visit.technicianName ?? 'Technician'}
                          {portal === 'admin' && visit.serviceCenterName && (
                            <span className="text-slate-500"> · {visit.serviceCenterName}</span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {visit.complaint?.customerName} · started {fromNow(visit.startedAt)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {range !== 'missed' && missedCount > 0 && (
            <Card className="border-red-200">
              <div className="flex items-start gap-3 px-5 py-4">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden />
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {missedCount} missed {missedCount === 1 ? 'visit' : 'visits'}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-600">
                    Booked for an earlier day and never started.{' '}
                    {portal === 'admin'
                      ? 'Check with the service center, or reschedule for the customer.'
                      : 'Check with the technician and reschedule.'}
                  </p>
                  <Button size="sm" variant="secondary" className="mt-3" onClick={() => update({ range: 'missed' })}>
                    Show missed visits
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

      {moving && (
        <RescheduleVisitDialog visitId={moving.id} currentAt={moving.scheduledAt} open onClose={() => setMoving(null)} />
      )}
      {cancelling && <CancelVisitDialog visitId={cancelling.id} open onClose={() => setCancelling(null)} />}
    </>
  );
}

/* ---- One visit ---------------------------------------------------------- */

function VisitRow({
  visit,
  portal,
  missed,
  onMove,
  onCancel,
}: {
  visit: VisitCard;
  portal: SchedulePortal;
  missed: boolean;
  /** Absent for visits that are over. */
  onMove: (() => void) | undefined;
  onCancel: (() => void) | undefined;
}) {
  const complaint = visit.complaint;
  const urgent = complaint?.priority === 'HIGH' || complaint?.priority === 'CRITICAL';

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <span className={cn('tabular w-20 shrink-0 text-sm font-semibold', missed ? 'text-red-700' : 'text-slate-900')}>
        {dayjs(visit.scheduledAt).format('h:mm A')}
      </span>

      <div className="min-w-[200px] flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {complaint ? (
            <Link
              to={`/${portal}/complaints/${complaint.id}`}
              className="tabular font-medium text-slate-900 hover:text-brand-700"
            >
              {complaint.complaintNumber}
            </Link>
          ) : (
            <span className="text-slate-500">Complaint unavailable</span>
          )}
          {urgent && complaint && <PriorityBadge priority={complaint.priority} />}
          {!onMove && <Outcome visit={visit} />}
        </p>
        {complaint && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
            <MapPin className="size-3 shrink-0" aria-hidden />
            {complaint.customerName} · {complaint.cityName} · {complaint.category}
          </p>
        )}
      </div>

      <div className="w-40 min-w-0">
        <p className="truncate text-sm text-slate-700">{visit.technicianName ?? 'Technician'}</p>
        {portal === 'admin' && visit.serviceCenterName && (
          <p className="truncate text-xs text-slate-500">{visit.serviceCenterName}</p>
        )}
      </div>

      {onMove && onCancel && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={onMove}>
            Reschedule
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

/** How a finished visit ended — a trip with nobody home is not a repair. */
function Outcome({ visit }: { visit: VisitCard }) {
  if (visit.status === 'CANCELLED') {
    return (
      <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20">
        <XCircle className="size-3" aria-hidden />
        Cancelled
      </Badge>
    );
  }

  if (visit.customerAvailability && visit.customerAvailability !== 'CUSTOMER_AVAILABLE') {
    return (
      <Badge className="bg-amber-50 text-amber-800 ring-amber-600/25">
        <UserX className="size-3" aria-hidden />
        {NO_WORK_REASON[visit.customerAvailability]}
      </Badge>
    );
  }

  return (
    <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-600/20">
      <CheckCircle2 className="size-3" aria-hidden />
      {visit.resolutionResult ? 'Work done' : 'Completed'}
    </Badge>
  );
}
