/**
 * Parts & Inventory (spec section 11).
 *
 * Two tabs, because they are two different jobs:
 *
 *  - **Requests** — technicians asking for parts, waiting on the Owner to
 *    approve, issue, mark unavailable or reject. This is a queue, so it opens
 *    first and shows the stock of each part beside the request.
 *  - **Stock** — what the centre holds. Deliveries are *added* ("we received
 *    20"); a stocktake *sets* the count ("there are 20"). They are separate
 *    actions on purpose: adding is safe when two people record deliveries at
 *    once, setting is not, and the server treats them differently.
 *
 * Stock goes down only when a part's use is confirmed on a complaint
 * (section 11: "decremented only when usage is finalized").
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, PackagePlus, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton, errorMessage } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDate, fromNow } from '@/lib/format';
import type { Paged, PartRequestRow, PartRequestStatus, StockRow } from '@/lib/types';
import {
  PartRequestActions,
  QueueStatusBadge,
  REQUEST_STATUS,
  usePartsCatalog,
  useRefreshCenter,
} from './shared';

type Tab = 'requests' | 'stock';

function useStock() {
  return useQuery({
    queryKey: ['stock', 'all'],
    queryFn: () => api<Paged<StockRow>>('/parts/stock/list', { query: { limit: 200 } }),
  });
}

export function PartsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'stock' ? 'stock' : 'requests';

  const setTab = (next: Tab) => {
    const updated = new URLSearchParams(params);
    if (next === 'requests') updated.delete('tab');
    else updated.set('tab', next);
    setParams(updated);
  };

  return (
    <>
      <PageHeader title="Parts & Inventory" />

      <div className="mb-6 flex gap-6 border-b border-slate-200" role="tablist">
        {(
          [
            ['requests', 'Requests'],
            ['stock', 'Stock'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
              tab === key
                ? 'border-brand-600 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'requests' ? <RequestsTab /> : <StockTab />}
    </>
  );
}

/* ---- Requests ---------------------------------------------------------- */

/**
 * The status filters.
 *
 * "Waiting" is everything not yet settled: new requests and approved ones.
 * Approving promises the part and issuing hands it over, so when Waiting
 * listed only new requests, approving one took it out of sight before the
 * part was issued. Same set as the server's `WAITING_REQUEST_STATUSES`.
 */
const REQUEST_FILTERS: ReadonlyArray<{ key: string; label: string; statuses: PartRequestStatus[] }> = [
  { key: 'waiting', label: 'Waiting', statuses: ['REQUESTED', 'APPROVED'] },
  { key: 'issued', label: 'Issued', statuses: ['ISSUED'] },
  { key: 'unavailable', label: 'Unavailable', statuses: ['UNAVAILABLE'] },
  { key: 'all', label: 'All', statuses: [] },
];

function RequestsTab() {
  const [filter, setFilter] = useState(REQUEST_FILTERS[0]!);
  const waiting = filter.key === 'waiting';
  const stock = useStock();

  const requests = useQuery({
    queryKey: ['part-requests', 'list', filter.key],
    queryFn: () =>
      api<Paged<PartRequestRow>>('/parts/requests/list', {
        query: { ...(filter.statuses.length > 0 ? { status: filter.statuses.join(',') } : {}), limit: 100 },
      }),
  });

  const stockOf = (partId: string) => stock.data?.items.find((row) => row.partId === partId);
  const rows = requests.data?.items ?? [];

  return (
    <>
      <div className="mb-4 inline-flex rounded-lg bg-white p-1 ring-1 ring-slate-200" role="radiogroup" aria-label="Request status">
        {REQUEST_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={filter.key === option.key}
            onClick={() => setFilter(option)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              filter.key === option.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {requests.error && !requests.data ? (
          <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
        ) : !requests.data ? (
          <div className="space-y-3 p-5" aria-busy aria-label="Loading requests">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={waiting ? 'No requests waiting' : 'No requests here'}
            description={
              waiting
                ? 'When a technician asks for a part on a job, it appears here for you to answer.'
                : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => {
              const held = stockOf(row.partId);
              const short = held !== undefined && held.availableQuantity < row.quantityRequested;
              /* The server refuses to approve or issue for a finished job, but
                 lets the request be rejected so it leaves this list. */
              const jobEnded =
                (row.status === 'REQUESTED' || row.status === 'APPROVED') &&
                (row.complaint?.status === 'CLOSED' || row.complaint?.status === 'CANCELLED');

              return (
                <li key={row.id} className="flex flex-wrap items-start gap-x-6 gap-y-3 px-5 py-4">
                  <div className="min-w-[220px] flex-1">
                    <p className="text-sm font-medium text-slate-900">
                      {row.part?.name ?? 'Part'}{' '}
                      <span className="tabular font-normal text-slate-500">
                        × {row.quantityRequested}
                        {row.part?.code && ` · ${row.part.code}`}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.requestedByName ?? 'Technician'} · {fromNow(row.createdAt)}
                      {row.complaint && (
                        <>
                          {' · '}
                          <Link
                            to={`/center/complaints/${row.complaint.id}`}
                            className="tabular font-medium text-brand-700 hover:underline"
                          >
                            {row.complaint.complaintNumber}
                          </Link>{' '}
                          ({row.complaint.customerName})
                        </>
                      )}
                    </p>
                    {row.reason && <p className="mt-1 text-sm text-slate-700">“{row.reason}”</p>}
                    {row.decisionRemarks && (
                      <p className="mt-1 text-xs text-slate-600">Your note: {row.decisionRemarks}</p>
                    )}
                    {jobEnded && (
                      <p className="mt-1 text-xs text-amber-700">
                        This complaint is {row.complaint?.status === 'CLOSED' ? 'closed' : 'cancelled'}, so no part can be
                        approved or issued for it. Reject the request to clear it from this list.
                      </p>
                    )}
                  </div>

                  <div className="w-32 text-sm">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">In stock</p>
                    {!stock.data ? (
                      <Skeleton className="mt-1 h-4 w-10" />
                    ) : held ? (
                      <p className={cn('tabular mt-0.5 font-medium', short ? 'text-red-600' : 'text-slate-900')}>
                        {held.availableQuantity}
                        {short && <span className="ml-1 text-xs font-normal">(not enough)</span>}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-slate-400">Not stocked</p>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <QueueStatusBadge status={row.status} />
                    <PartRequestActions request={row} inStock={held?.availableQuantity} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-500">
        {REQUEST_STATUS.ISSUED.label} parts come off the stock count when you confirm their use on the complaint.
      </p>
    </>
  );
}

/* ---- Stock ------------------------------------------------------------- */

type StockDialog = { kind: 'receive' | 'count'; row: StockRow } | { kind: 'add' } | null;

function StockTab() {
  const stock = useStock();
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [dialog, setDialog] = useState<StockDialog>(null);

  const term = search.trim().toLowerCase();
  const rows = (stock.data?.items ?? [])
    .filter((row) => !lowOnly || row.isLowStock)
    .filter((row) => !term || row.partName.toLowerCase().includes(term) || row.partCode.toLowerCase().includes(term))
    /* Low stock first, then by name — the ones needing an order lead. */
    .sort((a, b) => Number(b.isLowStock) - Number(a.isLowStock) || a.partName.localeCompare(b.partName));

  const lowCount = (stock.data?.items ?? []).filter((row) => row.isLowStock).length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search parts"
            aria-label="Search parts"
            className="h-9 w-full rounded-lg border-0 bg-white pl-9 pr-3 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(event) => setLowOnly(event.target.checked)}
            className="size-4 rounded accent-brand-700"
          />
          Low stock only
          {lowCount > 0 && (
            <span className="tabular rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700">{lowCount}</span>
          )}
        </label>

        <Button className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: 'add' })}>
          Add part to stock
        </Button>
      </div>

      <Card className="overflow-hidden">
        {stock.error && !stock.data ? (
          <ErrorState error={stock.error} onRetry={() => void stock.refetch()} />
        ) : !stock.data ? (
          <div className="space-y-3 p-5" aria-busy aria-label="Loading stock">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<PackagePlus className="size-5" />}
            title={stock.data.items.length === 0 ? 'No stock recorded yet' : 'No parts match'}
            description={
              stock.data.items.length === 0
                ? 'Add the parts your center keeps, with how many you hold and the level to reorder at.'
                : undefined
            }
          />
        ) : (
          /* `relative`: see TechniciansPage — keeps the screen-reader-only
             header inside this scroll box. */
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="whitespace-nowrap border-b border-slate-200 bg-slate-50/70 text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-3">Part</th>
                  <th scope="col" className="px-5 py-3 text-right">Available</th>
                  <th scope="col" className="px-5 py-3 text-right">Minimum</th>
                  <th scope="col" className="px-5 py-3">Last delivery</th>
                  <th scope="col" className="px-5 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-slate-900">{row.partName}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {row.partCode} · per {row.unit.toLowerCase()}
                      </p>
                    </td>
                    <td className="tabular px-5 py-3.5 text-right">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 font-medium',
                          row.isLowStock ? 'text-red-600' : 'text-slate-900',
                        )}
                      >
                        {row.isLowStock && (
                          <>
                            <AlertTriangle className="size-3.5" aria-hidden />
                            <span className="sr-only">Low stock:</span>
                          </>
                        )}
                        {row.availableQuantity}
                      </span>
                    </td>
                    <td className="tabular px-5 py-3.5 text-right text-slate-600">{row.minimumStock}</td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-500">
                      {row.lastRestockedAt ? formatDate(row.lastRestockedAt) : '—'}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => setDialog({ kind: 'receive', row })}>
                          Receive
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'count', row })}>
                          Set count
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog?.kind === 'receive' && <ReceiveDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'count' && <SetCountDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'add' && (
        <AddStockDialog stocked={(stock.data?.items ?? []).map((row) => row.partId)} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

/** Reads a whole number from an input, or null if it is not one. */
const wholeNumber = (value: string): number | null => {
  const parsed = Number(value);
  return value.trim() !== '' && Number.isInteger(parsed) ? parsed : null;
};

/* A delivery: a signed change, atomic on the server. */
function ReceiveDialog({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const refresh = useRefreshCenter();
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('Delivery received');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const receive = useMutation({
    mutationFn: (delta: number) =>
      api<StockRow>('/parts/stock/adjust', {
        method: 'POST',
        body: { partId: row.partId, delta, reason: reason.trim() },
      }),
    onSuccess: async (_result, delta) => {
      toast.success(`${delta} × ${row.partName} added to stock`);
      onClose();
      await refresh();
    },
    onError: (error) =>
      error instanceof ApiError && error.issues.length > 0
        ? setErrors(Object.fromEntries(error.issues.map((issue) => [issue.field, issue.message])))
        : toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Receive ${row.partName}`}
      description={`Currently ${row.availableQuantity} in stock. Adds to the count — safe even if someone else is recording a delivery at the same time.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={receive.isPending}
            onClick={() => {
              const delta = wholeNumber(quantity);
              const found: Record<string, string> = {};
              if (delta === null || delta < 1) found['delta'] = 'Enter how many arrived, at least 1';
              if (reason.trim().length < 3) found['reason'] = 'Say what this is, e.g. a supplier delivery';
              setErrors(found);
              if (Object.keys(found).length === 0 && delta !== null) receive.mutate(delta);
            }}
          >
            Add to stock
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          type="number"
          label="Quantity received"
          min={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          error={errors['delta']}
          required
          autoFocus
        />
        <Input
          label="Note"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          error={errors['reason']}
          hint="Recorded in the audit log."
          required
        />
      </div>
    </Dialog>
  );
}

/* A stocktake: the true count and the reorder level. */
function SetCountDialog({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const refresh = useRefreshCenter();
  const [available, setAvailable] = useState(String(row.availableQuantity));
  const [minimum, setMinimum] = useState(String(row.minimumStock));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (values: { availableQuantity: number; minimumStock: number }) =>
      api('/parts/stock', { method: 'PUT', body: { partId: row.partId, ...values } }),
    onSuccess: async () => {
      toast.success(`${row.partName} count updated`);
      onClose();
      await refresh();
    },
    onError: (error) =>
      error instanceof ApiError && error.issues.length > 0
        ? setErrors(Object.fromEntries(error.issues.map((issue) => [issue.field, issue.message])))
        : toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Set count for ${row.partName}`}
      description="For a stocktake: replaces the count with what is physically on the shelf. To record a delivery, use Receive instead."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              const availableQuantity = wholeNumber(available);
              const minimumStock = wholeNumber(minimum);
              const found: Record<string, string> = {};
              if (availableQuantity === null || availableQuantity < 0) found['availableQuantity'] = 'Enter a count, 0 or more';
              if (minimumStock === null || minimumStock < 0) found['minimumStock'] = 'Enter a level, 0 or more';
              setErrors(found);
              if (availableQuantity !== null && minimumStock !== null && Object.keys(found).length === 0) {
                save.mutate({ availableQuantity, minimumStock });
              }
            }}
          >
            Save count
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Input
          type="number"
          label="On the shelf"
          min={0}
          value={available}
          onChange={(event) => setAvailable(event.target.value)}
          error={errors['availableQuantity']}
          required
          autoFocus
        />
        <Input
          type="number"
          label="Reorder at"
          min={0}
          value={minimum}
          onChange={(event) => setMinimum(event.target.value)}
          error={errors['minimumStock']}
          hint="Low stock at or below this."
          required
        />
      </div>
    </Dialog>
  );
}

/* Start keeping a part the centre does not stock yet. */
function AddStockDialog({ stocked, onClose }: { stocked: string[]; onClose: () => void }) {
  const refresh = useRefreshCenter();
  const catalog = usePartsCatalog();
  const [partId, setPartId] = useState('');
  const [available, setAvailable] = useState('0');
  const [minimum, setMinimum] = useState('2');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const options = (catalog.data?.items ?? []).filter((part) => !stocked.includes(part.id));

  const add = useMutation({
    mutationFn: (values: { availableQuantity: number; minimumStock: number }) =>
      api('/parts/stock', { method: 'PUT', body: { partId, ...values } }),
    onSuccess: async () => {
      toast.success('Part added to stock');
      onClose();
      await refresh();
    },
    onError: (error) =>
      error instanceof ApiError && error.issues.length > 0
        ? setErrors(Object.fromEntries(error.issues.map((issue) => [issue.field, issue.message])))
        : toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Add part to stock"
      description="Parts come from the company's part list, kept by Admin."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={add.isPending}
            disabled={options.length === 0}
            onClick={() => {
              const availableQuantity = wholeNumber(available);
              const minimumStock = wholeNumber(minimum);
              const found: Record<string, string> = {};
              if (!partId) found['partId'] = 'Choose a part';
              if (availableQuantity === null || availableQuantity < 0) found['availableQuantity'] = 'Enter a count, 0 or more';
              if (minimumStock === null || minimumStock < 0) found['minimumStock'] = 'Enter a level, 0 or more';
              setErrors(found);
              if (availableQuantity !== null && minimumStock !== null && Object.keys(found).length === 0) {
                add.mutate({ availableQuantity, minimumStock });
              }
            }}
          >
            Add
          </Button>
        </>
      }
    >
      {!catalog.data && !catalog.error ? (
        <Skeleton className="h-10" />
      ) : options.length === 0 ? (
        <p className="text-sm text-slate-600">Every active part is already in your stock list.</p>
      ) : (
        <div className="space-y-4">
          <Select
            label="Part"
            value={partId}
            onChange={(event) => setPartId(event.target.value)}
            error={errors['partId']}
            required
          >
            <option value="">Choose a part</option>
            {options.map((part) => (
              <option key={part.id} value={part.id}>
                {part.name} ({part.code})
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              label="On the shelf"
              min={0}
              value={available}
              onChange={(event) => setAvailable(event.target.value)}
              error={errors['availableQuantity']}
              required
            />
            <Input
              type="number"
              label="Reorder at"
              min={0}
              value={minimum}
              onChange={(event) => setMinimum(event.target.value)}
              error={errors['minimumStock']}
              required
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}
