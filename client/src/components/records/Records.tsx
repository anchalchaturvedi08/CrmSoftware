/**
 * Building blocks for the record screens (spec section 25, Phase 2).
 *
 * Customers, products, service centres, users, parts and cities all do the
 * same few things: list with a search, add, edit, and switch a record off.
 * Section 17 rules out deleting operational records, so "switch off" is
 * always deactivation — and it is always confirmed, because deactivating a
 * centre or a technician can strand live work.
 *
 * Keeping these pieces shared is what makes the eight screens behave alike.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { api, ApiError } from '@/lib/api';
import { formatMobile, humanize } from '@/lib/format';
import type {
  City,
  IssuedPassword,
  Paged,
  Product,
  ServiceCenter,
  StrandedWork,
  Territory,
} from '@/lib/types';

/* ---- Lookups ------------------------------------------------------------ */

/**
 * The small reference lists every form picks from.
 *
 * Fetched whole (they are tens of rows, not thousands) and cached, so a city
 * select opens instantly and every screen shows the same names.
 */
export function useCities({ includeInactive = false } = {}) {
  return useQuery({
    queryKey: ['cities', includeInactive ? 'all-with-inactive' : 'all'],
    queryFn: () =>
      api<Paged<City>>('/cities', {
        query: { limit: 200, ...(includeInactive ? { includeInactive: true } : {}) },
      }),
    staleTime: 5 * 60_000,
  });
}

export function useTerritories({ includeInactive = false } = {}) {
  return useQuery({
    queryKey: ['territories', includeInactive ? 'all-with-inactive' : 'all'],
    queryFn: () =>
      api<Paged<Territory>>('/territories', {
        query: { limit: 200, ...(includeInactive ? { includeInactive: true } : {}) },
      }),
    staleTime: 5 * 60_000,
  });
}

export function useServiceCenters({ includeInactive = false } = {}) {
  return useQuery({
    queryKey: ['service-centers', includeInactive ? 'all-with-inactive' : 'all'],
    queryFn: () =>
      api<Paged<ServiceCenter>>('/service-centers', {
        query: { limit: 200, ...(includeInactive ? { includeInactive: true } : {}) },
      }),
    staleTime: 60_000,
  });
}

export function useProducts({ includeInactive = false } = {}) {
  return useQuery({
    queryKey: ['products', includeInactive ? 'all-with-inactive' : 'all'],
    queryFn: () =>
      api<Paged<Product>>('/products', {
        query: { limit: 200, ...(includeInactive ? { includeInactive: true } : {}) },
      }),
    staleTime: 60_000,
  });
}

/**
 * Refreshes every list a record edit can change.
 *
 * Broad on purpose: renaming a city changes the complaint form, the customer
 * list and the centre recommendations at once, and a stale name in any of
 * them would look like the edit failed.
 */
export function useRefreshRecords() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [
        'customers',
        'customer-history',
        'products',
        'product-models',
        'cities',
        'territories',
        'service-centers',
        'service-center',
        'recommendations',
        'users',
        'technicians',
        'user',
        'parts',
        'stock',
        'sla-rules',
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
}

/* ---- Form errors -------------------------------------------------------- */

/**
 * Field errors from a failed save.
 *
 * The server's messages are written for people, so they are shown beside the
 * field they belong to; anything not tied to a field becomes a toast.
 */
export function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fromError = (error: unknown) => {
    if (error instanceof ApiError && error.issues.length > 0) {
      setErrors(Object.fromEntries(error.issues.map((issue) => [issue.field, issue.message])));
      return;
    }
    toast.error(error instanceof Error ? error.message : 'Could not save');
  };

  return { errors, setErrors, fromError, clear: () => setErrors({}) };
}

/* ---- Toolbar ------------------------------------------------------------ */

export function RecordsToolbar({
  search,
  onSearch,
  placeholder,
  showInactive,
  onShowInactive,
  children,
}: {
  search: string;
  onSearch: (term: string) => void;
  placeholder: string;
  showInactive: boolean;
  onShowInactive: (value: boolean) => void;
  /** Extra filters, placed between the search and the inactive toggle. */
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(draft.trim());
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <form onSubmit={submit} className="relative min-w-[240px] flex-1 sm:max-w-sm" role="search">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            /* Clearing the box clears the search without another Enter. */
            if (event.target.value === '' && search) onSearch('');
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-9 w-full rounded-lg border-0 bg-white pl-9 pr-3 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </form>

      {children}

      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(event) => onShowInactive(event.target.checked)}
          className="size-4 rounded accent-brand-700"
        />
        Show inactive
      </label>
    </div>
  );
}

export function ActiveBadge({ active }: { active: boolean | undefined }) {
  return active === false ? (
    <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20">Inactive</Badge>
  ) : (
    <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-600/20">Active</Badge>
  );
}

/** The wrapper every record table sits in. `relative` keeps screen-reader-only
    headers from widening the page (see DECISIONS.md section 23). */
export function RecordsTable({ minWidth, children }: { minWidth: number; children: ReactNode }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const TH =
  'whitespace-nowrap px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500';

/* ---- Activate / deactivate ---------------------------------------------- */

export function ActiveToggleDialog({
  name,
  active,
  consequence,
  onClose,
  onConfirm,
}: {
  name: string;
  active: boolean;
  /** What deactivating does to this kind of record, in plain words. */
  consequence: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={active ? `Deactivate ${name}?` : `Activate ${name}?`}
      description={active ? consequence : 'It becomes available to choose again.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={active ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Could not update');
              } finally {
                setBusy(false);
              }
            }}
          >
            {active ? 'Deactivate' : 'Activate'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {active
          ? 'Nothing is deleted — its history stays, and you can activate it again at any time.'
          : 'You can deactivate it again at any time.'}
      </p>
    </Dialog>
  );
}

/* ---- Work left behind --------------------------------------------------- */

/**
 * Open complaints that need a new home after a deactivation (sections 8, 9).
 * Listed straight away with a link to each, rather than left to be found.
 */
export function StrandedWorkDialog({
  title,
  description,
  items,
  linkBase,
  onClose,
  assignable = true,
}: {
  title: string;
  description: string;
  items: StrandedWork[];
  linkBase: string;
  onClose: () => void;
  /**
   * False when whoever sees this dialog has no way to actually reassign the
   * item — e.g. Admin viewing a deactivated technician's jobs, where only
   * the service center owner can pick a new technician (there is no
   * technician-assignment control on Admin's complaint page). The item is
   * then a plain, non-actionable line instead of a "Reassign" link that
   * would lead nowhere. Defaults to true, the service-center-deactivation
   * behaviour, where the linked page really can reassign.
   */
  assignable?: boolean;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={title}
      description={description}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {items.map((item) => (
          <li key={item.complaintId} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-sm">
              <span className="tabular font-medium text-slate-900">{item.complaintNumber}</span>
              <span className="ml-2 text-xs text-slate-500">{humanize(item.status)}</span>
            </span>
            {item.status === 'ADMIN_CONFIRMATION' ? (
              // Accepted work is closed with the customer, not moved.
              <Link to={`${linkBase}/${item.complaintId}`} className="text-sm font-medium text-brand-700 hover:underline">
                Confirm and close
              </Link>
            ) : assignable ? (
              <Link to={`${linkBase}/${item.complaintId}`} className="text-sm font-medium text-brand-700 hover:underline">
                Reassign
              </Link>
            ) : (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-xs text-slate-500">The center reassigns</span>
                <Link to={`${linkBase}/${item.complaintId}`} className="font-medium text-brand-700 hover:underline">
                  Open
                </Link>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ---- The one-time password ---------------------------------------------- */

/**
 * A temporary password, shown the one time it can be read.
 *
 * Only a scrypt hash is stored, so this is the moment to hand it over — the
 * dialog says so rather than leaving someone to discover it later.
 */
export function IssuedPasswordDialog({ issued, onClose }: { issued: IssuedPassword; onClose: () => void }) {
  const copy = () => {
    if (!navigator.clipboard) {
      toast.error('Copying is not available here — select the password and copy it instead');
      return;
    }
    navigator.clipboard
      .writeText(issued.temporaryPassword)
      .then(() => toast.success('Password copied'))
      .catch(() => toast.error('Could not copy — select the password and copy it instead'));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Password for ${issued.user.name}`}
      description="Give this to them now. It cannot be shown again."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <dl className="space-y-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Mobile number</dt>
          <dd className="tabular mt-1 text-sm text-slate-900">{formatMobile(issued.user.mobile)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Temporary password</dt>
          <dd className="mt-1 flex items-center gap-2">
            <code className="flex-1 select-all rounded-lg bg-slate-100 px-3 py-2.5 font-mono text-base tracking-wide text-slate-900">
              {issued.temporaryPassword}
            </code>
            <Button variant="secondary" icon={<Copy className="size-4" />} onClick={copy}>
              Copy
            </Button>
          </dd>
        </div>
      </dl>
      <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        Only a scrambled copy is stored, so nobody — including Admin — can look this up later. When they first sign
        in, they will be asked to choose their own password.
      </p>
    </Dialog>
  );
}
