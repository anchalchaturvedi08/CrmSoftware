/**
 * Products and models (spec sections 6.1, 12, 25 Phase 2).
 *
 * A product has many models (DECISIONS.md section 4.4), so the screen is a
 * pair: products on one side, the selected product's models on the other.
 * The complaint form picks a product, then one of its models, so this is the
 * same shape the Admin will meet there.
 *
 * Warranty months are advisory defaults. Section 12 keeps the warranty choice
 * on the complaint authoritative, and the form says so rather than implying
 * the default decides anything.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { Package, Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  ActiveBadge,
  ActiveToggleDialog,
  RecordsTable,
  RecordsToolbar,
  TH,
  useFieldErrors,
  useProducts,
  useRefreshRecords,
} from '@/components/records/Records';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import type { Paged, Product, ProductModel } from '@/lib/types';

const months = (value?: number) =>
  value === undefined ? '—' : value === 0 ? 'None' : `${value} ${value === 1 ? 'month' : 'months'}`;

export function ProductsPage() {
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'product'; record: Product | null }
    | { kind: 'model'; record: ProductModel | null }
    | { kind: 'toggle-product'; record: Product }
    | { kind: 'toggle-model'; record: ProductModel }
    | null
  >(null);
  const refresh = useRefreshRecords();

  const products = useProducts({ includeInactive: true });
  const models = useQuery({
    queryKey: ['product-models', 'all-with-inactive'],
    queryFn: () =>
      api<Paged<ProductModel>>('/product-models', { query: { limit: 200, includeInactive: true } }),
  });

  const term = search.toLowerCase();
  const allModels = models.data?.items ?? [];

  const productRows = (products.data?.items ?? [])
    .filter((p) => showInactive || p.isActive !== false)
    .filter(
      (p) =>
        !term ||
        p.name.toLowerCase().includes(term) ||
        p.code.toLowerCase().includes(term) ||
        (p.category ?? '').toLowerCase().includes(term) ||
        allModels.some((m) => m.productId === p.id && m.modelNumber.toLowerCase().includes(term)),
    );

  /* The first product is selected by default, so the models panel is never
     an empty prompt on arrival. */
  const selected =
    productRows.find((p) => p.id === selectedId) ?? (selectedId ? undefined : productRows[0]);

  const modelRows = allModels
    .filter((m) => m.productId === selected?.id)
    .filter((m) => showInactive || m.isActive !== false)
    .sort((a, b) => a.modelNumber.localeCompare(b.modelNumber));

  const setActive = async (path: string, active: boolean, label: string) => {
    await api(path, { method: 'PATCH', body: { isActive: active } });
    toast.success(active ? `${label} activated` : `${label} deactivated`);
    await refresh();
  };

  return (
    <>
      <PageHeader
        title="Products"
        description="The coolers you service, and the models of each."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: 'product', record: null })}>
            Add product
          </Button>
        }
      />

      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        placeholder="Search products or model numbers"
        showInactive={showInactive}
        onShowInactive={setShowInactive}
      />

      <div className="grid gap-6 xl:grid-cols-5">
        {/* ---- Products ------------------------------------------------- */}
        <Card className="overflow-hidden xl:col-span-3">
          <CardHeader title="Products" description={products.data ? `${productRows.length} shown` : undefined} />
          {products.error && !products.data ? (
            <ErrorState error={products.error} onRetry={() => void products.refetch()} />
          ) : !products.data ? (
            <div className="space-y-2 p-5">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : productRows.length === 0 ? (
            <EmptyState icon={<Package className="size-5" />} title={term ? 'No products match' : 'No products yet'} />
          ) : (
            <RecordsTable minWidth={640}>
              <thead className="border-b border-slate-200 bg-slate-50/70">
                <tr>
                  <th scope="col" className={TH}>Product</th>
                  <th scope="col" className={TH}>Category</th>
                  <th scope="col" className={TH}>Warranty</th>
                  <th scope="col" className={cn(TH, 'text-right')}>Models</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {productRows.map((product) => {
                  const isSelected = product.id === selected?.id;
                  return (
                    <tr
                      key={product.id}
                      onClick={() => setSelectedId(product.id)}
                      className={cn('cursor-pointer transition-colors', isSelected ? 'bg-brand-50/60' : 'hover:bg-slate-50')}
                      aria-selected={isSelected}
                    >
                      <td className="whitespace-nowrap px-5 py-3">
                        <p className={cn('font-medium', isSelected ? 'text-brand-800' : 'text-slate-900')}>{product.name}</p>
                        <p className="text-xs text-slate-500">{product.code}</p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-slate-700">{product.category ?? '—'}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-slate-700">{months(product.defaultWarrantyMonths)}</td>
                      <td className="tabular px-5 py-3 text-right text-slate-700">
                        {/* A dash until the models arrive — "0" would read as a fact. */}
                        {models.data ? allModels.filter((m) => m.productId === product.id).length : '—'}
                      </td>
                      <td className="px-5 py-3">
                        <ActiveBadge active={product.isActive} />
                      </td>
                      <td className="px-5 py-3" onClick={(event) => event.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDialog({ kind: 'product', record: product })}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Power className="size-3.5" />}
                            className={product.isActive !== false ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
                            onClick={() => setDialog({ kind: 'toggle-product', record: product })}
                          >
                            {product.isActive !== false ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </RecordsTable>
          )}
        </Card>

        {/* ---- Models of the selected product --------------------------- */}
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader
            title={selected ? `${selected.name} — models` : 'Models'}
            description={selected ? `${modelRows.length} shown` : 'Select a product'}
            action={
              selected && (
                <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setDialog({ kind: 'model', record: null })}>
                  Add model
                </Button>
              )
            }
          />
          {!selected ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">Choose a product to see its models.</p>
          ) : models.error && !models.data ? (
            <ErrorState error={models.error} onRetry={() => void models.refetch()} />
          ) : !models.data ? (
            <div className="p-5">
              <Skeleton className="h-10" />
            </div>
          ) : modelRows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">No models yet. Add the first one.</p>
          ) : (
            <RecordsTable minWidth={440}>
              <thead className="border-b border-slate-200 bg-slate-50/70">
                <tr>
                  <th scope="col" className={TH}>Model</th>
                  <th scope="col" className={TH}>Warranty</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {modelRows.map((model) => (
                  <tr key={model.id}>
                    <td className="whitespace-nowrap px-5 py-3">
                      <p className="tabular font-medium text-slate-900">{model.modelNumber}</p>
                      {model.name && <p className="text-xs text-slate-500">{model.name}</p>}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-700">
                      {model.defaultWarrantyMonths === undefined
                        ? `Product default`
                        : months(model.defaultWarrantyMonths)}
                    </td>
                    <td className="px-5 py-3">
                      <ActiveBadge active={model.isActive} />
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDialog({ kind: 'model', record: model })}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Power className="size-3.5" />}
                          className={model.isActive !== false ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
                          onClick={() => setDialog({ kind: 'toggle-model', record: model })}
                        >
                          {model.isActive !== false ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </RecordsTable>
          )}
        </Card>
      </div>

      {dialog?.kind === 'product' && <ProductDialog product={dialog.record} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'model' && selected && (
        <ModelDialog product={selected} model={dialog.record} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'toggle-product' && (
        <ActiveToggleDialog
          name={dialog.record.name}
          active={dialog.record.isActive !== false}
          consequence="It can no longer be chosen on new complaints. Existing complaints keep it."
          onClose={() => setDialog(null)}
          onConfirm={() => setActive(`/products/${dialog.record.id}`, dialog.record.isActive === false, dialog.record.name)}
        />
      )}
      {dialog?.kind === 'toggle-model' && (
        <ActiveToggleDialog
          name={dialog.record.modelNumber}
          active={dialog.record.isActive !== false}
          consequence="It can no longer be chosen on new complaints. Existing complaints keep it."
          onClose={() => setDialog(null)}
          onConfirm={() =>
            setActive(`/product-models/${dialog.record.id}`, dialog.record.isActive === false, dialog.record.modelNumber)
          }
        />
      )}
    </>
  );
}

/* ---- Forms -------------------------------------------------------------- */

/** Reads the warranty field: blank is "no default", otherwise whole months. */
function warrantyValue(text: string): number | undefined | 'invalid' {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 600 ? value : 'invalid';
}

function ProductDialog({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();
  const [name, setName] = useState(product?.name ?? '');
  const [code, setCode] = useState(product?.code ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [warranty, setWarranty] = useState(
    product?.defaultWarrantyMonths === undefined ? '' : String(product.defaultWarrantyMonths),
  );
  const [notes, setNotes] = useState(product?.notes ?? '');

  const save = useMutation({
    mutationFn: (defaultWarrantyMonths: number | undefined) => {
      const body = {
        name: name.trim(),
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(defaultWarrantyMonths !== undefined ? { defaultWarrantyMonths } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      return product
        ? api(`/products/${product.id}`, { method: 'PATCH', body })
        : api('/products', { method: 'POST', body: { ...body, code: code.trim() } });
    },
    onSuccess: async () => {
      toast.success(product ? 'Product updated' : 'Product added');
      onClose();
      await refresh();
    },
    onError: fromError,
  });

  const submit = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found['name'] = 'Enter the product name';
    if (!product && !code.trim()) found['code'] = 'Enter a short code';
    const months = warrantyValue(warranty);
    if (months === 'invalid') found['defaultWarrantyMonths'] = 'Whole months, 0 to 600';
    setErrors(found);
    if (Object.keys(found).length === 0 && months !== 'invalid') save.mutate(months);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={product ? `Edit ${product.name}` : 'Add product'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {product ? 'Save' : 'Add product'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} required autoFocus />
        {product ? (
          <p className="text-sm text-slate-500">
            Code <span className="font-medium text-slate-700">{product.code}</span> is fixed once created.
          </p>
        ) : (
          <Input
            label="Code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            error={errors['code']}
            hint="Unique, e.g. DC50. Cannot be changed later."
            required
          />
        )}
        <Input label="Category (optional)" value={category} onChange={(e) => setCategory(e.target.value)} error={errors['category']} placeholder="e.g. Desert cooler" />
        <Input
          label="Default warranty in months (optional)"
          inputMode="numeric"
          value={warranty}
          onChange={(e) => setWarranty(e.target.value.replace(/\D/g, ''))}
          error={errors['defaultWarrantyMonths']}
          hint="A starting point only. The warranty chosen on each complaint is what counts."
        />
        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors['notes']} className="min-h-[64px]" />
      </div>
    </Dialog>
  );
}

function ModelDialog({
  product,
  model,
  onClose,
}: {
  product: Product;
  model: ProductModel | null;
  onClose: () => void;
}) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();
  const [modelNumber, setModelNumber] = useState(model?.modelNumber ?? '');
  const [name, setName] = useState(model?.name ?? '');
  const [warranty, setWarranty] = useState(
    model?.defaultWarrantyMonths === undefined ? '' : String(model.defaultWarrantyMonths),
  );

  const save = useMutation({
    mutationFn: (defaultWarrantyMonths: number | undefined) => {
      const body = {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(defaultWarrantyMonths !== undefined ? { defaultWarrantyMonths } : {}),
      };
      return model
        ? api(`/product-models/${model.id}`, { method: 'PATCH', body })
        : api('/product-models', {
            method: 'POST',
            body: { ...body, productId: product.id, modelNumber: modelNumber.trim() },
          });
    },
    onSuccess: async () => {
      toast.success(model ? 'Model updated' : 'Model added');
      onClose();
      await refresh();
    },
    onError: fromError,
  });

  const submit = () => {
    const found: Record<string, string> = {};
    if (!model && !modelNumber.trim()) found['modelNumber'] = 'Enter the model number';
    const months = warrantyValue(warranty);
    if (months === 'invalid') found['defaultWarrantyMonths'] = 'Whole months, 0 to 600';
    setErrors(found);
    if (Object.keys(found).length === 0 && months !== 'invalid') save.mutate(months);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={model ? `Edit ${model.modelNumber}` : `Add model to ${product.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {model ? 'Save' : 'Add model'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {model ? (
          <p className="text-sm text-slate-500">
            Model number <span className="font-medium text-slate-700">{model.modelNumber}</span> is fixed once created.
          </p>
        ) : (
          <Input
            label="Model number"
            value={modelNumber}
            onChange={(e) => setModelNumber(e.target.value.toUpperCase())}
            error={errors['modelNumber']}
            required
            autoFocus
          />
        )}
        <Input label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} />
        <Input
          label="Default warranty in months (optional)"
          inputMode="numeric"
          value={warranty}
          onChange={(e) => setWarranty(e.target.value.replace(/\D/g, ''))}
          error={errors['defaultWarrantyMonths']}
          hint="Leave blank to use the product's default."
        />
      </div>
    </Dialog>
  );
}
