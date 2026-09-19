/**
 * Admin dashboard (spec section 5.1).
 *
 * Section 5.1 lists ten KPI cards, nine visualisations and six quick actions.
 * All of it comes from one request — the server builds every panel in a single
 * aggregation — so the page loads as a whole rather than panel by panel.
 *
 * Forms were chosen by what each panel has to communicate, not by variety:
 *
 *  - the ten counts are **stat tiles**, because the number is the message;
 *  - status, priority, city, centre, model and workload are **bar lists** in a
 *    single hue, because each compares amounts across categories. Twelve
 *    statuses in a donut would mean twelve colours nobody can tell apart;
 *  - warranty and repeat rate are **meters** — a two-slice pie is just a
 *    harder way to read one percentage;
 *  - SLA is a **segmented bar**, because met/paused/breached are states that
 *    add up to the whole.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Hourglass,
  PackageSearch,
  PauseCircle,
  Plus,
  RotateCcw,
  Siren,
  Sparkles,
  Star,
  UserCheck,
  Users,
  Wrench,
  Package,
  Boxes,
  Timer,
  XCircle,
} from 'lucide-react';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { BarList, Meter, SegmentBar, StatTile, VIZ } from '@/components/charts/Charts';
import { RatingValue } from '@/components/complaint/RatingStars';
import { useServiceCenters } from '@/components/records/Records';
import { describeRange } from '@/components/reports/reportParams';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, PageHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Field';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import {
  cn,
  PRIORITY_META,
  STATUS_META,
  fromNow,
  type ComplaintStatus,
  type Priority,
} from '@/lib/format';
import type { Dashboard } from '@/lib/types';

/**
 * The period every panel covers: the last few days, everything, or dates the
 * Admin picks.
 *
 * One filter row, above everything it scopes, so every panel always describes
 * the same slice of time — a per-panel filter would let two panels disagree
 * without saying why. The choice lives in the address bar, so a refresh keeps
 * it and "last quarter for the client call" can be sent as a link.
 */
const RANGES = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
  /* Chosen dates, typed below the row. */
  { key: 'custom', label: 'Choose dates', days: null },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

/** A day as a date input wants it, e.g. `2026-09-18`. */
const asDay = (value: string): string => (value ? dayjs(value).format('YYYY-MM-DD') : '');

/**
 * The instants a choice covers.
 *
 * Whole days throughout: a preset starts at midnight, and chosen dates run
 * from the start of the first to the *end* of the last, so picking the same
 * day twice means that day rather than an empty moment. Either end may be
 * left out — "from 1 August" and "up to 15 September" are both useful.
 */
function rangeBounds(key: RangeKey, from: string, to: string): { from?: string; to?: string } {
  if (key === 'custom') {
    return {
      ...(from ? { from: dayjs(from).startOf('day').toISOString() } : {}),
      ...(to ? { to: dayjs(to).endOf('day').toISOString() } : {}),
    };
  }

  const preset = RANGES.find((range) => range.key === key);
  if (!preset || preset.days === null) return {};
  return { from: dayjs().startOf('day').subtract(preset.days, 'day').toISOString() };
}

/**
 * The two dates, applied together.
 *
 * Applied on a button rather than as each date changes: a half-entered period
 * ("from the 1st" while the "to" box still holds last month's date) would
 * reload every panel with figures nobody asked for.
 */
function ChooseDates({
  from,
  to,
  onApply,
  onClear,
}: {
  from: string;
  to: string;
  onApply: (from: string, to: string) => void;
  onClear: () => void;
}) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  /* Back, forward, or a shared link changes the dates in the address bar; the
     boxes follow it. */
  useEffect(() => setDraftFrom(from), [from]);
  useEffect(() => setDraftTo(to), [to]);

  const today = dayjs().format('YYYY-MM-DD');
  const backwards = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const unchanged = draftFrom === from && draftTo === to;

  return (
    <div className="mt-3 flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <Input
        label="From"
        type="date"
        max={draftTo || today}
        value={draftFrom}
        onChange={(event) => setDraftFrom(event.target.value)}
        className="w-[170px]"
      />
      <Input
        label="To"
        type="date"
        min={draftFrom || undefined}
        max={today}
        value={draftTo}
        onChange={(event) => setDraftTo(event.target.value)}
        error={backwards ? 'The end date is before the start date' : undefined}
        className="w-[170px]"
      />
      <div className="flex items-center gap-2 pt-[26px]">
        <Button
          size="sm"
          disabled={backwards || unchanged || (!draftFrom && !draftTo)}
          onClick={() => onApply(draftFrom, draftTo)}
        >
          Apply
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Priority is an ordered scale, so it is shown in order rather than by count. */
const PRIORITY_ORDER: Priority[] = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

export function DashboardPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const range: RangeKey = RANGES.find((option) => option.key === params.get('range'))?.key ?? 'all';
  const chosenFrom = asDay(params.get('from') ?? '');
  const chosenTo = asDay(params.get('to') ?? '');
  const bounds = rangeBounds(range, chosenFrom, chosenTo);
  const serviceCenterId = params.get('serviceCenterId') ?? '';
  /* Inactive centres stay in the list: a bookmarked or shared
     `?serviceCenterId=` link naming one must still render as a real, visible
     selection rather than silently falling back to "All centers" while the
     figures below stay narrowed to it (review finding, Sept 2026). */
  const centres = useServiceCenters({ includeInactive: true });

  const chooseRange = (key: RangeKey) => {
    const next = new URLSearchParams(params);
    next.set('range', key);
    /* A preset covers its own days; the typed ones would only confuse a
       later reading of the address bar. */
    if (key !== 'custom') {
      next.delete('from');
      next.delete('to');
    }
    setParams(next, { replace: true });
  };

  const chooseDates = (from: string, to: string) => {
    const next = new URLSearchParams(params);
    next.set('range', 'custom');
    if (from) next.set('from', from);
    else next.delete('from');
    if (to) next.set('to', to);
    else next.delete('to');
    setParams(next, { replace: true });
  };

  const chooseServiceCenter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('serviceCenterId', value);
    else next.delete('serviceCenterId');
    setParams(next, { replace: true });
  };

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['dashboard', range, bounds.from ?? '', bounds.to ?? '', serviceCenterId],
    queryFn: () =>
      api<Dashboard>('/dashboard', { query: { ...bounds, serviceCenterId: serviceCenterId || undefined } }),
    /* Keep the previous numbers on screen while a new range loads, at reduced
       opacity, instead of flashing skeletons and jumping the layout. */
    placeholderData: keepPreviousData,
  });

  /**
   * Opens the complaint list already filtered to what a tile counted.
   *
   * The chosen period and centre are carried along too — without it, choosing
   * "7 days" and a centre and then clicking a tile opened a list of every
   * complaint ever raised, disagreeing with the numbers just clicked.
   */
  const openList = (query: Record<string, string>) => {
    navigate(
      `/admin/complaints?${new URLSearchParams({
        ...(bounds.from ? { from: bounds.from } : {}),
        ...(bounds.to ? { to: bounds.to } : {}),
        ...(serviceCenterId ? { serviceCenterId } : {}),
        ...query,
      }).toString()}`,
    );
  };

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `Updated ${fromNow(data.generatedAt)}`
            : 'Service operations at a glance'
        }
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => navigate('/admin/complaints/new')}>
            Create complaint
          </Button>
        }
      />

      {/* One filter row for the whole page. */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="inline-flex flex-wrap rounded-lg bg-white p-1 ring-1 ring-slate-200"
            role="radiogroup"
            aria-label="Date range"
          >
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={range === option.key}
                onClick={() => chooseRange(option.key)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  range === option.key
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <select
            value={serviceCenterId}
            onChange={(event) => chooseServiceCenter(event.target.value)}
            aria-label="Filter by service center"
            className="h-9 rounded-lg border-0 bg-white pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
          >
            <option value="">All centers</option>
            {(centres.data?.items ?? []).map((centre) => (
              <option key={centre.id} value={centre.id}>
                {centre.name}
                {centre.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </div>

        {range === 'custom' && (
          <ChooseDates
            from={chosenFrom}
            to={chosenTo}
            onApply={chooseDates}
            onClear={() => chooseRange('all')}
          />
        )}

        {/* What the figures below cover, in words, whichever choice is made. */}
        <p className="mt-2 text-sm text-slate-500">
          Complaints raised: {describeRange(bounds)}
          {range === 'custom' && !bounds.from && !bounds.to && ' — pick a date to narrow it'}
        </p>
      </div>

      {error && !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : isLoading || !data ? (
        <DashboardSkeleton />
      ) : (
        <div className={cn('space-y-6 transition-opacity', isFetching && 'opacity-60')}>
          {/* ---- Ten KPI cards (section 5.1) ---------------------------- */}
          <section aria-label="Key figures">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile
                label="Open complaints"
                value={data.kpis.totalOpen}
                icon={ClipboardList}
                onClick={() => openList({ open: 'true' })}
              />
              <StatTile
                label="New"
                value={data.kpis.newComplaints}
                icon={Sparkles}
                hint="Awaiting a service center"
                onClick={() => openList({ status: 'NEW' })}
              />
              <StatTile
                label="In progress"
                value={data.kpis.inProgress}
                icon={Wrench}
                onClick={() => openList({ status: 'IN_PROGRESS' })}
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
                label="Resolution submitted"
                value={data.kpis.resolutionSubmitted}
                icon={ClipboardCheck}
                hint="Awaiting centre review"
                onClick={() => openList({ status: 'RESOLUTION_SUBMITTED' })}
              />
              <StatTile
                label="Confirmation pending"
                value={data.kpis.adminConfirmationPending}
                icon={UserCheck}
                hint="Call the customer"
                onClick={() => openList({ status: 'ADMIN_CONFIRMATION' })}
              />
              <StatTile
                label="Closed"
                value={data.kpis.closed}
                icon={CheckCircle2}
                onClick={() => openList({ status: 'CLOSED' })}
              />
              <StatTile
                label="SLA breached"
                value={data.kpis.slaBreached}
                icon={AlertTriangle}
                tone="alert"
                onClick={() => openList({ slaBreached: 'true' })}
              />
              <StatTile
                label="Critical open"
                value={data.kpis.critical}
                icon={Siren}
                tone="alert"
                onClick={() => openList({ priority: 'CRITICAL', open: 'true' })}
              />
            </div>
          </section>

          {/* ---- Quick actions (section 5.1) ----------------------------- */}
          <Card>
            <div className="flex flex-wrap items-center gap-2 px-5 py-3.5">
              <span className="mr-2 text-sm font-medium text-slate-500">Quick actions</span>
              <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => navigate('/admin/complaints/new')}>
                Create complaint
              </Button>
              <Button size="sm" variant="secondary" icon={<Users className="size-3.5" />} onClick={() => navigate('/admin/customers')}>
                Add customer
              </Button>
              <Button size="sm" variant="secondary" icon={<Package className="size-3.5" />} onClick={() => navigate('/admin/products')}>
                Add product
              </Button>
              <Button size="sm" variant="secondary" icon={<Wrench className="size-3.5" />} onClick={() => navigate('/admin/service-centers')}>
                Add service center
              </Button>
              <Button size="sm" variant="secondary" icon={<Boxes className="size-3.5" />} onClick={() => navigate('/admin/parts')}>
                Manage parts
              </Button>
              <Button size="sm" variant="secondary" icon={<Timer className="size-3.5" />} onClick={() => openList({ slaBreached: 'true' })}>
                View SLA breaches
              </Button>
            </div>
          </Card>

          {/* ---- SLA and the two ratios --------------------------------- */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader title="SLA performance" description="Resolution deadline" />
              <div className="px-5 py-5">
                <SegmentBar
                  segments={[
                    { key: 'met', label: 'On track', value: data.breakdowns.slaPerformance.met, color: VIZ.met, icon: CheckCircle2 },
                    { key: 'paused', label: 'Paused', value: data.breakdowns.slaPerformance.paused, color: VIZ.paused, icon: PauseCircle },
                    { key: 'breached', label: 'Breached', value: data.breakdowns.slaPerformance.breached, color: VIZ.breached, icon: XCircle },
                  ]}
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Warranty" description="In vs out of warranty" />
              <div className="px-5 py-5">
                <Meter
                  label="In warranty"
                  part={data.breakdowns.byWarranty.find((w) => w.label === 'IN_WARRANTY')?.count ?? 0}
                  whole={data.breakdowns.byWarranty.reduce((sum, w) => sum + w.count, 0)}
                  partLabel="In"
                  restLabel="Out"
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Repeat complaints" description="Reopened at least once" />
              <div className="px-5 py-5">
                <Meter
                  label="Repeat rate"
                  part={data.breakdowns.repeatComplaints.repeat}
                  whole={data.breakdowns.repeatComplaints.repeat + data.breakdowns.repeatComplaints.first}
                  partLabel="Repeat"
                  restLabel="First time"
                />
              </div>
            </Card>
          </div>

          {/* ---- Service center ratings (DECISIONS.md section 31) ------- */}
          <Card>
            <CardHeader
              title="Service center ratings"
              description="Admin's star rating of the centre's work, closed complaints in this period"
            />
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5">
              <RatingValue value={data.ratings.average} count={data.ratings.rated} size="md" />
              {data.ratings.closedUnrated > 0 ? (
                /* The list this opens is every closed complaint, not just the
                   unrated ones — the closed list has no rated/unrated column
                   or filter to narrow by. The copy says so, rather than
                   implying the button lands on an already-narrowed view
                   (review finding, Sept 2026). */
                <div className="flex flex-col items-end gap-1 text-right">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Star className="size-3.5" />}
                    onClick={() => openList({ status: 'CLOSED' })}
                  >
                    Open closed complaints
                  </Button>
                  <span className="text-xs text-slate-500">
                    {data.ratings.closedUnrated}{' '}
                    {data.ratings.closedUnrated === 1 ? 'of them still needs' : 'of them still need'} a rating — the
                    list isn&apos;t narrowed to just those
                  </span>
                </div>
              ) : (
                <span className="text-sm text-slate-500">No closed complaints waiting to be rated</span>
              )}
            </div>
          </Card>

          {/* ---- Status and priority ------------------------------------ */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Complaints by status" />
              <div className="px-5 py-5">
                <BarList
                  data={data.breakdowns.byStatus.map((row) => {
                    const meta = STATUS_META[row.label as ComplaintStatus];
                    return {
                      label: row.label,
                      count: row.count,
                      display: meta?.label ?? row.label,
                      /* The status dot is identity, beside the text — the bar
                         itself stays one hue because it encodes amount. */
                      ...(meta ? { dotClassName: meta.dot } : {}),
                    };
                  })}
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Complaints by priority" />
              <div className="px-5 py-5">
                <BarList
                  data={PRIORITY_ORDER.map((priority) => ({
                    label: priority,
                    count: data.breakdowns.byPriority.find((row) => row.label === priority)?.count ?? 0,
                    display: PRIORITY_META[priority].label,
                  }))}
                />
              </div>
            </Card>
          </div>

          {/* ---- Where and what ----------------------------------------- */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader title="By city" />
              <div className="px-5 py-5">
                <BarList data={data.breakdowns.byCity} limit={8} />
              </div>
            </Card>
            <Card>
              <CardHeader title="By service center" />
              <div className="px-5 py-5">
                <BarList data={data.breakdowns.byServiceCenter} limit={8} emptyText="No complaints assigned yet" />
              </div>
            </Card>
            <Card>
              <CardHeader title="By product model" />
              <div className="px-5 py-5">
                <BarList data={data.breakdowns.byModel} limit={8} />
              </div>
            </Card>
          </div>

          {/* ---- Workload ----------------------------------------------- */}
          <Card>
            <CardHeader
              title="Technician workload"
              description="Open jobs currently assigned to each technician"
            />
            <div className="px-5 py-5">
              <BarList
                data={data.breakdowns.technicianWorkload}
                limit={12}
                emptyText="No technician has open jobs"
              />
            </div>
          </Card>

          {data.operations && (
            <p className="flex items-center gap-2 text-xs text-slate-500">
              <Hourglass className="size-3.5" />
              {data.operations.todaysVisits} visits today · {data.operations.upcomingVisits} upcoming ·{' '}
              {data.operations.pendingPartRequests} part requests pending · {data.operations.lowStockParts}{' '}
              parts low on stock
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** Mirrors the real layout, so loading does not jump the page when it resolves. */
function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-[100px] rounded-[var(--radius-card)]" />
        ))}
      </div>
      <Skeleton className="h-14 rounded-[var(--radius-card)]" />
      <div className="grid gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-[var(--radius-card)]" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-72 rounded-[var(--radius-card)]" />
        ))}
      </div>
    </div>
  );
}
