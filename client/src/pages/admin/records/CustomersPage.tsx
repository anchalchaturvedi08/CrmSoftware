/**
 * Customers (spec sections 6.1, 13, 25 Phase 2).
 *
 * Customers run to thousands, so unlike the other record screens this one
 * searches and pages on the server — section 19's "avoid loading all
 * complaints into browser" applies just as much to the people behind them.
 *
 * ## The mobile number cannot be edited
 *
 * It is the customer's identity: section 13's repeat-complaint history is
 * keyed on it and snapshotted onto every complaint, so changing it would
 * silently split one person's history in two (DECISIONS.md section 5.1). The
 * form shows it read-only and says why, instead of offering a field the
 * server would refuse.
 */
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, History, Package, Pencil, Plus, Power, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  ActiveBadge,
  ActiveToggleDialog,
  RecordsTable,
  RecordsToolbar,
  TH,
  useCities,
  useFieldErrors,
  useRefreshRecords,
} from '@/components/records/Records';
import { CityInput, StateSelect } from '@/components/records/CityStateFields';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ContactButtons } from '@/components/ui/ContactButtons';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDate, formatMobile } from '@/lib/format';
import type { City, Complaint, Customer, CustomerProduct, Paged } from '@/lib/types';
import { warrantyPeriod } from '@/lib/warranty';

const PAGE_SIZE = 25;

export function CustomersPage() {
  const [search, setSearch] = useState('');
  const [cityId, setCityId] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [toggling, setToggling] = useState<Customer | null>(null);
  const [history, setHistory] = useState<Customer | null>(null);
  const refresh = useRefreshRecords();

  const cities = useCities({ includeInactive: true });
  const cityName = (id: string) => cities.data?.items.find((c) => c.id === id)?.name ?? '—';

  const customers = useQuery({
    queryKey: ['customers', 'list', { search, cityId, showInactive, page }],
    queryFn: () =>
      api<Paged<Customer>>('/customers', {
        query: {
          search,
          cityId,
          page,
          limit: PAGE_SIZE,
          ...(showInactive ? { includeInactive: true } : {}),
        },
      }),
    placeholderData: keepPreviousData,
  });

  const data = customers.data;
  /* Any filter change starts again from the first page. */
  const filter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description={data ? `${data.total.toLocaleString('en-IN')} ${data.total === 1 ? 'customer' : 'customers'}` : undefined}
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add customer
          </Button>
        }
      />

      <RecordsToolbar
        search={search}
        onSearch={filter(setSearch)}
        placeholder="Search by name or mobile"
        showInactive={showInactive}
        onShowInactive={filter(setShowInactive)}
      >
        <select
          value={cityId}
          onChange={(event) => filter(setCityId)(event.target.value)}
          aria-label="Filter by city"
          className="h-9 rounded-lg border-0 bg-white pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
        >
          <option value="">All cities</option>
          {(cities.data?.items ?? []).map((city) => (
            <option key={city.id} value={city.id}>
              {city.name}
            </option>
          ))}
        </select>
      </RecordsToolbar>

      <Card className="overflow-hidden">
        {customers.error && !data ? (
          <ErrorState error={customers.error} onRetry={() => void customers.refetch()} />
        ) : !data ? (
          <div className="space-y-2 p-5" aria-busy aria-label="Loading customers">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title={search || cityId ? 'No customers match' : 'No customers yet'}
            description={
              search || cityId
                ? 'Try a different name or number.'
                : 'Customers are added here or while creating a complaint.'
            }
          />
        ) : (
          <div className={cn('transition-opacity', customers.isFetching && 'opacity-60')}>
            <RecordsTable minWidth={940}>
              <thead className="border-b border-slate-200 bg-slate-50/70">
                <tr>
                  <th scope="col" className={TH}>Customer</th>
                  <th scope="col" className={TH}>Mobile</th>
                  <th scope="col" className={TH}>Address</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((customer) => (
                  <tr key={customer.id} className={cn(customer.isActive === false && 'bg-slate-50/60')}>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <p className="font-medium text-slate-900">{customer.name}</p>
                      {customer.email && <p className="text-xs text-slate-500">{customer.email}</p>}
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3.5 text-slate-700">
                      <div className="flex items-center gap-3">
                        <span>{formatMobile(customer.mobile)}</span>
                        <ContactButtons mobile={customer.mobile} name={customer.name} compact />
                      </div>
                      {customer.alternateMobile && (
                        <p className="text-xs text-slate-500">Alt. {formatMobile(customer.alternateMobile)}</p>
                      )}
                    </td>
                    <td className="max-w-xs px-5 py-3.5 text-slate-700">
                      <p className="truncate" title={customer.address}>
                        {customer.address}
                      </p>
                      <p className="text-xs text-slate-500">
                        {cityName(customer.cityId)}, {customer.state} {customer.pincode}
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      <ActiveBadge active={customer.isActive} />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => setHistory(customer)}>
                          History
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(customer)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Power className="size-3.5" />}
                          className={customer.isActive !== false ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
                          onClick={() => setToggling(customer)}
                        >
                          {customer.isActive !== false ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </RecordsTable>
          </div>
        )}

        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm">
            <span className="text-slate-500">
              Page {data.page} of {data.totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={<ChevronLeft className="size-4" />} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {editing && (
        <CustomerDialog
          customer={editing === 'new' ? null : editing}
          cities={cities.data?.items ?? []}
          onClose={() => setEditing(null)}
        />
      )}

      {toggling && (
        <ActiveToggleDialog
          name={toggling.name}
          active={toggling.isActive !== false}
          consequence="They no longer appear when searching for a customer on a new complaint. Their complaints are unaffected."
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            const activate = toggling.isActive === false;
            await api(`/customers/${toggling.id}`, { method: 'PATCH', body: { isActive: activate } });
            toast.success(activate ? `${toggling.name} activated` : `${toggling.name} deactivated`);
            await refresh();
          }}
        />
      )}

      {history && <HistoryDialog customer={history} onClose={() => setHistory(null)} />}
    </>
  );
}

/* ---- Form --------------------------------------------------------------- */

const MOBILE = /^[6-9]\d{9}$/;
const digits = (value: string) => value.replace(/\D/g, '');

function CustomerDialog({
  customer,
  cities,
  onClose,
}: {
  customer: Customer | null;
  cities: City[];
  onClose: () => void;
}) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();

  const [name, setName] = useState(customer?.name ?? '');
  const [mobile, setMobile] = useState(customer?.mobile ?? '');
  const [alternateMobile, setAlternateMobile] = useState(customer?.alternateMobile ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [address, setAddress] = useState(customer?.address ?? '');
  /* A typed city and a state from the list (DECISIONS.md section 32): the
     server files the name under the state, creating the city the first time
     anyone types it. An existing customer's city is shown by name. */
  const [cityName, setCityName] = useState(
    cities.find((city) => city.id === customer?.cityId)?.name ?? '',
  );
  const [state, setState] = useState(customer?.state ?? '');
  const [pincode, setPincode] = useState(customer?.pincode ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        /* An emptied field is sent as '' so removing a number actually saves;
           a new customer with none simply leaves it out. */
        ...(digits(alternateMobile)
          ? { alternateMobile: digits(alternateMobile) }
          : customer?.alternateMobile
            ? { alternateMobile: '' }
            : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        address: address.trim(),
        cityName: cityName.trim(),
        state,
        pincode: pincode.trim(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      return customer
        ? api(`/customers/${customer.id}`, { method: 'PATCH', body })
        : api('/customers', { method: 'POST', body: { ...body, mobile: digits(mobile) } });
    },
    onSuccess: async () => {
      toast.success(customer ? 'Customer updated' : 'Customer added');
      onClose();
      await refresh();
    },
    onError: (error) => {
      /* An existing customer with that number is a conflict, not a field
         format problem — but it belongs beside the mobile field all the same. */
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ mobile: error.message });
        return;
      }
      fromError(error);
    },
  });

  const submit = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found['name'] = 'Enter the customer’s name';
    if (!customer && !MOBILE.test(digits(mobile))) found['mobile'] = 'Enter a valid 10-digit mobile number';
    if (digits(alternateMobile) && !MOBILE.test(digits(alternateMobile))) {
      found['alternateMobile'] = 'Enter a valid 10-digit mobile number, or leave it blank';
    }
    if (!address.trim()) found['address'] = 'Enter the address';
    if (!state) found['state'] = 'Choose the state';
    if (!cityName.trim()) found['cityName'] = 'Enter the city';
    if (!/^\d{6}$/.test(pincode.trim())) found['pincode'] = 'Pincode must be 6 digits';
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={customer ? `Edit ${customer.name}` : 'Add customer'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {customer ? 'Save' : 'Add customer'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} required autoFocus />
        </div>
        {customer ? (
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Mobile</p>
            <p className="tabular py-2 text-sm text-slate-900">{formatMobile(customer.mobile)}</p>
            <p className="text-xs text-slate-500">
              Cannot be changed: it links this customer’s complaint history. A new number is a new customer.
            </p>
          </div>
        ) : (
          <Input
            label="Mobile"
            type="tel"
            inputMode="numeric"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            error={errors['mobile']}
            required
          />
        )}
        <Input
          label="Alternate mobile (optional)"
          type="tel"
          inputMode="numeric"
          value={alternateMobile}
          onChange={(e) => setAlternateMobile(e.target.value)}
          error={errors['alternateMobile']}
        />
        <div className="sm:col-span-2">
          <Input label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors['email']} />
        </div>
        <div className="sm:col-span-2">
          <Textarea label="Address" value={address} onChange={(e) => setAddress(e.target.value)} error={errors['address']} className="min-h-[64px]" required />
        </div>
        <StateSelect value={state} onChange={setState} error={errors['state']} />
        <CityInput
          value={cityName}
          state={state}
          onChange={setCityName}
          error={errors['cityName'] ?? errors['cityId']}
        />
        <Input
          label="Pincode"
          inputMode="numeric"
          maxLength={6}
          value={pincode}
          onChange={(e) => setPincode(digits(e.target.value))}
          error={errors['pincode']}
          required
        />
        <div className="sm:col-span-2">
          <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors['notes']} className="min-h-[64px]" />
        </div>
      </div>
    </Dialog>
  );
}

/* ---- History (section 13) ---------------------------------------------- */

function HistoryDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const history = useQuery({
    queryKey: ['customer-history', customer.id],
    queryFn: () =>
      api<{ complaints: Complaint[]; products: CustomerProduct[]; total: number }>(
        `/customers/${customer.id}/history`,
      ),
  });

  const rows = history.data?.complaints ?? [];
  const products = history.data?.products ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={customer.name}
      description={`${formatMobile(customer.mobile)} · their products, then every complaint, newest first`}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {!history.data && !history.error ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : history.error && !history.data ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          No complaints for this customer yet — their products appear here once a complaint records one.
        </p>
      ) : (
        <>
        <ProductsList products={products} />
        <h3 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-slate-500">
          Complaints ({rows.length})
        </h3>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {rows.map((complaint) => (
            <li key={complaint.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/admin/complaints/${complaint.id}`}
                  className="tabular text-sm font-medium text-slate-900 hover:text-brand-700 hover:underline"
                >
                  {complaint.complaintNumber}
                </Link>
                <StatusBadge status={complaint.status} />
                {(complaint.priority === 'HIGH' || complaint.priority === 'CRITICAL') && (
                  <PriorityBadge priority={complaint.priority} />
                )}
                {complaint.reopenCount > 0 && (
                  <span className="text-xs text-fuchsia-700">Reopened {complaint.reopenCount}×</span>
                )}
                <span className="ml-auto text-xs text-slate-500">{formatDate(complaint.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm text-slate-700">
                {complaint.category} · {complaint.productSnapshot.productName} {complaint.productSnapshot.modelNumber}
              </p>
              <p className="tabular text-xs text-slate-500">Serial {complaint.serialNumber}</p>
            </li>
          ))}
        </ul>
        </>
      )}
    </Dialog>
  );
}

/**
 * The units a customer owns, as their complaints record them
 * (DECISIONS.md section 32): one row per serial number, with the warranty
 * read from the purchase date. Nothing is entered here — a product appears
 * the moment a complaint is raised for it, which is how the client asked for
 * it: "show the customer's product after the complaint is created".
 */
function ProductsList({ products }: { products: CustomerProduct[] }) {
  return (
    <section aria-labelledby="customer-products">
      <h3 id="customer-products" className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Products ({products.length})
      </h3>
      {products.length === 0 ? (
        <p className="text-sm text-slate-500">No products recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {products.map((product) => {
            const period = warrantyPeriod(product.purchaseDate, product.warrantyMonths);
            return (
              <li key={product.serialNumber} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    <Package className="size-4 shrink-0 text-slate-400" aria-hidden />
                    {product.productName} {product.modelNumber}
                  </p>
                  <p className="tabular mt-0.5 text-xs text-slate-500">
                    Serial {product.serialNumber}
                    {product.purchaseDate ? ` · purchased ${formatDate(product.purchaseDate)}` : ' · no purchase date'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {product.complaints} {product.complaints === 1 ? 'complaint' : 'complaints'}
                    {product.openComplaints > 0 && `, ${product.openComplaints} open`} · last{' '}
                    {formatDate(product.lastComplaintAt)}
                  </p>
                </div>
                <p
                  className={cn(
                    'inline-flex items-center gap-1.5 text-sm font-medium',
                    period === null ? 'text-slate-500' : period.inWarranty ? 'text-emerald-700' : 'text-slate-700',
                  )}
                >
                  <ShieldCheck
                    className={cn('size-4', period?.inWarranty ? 'text-emerald-600' : 'text-slate-400')}
                    aria-hidden
                  />
                  {period === null
                    ? 'Warranty unknown'
                    : period.inWarranty
                      ? `In warranty · ${period.text}`
                      : `Out of warranty · ${period.text}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
