/**
 * Service Center dashboard (spec section 9).
 *
 * Section 9 lists what the Owner should see: open complaints, new assignments,
 * technician-assigned jobs, today's and upcoming visits, waiting for parts,
 * revisits, submissions pending review, SLA breaches, technician workload and
 * low stock. Section 21 adds "operational dashboard" and "review queue".
 *
 * So the page has two halves. The **numbers** — stat tiles, each opening the
 * list it counted. And the **work queues** — the actual complaints waiting on
 * this centre, oldest first, because a dashboard that says "4 to review"
 * without showing which four sends the Owner hunting.
 *
 * Charts follow the same validated method as the Admin dashboard: counts are
 * tiles, and workload is a single-hue bar list.
 */
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarCheck2,
  CalendarClock,
  CalendarX2,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  PackageSearch,
  RotateCcw,
  Siren,
  Sparkles,
  Star,
  UserCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { BarList, StatTile } from '@/components/charts/Charts';
import { needsRebooking } from '@/components/complaint/ComplaintList';
import { PriorityBadge } from '@/components/ui/Badge';
import { Card, CardHeader, PageHeader } from '@/components/ui/Card';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn, fromNow, type ComplaintStatus, type Priority } from '@/lib/format';
import type { Complaint, Dashboard, Paged, PartRequestRow, StockRow, User, VisitCard } from '@/lib/types';
import dayjs from 'dayjs';
import { useTechnicians } from './shared';

/** Statuses that need something from the centre, fetched in one request. */
const QUEUE_STATUSES: ComplaintStatus[] = [
  'ASSIGNED',
  'REOPENED',
  'TECHNICIAN_ASSIGNED',
  'REVISIT_REQUIRED',
  'IN_PROGRESS',
  'RESOLUTION_SUBMITTED',
];

const PRIORITY_RANK: Record<Priority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/** Most urgent first, then longest waiting. */
const byUrgency = (a: Complaint, b: Complaint) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();

export function DashboardPage() {
  const navigate = useNavigate();

  const dashboard = useQuery({
    queryKey: ['dashboard', 'center'],
    queryFn: () => api<Dashboard>('/dashboard'),
  });

  const queue = useQuery({
    queryKey: ['complaints', 'center', 'queues'],
    queryFn: () =>
      api<Paged<Complaint>>('/complaints', {
        query: { status: QUEUE_STATUSES.join(','), sort: 'createdAt', limit: 100 },
      }),
  });

  /* "Waiting" is requested or approved but not yet issued — the same
     definition the tile's count uses (dashboard.service.ts,
     `WAITING_PART_REQUEST_STATUSES`) and the Parts page's Waiting tab. An
     approved request stayed here until it was issued, not until it was
     merely approved. */
  const requests = useQuery({
    queryKey: ['part-requests', 'waiting'],
    queryFn: () =>
      api<Paged<PartRequestRow>>('/parts/requests/list', { query: { status: 'REQUESTED,APPROVED', limit: 5 } }),
  });

  const lowStock = useQuery({
    queryKey: ['stock', 'low'],
    queryFn: () => api<Paged<StockRow>>('/parts/stock/list', { query: { lowOnly: true, limit: 8 } }),
  });

  const today = useQuery({
    queryKey: ['visits', 'today'],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', {
        query: {
          status: 'SCHEDULED',
          from: dayjs().startOf('day').toISOString(),
          to: dayjs().endOf('day').toISOString(),
          sort: 'asc',
          limit: 20,
        },
      }),
  });

  const technicians = useTechnicians();

  const openList = (query: Record<string, string>) =>
    navigate(`/center/complaints?${new URLSearchParams(query).toString()}`);

  const data = dashboard.data;
  const countOf = (status: ComplaintStatus) =>
    data?.breakdowns.byStatus.find((row) => row.label === status)?.count ?? 0;

  /* ---- Queues ---------------------------------------------------------- */
  const items = [...(queue.data?.items ?? [])].sort(byUrgency);
  const toAssign = items.filter((c) => c.status === 'ASSIGNED' || c.status === 'REOPENED');
  const toBook = items.filter(
    (c) => c.status === 'TECHNICIAN_ASSIGNED' || c.status === 'REVISIT_REQUIRED' || needsRebooking(c),
  );
  const toReview = items.filter((c) => c.status === 'RESOLUTION_SUBMITTED');

  const bookingReason = (complaint: Complaint) =>
    complaint.status === 'REVISIT_REQUIRED'
      ? 'Revisit'
      : needsRebooking(complaint)
        ? 'No work done last visit'
        : 'New';

  const technicianName = (id: string) =>
    technicians.data?.items.find((technician) => technician.id === id)?.name ?? 'Technician';

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={data ? `Updated ${fromNow(data.generatedAt)}` : 'Your service center at a glance'}
      />

      {dashboard.error && !data ? (
        <Card>
          <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
        </Card>
      ) : !data ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-6">
          {/* ---- The numbers (section 9) --------------------------------- */}
          <section aria-label="Key figures">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile
                label="Open complaints"
                value={data.kpis.totalOpen}
                icon={ClipboardList}
                onClick={() => openList({ open: 'true' })}
              />
              <StatTile
                label="New assignments"
                value={countOf('ASSIGNED') + countOf('REOPENED')}
                icon={Sparkles}
                hint="Need a technician"
                onClick={() => openList({ status: 'ASSIGNED,REOPENED' })}
              />
              <StatTile
                label="Technician assigned"
                value={countOf('TECHNICIAN_ASSIGNED')}
                icon={UserCheck}
                hint="Need a visit booked"
                onClick={() => openList({ status: 'TECHNICIAN_ASSIGNED' })}
              />
              <StatTile
                label="Today's visits"
                value={data.operations?.todaysVisits ?? 0}
                icon={CalendarCheck2}
                onClick={() => navigate('/center/visits')}
              />
              <StatTile
                label="Upcoming visits"
                value={data.operations?.upcomingVisits ?? 0}
                icon={CalendarClock}
                onClick={() => navigate('/center/visits?range=week')}
              />
              <StatTile
                label="Missed visits"
                value={data.operations?.missedVisits ?? 0}
                icon={CalendarX2}
                tone="alert"
                hint="Booked, never started"
                onClick={() => navigate('/center/visits?range=missed')}
              />
              <StatTile
                label="Pending review"
                value={data.operations?.pendingReview ?? 0}
                icon={ClipboardCheck}
                hint="Work submitted"
                onClick={() => openList({ status: 'RESOLUTION_SUBMITTED' })}
              />
              <StatTile
                label="Waiting for parts"
                value={data.kpis.waitingForParts}
                icon={PackageSearch}
                onClick={() => openList({ status: 'WAITING_FOR_PARTS' })}
              />
              <StatTile
                label="Revisit required"
                value={data.kpis.revisitRequired}
                icon={RotateCcw}
                onClick={() => openList({ status: 'REVISIT_REQUIRED' })}
              />
              <StatTile
                label="SLA breached"
                value={data.kpis.slaBreached}
                icon={Siren}
                tone="alert"
                onClick={() => openList({ slaBreached: 'true' })}
              />
              <StatTile
                label="Avg. rating"
                value={data.ratings.average}
                display={
                  data.ratings.average === null
                    ? 'Not rated yet'
                    : `${Number.isInteger(data.ratings.average) ? data.ratings.average : data.ratings.average.toFixed(1)} / 5`
                }
                icon={Star}
                hint={data.ratings.rated > 0 ? `from ${data.ratings.rated} rated` : undefined}
                onClick={() => openList({ status: 'CLOSED' })}
              />
            </div>
          </section>

          {/* ---- Work queues --------------------------------------------- */}
          <section aria-label="Needs your action" className="grid gap-6 lg:grid-cols-3">
            <QueueCard
              title="Assign a technician"
              empty="No new jobs waiting."
              loading={!queue.data && !queue.error}
              count={toAssign.length}
              viewAll={() => openList({ status: 'ASSIGNED,REOPENED' })}
            >
              {toAssign.slice(0, 5).map((complaint) => (
                <QueueRow
                  key={complaint.id}
                  complaint={complaint}
                  detail={complaint.status === 'REOPENED' ? 'Reopened' : `Assigned ${fromNow(complaint.updatedAt)}`}
                />
              ))}
            </QueueCard>

            <QueueCard
              title="Book a visit"
              empty="Every job has a visit booked."
              loading={!queue.data && !queue.error}
              count={toBook.length}
              alert={toBook.some(needsRebooking)}
              viewAll={() => openList({ status: 'TECHNICIAN_ASSIGNED,REVISIT_REQUIRED,IN_PROGRESS' })}
            >
              {toBook.slice(0, 5).map((complaint) => (
                <QueueRow
                  key={complaint.id}
                  complaint={complaint}
                  detail={bookingReason(complaint)}
                  warn={needsRebooking(complaint)}
                />
              ))}
            </QueueCard>

            <QueueCard
              title="Review submitted work"
              empty="Nothing waiting for review."
              loading={!queue.data && !queue.error}
              count={toReview.length}
              viewAll={() => openList({ status: 'RESOLUTION_SUBMITTED' })}
            >
              {toReview.slice(0, 5).map((complaint) => (
                <QueueRow
                  key={complaint.id}
                  complaint={complaint}
                  detail={`Submitted ${fromNow(complaint.lastResolutionSubmittedAt ?? complaint.updatedAt)}`}
                />
              ))}
            </QueueCard>
          </section>

          <section className="grid gap-6 lg:grid-cols-3">
            {/* Today's visits */}
            <Card>
              <CardHeader
                title="Today's visits"
                action={
                  <Link to="/center/visits" className="text-sm font-medium text-brand-700 hover:underline">
                    Schedule
                  </Link>
                }
              />
              {!today.data && !today.error ? (
                <div className="space-y-2 p-5">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : (today.data?.items ?? []).length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-slate-500">No visits booked for today.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {today.data!.items.map((visit) => (
                    <li key={visit.id}>
                      <Link
                        to={visit.complaint ? `/center/complaints/${visit.complaint.id}` : '/center/visits'}
                        className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"
                      >
                        <span className="tabular w-16 shrink-0 text-sm font-semibold text-slate-900">
                          {dayjs(visit.scheduledAt).format('h:mm A')}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-slate-900">
                            {visit.complaint?.customerName ?? 'Customer'}
                          </span>
                          <span className="block truncate text-xs text-slate-500">
                            {technicianName(visit.technicianId)} · {visit.complaint?.cityName}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-slate-300" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Technician workload (section 9) */}
            <Card>
              <CardHeader
                title="Technician workload"
                description="Open jobs each"
                action={
                  <Link to="/center/technicians" className="text-sm font-medium text-brand-700 hover:underline">
                    Technicians
                  </Link>
                }
              />
              <div className="px-5 py-5">
                {!technicians.data && !technicians.error ? (
                  <Skeleton className="h-24" />
                ) : (
                  <BarList data={workloadBars(technicians.data?.items ?? [])} emptyText="No open jobs with your technicians." />
                )}
              </div>
            </Card>

            {/* Parts: requests waiting and low stock (sections 9, 11) */}
            <Card>
              <CardHeader
                title="Parts"
                action={
                  <Link to="/center/parts" className="text-sm font-medium text-brand-700 hover:underline">
                    Parts & Inventory
                  </Link>
                }
              />
              <div className="divide-y divide-slate-100">
                <div className="px-5 py-4">
                  <Link
                    to="/center/parts"
                    className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-brand-700"
                  >
                    Requests waiting
                    <span className="tabular normal-case tracking-normal text-slate-900">
                      {data.operations?.pendingPartRequests ?? 0}
                    </span>
                  </Link>
                  {(requests.data?.items ?? []).length === 0 ? (
                    <p className="text-sm text-slate-500">None.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {requests.data!.items.map((row) => (
                        <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
                          <Link
                            to="/center/parts?tab=requests"
                            className="min-w-0 truncate text-slate-900 hover:text-brand-700"
                          >
                            {row.part?.name ?? 'Part'} × {row.quantityRequested}
                          </Link>
                          <span className="tabular shrink-0 text-xs text-slate-500">
                            {row.complaint?.complaintNumber}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="px-5 py-4">
                  <p className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500">
                    Low stock
                    <span
                      className={cn(
                        'tabular normal-case tracking-normal',
                        (data.operations?.lowStockParts ?? 0) > 0 ? 'text-red-600' : 'text-slate-900',
                      )}
                    >
                      {data.operations?.lowStockParts ?? 0}
                    </span>
                  </p>
                  {(lowStock.data?.items ?? []).length === 0 ? (
                    <p className="text-sm text-slate-500">All parts above their minimum.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {lowStock.data!.items.map((row) => (
                        <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex min-w-0 items-center gap-1.5 text-slate-900">
                            <AlertTriangle className="size-3.5 shrink-0 text-red-500" aria-hidden />
                            <span className="truncate">{row.partName}</span>
                          </span>
                          <span className="tabular shrink-0 text-xs text-slate-600">
                            {row.availableQuantity} left · min {row.minimumStock}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          </section>
        </div>
      )}
    </>
  );
}

/**
 * One bar per technician, busiest first.
 *
 * The bar's label is what a screen reader announces, so it is the name — with
 * the last digits of the mobile added only when two technicians share a name.
 */
function workloadBars(technicians: User[]) {
  const seen = new Map<string, number>();
  for (const technician of technicians) seen.set(technician.name, (seen.get(technician.name) ?? 0) + 1);

  return technicians
    .map((technician) => ({
      label:
        (seen.get(technician.name) ?? 0) > 1
          ? `${technician.name} (…${technician.mobile.slice(-4)})`
          : technician.name,
      count: technician.workload?.openJobs ?? 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/* ---- Queue card -------------------------------------------------------- */

function QueueCard({
  title,
  empty,
  count,
  loading,
  alert = false,
  viewAll,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  loading: boolean;
  alert?: boolean;
  viewAll: () => void;
  children: ReactNode;
}) {
  return (
    <Card className={cn(alert && 'border-amber-300')}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            <span
              className={cn(
                'tabular rounded-full px-2 py-0.5 text-xs font-semibold',
                count > 0 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500',
              )}
            >
              {count}
            </span>
          </span>
        }
        action={
          count > 5 ? (
            <button type="button" onClick={viewAll} className="text-sm font-medium text-brand-700 hover:underline">
              View all
            </button>
          ) : undefined
        }
      />
      {loading ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : count === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">{children}</ul>
      )}
    </Card>
  );
}

function QueueRow({
  complaint,
  detail,
  warn = false,
}: {
  complaint: Complaint;
  detail: string;
  warn?: boolean;
}) {
  const urgent = complaint.priority === 'CRITICAL' || complaint.priority === 'HIGH';

  return (
    <li>
      <Link
        to={`/center/complaints/${complaint.id}`}
        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="tabular text-sm font-medium text-slate-900">{complaint.complaintNumber}</span>
            {urgent && <PriorityBadge priority={complaint.priority} />}
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {complaint.customerSnapshot.name} · {complaint.serviceAddress.cityName}
          </span>
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs',
            warn ? 'font-medium text-amber-700' : 'text-slate-500',
          )}
        >
          {warn && <AlertTriangle className="size-3.5" aria-hidden />}
          {detail}
        </span>
      </Link>
    </li>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 11 }, (_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-[var(--radius-card)]" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-64 rounded-[var(--radius-card)]" />
        ))}
      </div>
    </div>
  );
}
