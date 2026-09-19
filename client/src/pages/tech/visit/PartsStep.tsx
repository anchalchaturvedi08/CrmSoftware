/**
 * Parts (spec section 10 step 5, section 11).
 *
 * Section 10 lists four things a technician does with parts on a visit: record
 * what they used, record what is required, mark parts unavailable, and request
 * parts. They collapse into three actions here:
 *
 *  - **Used** — what went into the unit. Recorded immediately; stock moves only
 *    when the service center finalises it (section 11).
 *  - **Request** — a part the technician needs from the centre.
 *  - **Can't finish without it** — puts the complaint on hold as WAITING FOR
 *    PARTS and ends the visit for now.
 *
 * Each part is picked from the parts list rather than typed, so "cooling pad",
 * "Cooling Pad" and "pad cooling" all land on one stock line.
 *
 * ## Search runs on the server
 *
 * The picker used to fetch the first 100 parts and filter them on the phone —
 * fine for a short catalogue, wrong once it grew past 100: a part on page two
 * could never be found by typing its name. Search is sent to `/parts` instead
 * (debounced, so typing does not fire a request per key), which has the whole
 * catalogue to search.
 *
 * That means the picker's own results can no longer be trusted to contain
 * every part a usage record names — see `partNames.ts` for how names for
 * already-recorded parts are resolved instead.
 *
 * ## Picking away from a save in flight
 *
 * TanStack Query calls a mutation's *latest* `onSuccess`, not the one that was
 * current when `mutate()` was called — so reading `picked` (component state)
 * inside `onSuccess` broke the moment a technician tapped the "choose a
 * different part" cross while a save was still in flight: `picked` had
 * already gone back to `null` by the time the reply arrived, and `picked.name`
 * threw. Worse, nothing stopped a second `add.mutate()` firing before the
 * first resolved, which could record the same pick twice.
 *
 * The fix is two-part: `onSuccess`/`onError` read what was actually saved from
 * the mutation's variables, never from component state; and un-picking, the
 * mode switch, are disabled while a save is in flight, so there is only ever
 * one in flight to begin with.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, PackageCheck, PackageSearch, PauseCircle, Plus, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Field';
import { errorMessage } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import type { Paged, Part, PartUsage } from '@/lib/types';
import { rememberParts, usePartNames } from './partNames';

type Mode = 'used' | 'request';

/** Delays a fast-changing value, so typing does not fire a request per key. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Stepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center rounded-xl ring-1 ring-slate-300">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="flex size-12 items-center justify-center text-slate-700 active:bg-slate-100"
        aria-label="Decrease quantity"
      >
        <Minus className="size-5" />
      </button>
      <span className="tabular w-10 text-center text-lg font-semibold" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(99, value + 1))}
        className="flex size-12 items-center justify-center text-slate-700 active:bg-slate-100"
        aria-label="Increase quantity"
      >
        <Plus className="size-5" />
      </button>
    </div>
  );
}

export function PartsStep({
  complaintId,
  visitId,
  onWaitingForParts,
}: {
  complaintId: string;
  /** The visit in progress. Used so only this visit's own parts are counted. */
  visitId: string | undefined;
  onWaitingForParts: () => void;
}) {
  const client = useQueryClient();
  const [mode, setMode] = useState<Mode>('used');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Part | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const [holdOpen, setHoldOpen] = useState(false);
  const [holdReason, setHoldReason] = useState('');

  const debouncedSearch = useDebounced(search.trim());

  const parts = useQuery({
    queryKey: ['parts', 'search', debouncedSearch],
    queryFn: () => api<Paged<Part>>('/parts', { query: { search: debouncedSearch || undefined, limit: 20 } }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  /* Every result seen is remembered, so a part recorded from a search that has
     since scrolled off still has a name later (see partNames.ts). */
  useEffect(() => {
    if (parts.data) rememberParts(parts.data.items);
  }, [parts.data]);

  const usage = useQuery({
    queryKey: ['part-usage', complaintId],
    queryFn: () => api<{ items: PartUsage[] }>(`/complaints/${complaintId}/part-usage`),
  });

  /* An earlier visit's parts are its own history, not this visit's — see
     PartsStep's doc comment and VisitFlowPage's review step. They are still
     shown, in their own section below: a technician on a revisit must be able
     to see a part was already used on the job, not just on today's trip,
     or they may pick and record it again. */
  const usedHere = (usage.data?.items ?? []).filter((item) => item.visitId === visitId);
  const usedEarlier = (usage.data?.items ?? []).filter((item) => item.visitId !== visitId);
  const { nameOf, fallback } = usePartNames(usage.data?.items ?? []);

  const reset = () => {
    setPicked(null);
    setQuantity(1);
    setReason('');
    setSearch('');
  };

  const add = useMutation({
    mutationFn: (vars: { mode: Mode; part: Part; quantity: number; reason: string }) =>
      vars.mode === 'used'
        ? api(`/complaints/${complaintId}/part-usage`, {
            method: 'POST',
            body: { partId: vars.part.id, quantity: vars.quantity },
          })
        : api(`/complaints/${complaintId}/part-requests`, {
            method: 'POST',
            body: {
              partId: vars.part.id,
              quantityRequested: vars.quantity,
              ...(vars.reason.trim() ? { reason: vars.reason.trim() } : {}),
            },
          }),
    /* `vars` is this specific call's own arguments, unlike `picked` — see the
       file's doc comment. */
    onSuccess: async (_result, vars) => {
      toast.success(
        vars.mode === 'used'
          ? `${vars.quantity} × ${vars.part.name} recorded`
          : `Requested ${vars.quantity} × ${vars.part.name} from your center`,
      );
      reset();
      await client.invalidateQueries({ queryKey: ['part-usage', complaintId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const hold = useMutation({
    mutationFn: () =>
      api(`/complaints/${complaintId}/waiting-for-parts`, {
        method: 'POST',
        body: { reason: holdReason.trim() },
      }),
    onSuccess: async () => {
      toast.success('Job put on hold until parts arrive');
      setHoldOpen(false);
      /* The job screen must not still say "In progress / Continue visit" —
         it shares this cache with the visit list and the complaint record. */
      await Promise.all([
        client.invalidateQueries({ queryKey: ['complaint', complaintId] }),
        client.invalidateQueries({ queryKey: ['visits'] }),
        client.invalidateQueries({ queryKey: ['my-jobs'] }),
      ]);
      onWaitingForParts();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      {/* Already recorded on this visit. */}
      {usedHere.length > 0 && (
        <div className="rounded-2xl bg-emerald-50/70 p-4 ring-1 ring-emerald-200">
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <PackageCheck className="size-4" />
            Parts used on this visit
          </p>
          <ul className="mt-2 space-y-1">
            {usedHere.map((item) => (
              <li key={item.id} className="flex justify-between text-[15px] text-slate-800">
                <span>{nameOf(item.partId) ?? fallback}</span>
                <span className="tabular font-semibold">× {item.quantity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recorded on an earlier trip to this same job — history, not this
          visit's own count (see the doc comment above), but a technician on a
          revisit still needs to see it so they don't record a part twice. */}
      {usedEarlier.length > 0 && (
        <div className="rounded-2xl bg-slate-100 p-4 ring-1 ring-slate-200">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <PackageCheck className="size-4" />
            Used on earlier visits
          </p>
          <ul className="mt-2 space-y-1">
            {usedEarlier.map((item) => (
              <li key={item.id} className="flex justify-between text-[15px] text-slate-600">
                <span>{nameOf(item.partId) ?? fallback}</span>
                <span className="tabular font-semibold">× {item.quantity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-200/70 p-1" role="radiogroup">
        {(
          [
            ['used', 'I used a part'],
            ['request', 'I need a part'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            disabled={add.isPending}
            onClick={() => {
              setMode(value);
              reset();
            }}
            className={cn(
              'h-11 rounded-xl text-sm font-semibold transition-colors disabled:opacity-60',
              mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {picked ? (
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-semibold text-slate-900">{picked.name}</p>
              <p className="text-sm text-slate-500">{picked.code}</p>
            </div>
            <button
              type="button"
              onClick={reset}
              disabled={add.isPending}
              className="flex size-10 items-center justify-center rounded-full text-slate-400 active:bg-slate-100 disabled:opacity-40"
              aria-label="Choose a different part"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[15px] font-medium text-slate-700">Quantity</span>
            <Stepper value={quantity} onChange={setQuantity} />
          </div>

          {mode === 'request' && (
            <div className="mt-4">
              <Textarea
                label="Why is it needed? (optional)"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="min-h-[72px] text-base"
              />
            </div>
          )}

          <Button
            size="lg"
            className="mt-4 h-12 w-full text-base"
            loading={add.isPending}
            onClick={() => add.mutate({ mode, part: picked, quantity, reason })}
          >
            {mode === 'used' ? 'Record part used' : 'Send request'}
          </Button>
        </div>
      ) : (
        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search parts"
              aria-label="Search parts"
              className="h-12 w-full rounded-xl border-0 bg-white pl-11 pr-3 text-base ring-1 ring-inset ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </div>

          <ul className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            {parts.error && !parts.data ? (
              <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-slate-600">
                {errorMessage(parts.error)}
                <Button variant="secondary" size="sm" onClick={() => void parts.refetch()}>
                  Retry
                </Button>
              </li>
            ) : !parts.data ? (
              <li className="px-4 py-4 text-sm text-slate-500">Loading parts…</li>
            ) : parts.data.items.length === 0 ? (
              <li className="px-4 py-4 text-sm text-slate-500">
                {debouncedSearch ? `No part matches “${debouncedSearch}”.` : 'No parts found.'}
              </li>
            ) : (
              parts.data.items.map((part) => (
                <li key={part.id} className="border-b border-slate-100 last:border-0">
                  <button
                    type="button"
                    onClick={() => setPicked(part)}
                    className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left active:bg-slate-50"
                  >
                    <span className="text-[15px] font-medium text-slate-900">{part.name}</span>
                    <span className="text-xs text-slate-500">{part.code}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {/* Section 10: "Parts unavailable". Ends the visit for now. */}
      <button
        type="button"
        onClick={() => setHoldOpen(true)}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-orange-50 px-4 text-left ring-1 ring-orange-200 active:bg-orange-100"
      >
        <PauseCircle className="size-6 shrink-0 text-orange-600" />
        <span>
          <span className="block text-[15px] font-semibold text-orange-900">
            I can’t finish without a part
          </span>
          <span className="block text-xs text-orange-800">Puts the job on hold until it arrives</span>
        </span>
      </button>

      <Dialog
        open={holdOpen}
        onClose={() => setHoldOpen(false)}
        size="sm"
        title="Put job on hold?"
        description="The job waits for parts. You can resume it from My Jobs once they arrive."
        footer={
          <>
            <Button variant="secondary" onClick={() => setHoldOpen(false)}>
              Back
            </Button>
            <Button
              disabled={holdReason.trim().length < 3}
              loading={hold.isPending}
              icon={<PackageSearch className="size-4" />}
              onClick={() => hold.mutate()}
            >
              Put on hold
            </Button>
          </>
        }
      >
        <Textarea
          label="Which part is missing?"
          value={holdReason}
          onChange={(event) => setHoldReason(event.target.value)}
          placeholder="e.g. Fan motor out of stock"
          className="text-base"
          required
          autoFocus
        />
      </Dialog>
    </div>
  );
}
