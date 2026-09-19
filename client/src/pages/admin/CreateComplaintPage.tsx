/**
 * Create complaint (spec section 6.1, Workflow A).
 *
 * Follows Workflow A's order: customer, product, serial number, the complaint
 * itself, priority, warranty, service address, then an optional service
 * center. On success the complaint number and Happy Code are shown once, with
 * the WhatsApp action ready (Workflow A step 14).
 *
 * ## Repeat complaints are surfaced before the complaint exists
 *
 * Section 13 asks Admin to decide, for a repeat problem, between reopening an
 * existing complaint and raising a new one — and rules out automatic duplicate
 * detection. That decision has to be made *before* submitting, so as soon as a
 * customer is picked or a serial number typed, their previous complaints
 * appear beside the form with a link to reopen. Showing history afterwards
 * would only reveal the duplicate that had just been created.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  History,
  MessageCircle,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, PageHeader } from '@/components/ui/Card';
import { CityInput, StateSelect } from '@/components/records/CityStateFields';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { errorMessage } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDate, formatMobile, PRIORITY_META, type Priority } from '@/lib/format';
import type {
  City,
  Complaint,
  Customer,
  Paged,
  Product,
  ProductModel,
  Recommendation,
} from '@/lib/types';

/* ---- Small hook -------------------------------------------------------- */

/** Delays a fast-changing value, so typing does not fire a request per key. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Complaint categories.
 *
 * Offered as suggestions, not a closed list: the spec names "Complaint
 * Category" as a field but does not enumerate them, and a free-text field with
 * common options keeps reports groupable without blocking an unusual fault.
 */
const CATEGORY_SUGGESTIONS = [
  'Not cooling',
  'Water leakage',
  'Fan not working',
  'Pump not working',
  'Noise',
  'Electrical fault',
  'Remote not working',
  'Installation',
  'Other',
];

interface CreatedResult {
  complaint: Complaint;
  happyCode: string;
}

export function CreateComplaintPage() {
  const navigate = useNavigate();

  /* ---- Customer ---------------------------------------------------------- */
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    mobile: '',
    address: '',
    cityName: '',
    state: '',
    pincode: '',
  });

  /* ---- Service address (Workflow A step 8) -------------------------------
   *
   * Defaults to the customer's own address — the one just saved for a new
   * customer, or the one on file for an existing one — and stays read-only
   * until the Admin explicitly asks for something different. Whichever one is
   * in effect is what is sent, always, so the complaint is never saved with an
   * address nobody confirmed on screen (section 6.1). */
  const [useDifferentAddress, setUseDifferentAddress] = useState(false);
  const [serviceAddress, setServiceAddress] = useState({ address: '', cityName: '', state: '', pincode: '' });

  /* ---- Product and complaint --------------------------------------------- */
  const [productId, setProductId] = useState('');
  const [productModelId, setProductModelId] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [warrantyStatus, setWarrantyStatus] = useState<'' | 'IN_WARRANTY' | 'OUT_OF_WARRANTY'>('');
  const [serviceCenterId, setServiceCenterId] = useState('');

  const [issues, setIssues] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedResult | null>(null);

  /* ---- Lookups ----------------------------------------------------------- */
  const debouncedSearch = useDebounced(customerSearch.trim());

  const customers = useQuery({
    queryKey: ['customers', 'search', debouncedSearch],
    queryFn: () =>
      api<Paged<Customer>>('/customers', { query: { search: debouncedSearch, limit: 8 } }),
    enabled: customerMode === 'existing' && !customer && debouncedSearch.length >= 2,
  });

  /**
   * Checks the typed mobile as it is entered, for a "new" customer.
   *
   * A number already on file belongs to that customer (section 13's history is
   * keyed on it), and the server refuses a second record for it. Catching it
   * here, before Save, is what lets the Admin be told whose number it is and
   * switch to them — rather than finding out only from a 409 after typing a
   * different name and address that would never have been saved.
   */
  const debouncedNewMobile = useDebounced(newCustomer.mobile.replace(/\D/g, '').slice(-10));
  const mobileMatch = useQuery({
    queryKey: ['customer-by-mobile', debouncedNewMobile],
    queryFn: () => api<Paged<Customer>>('/customers', { query: { search: debouncedNewMobile, limit: 5 } }),
    enabled: customerMode === 'new' && /^[6-9]\d{9}$/.test(debouncedNewMobile),
  });
  const duplicateCustomer = mobileMatch.data?.items.find((item) => item.mobile === debouncedNewMobile);

  const products = useQuery({
    queryKey: ['products', 'all'],
    queryFn: () => api<Paged<Product>>('/products', { query: { limit: 200 } }),
  });

  const models = useQuery({
    queryKey: ['product-models', productId],
    queryFn: () =>
      api<Paged<ProductModel>>('/product-models', { query: { productId, limit: 200 } }),
    enabled: Boolean(productId),
  });

  const cities = useQuery({
    queryKey: ['cities', 'all'],
    queryFn: () => api<Paged<City>>('/cities', { query: { limit: 200 } }),
  });

  /**
   * The customer's own address — the starting point for step 8, and what is
   * sent unless the Admin turns on "a different address for this complaint".
   */
  const defaultAddress =
    customerMode === 'existing' && customer
      ? {
          address: customer.address,
          cityName: cities.data?.items.find((c) => c.id === customer.cityId)?.name ?? '',
          state: customer.state,
          pincode: customer.pincode,
        }
      : {
          address: newCustomer.address,
          cityName: newCustomer.cityName,
          state: newCustomer.state,
          pincode: newCustomer.pincode,
        };
  const hasDefaultAddress = Boolean(defaultAddress.address && defaultAddress.cityName && defaultAddress.pincode);

  /* What is actually confirmed for this complaint — step 8. Recommendations
     and the payload both follow this, not the customer's address, so a centre
     recommended (or saved) matches whichever one was chosen on screen. */
  const effectiveAddress = useDifferentAddress ? serviceAddress : defaultAddress;

  /* Where the service happens, which drives the section 8 recommendation. */
  /* A typed city and state: the server resolves them to the city record. */
  const location = {
    pincode: effectiveAddress.pincode,
    cityName: effectiveAddress.cityName,
    state: effectiveAddress.state,
  };

  const recommendations = useQuery({
    queryKey: ['recommendations', location.pincode, location.cityName, location.state],
    queryFn: () =>
      api<{ recommended: Recommendation[]; others: Recommendation[]; fellBackToAll: boolean }>(
        '/complaints/recommendations',
        { query: location },
      ),
    enabled: /^\d{6}$/.test(location.pincode),
  });

  /* ---- Section 13: history before creating ------------------------------ */
  const customerHistory = useQuery({
    queryKey: ['customer-history', customer?.id],
    queryFn: () =>
      api<{ complaints: Complaint[]; total: number }>(`/customers/${customer!.id}/history`),
    enabled: Boolean(customer),
  });

  const debouncedSerial = useDebounced(serialNumber.trim());
  const serialHistory = useQuery({
    queryKey: ['serial-history', debouncedSerial],
    queryFn: () =>
      api<{ complaints: Complaint[]; total: number }>(
        `/serial-history/${encodeURIComponent(debouncedSerial)}`,
      ),
    enabled: debouncedSerial.length >= 3,
  });

  /** Both histories merged, without listing a complaint twice. */
  const previous = useMemo(() => {
    const seen = new Map<string, Complaint>();
    for (const item of [
      ...(serialHistory.data?.complaints ?? []),
      ...(customerHistory.data?.complaints ?? []),
    ]) {
      seen.set(item.id, item);
    }
    return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [serialHistory.data, customerHistory.data]);

  const sameUnit = (serialHistory.data?.total ?? 0) > 0;

  /* When the product changes, a model from the previous product is invalid. */
  useEffect(() => setProductModelId(''), [productId]);

  /* ---- Submit ------------------------------------------------------------ */
  const submit = useMutation({
    mutationFn: () =>
      api<CreatedResult>('/complaints', {
        method: 'POST',
        body: {
          ...(customerMode === 'existing' && customer
            ? { customerId: customer.id }
            : { newCustomer }),
          productId,
          productModelId,
          serialNumber: serialNumber.trim(),
          ...(purchaseDate ? { purchaseDate } : {}),
          category: category.trim(),
          description: description.trim(),
          priority,
          warrantyStatus,
          /* Always sent, and always the address actually confirmed in step 4
             below — never the customer's on file when a different one was
             chosen on screen. */
          serviceAddress: {
            address: effectiveAddress.address.trim(),
            cityName: effectiveAddress.cityName.trim(),
            state: effectiveAddress.state,
            pincode: effectiveAddress.pincode,
          },
          ...(serviceCenterId ? { serviceCenterId } : {}),
        },
      }),
    onSuccess: (result) => {
      setCreated(result);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.issues.length > 0) {
        const mapped: Record<string, string> = {};
        for (const issue of error.issues) {
          mapped[issue.field] = issue.message;
          /* `newCustomer.mobile` is also read by its last segment, since the
             input there is named by it. `serviceAddress.*` is not: its fields
             share tails (`address`, `cityId`, `pincode`) with `newCustomer.*`,
             and falling back the same way would put a service-address error
             on the customer's own address input instead. */
          if (issue.field.startsWith('newCustomer.')) {
            const tail = issue.field.split('.').pop();
            if (tail) mapped[tail] = issue.message;
          }
        }
        setIssues(mapped);
        toast.error('Please fix the highlighted fields');
      } else {
        toast.error(errorMessage(error));
      }
    },
  });

  /** Catches the obvious gaps before a round trip, with messages by the fields. */
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};

    if (customerMode === 'existing' && !customer) found['customer'] = 'Choose a customer, or add a new one';
    if (customerMode === 'new') {
      if (!newCustomer.name.trim()) found['name'] = 'Customer name is required';
      if (!/^[6-9]\d{9}$/.test(newCustomer.mobile.replace(/\D/g, '').slice(-10)))
        found['mobile'] = 'Enter a valid 10-digit mobile number';
      /* Refused here too, not only on the server: the Admin must act on it —
         switch to the existing customer — before this can be saved at all. */
      else if (duplicateCustomer) found['mobile'] = `This mobile belongs to ${duplicateCustomer.name}`;
      if (!newCustomer.address.trim()) found['address'] = 'Address is required';
      if (!newCustomer.state) found['state'] = 'Choose the state';
      if (!newCustomer.cityName.trim()) found['cityName'] = 'Enter the city';
      if (!/^\d{6}$/.test(newCustomer.pincode)) found['pincode'] = 'Pincode must be 6 digits';
    }
    if (!productId) found['productId'] = 'Choose a product';
    if (!productModelId) found['productModelId'] = 'Choose a model';
    if (!serialNumber.trim()) found['serialNumber'] = 'Serial number is required';
    if (!category.trim()) found['category'] = 'Choose or type a category';
    if (!description.trim()) found['description'] = 'Describe the problem';
    if (!warrantyStatus) found['warrantyStatus'] = 'Select the warranty status';
    if (!effectiveAddress.address.trim()) found['serviceAddress.address'] = 'Service address is required';
    if (!effectiveAddress.state) found['serviceAddress.state'] = 'Choose the state';
    if (!effectiveAddress.cityName.trim()) found['serviceAddress.cityName'] = 'Enter the city';
    if (!/^\d{6}$/.test(effectiveAddress.pincode)) found['serviceAddress.pincode'] = 'Pincode must be 6 digits';

    setIssues(found);
    if (Object.keys(found).length > 0) {
      toast.error('Please fix the highlighted fields');
      return;
    }

    submit.mutate();
  };

  if (created) {
    return <CreatedPanel result={created} onAnother={() => navigate(0)} />;
  }

  const clear = (key: string) =>
    setIssues((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });

  return (
    <>
      <Link
        to="/admin/complaints"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" />
        Complaints
      </Link>

      <PageHeader
        title="New complaint"
        description="Only Admin can raise a complaint. The complaint number and Happy Code are generated when you save."
      />

      <form onSubmit={onSubmit} noValidate className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ---- 1. Customer ------------------------------------------- */}
          <Card>
            <CardHeader
              title="1. Customer"
              action={
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm" role="radiogroup">
                  {(['existing', 'new'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={customerMode === mode}
                      onClick={() => {
                        setCustomerMode(mode);
                        setCustomer(null);
                        clear('customer');
                      }}
                      className={cn(
                        'rounded-md px-3 py-1 font-medium transition-colors',
                        customerMode === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600',
                      )}
                    >
                      {mode === 'existing' ? 'Existing' : 'New customer'}
                    </button>
                  ))}
                </div>
              }
            />
            <div className="px-5 py-5">
              {customerMode === 'existing' ? (
                customer ? (
                  <div className="flex items-start justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50/50 p-4">
                    <div>
                      <p className="font-medium text-slate-900">{customer.name}</p>
                      <p className="tabular mt-0.5 text-sm text-slate-600">
                        {formatMobile(customer.mobile)}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {customer.address}, {customer.pincode}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<X className="size-3.5" />}
                      onClick={() => setCustomer(null)}
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <div>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-[38px] size-4 text-slate-400" />
                      <Input
                        label="Find customer"
                        value={customerSearch}
                        onChange={(event) => setCustomerSearch(event.target.value)}
                        placeholder="Search by name or mobile number"
                        className="pl-9"
                        error={issues['customer']}
                        autoFocus
                      />
                    </div>

                    {debouncedSearch.length >= 2 && (
                      <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
                        {customers.isLoading ? (
                          <p className="px-4 py-3 text-sm text-slate-500">Searching…</p>
                        ) : customers.data && customers.data.items.length > 0 ? (
                          <ul className="divide-y divide-slate-100" role="listbox">
                            {customers.data.items.map((item) => (
                              <li key={item.id}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCustomer(item);
                                    clear('customer');
                                  }}
                                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
                                >
                                  <span>
                                    <span className="block text-sm font-medium text-slate-900">
                                      {item.name}
                                    </span>
                                    <span className="block text-xs text-slate-500">
                                      {item.address}, {item.pincode}
                                    </span>
                                  </span>
                                  <span className="tabular text-sm text-slate-600">
                                    {formatMobile(item.mobile)}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="flex items-center justify-between gap-3 px-4 py-3">
                            <span className="text-sm text-slate-500">No customer found.</span>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<UserPlus className="size-3.5" />}
                              onClick={() => {
                                setCustomerMode('new');
                                /* Carry a typed mobile number over, rather than
                                   making Admin type it twice. */
                                if (/^\d{10}$/.test(customerSearch.replace(/\D/g, ''))) {
                                  setNewCustomer((current) => ({
                                    ...current,
                                    mobile: customerSearch.replace(/\D/g, ''),
                                  }));
                                }
                              }}
                            >
                              Add as new
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label="Customer name"
                    value={newCustomer.name}
                    onChange={(e) => {
                      setNewCustomer({ ...newCustomer, name: e.target.value });
                      clear('name');
                    }}
                    error={issues['name']}
                    required
                  />
                  <Input
                    label="Mobile number"
                    type="tel"
                    inputMode="numeric"
                    value={newCustomer.mobile}
                    onChange={(e) => {
                      setNewCustomer({ ...newCustomer, mobile: e.target.value });
                      clear('mobile');
                    }}
                    error={duplicateCustomer ? undefined : issues['mobile']}
                    hint="A number already on file cannot be used for a new customer."
                    required
                  />

                  {/* A mobile already on file: named plainly, with a way out
                      that never saves what is on screen under someone else's
                      record. Shown as it is typed, not only after Save fails,
                      so the wrong address is never sent at all. */}
                  {duplicateCustomer && (
                    <div className="flex items-start gap-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 sm:col-span-2">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span className="flex-1">
                        This mobile belongs to <strong>{duplicateCustomer.name}</strong>. Choose them as
                        the existing customer instead — you can still use a different service address
                        for this complaint.
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setCustomerMode('existing');
                          setCustomer(duplicateCustomer);
                          setCustomerSearch('');
                          clear('mobile');
                        }}
                      >
                        Use {duplicateCustomer.name}
                      </Button>
                    </div>
                  )}

                  <Input
                    label="Service address"
                    value={newCustomer.address}
                    onChange={(e) => {
                      setNewCustomer({ ...newCustomer, address: e.target.value });
                      clear('address');
                    }}
                    error={issues['address']}
                    className="sm:col-span-2"
                    required
                  />
                  <StateSelect
                    value={newCustomer.state}
                    onChange={(state) => {
                      setNewCustomer({ ...newCustomer, state });
                      clear('state');
                    }}
                    error={issues['state']}
                  />
                  <CityInput
                    value={newCustomer.cityName}
                    state={newCustomer.state}
                    onChange={(cityName) => {
                      setNewCustomer({ ...newCustomer, cityName });
                      clear('cityName');
                    }}
                    error={issues['cityName'] ?? issues['cityId']}
                  />
                  <Input
                    label="Pincode"
                    inputMode="numeric"
                    maxLength={6}
                    value={newCustomer.pincode}
                    onChange={(e) => {
                      setNewCustomer({ ...newCustomer, pincode: e.target.value.replace(/\D/g, '') });
                      clear('pincode');
                    }}
                    error={issues['pincode']}
                    required
                  />
                </div>
              )}
            </div>
          </Card>

          {/* ---- 2. Product --------------------------------------------- */}
          <Card>
            <CardHeader title="2. Product" />
            <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
              <Select
                label="Product"
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value);
                  clear('productId');
                }}
                error={issues['productId']}
                required
              >
                <option value="">Select a product</option>
                {products.data?.items.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Model"
                value={productModelId}
                onChange={(e) => {
                  setProductModelId(e.target.value);
                  clear('productModelId');
                }}
                error={issues['productModelId']}
                disabled={!productId}
                required
              >
                <option value="">{productId ? 'Select a model' : 'Choose a product first'}</option>
                {models.data?.items.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.modelNumber}
                    {model.name ? ` — ${model.name}` : ''}
                  </option>
                ))}
              </Select>
              <Input
                label="Serial number"
                value={serialNumber}
                onChange={(e) => {
                  setSerialNumber(e.target.value.toUpperCase());
                  clear('serialNumber');
                }}
                error={issues['serialNumber']}
                required
              />
              <Input
                label="Purchase date"
                type="date"
                value={purchaseDate}
                /* The local date, not UTC's — `toISOString` reads UTC, which
                   between midnight and 05:29 IST is still yesterday, and that
                   made today unselectable for exactly those five and a half
                   hours. */
                max={dayjs().format('YYYY-MM-DD')}
                onChange={(e) => setPurchaseDate(e.target.value)}
                hint="Optional"
              />
            </div>
          </Card>

          {/* ---- 3. Complaint ------------------------------------------- */}
          <Card>
            <CardHeader title="3. Complaint" />
            <div className="space-y-5 px-5 py-5">
              <div>
                <Input
                  label="Category"
                  list="category-suggestions"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    clear('category');
                  }}
                  error={issues['category']}
                  placeholder="e.g. Not cooling"
                  required
                />
                <datalist id="category-suggestions">
                  {CATEGORY_SUGGESTIONS.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>

              <Textarea
                label="Description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  clear('description');
                }}
                error={issues['description']}
                placeholder="What is the customer reporting?"
                required
              />

              <fieldset>
                <legend className="mb-2 block text-sm font-medium text-slate-700">
                  Priority <span className="text-red-500" aria-hidden>*</span>
                </legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const).map((level) => (
                    <label
                      key={level}
                      className={cn(
                        'flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                        priority === level
                          ? 'border-brand-600 bg-brand-50 text-brand-800 ring-1 ring-brand-600'
                          : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="priority"
                        value={level}
                        checked={priority === level}
                        onChange={() => setPriority(level)}
                        className="sr-only"
                      />
                      {PRIORITY_META[level].label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 block text-sm font-medium text-slate-700">
                  Warranty <span className="text-red-500" aria-hidden>*</span>
                </legend>
                {/* Nothing preselected: section 12 makes this Admin's explicit
                    choice, and a default would let it be skipped. */}
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['IN_WARRANTY', 'In warranty'],
                      ['OUT_OF_WARRANTY', 'Out of warranty'],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className={cn(
                        'flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                        warrantyStatus === value
                          ? 'border-brand-600 bg-brand-50 text-brand-800 ring-1 ring-brand-600'
                          : issues['warrantyStatus']
                            ? 'border-red-300 text-slate-700'
                            : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="warranty"
                        value={value}
                        checked={warrantyStatus === value}
                        onChange={() => {
                          setWarrantyStatus(value);
                          clear('warrantyStatus');
                        }}
                        className="sr-only"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {issues['warrantyStatus'] && (
                  <p className="mt-1.5 text-sm text-red-600" role="alert">
                    {issues['warrantyStatus']}
                  </p>
                )}
              </fieldset>
            </div>
          </Card>

          {/* ---- 4. Service address (Workflow A step 8) ------------------ */}
          <Card>
            <CardHeader
              title="4. Service address"
              description="Where the technician goes for this complaint."
            />
            <div className="px-5 py-5">
              {!hasDefaultAddress ? (
                <p className="text-sm text-slate-500">
                  {customerMode === 'existing'
                    ? 'Choose a customer first.'
                    : 'Enter the new customer’s name, mobile and address above first.'}
                </p>
              ) : (
                <div className="space-y-4">
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-slate-700">
                      {customerMode === 'existing' ? "Customer's saved address" : 'Address entered above'}
                    </p>
                    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 text-sm">
                      <p className="text-slate-900">{defaultAddress.address}</p>
                      <p className="mt-0.5 text-slate-500">
                        {defaultAddress.cityName}, {defaultAddress.state} – {defaultAddress.pincode}
                      </p>
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={useDifferentAddress}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setUseDifferentAddress(checked);
                        /* Seeded from the default once, so switching this on
                           starts from something rather than four blank fields —
                           and switching it off and on again does not lose an
                           edit already made. */
                        if (checked && !serviceAddress.address) setServiceAddress(defaultAddress);
                      }}
                      className="size-4 rounded accent-brand-700"
                    />
                    Use a different address for this complaint
                  </label>

                  {useDifferentAddress && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input
                        label="Service address"
                        value={serviceAddress.address}
                        onChange={(e) => {
                          setServiceAddress({ ...serviceAddress, address: e.target.value });
                          clear('serviceAddress.address');
                        }}
                        error={issues['serviceAddress.address']}
                        className="sm:col-span-2"
                        required
                      />
                      <StateSelect
                        value={serviceAddress.state}
                        onChange={(state) => {
                          setServiceAddress({ ...serviceAddress, state });
                          clear('serviceAddress.state');
                        }}
                        error={issues['serviceAddress.state']}
                      />
                      <CityInput
                        value={serviceAddress.cityName}
                        state={serviceAddress.state}
                        onChange={(cityName) => {
                          setServiceAddress({ ...serviceAddress, cityName });
                          clear('serviceAddress.cityName');
                        }}
                        error={issues['serviceAddress.cityName'] ?? issues['serviceAddress.cityId']}
                      />
                      <Input
                        label="Pincode"
                        inputMode="numeric"
                        maxLength={6}
                        value={serviceAddress.pincode}
                        onChange={(e) => {
                          setServiceAddress({ ...serviceAddress, pincode: e.target.value.replace(/\D/g, '') });
                          clear('serviceAddress.pincode');
                        }}
                        error={issues['serviceAddress.pincode']}
                        required
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* ---- 5. Service center (optional) --------------------------- */}
          <Card>
            <CardHeader
              title="5. Service center"
              description="Optional. You can also assign one later from the complaint."
            />
            <div className="px-5 py-5">
              {!/^\d{6}$/.test(location.pincode) ? (
                <p className="text-sm text-slate-500">
                  Choose the customer first — centers are recommended from their pincode.
                </p>
              ) : recommendations.isLoading ? (
                <p className="text-sm text-slate-500">Finding centers…</p>
              ) : recommendations.data ? (
                <div className="space-y-2">
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm',
                      !serviceCenterId ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600' : 'border-slate-200',
                    )}
                  >
                    <input
                      type="radio"
                      name="centre"
                      checked={!serviceCenterId}
                      onChange={() => setServiceCenterId('')}
                      className="accent-brand-700"
                    />
                    <span className="text-slate-700">Decide later — save as New</span>
                  </label>

                  {[...recommendations.data.recommended, ...recommendations.data.others].map((option) => (
                    <label
                      key={option.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
                        serviceCenterId === option.id
                          ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600'
                          : 'border-slate-200 hover:bg-slate-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="centre"
                        checked={serviceCenterId === option.id}
                        onChange={() => setServiceCenterId(option.id)}
                        className="mt-1 accent-brand-700"
                      />
                      <span className="min-w-0">
                        <span className="text-sm font-medium text-slate-900">{option.name}</span>
                        <span className="ml-1.5 text-xs text-slate-500">{option.code}</span>
                        {option.reason !== 'NO_MATCH' && (
                          <span className="mt-1 flex items-center gap-1 text-xs font-medium text-brand-700">
                            <CheckCircle2 className="size-3.5" />
                            {option.explanation}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </Card>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate('/admin/complaints')}>
              Cancel
            </Button>
            <Button type="submit" size="lg" loading={submit.isPending}>
              Create complaint
            </Button>
          </div>
        </div>

        {/* ---- Section 13: previous complaints -------------------------- */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Card className={cn(sameUnit && 'border-amber-300')}>
            <CardHeader
              title="Previous complaints"
              description="Check before creating — it may be a repeat."
            />
            <div className="px-5 py-5">
              {!customer && debouncedSerial.length < 3 ? (
                <p className="flex gap-2 text-sm text-slate-500">
                  <History className="mt-0.5 size-4 shrink-0" />
                  Choose a customer or enter a serial number to see their history.
                </p>
              ) : previous.length === 0 ? (
                <p className="text-sm text-slate-500">No previous complaints found.</p>
              ) : (
                <>
                  {sameUnit && (
                    <div className="mb-4 flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>
                        This unit has had complaints before. If it is the same problem, reopen the
                        earlier complaint instead of creating a new one.
                      </span>
                    </div>
                  )}
                  <ul className="space-y-3">
                    {previous.slice(0, 8).map((item) => (
                      <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <Link
                            to={`/admin/complaints/${item.id}`}
                            target="_blank"
                            className="tabular inline-flex items-center gap-1 text-sm font-medium text-slate-900 hover:text-brand-700"
                          >
                            {item.complaintNumber}
                            <ExternalLink className="size-3" />
                          </Link>
                          <StatusBadge status={item.status} />
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatDate(item.createdAt)} · {item.serialNumber}
                        </p>
                        <p className="mt-1 line-clamp-2 text-sm text-slate-700">{item.category}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </aside>
      </form>
    </>
  );
}

/* ---- Success ----------------------------------------------------------- */

/**
 * Workflow A steps 11-14: the number, the Happy Code, and the WhatsApp action.
 *
 * The code is shown here exactly once — the server returns it only at
 * creation. After this it can only be read through the audited WhatsApp route
 * on the complaint.
 */
function CreatedPanel({ result, onAnother }: { result: CreatedResult; onAnother: () => void }) {
  const navigate = useNavigate();
  const { complaint, happyCode } = result;

  const whatsapp = useMutation({
    mutationFn: () =>
      api<{ available: boolean; url?: string; reason?: string }>(
        `/complaints/${complaint.id}/whatsapp`,
      ),
    onSuccess: (link) => {
      if (!link.available || !link.url) {
        toast.error(link.reason ?? 'WhatsApp is not available for this customer');
        return;
      }
      window.open(link.url, '_blank', 'noopener,noreferrer');
      toast.info('WhatsApp opened with the message ready. Press send in WhatsApp.', {
        duration: 8000,
      });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy — select it and copy manually');
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <div className="px-8 py-10 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="size-6" />
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Complaint created</h1>
          <p className="mt-1 text-sm text-slate-500">
            {complaint.customerSnapshot.name} · {complaint.productSnapshot.productName}
          </p>

          <div className="mt-8 grid gap-3 text-left sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Complaint number</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="tabular text-lg font-semibold text-slate-900">
                  {complaint.complaintNumber}
                </span>
                <button
                  type="button"
                  onClick={() => void copy(complaint.complaintNumber, 'Complaint number')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Copy complaint number"
                >
                  <Copy className="size-4" />
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-teal-800">Happy Code</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="tabular text-lg font-semibold tracking-[0.2em] text-slate-900">
                  {happyCode}
                </span>
                <button
                  type="button"
                  onClick={() => void copy(happyCode, 'Happy Code')}
                  className="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-600"
                  aria-label="Copy Happy Code"
                >
                  <Copy className="size-4" />
                </button>
              </div>
            </div>
          </div>

          <p className="mt-3 text-left text-xs text-slate-500">
            The customer needs this code to confirm the service. Send it now — it can be viewed
            again later from the complaint, and every viewing is recorded.
          </p>

          <div className="mt-8 flex flex-col gap-2">
            <Button
              size="lg"
              icon={<MessageCircle className="size-4" />}
              loading={whatsapp.isPending}
              onClick={() => whatsapp.mutate()}
            >
              Send to customer on WhatsApp
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => navigate(`/admin/complaints/${complaint.id}`)}>
                Open complaint
              </Button>
              <Button variant="secondary" onClick={onAnother}>
                Create another
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
