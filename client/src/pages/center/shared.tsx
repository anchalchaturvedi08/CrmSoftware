/**
 * Pieces several Service Center screens share: the centre's technicians, the
 * parts catalogue, the visit dialogs and the part-request decisions.
 *
 * Each action lives in one place so the dashboard, the visit schedule and the
 * complaint page cannot drift apart in what "reschedule" or "issue" does.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, PackageCheck, PackageX } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Field';
import { ReasonDialog } from '@/components/ui/ReasonDialog';
import { errorMessage } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import type { Paged, Part, PartRequestRow, PartRequestStatus, User } from '@/lib/types';

/* ---- Data -------------------------------------------------------------- */

/** The centre's technicians, with workload. Inactive ones only on request. */
export function useTechnicians({ includeInactive = false }: { includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: ['technicians', includeInactive ? 'all' : 'active'],
    queryFn: () =>
      api<Paged<User>>('/users', {
        query: {
          role: 'TECHNICIAN',
          limit: 100,
          ...(includeInactive ? { includeInactive: true } : {}),
        },
      }),
  });
}

export function usePartsCatalog() {
  return useQuery({
    queryKey: ['parts', 'all'],
    queryFn: () => api<Paged<Part>>('/parts', { query: { limit: 100 } }),
    staleTime: 5 * 60_000,
  });
}

/**
 * Refreshes everything a centre action can change.
 *
 * Broad on purpose: an issued part changes a request, a complaint's timeline
 * and possibly the dashboard's queue counts, and a stale number on a dashboard
 * is exactly the kind of quiet wrongness nobody reports.
 */
export function useRefreshCenter() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [
        ['complaint'],
        ['complaints'],
        ['timeline'],
        ['visits'],
        ['visit'],
        ['dashboard'],
        ['technicians'],
        ['part-requests'],
        ['part-usage'],
        ['stock'],
      ].map((queryKey) => client.invalidateQueries({ queryKey })),
    );
}

/* ---- Visits ------------------------------------------------------------ */

/* Booking times and the reschedule/cancel dialogs are shared with Admin's
   schedule, so they live with the other shared components. */
export {
  CancelVisitDialog,
  RescheduleVisitDialog,
  VisitTimeField,
  defaultVisitTime,
  toLocalInput,
} from '@/components/visits/VisitDialogs';

/* ---- Part requests (section 11) ---------------------------------------- */

export const REQUEST_STATUS: Record<PartRequestStatus, { label: string; tone: string }> = {
  REQUESTED: { label: 'Requested', tone: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
  APPROVED: { label: 'Approved', tone: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  ISSUED: { label: 'Issued', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'bg-orange-50 text-orange-800 ring-orange-600/25' },
  REJECTED: { label: 'Rejected', tone: 'bg-rose-50 text-rose-700 ring-rose-600/20' },
  CANCELLED: { label: 'Cancelled', tone: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
};

export function RequestStatusBadge({ status }: { status: PartRequestStatus }) {
  const meta = REQUEST_STATUS[status];
  return <Badge className={meta.tone}>{meta.label}</Badge>;
}

/**
 * "Approved" alone reads as done; everywhere the Owner decides requests
 * (the centre-wide Requests queue and a complaint's own Part requests card)
 * a part that is merely approved still has to be physically issued.
 */
export function QueueStatusBadge({ status }: { status: PartRequestStatus }) {
  if (status !== 'APPROVED') return <RequestStatusBadge status={status} />;
  return <Badge className={REQUEST_STATUS.APPROVED.tone}>Approved — to issue</Badge>;
}

type Decision = 'APPROVED' | 'ISSUED' | 'UNAVAILABLE' | 'REJECTED';

/**
 * Section 11's "Service Center actions": approve, issue, mark unavailable,
 * reject. Issuing records what left the store; stock itself moves only when
 * the usage is confirmed (the backend's transaction rule).
 */
export function PartRequestActions({
  request,
  inStock,
}: {
  request: PartRequestRow;
  /** Current stock of this part, when known — shown in the issue dialog. */
  inStock?: number | undefined;
}) {
  const refresh = useRefreshCenter();
  const [open, setOpen] = useState<Decision | null>(null);
  const [quantity, setQuantity] = useState(String(request.quantityRequested));
  const [quantityError, setQuantityError] = useState<string | undefined>();

  const decide = useMutation({
    mutationFn: (body: { status: Decision; quantityIssued?: number; remarks?: string }) =>
      api(`/parts/requests/${request.id}/decide`, { method: 'POST', body }),
    onSuccess: async (_result, body) => {
      const name = request.part?.name ?? 'Part';
      toast.success(
        body.status === 'ISSUED'
          ? `${body.quantityIssued} × ${name} issued`
          : body.status === 'APPROVED'
            ? `${name} request approved`
            : body.status === 'UNAVAILABLE'
              ? `${name} marked unavailable`
              : `${name} request rejected`,
      );
      await refresh();
    },
  });

  if (request.status !== 'REQUESTED' && request.status !== 'APPROVED') return null;

  const unit = request.part?.unit?.toLowerCase() ?? 'piece';

  /* A closed or cancelled job gets no part: the server refuses approving or
     issuing one, so those buttons are not offered. The request can still be
     cleared from the queue as unavailable or rejected. */
  const jobEnded = request.complaint?.status === 'CLOSED' || request.complaint?.status === 'CANCELLED';

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {request.status === 'REQUESTED' && !jobEnded && (
        <Button
          size="sm"
          variant="secondary"
          icon={<CheckCircle2 className="size-3.5" />}
          loading={decide.isPending && decide.variables?.status === 'APPROVED'}
          onClick={() =>
            decide.mutate({ status: 'APPROVED' }, { onError: (error) => toast.error(errorMessage(error)) })
          }
        >
          Approve
        </Button>
      )}
      {!jobEnded && (
        <Button size="sm" icon={<PackageCheck className="size-3.5" />} onClick={() => setOpen('ISSUED')}>
          Issue
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon={<PackageX className="size-3.5" />}
        onClick={() => setOpen('UNAVAILABLE')}
      >
        Unavailable
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon={<Ban className="size-3.5" />}
        className="text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={() => setOpen('REJECTED')}
      >
        Reject
      </Button>

      <Dialog
        open={open === 'ISSUED'}
        onClose={() => setOpen(null)}
        size="sm"
        title={`Issue ${request.part?.name ?? 'part'}`}
        description={
          `Requested: ${request.quantityRequested} ${unit}` +
          (inStock !== undefined ? ` · In stock: ${inStock}` : '') +
          '. Stock is deducted when you confirm the part was used.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(null)}>
              Back
            </Button>
            <Button
              loading={decide.isPending}
              onClick={() => {
                const value = Number(quantity);
                if (!Number.isInteger(value) || value < 1) {
                  setQuantityError('Enter a whole number, at least 1');
                  return;
                }
                decide.mutate(
                  { status: 'ISSUED', quantityIssued: value },
                  {
                    onSuccess: () => setOpen(null),
                    onError: (error) =>
                      error instanceof ApiError && error.issueFor('quantityIssued')
                        ? setQuantityError(error.issueFor('quantityIssued'))
                        : toast.error(errorMessage(error)),
                  },
                );
              }}
            >
              Issue
            </Button>
          </>
        }
      >
        <Input
          type="number"
          label="Quantity to issue"
          min={1}
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
            setQuantityError(undefined);
          }}
          error={quantityError}
          required
        />
      </Dialog>

      <ReasonDialog
        open={open === 'UNAVAILABLE' || open === 'REJECTED'}
        onClose={() => setOpen(null)}
        title={open === 'REJECTED' ? 'Reject request' : 'Mark as unavailable'}
        description={
          open === 'REJECTED'
            ? 'The technician sees your reason.'
            : 'The technician sees this. If the job cannot continue, put it on hold for parts.'
        }
        label={open === 'REJECTED' ? 'Why is it rejected?' : 'What is the situation?'}
        placeholder={open === 'REJECTED' ? 'e.g. Wrong part for this model' : 'e.g. Out of stock, supplier delivery Friday'}
        confirmLabel={open === 'REJECTED' ? 'Reject' : 'Mark unavailable'}
        tone={open === 'REJECTED' ? 'danger' : 'primary'}
        onConfirm={async (remarks) => {
          if (!open || open === 'APPROVED' || open === 'ISSUED') return;
          await decide.mutateAsync({ status: open, remarks });
        }}
      />
    </div>
  );
}
