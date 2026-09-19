/**
 * Draws one report (spec section 16).
 *
 * Every report arrives in the same shape — headline figures, breakdowns, an
 * optional trend and tables — so this one component renders all five, in the
 * same order the download is written. What is on the page is what is in the
 * file.
 */
import {
  AlertTriangle,
  Boxes,
  Building2,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Hourglass,
  Inbox,
  Package,
  PackageSearch,
  PackageX,
  Repeat,
  RotateCcw,
  ShieldCheck,
  Timer,
  Undo2,
  Users,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BarList, ColumnChart, StatTile } from '@/components/charts/Charts';
import { RecordsTable, TH } from '@/components/records/Records';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, Skeleton } from '@/components/ui/States';
import {
  STATUS_META,
  cn,
  formatDate,
  formatMobile,
  type ComplaintStatus,
} from '@/lib/format';
import type {
  Report,
  ReportBreakdown,
  ReportColumn,
  ReportSummaryItem,
  ReportTable,
  ReportValueFormat,
} from '@/lib/types';
import type { Portal } from './reportParams';

/* ---- Values ---------------------------------------------------------------- */

/** Hours read as minutes, hours or days — "52.3 h" makes a person do arithmetic. */
export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toLocaleString('en-IN', { maximumFractionDigits: 1 })} h`;
  return `${(hours / 24).toLocaleString('en-IN', { maximumFractionDigits: 1 })} days`;
}

export function formatValue(value: unknown, format: ReportValueFormat): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (format) {
    case 'percent':
      return `${Number(value).toLocaleString('en-IN')}%`;
    case 'hours':
      return formatHours(Number(value));
    case 'decimal':
      return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 });
    case 'number':
      return Number(value).toLocaleString('en-IN');
    case 'date':
      return formatDate(String(value));
    default:
      return String(value);
  }
}

const NUMERIC: ReadonlySet<ReportValueFormat> = new Set(['number', 'decimal', 'percent', 'hours']);

/* ---- Headline figures ------------------------------------------------------ */

const ICONS: Record<string, LucideIcon> = {
  total: ClipboardList,
  complaints: ClipboardList,
  open: Inbox,
  closed: CheckCircle2,
  cancelled: XCircle,
  avgCloseHours: Timer,
  closedWithinSla: ShieldCheck,
  slaBreached: AlertTriangle,
  reopened: RotateCcw,
  repeatRate: Repeat,
  centers: Building2,
  unassigned: Hourglass,
  revisitRate: RotateCcw,
  technicians: Users,
  jobsAssigned: ClipboardList,
  visitsCompleted: CalendarCheck,
  resolutionsSubmitted: ClipboardCheck,
  sentBack: Undo2,
  models: Package,
  unitsAffected: Boxes,
  repeatUnits: Repeat,
  partsUsed: Wrench,
  jobsWithParts: ClipboardList,
  lowStockItems: AlertTriangle,
  requested: PackageSearch,
  unavailableRequests: PackageX,
};

/** Figures that are bad news when above zero, marked with colour and an icon. */
const ALERTS = new Set(['slaBreached', 'lowStockItems', 'unavailableRequests', 'unassigned']);

/** A line under a figure that would otherwise need explaining. */
const HINTS: Record<string, string> = {
  avgCloseHours: 'From raised to closed',
  closedWithinSla: 'Of the complaints closed',
  slaBreached: 'Went past the deadline',
  repeatRate: 'Reopened after closing',
  revisitRate: 'Resolutions sent back',
  sentBack: 'By the center or Admin',
  unassigned: 'Assign from Complaints',
  lowStockItems: 'At or below the minimum',
};

function Figures({ items }: { items: ReportSummaryItem[] }) {
  return (
    <section aria-label="Key figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {items.map((item) => (
        <StatTile
          key={item.key}
          label={item.label}
          value={item.value}
          display={formatValue(item.value, item.format)}
          icon={ICONS[item.key] ?? ClipboardList}
          tone={ALERTS.has(item.key) ? 'alert' : 'default'}
          {...(HINTS[item.key] ? { hint: HINTS[item.key] } : {})}
        />
      ))}
    </section>
  );
}

/* ---- Breakdowns ------------------------------------------------------------ */

function BreakdownCard({ breakdown }: { breakdown: ReportBreakdown }) {
  return (
    <Card>
      <CardHeader title={breakdown.title} />
      <div className="px-5 py-5">
        <BarList
          limit={10}
          emptyText="Nothing in these dates"
          data={breakdown.items.map((item) => {
            /* A status keeps its dot, so it reads the same as everywhere else. */
            const status = breakdown.key === 'byStatus' ? STATUS_META[item.key as ComplaintStatus] : undefined;
            return {
              label: item.label,
              count: item.value,
              ...(status ? { dotClassName: status.dot } : {}),
            };
          })}
        />
      </div>
    </Card>
  );
}

/* ---- Tables ---------------------------------------------------------------- */

const PAGE = 25;

/** What an empty table means, where "nothing matches" would undersell it. */
const EMPTY_TEXT: Record<string, string> = {
  repeatUnits: 'No unit has had more than one complaint in these dates.',
  byCenter: 'No service center has work in these dates.',
  byTechnician: 'No technician has work in these dates.',
};

function Cell({
  row,
  column,
  portal,
}: {
  row: ReportTable['rows'][number];
  column: ReportColumn;
  portal: Portal;
}): ReactNode {
  const value = row[column.key];

  if (column.key === 'latestComplaintNumber' && row['latestComplaintId']) {
    return (
      <Link
        to={`/${portal}/complaints/${String(row['latestComplaintId'])}`}
        className="font-medium text-brand-700 hover:underline"
      >
        {String(value)}
      </Link>
    );
  }

  if (column.key === 'serialNumber' && value) {
    /* The complaint search finds a serial number's whole history. */
    return (
      <Link
        to={`/${portal}/complaints?search=${encodeURIComponent(String(value))}`}
        className="font-medium text-brand-700 hover:underline"
      >
        {String(value)}
      </Link>
    );
  }

  if (column.key === 'mobile') return formatMobile(value ? String(value) : '');

  const lowStock =
    (column.key === 'lowStock' && value === 'Yes') || (column.key === 'lowStockAt' && Number(value) > 0);
  if (lowStock) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-red-600">
        <AlertTriangle className="size-3.5" aria-hidden />
        {column.key === 'lowStock' ? 'Low' : (
          <>
            <span className="sr-only">Low stock at</span>
            {formatValue(value, column.format)}
          </>
        )}
      </span>
    );
  }

  return formatValue(value, column.format);
}

function TableCard({ table, portal }: { table: ReportTable; portal: Portal }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? table.rows : table.rows.slice(0, PAGE);

  const description =
    table.rows.length === 0
      ? undefined
      : table.truncated
        ? `Showing ${table.rows.length.toLocaleString('en-IN')} of ${table.total.toLocaleString('en-IN')}`
        : `${table.total.toLocaleString('en-IN')} ${table.total === 1 ? 'row' : 'rows'}`;

  return (
    <Card className="overflow-hidden">
      <CardHeader title={table.title} description={description} />
      {table.rows.length === 0 ? (
        <EmptyState
          title="Nothing to show"
          description={EMPTY_TEXT[table.key] ?? 'Nothing matches these dates and filters.'}
        />
      ) : (
        <RecordsTable minWidth={Math.max(560, table.columns.length * 118)}>
          <thead className="border-b border-slate-200 bg-slate-50/70">
            <tr>
              {table.columns.map((column) => (
                <th key={column.key} scope="col" className={cn(TH, NUMERIC.has(column.format) && 'text-right')}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={index} className="hover:bg-slate-50/60">
                {table.columns.map((column, columnIndex) => (
                  <td
                    key={column.key}
                    className={cn(
                      'whitespace-nowrap px-5 py-3',
                      NUMERIC.has(column.format) ? 'tabular text-right text-slate-700' : 'text-slate-700',
                      columnIndex === 0 && 'font-medium text-slate-900',
                    )}
                  >
                    <Cell row={row} column={column} portal={portal} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </RecordsTable>
      )}
      {table.rows.length > PAGE && (
        <div className="border-t border-slate-100 px-5 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => setExpanded((open) => !open)}>
            {expanded ? 'Show fewer' : `Show all ${table.rows.length.toLocaleString('en-IN')}`}
          </Button>
        </div>
      )}
    </Card>
  );
}

/* ---- The report ------------------------------------------------------------ */

export function ReportView({ report, portal }: { report: Report; portal: Portal }) {
  return (
    <div className="space-y-6">
      {report.summary.length > 0 && <Figures items={report.summary} />}

      {report.trend && (
        <Card>
          <CardHeader
            title={report.trend.title}
            description={report.trend.unit === 'week' ? 'Per week, starting Monday' : `Per ${report.trend.unit}`}
          />
          <div className="px-5 pb-4 pt-6">
            <ColumnChart
              data={report.trend.points}
              title={report.trend.title}
              valueLabel={report.trend.valueHeader.toLowerCase()}
            />
          </div>
        </Card>
      )}

      {report.breakdowns.length > 0 && (
        <div className={cn('grid gap-6', report.breakdowns.length > 1 && 'lg:grid-cols-2')}>
          {report.breakdowns.map((breakdown) => (
            <BreakdownCard key={breakdown.key} breakdown={breakdown} />
          ))}
        </div>
      )}

      {report.tables.map((table) => (
        <TableCard key={table.key} table={table} portal={portal} />
      ))}
    </div>
  );
}

/** Mirrors the report layout, so the page does not jump when data arrives. */
export function ReportSkeleton() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading report">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[100px] rounded-[var(--radius-card)]" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-[var(--radius-card)]" />
      <Skeleton className="h-72 rounded-[var(--radius-card)]" />
    </div>
  );
}
