/**
 * One service center, everything about it on one page (DECISIONS.md section 29).
 *
 * Opened from the Service Centers list. The list says what a centre is; this
 * page says how it is doing — who works there and how busy each person is,
 * what is open and overdue, what is booked, what stock is short — with a way
 * into the full list behind each part.
 *
 * Performance comes from the Service centers report filtered to this centre
 * rather than from a calculation of its own, so the figures here are the
 * figures on the Reports page.
 */
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  ClipboardList,
  Mail,
  MapPin,
  Package,
  Pencil,
  Power,
  Timer,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { StatTile } from '@/components/charts/Charts';
import {
  ActiveBadge,
  ActiveToggleDialog,
  StrandedWorkDialog,
  useCities,
  useRefreshRecords,
} from '@/components/records/Records';
import { dateRange } from '@/components/reports/reportParams';
import { formatValue } from '@/components/reports/ReportView';
import { RatingValue } from '@/components/complaint/RatingStars';
import { Badge, PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ContactButtons } from '@/components/ui/ContactButtons';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDate, formatDuration, formatMobile, fromNow } from '@/lib/format';
import type { Report, ServiceCenter, StrandedWork } from '@/lib/types';
import { CentreDialog, DEACTIVATE_CENTRE_CONSEQUENCE } from './ServiceCentersPage';

/* ---- What the server sends ------------------------------------------------ */

interface StaffMember {
  id: string;
  name: string;
  mobile: string;
  email?: string;
  isActive: boolean;
  lastLoginAt?: string;
  mustChangePassword: boolean;
}

interface CenterOverview {
  center: ServiceCenter & {
    createdAt: string;
    updatedAt: string;
    city: { name: string; state: string } | null;
    territory: { name: string; code: string } | null;
    servedCities: Array<{ id: string; name: string; state: string; isActive: boolean }>;
  };
  /** All-time, for the heading; the Performance card shows the chosen period's. */
  ratings: { average: number | null; rated: number };
  staff: {
    owners: StaffMember[];
    technicians: Array<StaffMember & { openJobs: number }>;
  };
  complaints: {
    open: number;
    overdue: number;
    waitingForTechnician: number;
    byStatus: Array<{ status: string; count: number }>;
    mostUrgent: Array<{
      id: string;
      complaintNumber: string;
      status: string;
      priority: string;
      customerName: string;
      cityName: string;
      technicianName: string | null;
      resolutionDueAt: string | null;
      slaState: string | null;
      breached: boolean;
      createdAt: string;
    }>;
  };
  visits: {
    scheduled: number;
    missed: number;
    next: Array<{
      id: string;
      complaintId: string;
      complaintNumber: string;
      customerName: string;
      cityName: string;
      technicianName: string | null;
      scheduledAt: string;
      sequence: number;
      missed: boolean;
    }>;
  };
  stock: {
    tracked: number;
    low: number;
    waitingRequests: number;
    lowItems: Array<{
      partId: string;
      name: string;
      code: string;
      unit: string;
      available: number;
      minimum: number;
    }>;
  };
}

/* ---- Links into the full lists ------------------------------------------- */

/* The complaint list takes the same filter names as the API, so each link
   lists exactly what its figure counted. */
const links = {
  complaints: (centreId: string) => `/admin/complaints?serviceCenterId=${centreId}&open=true`,
  breached: (centreId: string) => `/admin/complaints?serviceCenterId=${centreId}&slaBreached=true`,
  technicianJobs: (technicianId: string) => `/admin/complaints?technicianId=${technicianId}&open=true`,
  visits: (centreId: string, range: 'all' | 'missed' = 'all') =>
    `/admin/visits?range=${range}&serviceCenterId=${centreId}`,
  stock: (centreId: string, lowOnly = false) =>
    `/admin/parts?tab=stock&serviceCenterId=${centreId}${lowOnly ? '&low=1' : ''}`,
  users: (centreId: string) => `/admin/technicians?serviceCenterId=${centreId}`,
  report: (centreId: string, period: Period) =>
    `/admin/reports?report=service-centers&range=${period}&serviceCenterId=${centreId}`,
};

/* ---- The page -------------------------------------------------------------- */

export function ServiceCenterDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const refresh = useRefreshRecords();

  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [stranded, setStranded] = useState<StrandedWork[] | null>(null);

  const cities = useCities({ includeInactive: true });

  const overview = useQuery({
    /* Under 'service-center' so a record edit anywhere refreshes it. */
    queryKey: ['service-center', id, 'overview'],
    queryFn: ({ signal }) => api<CenterOverview>(`/service-centers/${id}/overview`, { signal }),
  });

  if (!overview.data) {
    if (overview.error instanceof ApiError && overview.error.status === 404) {
      return (
        <>
          <BackLink />
          <Card>
            <EmptyState
              title="Service center not found"
              description="The link may be mistyped, or the center may no longer exist."
              action={
                <Link to="/admin/service-centers" className="text-sm font-medium text-brand-700">
                  Back to service centers
                </Link>
              }
            />
          </Card>
        </>
      );
    }
    if (overview.error) {
      return (
        <>
          <BackLink />
          <Card>
            <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
          </Card>
        </>
      );
    }
    return <PageSkeleton />;
  }

  const { center, staff, complaints, visits, stock } = overview.data;
  const place = center.city ? `${center.city.name}, ${center.city.state}` : '';

  return (
    <>
      <BackLink />

      {/* ---- Header ------------------------------------------------------- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{center.name}</h1>
            <ActiveBadge active={center.isActive} />
            <RatingValue value={overview.data.ratings.average} count={overview.data.ratings.rated} size="md" />
          </div>
          <p className="mt-1.5 text-sm text-slate-500">
            <span className="tabular">{center.code}</span>
            {place && ` · ${place}`} · added {formatDate(center.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="secondary"
            icon={<Power className="size-4" />}
            className={center.isActive ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
            onClick={() => setToggling(true)}
          >
            {center.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        </div>
      </div>

      {!center.isActive && (
        <div
          role="status"
          className="mb-6 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">This service center is deactivated</p>
            <p className="mt-0.5">
              It gets no new complaints, and its Owner and technicians cannot sign in.
              {complaints.open > 0 && (
                <>
                  {' '}
                  {complaints.open === 1 ? 'Its 1 open complaint still needs' : `Its ${complaints.open} open complaints still need`} a
                  new service center —{' '}
                  <Link to={links.complaints(center.id)} className="font-medium underline">
                    reassign {complaints.open === 1 ? 'it' : 'them'}
                  </Link>
                  .
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* ---- Headline figures --------------------------------------------- */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Open complaints"
          value={complaints.open}
          icon={ClipboardList}
          hint={
            complaints.waitingForTechnician > 0
              ? `${complaints.waitingForTechnician} waiting for a technician`
              : 'All have a technician'
          }
          onClick={() => navigate(links.complaints(center.id))}
        />
        <StatTile
          label="SLA breached"
          value={complaints.overdue}
          icon={Timer}
          tone="alert"
          hint="Open and past the resolution time"
          onClick={() => navigate(links.breached(center.id))}
        />
        <StatTile
          label="Visits booked"
          value={visits.scheduled}
          icon={CalendarClock}
          hint={visits.missed > 0 ? `${visits.missed} missed — not started on time` : 'None missed'}
          onClick={() => navigate(links.visits(center.id, visits.missed > 0 ? 'missed' : 'all'))}
        />
        <StatTile
          label="Low on stock"
          value={stock.low}
          icon={Package}
          tone="alert"
          hint={`of ${stock.tracked} ${stock.tracked === 1 ? 'part' : 'parts'} stocked`}
          onClick={() => navigate(links.stock(center.id, stock.low > 0))}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---- Main column ------------------------------------------------ */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <UrgentComplaints centreId={center.id} complaints={complaints} />
          <Technicians centreId={center.id} technicians={staff.technicians} />
          <BookedVisits centreId={center.id} visits={visits} />
          <Performance centreId={center.id} />
        </div>

        {/* ---- Side column ------------------------------------------------ */}
        <div className="min-w-0 space-y-6">
          <ContactCard center={center} />
          <CoverageCard center={center} />
          <OwnersCard centreId={center.id} owners={staff.owners} />
          <StockCard centreId={center.id} stock={stock} />
          {center.notes && (
            <Card>
              <CardHeader title="Notes" />
              <p className="whitespace-pre-line px-5 py-4 text-sm leading-relaxed text-slate-700">{center.notes}</p>
            </Card>
          )}
        </div>
      </div>

      {editing && (
        <CentreDialog
          centre={center}
          cities={cities.data?.items ?? []}
          onClose={() => setEditing(false)}
        />
      )}

      {toggling && (
        <ActiveToggleDialog
          name={center.name}
          active={center.isActive}
          consequence={DEACTIVATE_CENTRE_CONSEQUENCE}
          onClose={() => setToggling(false)}
          onConfirm={async () => {
            const result = await api<{ openComplaintsNeedingReassignment?: StrandedWork[] }>(
              `/service-centers/${center.id}`,
              { method: 'PATCH', body: { isActive: !center.isActive } },
            );
            toast.success(center.isActive ? `${center.name} deactivated` : `${center.name} activated`);
            if (result.openComplaintsNeedingReassignment?.length) {
              setStranded(result.openComplaintsNeedingReassignment);
            }
            await refresh();
          }}
        />
      )}

      {stranded && (
        <StrandedWorkDialog
          title="Reassign these complaints"
          description={`${center.name} is deactivated but still has ${stranded.length} open ${
            stranded.length === 1 ? 'complaint' : 'complaints'
          }. Their history stays; each needs a new service center.`}
          items={stranded}
          linkBase="/admin/complaints"
          onClose={() => setStranded(null)}
        />
      )}
    </>
  );
}

function BackLink() {
  return (
    <Link
      to="/admin/service-centers"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
    >
      <ArrowLeft className="size-4" />
      Service Centers
    </Link>
  );
}

/** "View all 12" in a card header. */
function ViewAll({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-brand-700 hover:underline"
    >
      {children}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

/* ---- Open complaints --------------------------------------------------------- */

function UrgentComplaints({ centreId, complaints }: { centreId: string; complaints: CenterOverview['complaints'] }) {
  const shown = complaints.mostUrgent.length;

  return (
    <Card>
      <CardHeader
        title="Open complaints"
        description={
          complaints.open === 0
            ? 'Nothing open right now'
            : shown < complaints.open
              ? `The ${shown} with the nearest deadline, of ${complaints.open}`
              : 'Nearest deadline first'
        }
        action={complaints.open > 0 && <ViewAll to={links.complaints(centreId)}>View all {complaints.open}</ViewAll>}
      />
      {shown === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">No open complaints.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {complaints.mostUrgent.map((complaint) => (
            <li key={complaint.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/admin/complaints/${complaint.id}`}
                    className="tabular font-medium text-slate-900 hover:text-brand-700"
                  >
                    {complaint.complaintNumber}
                  </Link>
                  <PriorityBadge priority={complaint.priority} />
                </div>
                <p className="mt-0.5 text-sm text-slate-600">
                  {complaint.customerName}
                  {complaint.cityName && ` · ${complaint.cityName}`}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {complaint.technicianName ?? <span className="text-amber-700">No technician yet</span>}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <StatusBadge status={complaint.status} />
                <DueText complaint={complaint} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DueText({ complaint }: { complaint: CenterOverview['complaints']['mostUrgent'][number] }) {
  if (complaint.breached) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
        <AlertTriangle className="size-3.5" aria-hidden />
        SLA breached
      </span>
    );
  }
  if (complaint.slaState === 'PAUSED') return <span className="text-xs text-slate-500">SLA paused</span>;
  if (!complaint.resolutionDueAt) return null;
  return (
    <span className="text-xs text-slate-500" title={`Due ${dayjs(complaint.resolutionDueAt).format('D MMM YYYY, h:mm A')}`}>
      {formatDuration(dayjs(complaint.resolutionDueAt).diff(dayjs()))}
    </span>
  );
}

/* ---- Technicians ------------------------------------------------------------- */

function signInText(member: StaffMember): string {
  if (!member.lastLoginAt) return 'Never signed in';
  return `Signed in ${fromNow(member.lastLoginAt)}`;
}

function Technicians({
  centreId,
  technicians,
}: {
  centreId: string;
  technicians: CenterOverview['staff']['technicians'];
}) {
  const active = technicians.filter((technician) => technician.isActive).length;

  return (
    <Card>
      <CardHeader
        title="Technicians"
        description={
          technicians.length === 0
            ? 'Nobody added yet'
            : `${active} active${technicians.length > active ? `, ${technicians.length - active} inactive` : ''}`
        }
        action={<ViewAll to={links.users(centreId)}>Manage</ViewAll>}
      />
      {technicians.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">
          No technicians yet. The center's Owner adds them from their portal.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {technicians.map((technician) => (
            <li
              key={technician.id}
              className={cn(
                'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5',
                !technician.isActive && 'bg-slate-50/60',
              )}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-slate-900">{technician.name}</p>
                  {!technician.isActive && <ActiveBadge active={false} />}
                </div>
                <p className="tabular mt-0.5 text-xs text-slate-500">
                  {formatMobile(technician.mobile)} · {signInText(technician)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {technician.openJobs > 0 ? (
                  <Link
                    to={links.technicianJobs(technician.id)}
                    className="whitespace-nowrap text-sm font-medium text-brand-700 hover:underline"
                  >
                    {technician.openJobs} open {technician.openJobs === 1 ? 'job' : 'jobs'}
                  </Link>
                ) : (
                  <span className="whitespace-nowrap text-sm text-slate-500">No open jobs</span>
                )}
                <ContactButtons mobile={technician.mobile} name={technician.name} compact />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---- Visits ------------------------------------------------------------------ */

function BookedVisits({ centreId, visits }: { centreId: string; visits: CenterOverview['visits'] }) {
  return (
    <Card>
      <CardHeader
        title="Booked visits"
        description={
          visits.scheduled === 0
            ? 'Nothing booked'
            : `${visits.scheduled} booked${visits.missed > 0 ? `, ${visits.missed} missed` : ''}`
        }
        action={<ViewAll to={links.visits(centreId)}>Schedule</ViewAll>}
      />
      {visits.next.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">No visits booked.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {visits.next.map((visit) => (
            <li key={visit.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-3.5">
              <div className="flex min-w-0 gap-4">
                <div className="w-20 shrink-0">
                  <p className="text-sm font-medium text-slate-900">{dayjs(visit.scheduledAt).format('D MMM')}</p>
                  <p className="text-xs text-slate-500">{dayjs(visit.scheduledAt).format('h:mm A')}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-sm">
                    <Link
                      to={`/admin/complaints/${visit.complaintId}`}
                      className="tabular font-medium text-slate-900 hover:text-brand-700"
                    >
                      {visit.complaintNumber}
                    </Link>
                    <span className="text-slate-500"> · visit {visit.sequence}</span>
                  </p>
                  <p className="mt-0.5 text-sm text-slate-600">
                    {visit.customerName}
                    {visit.cityName && ` · ${visit.cityName}`}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                {visit.missed && <Badge className="bg-red-50 text-red-700 ring-red-600/20">Missed</Badge>}
                <span className="text-xs text-slate-500">{visit.technicianName ?? 'No technician'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---- Performance ------------------------------------------------------------- */

const PERIODS = [
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
] as const;

type Period = (typeof PERIODS)[number]['key'];

/** The report columns shown, in reading order. */
const FIGURES = [
  { key: 'complaints', label: 'Complaints received' },
  { key: 'closed', label: 'Closed' },
  { key: 'avgCloseHours', label: 'Avg. time to close' },
  { key: 'closedWithinSla', label: 'Closed within SLA' },
  { key: 'revisitRate', label: 'Revisit rate' },
  { key: 'reopened', label: 'Reopened' },
  /* DECISIONS.md section 31 — the report's own byCenter columns; keys and
     formats (avgRating: 'decimal', rated: 'number') come straight from
     reports.service.ts serviceCenterReport(), same as every figure above. */
  { key: 'avgRating', label: 'Avg. rating' },
  { key: 'rated', label: 'Rated' },
] as const;

function Performance({ centreId }: { centreId: string }) {
  const [period, setPeriod] = useState<Period>('30d');
  const range = dateRange(period, '', '');
  const query = { serviceCenterId: centreId, ...range };

  const report = useQuery({
    queryKey: ['report', 'service-centers', query],
    queryFn: ({ signal }) => api<Report>('/reports/service-centers', { query, signal }),
  });

  const table = report.data?.tables[0];
  const row = table?.rows[0];
  const formatOf = (key: string) => table?.columns.find((column) => column.key === key)?.format ?? 'number';

  return (
    <Card>
      <CardHeader
        title="Performance"
        description="Complaints received in the period, and how they went"
        action={<ViewAll to={links.report(centreId, period)}>Full report</ViewAll>}
      />
      <div className="px-5 py-4">
        <div role="group" aria-label="Period" className="mb-4 flex flex-wrap gap-1.5">
          {PERIODS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={period === option.key}
              onClick={() => setPeriod(option.key)}
              className={cn(
                'h-8 rounded-lg px-3 text-sm font-medium transition-colors',
                period === option.key
                  ? 'bg-brand-700 text-white'
                  : 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {report.error && !report.data ? (
          <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        ) : !report.data ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-busy aria-label="Loading performance">
            {FIGURES.map((figure) => (
              <Skeleton key={figure.key} className="h-12" />
            ))}
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
              {FIGURES.map((figure) => (
                <div key={figure.key}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{figure.label}</dt>
                  <dd className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
                    {/* No complaints in the period: counts are zero, rates have nothing to measure. */}
                    {row ? formatValue(row[figure.key], formatOf(figure.key)) : formatOf(figure.key) === 'number' ? '0' : '—'}
                  </dd>
                </div>
              ))}
            </dl>
            {!row && <p className="mt-4 text-sm text-slate-500">No complaints were received in this period.</p>}
          </>
        )}
      </div>
    </Card>
  );
}

/* ---- Side cards -------------------------------------------------------------- */

function ContactCard({ center }: { center: CenterOverview['center'] }) {
  return (
    <Card>
      <CardHeader title="Contact" />
      <dl className="space-y-4 px-5 py-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Mobile</dt>
          <dd className="mt-1">
            <span className="tabular text-sm font-medium text-slate-900">{formatMobile(center.mobile)}</span>
            <ContactButtons mobile={center.mobile} name={center.name} className="mt-2" />
          </dd>
        </div>
        {center.email && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Email</dt>
            <dd className="mt-1 text-sm">
              <a href={`mailto:${center.email}`} className="inline-flex items-center gap-2 break-all text-brand-700 hover:underline">
                <Mail className="size-4 shrink-0 text-slate-400" aria-hidden />
                {center.email}
              </a>
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Address</dt>
          <dd className="mt-1 flex gap-2 text-sm text-slate-900">
            <MapPin className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
            <span className="whitespace-pre-line">
              {center.address}
              <br />
              {center.city ? `${center.city.name}, ${center.city.state} ` : ''}
              <span className="tabular">{center.pincode}</span>
            </span>
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function CoverageCard({ center }: { center: CenterOverview['center'] }) {
  const pincodes = (center.servedPincodes ?? []).filter((pincode) => pincode !== center.pincode);

  return (
    <Card>
      <CardHeader title="Coverage" description="Where complaints are recommended to this center" />
      <div className="space-y-4 px-5 py-4 text-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Always</p>
          <p className="mt-1 text-slate-900">
            {center.city?.name ?? 'Its own city'} · <span className="tabular">{center.pincode}</span>
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Also serves cities</p>
          {center.servedCities.length === 0 ? (
            <p className="mt-1 text-slate-500">None</p>
          ) : (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {center.servedCities.map((city) => (
                <li key={city.id}>
                  <Badge className="bg-slate-50 text-slate-700 ring-slate-300">
                    {city.name}
                    {!city.isActive && <span className="text-slate-400">(inactive)</span>}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Also serves pincodes</p>
          {pincodes.length === 0 ? (
            <p className="mt-1 text-slate-500">None</p>
          ) : (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {pincodes.map((pincode) => (
                <li key={pincode}>
                  <Badge className="tabular bg-slate-50 text-slate-700 ring-slate-300">{pincode}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function OwnersCard({ centreId, owners }: { centreId: string; owners: StaffMember[] }) {
  return (
    <Card>
      <CardHeader title={owners.length > 1 ? 'Owners' : 'Owner'} />
      {owners.length === 0 ? (
        <div className="px-5 py-4 text-sm text-slate-500">
          <p>No Owner account yet, so nobody at the center can sign in to manage its work.</p>
          <Link to={links.users(centreId)} className="mt-2 inline-block font-medium text-brand-700 hover:underline">
            Add an Owner
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {owners.map((owner) => (
            <li key={owner.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-slate-900">{owner.name}</p>
                {!owner.isActive && <ActiveBadge active={false} />}
              </div>
              <p className="tabular mt-0.5 text-sm text-slate-600">{formatMobile(owner.mobile)}</p>
              {owner.email && <p className="mt-0.5 break-all text-sm text-slate-600">{owner.email}</p>}
              <p className="mt-0.5 text-xs text-slate-500">{signInText(owner)}</p>
              <ContactButtons mobile={owner.mobile} name={owner.name} className="mt-2.5" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StockCard({ centreId, stock }: { centreId: string; stock: CenterOverview['stock'] }) {
  return (
    <Card>
      <CardHeader
        title="Stock"
        description={
          stock.tracked === 0
            ? 'No stock recorded yet'
            : `${stock.tracked} ${stock.tracked === 1 ? 'part' : 'parts'} stocked · ${stock.low} low`
        }
        action={stock.tracked > 0 && <ViewAll to={links.stock(centreId)}>View</ViewAll>}
      />
      <div className="px-5 py-4 text-sm">
        {stock.tracked === 0 ? (
          <p className="text-slate-500">Stock is set per part from Parts → Stock.</p>
        ) : stock.lowItems.length === 0 ? (
          <p className="text-slate-500">Nothing is running low.</p>
        ) : (
          <ul className="space-y-3">
            {stock.lowItems.map((item) => (
              <li key={item.partId} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-slate-900">{item.name}</p>
                  <p className="tabular text-xs text-slate-500">{item.code}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn('font-medium', item.available === 0 ? 'text-red-600' : 'text-slate-900')}>
                    {item.available === 0 ? 'None left' : `${item.available} left`}
                  </p>
                  <p className="text-xs text-slate-500">reorder at {item.minimum}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {stock.waitingRequests > 0 && (
          <p className="mt-4 border-t border-slate-100 pt-3 text-slate-600">
            {stock.waitingRequests} part {stock.waitingRequests === 1 ? 'request is' : 'requests are'} waiting for the
            Owner.
          </p>
        )}
      </div>
    </Card>
  );
}

/* ---- Loading ----------------------------------------------------------------- */

function PageSkeleton() {
  return (
    <div aria-busy aria-label="Loading service center">
      <Skeleton className="mb-4 h-4 w-28" />
      <Skeleton className="mb-2 h-8 w-72" />
      <Skeleton className="mb-6 h-4 w-96 max-w-full" />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-[var(--radius-card)]" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-72 rounded-[var(--radius-card)]" />
          <Skeleton className="h-56 rounded-[var(--radius-card)]" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-48 rounded-[var(--radius-card)]" />
          <Skeleton className="h-40 rounded-[var(--radius-card)]" />
        </div>
      </div>
    </div>
  );
}
