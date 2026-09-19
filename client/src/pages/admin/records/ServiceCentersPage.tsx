/**
 * Service centres (spec sections 8, 18, 25 Phase 2).
 *
 * A centre's **coverage** — its own city and pincode, plus the cities and
 * pincodes it also serves — is what section 8's recommendation matches a
 * complaint against. So the form treats coverage as a first-class part of the
 * record rather than an afterthought, and the list shows how much each centre
 * covers at a glance.
 *
 * Deactivating a centre never moves its work silently. Section 8: "Existing
 * complaint history remains unchanged. Open complaints must be reassigned by
 * Admin" — so the complaints left open are listed at once, each with a link.
 *
 * Clicking a centre opens its own page (ServiceCenterDetailPage) with
 * everything about it: contact, coverage, people, open work and stock.
 */
import { useMutation } from '@tanstack/react-query';
import { Pencil, Plus, Power, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  ActiveBadge,
  ActiveToggleDialog,
  RecordsTable,
  RecordsToolbar,
  StrandedWorkDialog,
  TH,
  useCities,
  useFieldErrors,
  useRefreshRecords,
  useServiceCenters,
} from '@/components/records/Records';
import { CityInput, StateSelect } from '@/components/records/CityStateFields';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn, formatMobile } from '@/lib/format';
import type { City, ServiceCenter, StrandedWork } from '@/lib/types';

/**
 * What deactivating a centre does, in the words of the confirmation.
 *
 * Its staff lose sign-in as well (decided with the client, DECISIONS.md
 * section 29): a centre that has stopped working for the company keeps no
 * access to its customers.
 */
export const DEACTIVATE_CENTRE_CONSEQUENCE =
  'It stops being recommended and cannot receive new complaints, and its Owner and technicians can no longer sign in. ' +
  'Its open complaints will need a new center.';

export function ServiceCentersPage() {
  const navigate = useNavigate();
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ServiceCenter | 'new' | null>(null);
  const [toggling, setToggling] = useState<ServiceCenter | null>(null);
  const [stranded, setStranded] = useState<{ name: string; items: StrandedWork[] } | null>(null);
  const refresh = useRefreshRecords();

  const centres = useServiceCenters({ includeInactive: true });
  const cities = useCities({ includeInactive: true });

  const cityName = (id?: string) => cities.data?.items.find((c) => c.id === id)?.name ?? '—';
  const term = search.toLowerCase();

  const rows = (centres.data?.items ?? [])
    .filter((c) => showInactive || c.isActive)
    .filter(
      (c) =>
        !term ||
        c.name.toLowerCase().includes(term) ||
        c.code.toLowerCase().includes(term) ||
        c.mobile.includes(term) ||
        c.pincode.includes(term),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title="Service Centers"
        description="The centres complaints are sent to, and the areas each one covers."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add service center
          </Button>
        }
      />

      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        placeholder="Search by name, code, mobile or pincode"
        showInactive={showInactive}
        onShowInactive={setShowInactive}
      />

      <Card className="overflow-hidden">
        {centres.error && !centres.data ? (
          <ErrorState error={centres.error} onRetry={() => void centres.refetch()} />
        ) : !centres.data ? (
          <div className="space-y-2 p-5" aria-busy aria-label="Loading service centres">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Wrench className="size-5" />}
            title={term ? 'No centres match' : 'No service centres yet'}
            description={term ? undefined : 'Add your first centre so complaints have somewhere to go.'}
          />
        ) : (
          <RecordsTable minWidth={900}>
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <th scope="col" className={TH}>Service center</th>
                <th scope="col" className={TH}>Location</th>
                <th scope="col" className={TH}>Mobile</th>
                <th scope="col" className={TH}>Also covers</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((centre) => {
                /* Its own city and pincode are always covered; older records
                   list them again, which must not read as extra coverage. */
                const cityCount = (centre.servedCityIds ?? []).filter((id) => id !== centre.cityId).length;
                const pincodeCount = (centre.servedPincodes ?? []).filter((p) => p !== centre.pincode).length;
                return (
                  <tr
                    key={centre.id}
                    /* The whole row opens the centre; its name is the real
                       link, so keyboards and screen readers reach it too. */
                    onClick={() => navigate(`/admin/service-centers/${centre.id}`)}
                    className={cn('cursor-pointer transition-colors hover:bg-slate-50', !centre.isActive && 'bg-slate-50/60')}
                  >
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <Link
                        to={`/admin/service-centers/${centre.id}`}
                        onClick={(event) => event.stopPropagation()}
                        className="font-medium text-slate-900 hover:text-brand-700"
                      >
                        {centre.name}
                      </Link>
                      <p className="text-xs text-slate-500">{centre.code}</p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-700">
                      {cityName(centre.cityId)} · {centre.pincode}
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3.5 text-slate-700">{formatMobile(centre.mobile)}</td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-700">
                      {cityCount === 0 && pincodeCount === 0 ? (
                        <span className="text-slate-400">Own city and pincode only</span>
                      ) : (
                        [
                          cityCount > 0 && `${cityCount} ${cityCount === 1 ? 'city' : 'cities'}`,
                          pincodeCount > 0 && `${pincodeCount} ${pincodeCount === 1 ? 'pincode' : 'pincodes'}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <ActiveBadge active={centre.isActive} />
                    </td>
                    <td className="px-5 py-3.5" onClick={(event) => event.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(centre)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Power className="size-3.5" />}
                          className={centre.isActive ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
                          onClick={() => setToggling(centre)}
                        >
                          {centre.isActive ? 'Deactivate' : 'Activate'}
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

      {editing && (
        <CentreDialog
          centre={editing === 'new' ? null : editing}
          cities={cities.data?.items ?? []}
          onClose={() => setEditing(null)}
        />
      )}

      {toggling && (
        <ActiveToggleDialog
          name={toggling.name}
          active={toggling.isActive}
          consequence={DEACTIVATE_CENTRE_CONSEQUENCE}
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            const result = await api<{ openComplaintsNeedingReassignment?: StrandedWork[] }>(
              `/service-centers/${toggling.id}`,
              { method: 'PATCH', body: { isActive: !toggling.isActive } },
            );
            toast.success(toggling.isActive ? `${toggling.name} deactivated` : `${toggling.name} activated`);
            if (result.openComplaintsNeedingReassignment?.length) {
              setStranded({ name: toggling.name, items: result.openComplaintsNeedingReassignment });
            }
            await refresh();
          }}
        />
      )}

      {stranded && (
        <StrandedWorkDialog
          title="Reassign these complaints"
          description={`${stranded.name} is deactivated but still has ${stranded.items.length} open ${
            stranded.items.length === 1 ? 'complaint' : 'complaints'
          }. Their history stays; each needs a new service center.`}
          items={stranded.items}
          linkBase="/admin/complaints"
          onClose={() => setStranded(null)}
        />
      )}
    </>
  );
}

/* ---- Form --------------------------------------------------------------- */

const PINCODE = /^\d{6}$/;
const MOBILE = /^[6-9]\d{9}$/;

/** "302001, 302002 302003" -> ["302001", "302002", "302003"], de-duplicated. */
const parsePincodes = (text: string) => [...new Set(text.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean))];

/** A city the centre also serves, as typed: the server files it under its state. */
interface ServedCity {
  name: string;
  state: string;
}

export function CentreDialog({
  centre,
  cities,
  onClose,
}: {
  centre: ServiceCenter | null;
  cities: City[];
  onClose: () => void;
}) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();

  const [name, setName] = useState(centre?.name ?? '');
  const [code, setCode] = useState(centre?.code ?? '');
  const [mobile, setMobile] = useState(centre?.mobile ?? '');
  const [email, setEmail] = useState(centre?.email ?? '');
  const [address, setAddress] = useState(centre?.address ?? '');
  /* The centre's own city is typed and filed under a state; its territory
     follows from the state on the server (DECISIONS.md section 32), so there
     is nothing left to choose here. */
  const ownCity = cities.find((city) => city.id === centre?.cityId);
  const [state, setState] = useState(ownCity?.state ?? '');
  const [cityName, setCityName] = useState(ownCity?.name ?? '');
  const [pincode, setPincode] = useState(centre?.pincode ?? '');
  /* The centre's own city and pincode are covered anyway, so they are not
     shown as "also serves" even where an older record lists them. */
  const [servedCities, setServedCities] = useState<ServedCity[]>(
    (centre?.servedCityIds ?? [])
      .filter((id) => id !== centre?.cityId)
      .map((id) => cities.find((city) => city.id === id))
      .filter((city): city is City => Boolean(city))
      .map((city) => ({ name: city.name, state: city.state })),
  );
  const [servedPincodes, setServedPincodes] = useState(
    (centre?.servedPincodes ?? []).filter((p) => p !== centre?.pincode).join(', '),
  );
  const [notes, setNotes] = useState(centre?.notes ?? '');

  /* The next city to add to the coverage list. */
  const [addState, setAddState] = useState('');
  const [addCity, setAddCity] = useState('');
  const [addError, setAddError] = useState<string | undefined>();

  const sameCity = (a: ServedCity, b: ServedCity) =>
    a.state === b.state && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

  const addServedCity = () => {
    const entry = { name: addCity.trim(), state: addState };
    if (!entry.state) return setAddError('Choose the state');
    if (!entry.name) return setAddError('Type the city');
    if (entry.state === state && entry.name.toLowerCase() === cityName.trim().toLowerCase()) {
      return setAddError('That is the centre’s own city, which is always covered');
    }
    if (servedCities.some((city) => sameCity(city, entry))) return setAddError('Already in the list');
    setServedCities((list) => [...list, entry]);
    setAddCity('');
    setAddError(undefined);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        mobile: mobile.replace(/\D/g, ''),
        ...(email.trim() ? { email: email.trim() } : {}),
        address: address.trim(),
        cityName: cityName.trim(),
        state,
        pincode: pincode.trim(),
        /* Typed cities only; the server resolves each to its record. */
        servedCityIds: [],
        servedCities,
        servedPincodes: parsePincodes(servedPincodes).filter((p) => p !== pincode.trim()),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      return centre
        ? api(`/service-centers/${centre.id}`, { method: 'PATCH', body })
        : api('/service-centers', { method: 'POST', body: { ...body, code: code.trim() } });
    },
    onSuccess: async () => {
      toast.success(centre ? 'Service center updated' : 'Service center added');
      onClose();
      await refresh();
    },
    onError: fromError,
  });

  const submit = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found['name'] = 'Enter the centre name';
    if (!centre && !code.trim()) found['code'] = 'Enter a short code';
    if (!MOBILE.test(mobile.replace(/\D/g, ''))) found['mobile'] = 'Enter a valid 10-digit mobile number';
    if (!address.trim()) found['address'] = 'Enter the address';
    if (!state) found['state'] = 'Choose the state';
    if (!cityName.trim()) found['cityName'] = 'Enter the city';
    if (!PINCODE.test(pincode.trim())) found['pincode'] = 'Pincode must be 6 digits';
    const badPincodes = parsePincodes(servedPincodes).filter((p) => !PINCODE.test(p));
    if (badPincodes.length > 0) found['servedPincodes'] = `Not a 6-digit pincode: ${badPincodes.slice(0, 3).join(', ')}`;
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={centre ? `Edit ${centre.name}` : 'Add service center'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {centre ? 'Save' : 'Add service center'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} required autoFocus />
          {centre ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">Code</p>
              <p className="py-2 text-sm text-slate-600">{centre.code} <span className="text-slate-400">(fixed)</span></p>
            </div>
          ) : (
            <Input
              label="Code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              error={errors['code']}
              hint="Unique, e.g. JAI-02. Cannot be changed later."
              required
            />
          )}
          <Input
            label="Mobile"
            type="tel"
            inputMode="numeric"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            error={errors['mobile']}
            required
          />
          <Input label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors['email']} />
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
            onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))}
            error={errors['pincode']}
            required
          />
        </section>

        {/* ---- Coverage (section 8) ------------------------------------ */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900">Coverage</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            The centre is always recommended for its own city and pincode. Add anywhere else it also serves.
          </p>

          <fieldset className="mt-3">
            <legend className="mb-1.5 text-sm font-medium text-slate-700">Also serves these cities</legend>
            {servedCities.length === 0 ? (
              <p className="mb-3 text-sm text-slate-500">None yet — its own city is always covered.</p>
            ) : (
              <ul className="mb-3 flex flex-wrap gap-1.5">
                {servedCities.map((city) => (
                  <li
                    key={`${city.state}/${city.name.toLowerCase()}`}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-1 pl-2.5 pr-1 text-sm text-slate-700"
                  >
                    {city.name}, {city.state}
                    <button
                      type="button"
                      onClick={() => setServedCities((list) => list.filter((entry) => !sameCity(entry, city)))}
                      aria-label={`Remove ${city.name}, ${city.state}`}
                      className="rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <StateSelect label="State" value={addState} onChange={setAddState} required={false} />
              <CityInput
                label="City"
                value={addCity}
                state={addState}
                onChange={(value) => {
                  setAddCity(value);
                  setAddError(undefined);
                }}
                required={false}
                error={addError}
                hint=" "
              />
              <Button type="button" variant="secondary" onClick={addServedCity} className="sm:mb-[26px]">
                Add city
              </Button>
            </div>
          </fieldset>

          <div className="mt-4">
            <Textarea
              label="Also serves these pincodes (optional)"
              value={servedPincodes}
              onChange={(e) => setServedPincodes(e.target.value)}
              error={errors['servedPincodes']}
              hint="Separate with commas or spaces, e.g. 302001, 302004"
              className="min-h-[64px]"
            />
          </div>
        </section>

        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors['notes']} className="min-h-[64px]" />
      </div>
    </Dialog>
  );
}
