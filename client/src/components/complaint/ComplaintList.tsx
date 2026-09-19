/**
 * Complaint list, for Admin and the Service Center (spec sections 5, 9, 16).
 *
 * Filters live in the URL rather than in component state. That is what lets a
 * dashboard tile link straight to "?status=WAITING_FOR_PARTS", lets the top-bar
 * search land here already filtered, and means a filtered view can be
 * bookmarked, shared, or survive a reload.
 *
 * Search, filtering and paging all happen on the server — section 19: "Avoid
 * loading all complaints into browser".
 *
 * The two portals differ where section 9 says they should. The centre's list
 * adds the technician and visit date columns and a technician filter; only
 * Admin can create complaints, so only Admin gets the button.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useServiceCenters } from '@/components/records/Records';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { ContactButtons } from '@/components/ui/ContactButtons';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import {
  cn,
  formatDate,
  formatDuration,
  formatMobile,
  PRIORITY_META,
  STATUS_META,
  type ComplaintStatus,
  type Priority,
} from '@/lib/format';
import type { Complaint, Paged, User } from '@/lib/types';
import dayjs from 'dayjs';

const PAGE_SIZE = 20;

export type Portal = 'admin' | 'center';

const SELECT =
  'h-9 rounded-lg border-0 pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600';

/** SLA shown as a compact, colour-plus-text cell. */
function SlaCell({ complaint }: { complaint: Complaint }) {
  const snapshot = complaint.slaSnapshot;

  if (complaint.status === 'CLOSED' || complaint.status === 'CANCELLED') {
    return <span className="text-slate-400">—</span>;
  }
  if (!snapshot) return <span className="text-slate-400">—</span>;
  if (snapshot.state === 'PAUSED') {
    return <span className="text-slate-500">Paused</span>;
  }

  const remaining = snapshot.resolutionRemainingMs;
  const breached = snapshot.resolutionBreached;
  /* Under six hours left counts as at risk. */
  const atRisk = !breached && remaining !== null && remaining < 6 * 3_600_000;

  return (
    <span
      className={cn(
        'tabular whitespace-nowrap text-sm',
        breached ? 'font-medium text-red-600' : atRisk ? 'text-amber-700' : 'text-slate-600',
      )}
    >
      {formatDuration(remaining)}
    </span>
  );
}

/**
 * True when a complaint says "in progress" but nobody is working it: the last
 * visit ended without work (customer out) and nothing new is booked.
 */
export function needsRebooking(complaint: Complaint): boolean {
  return complaint.status === 'IN_PROGRESS' && !complaint.currentVisit;
}

/** The visit column: when it is booked, or that it is under way. */
function VisitCell({ complaint }: { complaint: Complaint }) {
  const visit = complaint.currentVisit;

  if (needsRebooking(complaint)) {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-amber-700">
        <AlertTriangle className="size-3.5" />
        Needs rebooking
      </span>
    );
  }
  if (!visit) return <span className="text-slate-400">—</span>;

  if (visit.status === 'IN_PROGRESS') {
    return <span className="whitespace-nowrap text-sm text-slate-700">On site now</span>;
  }

  const date = dayjs(visit.scheduledAt);
  const missed = date.isBefore(dayjs(), 'day');

  return (
    <span className={cn('tabular whitespace-nowrap text-sm', missed ? 'font-medium text-red-600' : 'text-slate-700')}>
      {date.format('D MMM, h:mm A')}
      {missed && ' · missed'}
    </span>
  );
}

export function ComplaintList({ portal }: { portal: Portal }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const base = portal === 'admin' ? '/admin/complaints' : '/center/complaints';
  const center = portal === 'center';

  const search = params.get('search') ?? '';
  const status = params.get('status') ?? '';
  const priority = params.get('priority') ?? '';
  const warrantyStatus = params.get('warrantyStatus') ?? '';
  const technicianId = params.get('technicianId') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  /* These four only ever arrive as a link — a dashboard tile, a service
     center's own page — never from a control on this screen, which is why
     they show as removable chips instead of a dropdown (below). Read and sent
     under exactly the names the server's query understands
     (complaint.validation.ts). */
  const open = params.get('open') === 'true';
  const slaBreached = params.get('slaBreached') === 'true';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  /* Only Admin's scope spans more than one centre, so only Admin can usefully
     narrow to one — a centre Owner is already confined to their own. */
  const serviceCenterId = portal === 'admin' ? (params.get('serviceCenterId') ?? '') : '';

  /* The input is local so typing does not fire a request per keystroke; it is
     committed to the URL on submit. */
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);

  /** Updates one filter, resetting to page 1 so a new filter never opens on an empty page. */
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    setFilter('search', draft.trim());
  };

  const hasFilters = Boolean(
    search ||
      status ||
      priority ||
      warrantyStatus ||
      technicianId ||
      open ||
      slaBreached ||
      from ||
      to ||
      serviceCenterId,
  );

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: [
      'complaints',
      portal,
      { search, status, priority, warrantyStatus, technicianId, open, slaBreached, from, to, serviceCenterId, page },
    ],
    queryFn: () =>
      api<Paged<Complaint>>('/complaints', {
        query: {
          search,
          status,
          priority,
          warrantyStatus,
          technicianId,
          open: open || undefined,
          slaBreached: slaBreached || undefined,
          from: from || undefined,
          to: to || undefined,
          serviceCenterId: serviceCenterId || undefined,
          page,
          limit: PAGE_SIZE,
        },
      }),
    placeholderData: keepPreviousData,
  });

  /* The centre's own technicians, for the filter dropdown and — on the centre
     portal — the technicianId chip's name. Inactive ones stay listed: their
     past jobs are still searchable. */
  const technicians = useQuery({
    queryKey: ['technicians', 'all'],
    queryFn: () =>
      api<Paged<User>>('/users', { query: { role: 'TECHNICIAN', includeInactive: true, limit: 100 } }),
    enabled: center,
    staleTime: 5 * 60_000,
  });

  /* Admin has no such list loaded (it would span every centre), so a
     technicianId arriving on the Admin portal — from a service center's own
     page — is named with a single lookup instead. */
  const technicianLookup = useQuery({
    queryKey: ['user', technicianId],
    queryFn: () => api<User>(`/users/${technicianId}`),
    enabled: portal === 'admin' && Boolean(technicianId),
    staleTime: 5 * 60_000,
  });

  const technicianName = center
    ? technicians.data?.items.find((t) => t.id === technicianId)?.name
    : technicianLookup.data?.name;

  /* Every service centre, for the Admin-only filter dropdown below. */
  const centres = useServiceCenters({ includeInactive: true });

  /* A status in the URL may be a comma-separated set from a dashboard queue;
     the dropdown can only show one, so a set reads as "Several". */
  const statusIsSet = status.includes(',');

  /* Until a name has loaded, the chip says "…" rather than showing a raw id.
     serviceCenterId is deliberately left out here: on Admin it now has its
     own dropdown (below), so a chip would just repeat that selection — the
     same reason status/priority/warrantyStatus never grow a matching chip. */
  const linkedChips: Array<{ key: string; prefix?: string; label: string }> = [];
  if (open) linkedChips.push({ label: 'Open only', key: 'open' });
  if (slaBreached) linkedChips.push({ label: 'SLA breached', key: 'slaBreached' });
  if (from) linkedChips.push({ prefix: 'From', label: formatDate(from), key: 'from' });
  if (to) linkedChips.push({ prefix: 'To', label: formatDate(to), key: 'to' });
  if (technicianId) linkedChips.push({ prefix: 'Technician', label: technicianName ?? '…', key: 'technicianId' });

  return (
    <>
      <PageHeader
        title={center ? 'My Complaints' : 'Complaints'}
        description={
          data ? `${data.total.toLocaleString('en-IN')} ${data.total === 1 ? 'complaint' : 'complaints'}` : undefined
        }
        actions={
          center ? undefined : (
            <Button icon={<Plus className="size-4" />} onClick={() => navigate('/admin/complaints/new')}>
              New complaint
            </Button>
          )
        }
      />

      {/* One filter row, above the table it scopes. */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 p-3">
          <form onSubmit={onSearch} className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Complaint no., serial no. or customer mobile"
              aria-label="Search"
              className="h-9 w-full rounded-lg border-0 pl-9 pr-3 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </form>

          <select
            value={statusIsSet ? '__set' : status}
            onChange={(event) => setFilter('status', event.target.value)}
            aria-label="Filter by status"
            className={SELECT}
          >
            <option value="">All statuses</option>
            {statusIsSet && (
              <option value="__set" disabled>
                Several statuses
              </option>
            )}
            {(Object.keys(STATUS_META) as ComplaintStatus[])
              /* NEW never reaches a centre: it has no centre yet. */
              .filter((key) => !(center && key === 'NEW'))
              .map((key) => (
                <option key={key} value={key}>
                  {STATUS_META[key].label}
                </option>
              ))}
          </select>

          <select
            value={priority}
            onChange={(event) => setFilter('priority', event.target.value)}
            aria-label="Filter by priority"
            className={SELECT}
          >
            <option value="">All priorities</option>
            {(Object.keys(PRIORITY_META) as Priority[]).map((key) => (
              <option key={key} value={key}>
                {PRIORITY_META[key].label}
              </option>
            ))}
          </select>

          {center && (
            <select
              value={technicianId}
              onChange={(event) => setFilter('technicianId', event.target.value)}
              aria-label="Filter by technician"
              className={SELECT}
            >
              <option value="">All technicians</option>
              {(technicians.data?.items ?? []).map((technician) => (
                <option key={technician.id} value={technician.id}>
                  {technician.name}
                  {technician.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          )}

          {/* Only Admin's scope spans more than one centre — the centre
              portal is already scoped to its own by the server, so offering
              this control there would filter nothing. */}
          {!center && (
            <select
              value={serviceCenterId}
              onChange={(event) => setFilter('serviceCenterId', event.target.value)}
              aria-label="Filter by service center"
              className={SELECT}
            >
              <option value="">All centers</option>
              {(centres.data?.items ?? []).map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.name}
                  {centre.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          )}

          <select
            value={warrantyStatus}
            onChange={(event) => setFilter('warrantyStatus', event.target.value)}
            aria-label="Filter by warranty"
            className={SELECT}
          >
            <option value="">Any warranty</option>
            <option value="IN_WARRANTY">In warranty</option>
            <option value="OUT_OF_WARRANTY">Out of warranty</option>
          </select>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X className="size-3.5" />}
              onClick={() => setParams(new URLSearchParams())}
            >
              Clear
            </Button>
          )}
        </div>

        {/* Filters that only ever arrive as a link, never a control above —
            shown so what a dashboard tile or a centre's own page opened this
            list to is never a mystery, and is one click to remove. */}
        {linkedChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2.5">
            {linkedChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-brand-50 pl-3 pr-1 text-sm text-brand-900 ring-1 ring-inset ring-brand-600/20"
              >
                <span className="truncate">
                  {chip.prefix && <span className="text-brand-800/70">{chip.prefix}: </span>}
                  {chip.label}
                </span>
                <button
                  type="button"
                  onClick={() => setFilter(chip.key, '')}
                  aria-label={`Remove the ${chip.prefix ?? chip.label} filter`}
                  className="shrink-0 rounded-full p-1 text-brand-700 hover:bg-brand-100"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        {error && !data ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : !data ? (
          <div className="divide-y divide-slate-100" aria-busy aria-label="Loading complaints">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : data.items.length === 0 ? (
          hasFilters ? (
            <EmptyState
              title="No complaints match these filters"
              description="Try a different search, or clear the filters."
              action={
                <Button variant="secondary" size="sm" onClick={() => setParams(new URLSearchParams())}>
                  Clear filters
                </Button>
              }
            />
          ) : center ? (
            <EmptyState
              title="No complaints yet"
              description="Complaints Admin assigns to your service center will appear here."
            />
          ) : (
            <EmptyState
              title="No complaints yet"
              description="Complaints you create will appear here."
              action={
                <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => navigate('/admin/complaints/new')}>
                  Create the first complaint
                </Button>
              }
            />
          )
        ) : (
          <div className={cn('overflow-x-auto transition-opacity', isFetching && 'opacity-60')}>
            {/* A minimum width, so on a narrow screen the table scrolls
                sideways instead of crushing its columns. Without it the
                complaint number — the one thing people scan this list for —
                wrapped across three lines. */}
            <table className={cn('w-full text-left text-sm', center ? 'min-w-[1120px]' : 'min-w-[960px]')}>
              <thead className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-3">Complaint</th>
                  <th scope="col" className="px-5 py-3">Customer</th>
                  <th scope="col" className="px-5 py-3">Product</th>
                  <th scope="col" className="px-5 py-3">Status</th>
                  <th scope="col" className="px-5 py-3">Priority</th>
                  {center && <th scope="col" className="px-5 py-3">Technician</th>}
                  {center && <th scope="col" className="px-5 py-3">Visit</th>}
                  <th scope="col" className="px-5 py-3">SLA</th>
                  {!center && <th scope="col" className="px-5 py-3 text-right">Created</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((complaint) => (
                  <tr
                    key={complaint.id}
                    /* The whole row is clickable, but the complaint number is
                       the real link — so keyboard users can reach it with Tab
                       and screen readers announce it as a link. */
                    onClick={() => navigate(`${base}/${complaint.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-3.5">
                      <a
                        href={`${base}/${complaint.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          navigate(`${base}/${complaint.id}`);
                        }}
                        className="tabular whitespace-nowrap font-medium text-slate-900 hover:text-brand-700"
                      >
                        {complaint.complaintNumber}
                      </a>
                      <p className="mt-0.5 text-xs text-slate-500">{complaint.category}</p>
                    </td>
                    {/* No wrapping: a name split over two lines and a phone
                        number over three is harder to read than a table that
                        scrolls sideways. */}
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div>
                          <p className="text-slate-900">{complaint.customerSnapshot.name}</p>
                          <p className="tabular mt-0.5 text-xs text-slate-500">
                            {formatMobile(complaint.customerSnapshot.mobile)} · {complaint.serviceAddress.cityName}
                          </p>
                        </div>
                        {/* Calling or messaging from the list must not also open
                            the complaint, which a click on the row does. */}
                        <span onClick={(event) => event.stopPropagation()}>
                          <ContactButtons
                            mobile={complaint.customerSnapshot.mobile}
                            name={complaint.customerSnapshot.name}
                            compact
                          />
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <p className="text-slate-900">{complaint.productSnapshot.productName}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {complaint.productSnapshot.modelNumber} · {complaint.serialNumber}
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={complaint.status} />
                    </td>
                    <td className="px-5 py-3.5">
                      <PriorityBadge priority={complaint.priority} />
                    </td>
                    {center && (
                      <td className="px-5 py-3.5">
                        {complaint.technicianName ? (
                          <span className="whitespace-nowrap text-slate-900">{complaint.technicianName}</span>
                        ) : (
                          <span className="text-slate-400">Not assigned</span>
                        )}
                      </td>
                    )}
                    {center && (
                      <td className="px-5 py-3.5">
                        <VisitCell complaint={complaint} />
                      </td>
                    )}
                    <td className="px-5 py-3.5">
                      <SlaCell complaint={complaint} />
                    </td>
                    {!center && (
                      <td className="tabular whitespace-nowrap px-5 py-3.5 text-right text-slate-500">
                        {formatDate(complaint.createdAt)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm">
            <span className="text-slate-500">
              Page {data.page} of {data.totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<ChevronLeft className="size-4" />}
                disabled={page <= 1}
                onClick={() => setFilter('page', String(page - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setFilter('page', String(page + 1))}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
