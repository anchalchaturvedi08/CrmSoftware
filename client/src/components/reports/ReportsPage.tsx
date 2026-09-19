/**
 * Reports & MIS (spec section 16), for Admin and the Service Center portal.
 *
 * One page for both. The server scopes every figure to the caller — an Owner's
 * reports are their own centre's — so the differences here are only what to
 * offer: an Owner gets no service-center report and no centre filter.
 *
 * Layout follows the dashboard's rules: one filter row above everything it
 * scopes, so every figure on the page describes the same slice; and a refetch
 * keeps the old numbers on screen, dimmed, instead of flashing skeletons.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Download, Info, SlidersHorizontal, X } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { useCities, useProducts, useServiceCenters, useTerritories } from '@/components/records/Records';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { ErrorState, errorMessage } from '@/components/ui/States';
import { api, download } from '@/lib/api';
import { PRIORITY_META, STATUS_META, WARRANTY_LABEL, cn, type ComplaintStatus, type Priority } from '@/lib/format';
import type { Paged, ProductModel, Report, User } from '@/lib/types';
import { ReportSkeleton, ReportView } from './ReportView';
import {
  DATE_PRESETS,
  FILTER_LABELS,
  describeRange,
  useReportParams,
  type DatePreset,
  type FilterKey,
  type Portal,
} from './reportParams';

const CONTROL =
  'h-9 rounded-lg border-0 bg-white pl-3 pr-8 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600';

export function ReportsPage({ portal }: { portal: Portal }) {
  const params = useReportParams(portal);
  const { kind, query } = params;
  const [busy, setBusy] = useState<'xlsx' | 'csv' | null>(null);

  const report = useQuery({
    queryKey: ['report', kind, query],
    queryFn: ({ signal }) => api<Report>(`/reports/${kind}`, { query, signal }),
    placeholderData: keepPreviousData,
  });

  /* The previous report stays on screen while filters change — but not
     across reports, whose figures would sit under the wrong heading. */
  const data = report.data?.kind === kind ? report.data : undefined;

  const save = async (format: 'xlsx' | 'csv') => {
    setBusy(format);
    try {
      await download(`/reports/${kind}`, { ...query, format });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={portal === 'admin' ? 'Reports & MIS' : 'Reports'}
        description={
          portal === 'admin'
            ? 'Complaints, service centers, technicians, products and parts. Filter any way, and download what you see.'
            : 'How your center is doing. Filter any way, and download what you see.'
        }
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download className="size-4" />}
              loading={busy === 'xlsx'}
              disabled={busy !== null}
              onClick={() => void save('xlsx')}
            >
              Download Excel
            </Button>
            <Button
              variant="secondary"
              icon={<Download className="size-4" />}
              loading={busy === 'csv'}
              disabled={busy !== null}
              onClick={() => void save('csv')}
            >
              Download CSV
            </Button>
          </>
        }
      />

      {/* Scrolls sideways on a phone; `overflow-y-hidden` stops the tabs'
          1px underline overlap from adding a vertical scrollbar. */}
      <div
        className="mb-5 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-slate-200"
        role="tablist"
        aria-label="Report"
      >
        {params.available.map((option) => (
          <button
            key={option.kind}
            type="button"
            role="tab"
            aria-selected={kind === option.kind}
            onClick={() => params.update({ report: option.kind === 'complaints' ? '' : option.kind }, { push: true })}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
              kind === option.kind
                ? 'border-brand-600 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Filters portal={portal} params={params} />

      <p className="mb-6 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{describeRange(params.range)}.</span>
        {data && ` ${data.dateBasis}`}
      </p>

      {params.notApplied.length > 0 && (
        <p className="-mt-3 mb-6 flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
          <Info className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
          <span>
            {params.notApplied.map((key) => FILTER_LABELS[key]).join(', ')}{' '}
            {params.notApplied.length === 1 ? 'is' : 'are'} not used by this report.{' '}
            <button
              type="button"
              className="font-medium text-brand-700 hover:underline"
              onClick={() => params.update(Object.fromEntries(params.notApplied.map((key) => [key, ''])))}
            >
              Clear
            </button>
          </span>
        </p>
      )}

      {report.error && !data ? (
        <Card>
          <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        </Card>
      ) : !data ? (
        <ReportSkeleton />
      ) : (
        <div className={cn('transition-opacity', report.isFetching && 'opacity-60')}>
          <ReportView report={data} portal={portal} />
        </div>
      )}
    </>
  );
}

/* ---- Filters ---------------------------------------------------------------- */

const PLACEHOLDERS: Record<FilterKey, string> = {
  serviceCenterId: 'All service centers',
  technicianId: 'All technicians',
  territoryId: 'All states',
  cityId: 'All cities',
  productId: 'All products',
  productModelId: 'All models',
  priority: 'Any priority',
  warrantyStatus: 'Any warranty',
  status: 'Any status',
};

/** Choosing a parent clears its child: a model belongs to one product, and so on. */
const DEPENDENT: Partial<Record<FilterKey, FilterKey>> = {
  serviceCenterId: 'technicianId',
  territoryId: 'cityId',
  productId: 'productModelId',
};

type Option = { value: string; label: string };

/**
 * The date range, then one "Filters" button.
 *
 * Nine dropdowns laid out in a row took four rows on a laptop and pushed the
 * report off the screen. They live in a panel instead, and whatever is set
 * shows as a chip beside the button — so what the numbers are filtered by is
 * always visible, and each filter is one click to remove.
 */
function Filters({ portal, params }: { portal: Portal; params: ReturnType<typeof useReportParams> }) {
  const { values, applicable, update } = params;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const today = dayjs().format('YYYY-MM-DD');

  const cities = useCities({ includeInactive: true });
  const territories = useTerritories({ includeInactive: true });
  const centres = useServiceCenters({ includeInactive: true });
  const products = useProducts({ includeInactive: true });
  const models = useQuery({
    queryKey: ['product-models', 'all-with-inactive'],
    queryFn: () => api<Paged<ProductModel>>('/product-models', { query: { limit: 200, includeInactive: true } }),
    staleTime: 60_000,
  });
  const technicians = useQuery({
    queryKey: ['technicians', 'report-options'],
    queryFn: () =>
      api<Paged<User>>('/users', { query: { role: 'TECHNICIAN', limit: 100, includeInactive: true } }),
    staleTime: 60_000,
  });

  const named = <T extends { id: string; name: string; isActive?: boolean }>(rows: T[] | undefined): Option[] =>
    [...(rows ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ value: row.id, label: `${row.name}${row.isActive === false ? ' (inactive)' : ''}` }));

  const options: Record<FilterKey, Option[]> = {
    serviceCenterId: portal === 'admin' ? named(centres.data?.items) : [],
    technicianId: named(
      technicians.data?.items.filter(
        (user) => !values.serviceCenterId || user.serviceCenterId === values.serviceCenterId,
      ),
    ),
    territoryId: named(territories.data?.items),
    cityId: named(
      cities.data?.items.filter((city) => !values.territoryId || city.territoryId === values.territoryId),
    ),
    productId: named(products.data?.items),
    productModelId: [...(models.data?.items ?? [])]
      .filter((model) => !values.productId || model.productId === values.productId)
      .sort((a, b) => a.modelNumber.localeCompare(b.modelNumber))
      .map((model) => ({
        value: model.id,
        label: `${model.modelNumber}${model.isActive === false ? ' (inactive)' : ''}`,
      })),
    priority: (Object.keys(PRIORITY_META) as Priority[]).map((key) => ({ value: key, label: PRIORITY_META[key].label })),
    warrantyStatus: Object.entries(WARRANTY_LABEL).map(([value, label]) => ({ value, label })),
    status: (Object.keys(STATUS_META) as ComplaintStatus[]).map((key) => ({ value: key, label: STATUS_META[key].label })),
  };

  const set = (key: FilterKey, value: string) => {
    const child = DEPENDENT[key];
    update({ [key]: value, ...(child ? { [child]: '' } : {}) });
  };

  const active = applicable.filter((key) => values[key]);
  /* Until the options load, a chip says "…" rather than showing an id. */
  const chipLabel = (key: FilterKey) => options[key].find((option) => option.value === values[key])?.label ?? '…';

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={params.preset}
          onChange={(event) => {
            const preset = event.target.value as DatePreset;
            update(
              preset === 'custom'
                ? {
                    range: preset,
                    from: params.customFrom || dayjs().subtract(29, 'day').format('YYYY-MM-DD'),
                    to: params.customTo || today,
                  }
                : { range: preset === '30d' ? '' : preset, from: '', to: '' },
            );
          }}
          aria-label="Dates"
          className={CONTROL}
        >
          {DATE_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
        </select>

        {params.preset === 'custom' && (
          <span className="inline-flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={params.customFrom}
              max={params.customTo || today}
              onChange={(event) => update({ from: event.target.value })}
              aria-label="From date"
              className={cn(CONTROL, 'pr-3')}
            />
            <span className="text-sm text-slate-500">to</span>
            <input
              type="date"
              value={params.customTo}
              min={params.customFrom || undefined}
              max={today}
              onChange={(event) => update({ to: event.target.value })}
              aria-label="To date"
              className={cn(CONTROL, 'pr-3')}
            />
          </span>
        )}

        <Button
          size="sm"
          variant="secondary"
          className={cn('h-9', open && 'bg-slate-100')}
          icon={<SlidersHorizontal className="size-4" />}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          Filters{active.length > 0 ? ` (${active.length})` : ''}
        </Button>

        {active.map((key) => (
          <span
            key={key}
            className="inline-flex h-8 max-w-full items-center gap-1 rounded-full bg-brand-50 pl-3 pr-1 text-sm text-brand-900 ring-1 ring-inset ring-brand-600/20"
          >
            <span className="truncate">
              <span className="text-brand-800/70">{FILTER_LABELS[key]}:</span> {chipLabel(key)}
            </span>
            <button
              type="button"
              onClick={() => set(key, '')}
              aria-label={`Remove the ${FILTER_LABELS[key].toLowerCase()} filter`}
              className="shrink-0 rounded-full p-1 text-brand-700 hover:bg-brand-100"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}

        {active.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => update(Object.fromEntries(applicable.map((key) => [key, ''])))}
          >
            Clear all
          </Button>
        )}
      </div>

      {open && (
        <div
          id={panelId}
          className="mt-3 grid gap-3 rounded-[var(--radius-card)] border border-slate-200/80 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
        >
          {applicable.map((key) => (
            <label key={key} className="block min-w-0">
              <span className="mb-1 block text-xs font-medium text-slate-600">{FILTER_LABELS[key]}</span>
              <select
                value={values[key]}
                onChange={(event) => set(key, event.target.value)}
                className={cn(CONTROL, 'w-full')}
              >
                <option value="">{PLACEHOLDERS[key]}</option>
                {options[key].map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
