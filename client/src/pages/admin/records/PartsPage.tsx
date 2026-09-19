/**
 * Parts & Inventory, Admin view (spec sections 11, 25 Phase 2).
 *
 * Two tabs:
 *
 *  - **Part list** — the company-wide master section 11 describes: name, code,
 *    category, unit, active. Only Admin edits it. Every centre's stock, every
 *    technician's request and every usage record picks from this list, which
 *    is what keeps "cooling pad" one part instead of three spellings.
 *  - **Stock by center** — read-only. Counts belong to each centre's Owner
 *    (section 3.2, "manage center parts stock"); Admin's job is to see where
 *    stock is running low across all of them.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Boxes, Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  ActiveBadge,
  ActiveToggleDialog,
  RecordsTable,
  RecordsToolbar,
  TH,
  useFieldErrors,
  useRefreshRecords,
  useServiceCenters,
} from '@/components/records/Records';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn, formatDate, humanize } from '@/lib/format';
import type { Paged, Part, StockRow } from '@/lib/types';

/* Mirrors PART_UNITS on the server (parts.model.ts). */
const UNITS = ['PIECE', 'SET', 'METER', 'LITRE', 'KILOGRAM'] as const;

export function PartsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stock' ? 'stock' : 'parts';

  return (
    <>
      <PageHeader
        title="Parts & Inventory"
        description="The company's part list, and how much each service center holds."
      />

      <div className="mb-6 flex gap-6 border-b border-slate-200" role="tablist">
        {(
          [
            ['parts', 'Part list'],
            ['stock', 'Stock by center'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            /* Clicking the open tab again keeps its filters. */
            onClick={() => key !== tab && setParams(key === 'parts' ? {} : { tab: key })}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
              tab === key ? 'border-brand-600 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'parts' ? <PartListTab /> : <StockTab />}
    </>
  );
}

/* ---- Part list ---------------------------------------------------------- */

function PartListTab() {
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Part | 'new' | null>(null);
  const [toggling, setToggling] = useState<Part | null>(null);
  const refresh = useRefreshRecords();

  const parts = useQuery({
    queryKey: ['parts', 'master'],
    queryFn: () => api<Paged<Part>>('/parts', { query: { limit: 100, includeInactive: true } }),
  });

  const term = search.toLowerCase();
  const rows = (parts.data?.items ?? [])
    .filter((p) => showInactive || p.isActive !== false)
    .filter(
      (p) =>
        !term ||
        p.name.toLowerCase().includes(term) ||
        p.code.toLowerCase().includes(term) ||
        (p.category ?? '').toLowerCase().includes(term),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <RecordsToolbar
            search={search}
            onSearch={setSearch}
            placeholder="Search by name, code or category"
            showInactive={showInactive}
            onShowInactive={setShowInactive}
          />
        </div>
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          Add part
        </Button>
      </div>

      <Card className="overflow-hidden">
        {parts.error && !parts.data ? (
          <ErrorState error={parts.error} onRetry={() => void parts.refetch()} />
        ) : !parts.data ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Boxes className="size-5" />} title={term ? 'No parts match' : 'No parts yet'} />
        ) : (
          <RecordsTable minWidth={720}>
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <th scope="col" className={TH}>Part</th>
                <th scope="col" className={TH}>Category</th>
                <th scope="col" className={TH}>Unit</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((part) => (
                <tr key={part.id} className={cn(part.isActive === false && 'bg-slate-50/60')}>
                  <td className="whitespace-nowrap px-5 py-3">
                    <p className="font-medium text-slate-900">{part.name}</p>
                    <p className="text-xs text-slate-500">{part.code}</p>
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-slate-700">{part.category ?? '—'}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-slate-700">{humanize(part.unit)}</td>
                  <td className="px-5 py-3">
                    <ActiveBadge active={part.isActive} />
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(part)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Power className="size-3.5" />}
                        className={part.isActive !== false ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
                        onClick={() => setToggling(part)}
                      >
                        {part.isActive !== false ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </RecordsTable>
        )}
      </Card>

      {editing && <PartDialog part={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      {toggling && (
        <ActiveToggleDialog
          name={toggling.name}
          active={toggling.isActive !== false}
          consequence="Centres can no longer stock it and technicians can no longer request it. Past usage keeps it."
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            const activate = toggling.isActive === false;
            await api(`/parts/${toggling.id}`, { method: 'PATCH', body: { isActive: activate } });
            toast.success(activate ? `${toggling.name} activated` : `${toggling.name} deactivated`);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function PartDialog({ part, onClose }: { part: Part | null; onClose: () => void }) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();
  const [name, setName] = useState(part?.name ?? '');
  const [code, setCode] = useState(part?.code ?? '');
  const [category, setCategory] = useState(part?.category ?? '');
  const [unit, setUnit] = useState(part?.unit ?? 'PIECE');

  const save = useMutation({
    mutationFn: () => {
      const trimmed = category.trim();
      return part
        ? /* An emptied box is sent as null, which clears it. Leaving the key
             out, as this did, keeps the old category while saying "updated". */
          api(`/parts/${part.id}`, {
            method: 'PATCH',
            body: { name: name.trim(), unit, category: trimmed || null },
          })
        : api('/parts', {
            method: 'POST',
            body: { name: name.trim(), code: code.trim(), unit, ...(trimmed ? { category: trimmed } : {}) },
          });
    },
    onSuccess: async () => {
      toast.success(part ? 'Part updated' : 'Part added');
      onClose();
      await refresh();
    },
    onError: fromError,
  });

  const submit = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found['name'] = 'Enter the part name';
    if (!part && !/^[A-Za-z0-9_-]+$/.test(code.trim())) {
      found['code'] = 'Letters, digits, hyphen and underscore only';
    }
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={part ? `Edit ${part.name}` : 'Add part'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {part ? 'Save' : 'Add part'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} required autoFocus />
        {part ? (
          <p className="text-sm text-slate-500">
            Code <span className="font-medium text-slate-700">{part.code}</span> is fixed once created.
          </p>
        ) : (
          <Input
            label="Code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            error={errors['code']}
            hint="Unique, e.g. PUMP-02. Cannot be changed later."
            required
          />
        )}
        <Input label="Category (optional)" value={category} onChange={(e) => setCategory(e.target.value)} error={errors['category']} placeholder="e.g. Electrical" />
        <Select label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} error={errors['unit']} required>
          {UNITS.map((option) => (
            <option key={option} value={option}>
              {humanize(option)}
            </option>
          ))}
        </Select>
      </div>
    </Dialog>
  );
}

/* ---- Stock by center ---------------------------------------------------- */

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function StockTab() {
  /**
   * Filters live in the address bar, so a link can open this tab already
   * narrowed — `?tab=stock&serviceCenterId=<id>` for one centre, plus `&low=1`
   * for its low stock (the service center page links here). A malformed id is
   * ignored rather than sent, which the server would refuse.
   */
  const [params, setParams] = useSearchParams();
  const requestedCentre = params.get('serviceCenterId') ?? '';
  const centreId = OBJECT_ID.test(requestedCentre) ? requestedCentre : '';
  const lowOnly = params.get('low') === '1';

  const setFilter = (key: 'serviceCenterId' | 'low', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const centres = useServiceCenters({ includeInactive: true });
  const centreName = (id: string) => centres.data?.items.find((c) => c.id === id)?.name ?? '—';
  const centreListed = (centres.data?.items ?? []).some((centre) => centre.id === centreId);

  const stock = useQuery({
    queryKey: ['stock', 'admin', centreId, lowOnly],
    queryFn: () =>
      api<Paged<StockRow>>('/parts/stock/list', {
        query: { limit: 200, ...(centreId ? { serviceCenterId: centreId } : {}), ...(lowOnly ? { lowOnly: true } : {}) },
      }),
  });

  const rows = [...(stock.data?.items ?? [])].sort(
    (a, b) =>
      Number(b.isLowStock) - Number(a.isLowStock) ||
      centreName(a.serviceCenterId).localeCompare(centreName(b.serviceCenterId)) ||
      a.partName.localeCompare(b.partName),
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={centreId}
          onChange={(event) => setFilter('serviceCenterId', event.target.value)}
          aria-label="Filter by service center"
          className="h-9 rounded-lg border-0 bg-white pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
        >
          <option value="">All service centers</option>
          {/* A centre from the link, until the list arrives (or if it is not
              in it), so the box never claims "All" while one is filtered. */}
          {centreId && !centreListed && (
            <option value={centreId}>{centres.data ? 'Unknown service center' : 'Loading…'}</option>
          )}
          {(centres.data?.items ?? []).map((centre) => (
            <option key={centre.id} value={centre.id}>
              {centre.name}
            </option>
          ))}
        </select>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(event) => setFilter('low', event.target.checked ? '1' : '')}
            className="size-4 rounded accent-brand-700"
          />
          Low stock only
        </label>
        <p className="text-sm text-slate-500 sm:ml-auto">Counts are kept by each center’s Owner.</p>
      </div>

      <Card className="overflow-hidden">
        {stock.error && !stock.data ? (
          <ErrorState error={stock.error} onRetry={() => void stock.refetch()} />
        ) : !stock.data ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Boxes className="size-5" />}
            title={lowOnly ? 'Nothing is low' : 'No stock recorded'}
            description={lowOnly ? 'Every stocked part is above its minimum.' : 'Centres add stock from their own portal.'}
          />
        ) : (
          <RecordsTable minWidth={760}>
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <th scope="col" className={TH}>Service center</th>
                <th scope="col" className={TH}>Part</th>
                <th scope="col" className={cn(TH, 'text-right')}>Available</th>
                <th scope="col" className={cn(TH, 'text-right')}>Minimum</th>
                <th scope="col" className={TH}>Last delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-5 py-3 text-slate-700">{centreName(row.serviceCenterId)}</td>
                  <td className="whitespace-nowrap px-5 py-3">
                    <p className="font-medium text-slate-900">{row.partName}</p>
                    <p className="text-xs text-slate-500">{row.partCode}</p>
                  </td>
                  <td className="tabular px-5 py-3 text-right">
                    <span className={cn('inline-flex items-center gap-1.5 font-medium', row.isLowStock ? 'text-red-600' : 'text-slate-900')}>
                      {row.isLowStock && (
                        <>
                          <AlertTriangle className="size-3.5" aria-hidden />
                          <span className="sr-only">Low stock:</span>
                        </>
                      )}
                      {row.availableQuantity}
                    </span>
                  </td>
                  <td className="tabular px-5 py-3 text-right text-slate-600">{row.minimumStock}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-slate-500">
                    {row.lastRestockedAt ? formatDate(row.lastRestockedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </RecordsTable>
        )}
      </Card>
    </>
  );
}
