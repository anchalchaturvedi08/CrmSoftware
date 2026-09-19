/**
 * Complaint detail, Admin view (spec sections 6, 7, 8, 17, 22; Workflow F).
 *
 * This is where Admin does the three things only Admin can do: pick the
 * service center (section 8), confirm with the customer and verify the Happy
 * Code (Workflow F), and close. Reopen and cancel live here too.
 *
 * ## The server decides what is possible
 *
 * The page never works out for itself which actions a complaint allows. It
 * shows what the server returned in `nextActions`, which comes from the same
 * status machine that enforces the rule on write. A button the server would
 * refuse is never shown — and if the page and the server ever disagree, the
 * server still wins, because it re-checks on every request.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  KeyRound,
  Lock,
  MessageCircle,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Star,
  Wrench,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  ComplaintNotFound,
  CustomerCard,
  DescriptionCard,
  DetailSkeleton,
  ProductCard,
  SlaCard,
  Timeline,
} from '@/components/complaint/ComplaintCards';
import { PhotosCard } from '@/components/complaint/PhotosCard';
import { RatingValue, StarPicker } from '@/components/complaint/RatingStars';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, Detail } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Field';
import { ErrorState, Skeleton, errorMessage } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDate, formatMobile, fromNow, type ComplaintStatus } from '@/lib/format';
import type { Complaint, ComplaintDetail, Recommendation } from '@/lib/types';

/* ---- Data -------------------------------------------------------------- */

function useComplaint(id: string) {
  return useQuery({
    queryKey: ['complaint', id],
    queryFn: () => api<ComplaintDetail>(`/complaints/${id}`),
  });
}

/** Refreshes everything that a state change can affect. */
function useInvalidateComplaint(id: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['complaint', id] }),
      client.invalidateQueries({ queryKey: ['timeline', id] }),
      client.invalidateQueries({ queryKey: ['complaints'] }),
      client.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
}

/* ---- Page -------------------------------------------------------------- */

export function ComplaintDetailPage() {
  const { id = '' } = useParams();
  const { data, error, refetch } = useComplaint(id);

  if (!data && !error) return <DetailSkeleton />;

  if (error || !data) {
    /* A 404 here usually means a stale link, not a fault — say so plainly. */
    if (error instanceof ApiError && error.status === 404) {
      return <ComplaintNotFound listPath="/admin/complaints" />;
    }
    return (
      <Card>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Card>
    );
  }

  const { complaint, nextActions } = data;
  const allowed = new Set(nextActions.map((action) => action.to));

  return (
    <>
      <Link
        to="/admin/complaints"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" />
        Complaints
      </Link>

      {/* ---- Header ---------------------------------------------------- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="tabular text-2xl font-semibold tracking-tight text-slate-900">
              {complaint.complaintNumber}
            </h1>
            <StatusBadge status={complaint.status} />
            <PriorityBadge priority={complaint.priority} />
          </div>
          <p className="mt-1.5 text-sm text-slate-500">
            {complaint.category} · raised {fromNow(complaint.createdAt)}
            {complaint.reopenCount > 0 &&
              ` · reopened ${complaint.reopenCount} ${complaint.reopenCount === 1 ? 'time' : 'times'}`}
          </p>
        </div>

        <HeaderActions
          complaintId={id}
          status={complaint.status}
          allowed={allowed}
          hasCentre={Boolean(complaint.serviceCenterId)}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---- Main column --------------------------------------------- */}
        <div className="space-y-6 lg:col-span-2">
          <NextStepBanner
            status={complaint.status}
            verified={Boolean(complaint.happyCode.verifiedAt)}
            hasCentre={Boolean(complaint.serviceCenterId)}
          />

          {(complaint.status === 'ADMIN_CONFIRMATION' ||
            complaint.status === 'RESOLUTION_SUBMITTED') && (
            <HappyCodePanel
              complaintId={id}
              verifiedAt={complaint.happyCode.verifiedAt}
              lockedAt={complaint.happyCode.lockedAt}
              attempts={complaint.happyCode.attempts}
              canClose={allowed.has('CLOSED')}
            />
          )}

          <DescriptionCard complaint={complaint} />

          <PhotosCard complaintId={id} />

          <Timeline complaintId={id} />
        </div>

        {/* ---- Side column --------------------------------------------- */}
        <div className="space-y-6">
          <SlaCard complaint={complaint} />

          <CustomerCard complaint={complaint}>
            {/* The code only matters while the customer still has to confirm. */}
            {complaint.status !== 'CLOSED' && complaint.status !== 'CANCELLED' && <WhatsAppButton complaintId={id} />}
          </CustomerCard>

          <ProductCard complaint={complaint} listPath="/admin/complaints" />

          <AssignmentCard
            complaintId={id}
            serviceCenterId={complaint.serviceCenterId}
            technicianId={complaint.technicianId}
          />

          {/* Rating only makes sense once the work is done and someone did
              it — a closed complaint with a service center (DECISIONS.md
              section 31). */}
          {complaint.status === 'CLOSED' && complaint.serviceCenterId && (
            <ServiceRatingCard complaintId={id} rating={complaint.serviceRating} />
          )}
        </div>
      </div>
    </>
  );
}

/* ---- Header actions ---------------------------------------------------- */

type ReasonAction = 'reopen' | 'cancel' | 'require-rework';

function HeaderActions({
  complaintId,
  status,
  allowed,
  hasCentre,
}: {
  complaintId: string;
  status: ComplaintStatus;
  allowed: Set<ComplaintStatus>;
  hasCentre: boolean;
}) {
  const [reasonFor, setReasonFor] = useState<ReasonAction | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  /* A reopened complaint that still has its centre goes back to that centre,
     which assigns a technician; one reopened before it ever had a centre
     needs one chosen, with no reason — it is not a move (pre-launch review:
     the reason box was hidden but the server demanded a reason). */
  const needsCentre = status === 'NEW' || (status === 'REOPENED' && !hasCentre);

  /**
   * Reassignment is offered in two situations.
   *
   * Later statuses reach ASSIGNED through a real transition, so the server
   * lists it in `nextActions`. But correcting the centre while the complaint
   * is *still* ASSIGNED changes no status, so it never appears there — it is
   * an operation, like reassigning a technician. It is named here explicitly
   * because without it a mis-clicked centre could only be undone by cancelling
   * the complaint. The server still enforces who may do it.
   */
  const canReassign =
    hasCentre && !needsCentre && (allowed.has('ASSIGNED') || status === 'ASSIGNED');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {(needsCentre || canReassign) && (
        <Button
          variant={needsCentre ? 'primary' : 'secondary'}
          icon={<Wrench className="size-4" />}
          onClick={() => setPickerOpen(true)}
        >
          {needsCentre ? 'Assign service center' : 'Reassign center'}
        </Button>
      )}

      {/* Section 3.1: the customer says it is still not fixed. Offered while
          confirming with the customer, the only time the server allows it. */}
      {allowed.has('REVISIT_REQUIRED') && (
        <Button
          variant="secondary"
          icon={<RotateCcw className="size-4" />}
          onClick={() => setReasonFor('require-rework')}
        >
          Send back for rework
        </Button>
      )}

      {allowed.has('REOPENED') && (
        <Button
          variant="secondary"
          icon={<RotateCcw className="size-4" />}
          onClick={() => setReasonFor('reopen')}
        >
          Reopen
        </Button>
      )}

      {allowed.has('CANCELLED') && (
        <Button
          variant="ghost"
          icon={<Ban className="size-4" />}
          onClick={() => setReasonFor('cancel')}
          className="text-red-600 hover:bg-red-50 hover:text-red-700"
        >
          Cancel complaint
        </Button>
      )}

      <ServiceCenterPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        complaintId={complaintId}
        reassigning={canReassign}
      />

      {reasonFor && (
        <ReasonDialog
          action={reasonFor}
          complaintId={complaintId}
          onClose={() => setReasonFor(null)}
        />
      )}
    </div>
  );
}

/* ---- What happens next ------------------------------------------------- */

/**
 * Tells Admin who the complaint is waiting on.
 *
 * Most statuses are someone else's move — the centre's or the technician's —
 * and without this the page would look stuck when it is really just waiting.
 */
function NextStepBanner({
  status,
  verified,
  hasCentre,
}: {
  status: ComplaintStatus;
  verified: boolean;
  hasCentre: boolean;
}) {
  const copy: Partial<Record<ComplaintStatus, { text: string; icon: ReactNode; tone: string }>> = {
    NEW: {
      text: 'Choose a service center to send this complaint to.',
      icon: <Sparkles className="size-4" />,
      tone: 'border-sky-200 bg-sky-50 text-sky-900',
    },
    ASSIGNED: {
      text: 'Waiting for the service center to assign a technician.',
      icon: <Clock className="size-4" />,
      tone: 'border-slate-200 bg-slate-50 text-slate-700',
    },
    TECHNICIAN_ASSIGNED: {
      text: 'Waiting for the service center to schedule a visit.',
      icon: <Clock className="size-4" />,
      tone: 'border-slate-200 bg-slate-50 text-slate-700',
    },
    VISIT_SCHEDULED: {
      text: 'A visit is scheduled. The technician will start it on site.',
      icon: <Clock className="size-4" />,
      tone: 'border-slate-200 bg-slate-50 text-slate-700',
    },
    IN_PROGRESS: {
      text: 'The technician is working on this.',
      icon: <Wrench className="size-4" />,
      tone: 'border-amber-200 bg-amber-50 text-amber-900',
    },
    WAITING_FOR_PARTS: {
      text: 'Work is on hold until parts are available.',
      icon: <Package className="size-4" />,
      tone: 'border-orange-200 bg-orange-50 text-orange-900',
    },
    REVISIT_REQUIRED: {
      text: 'The service center sent the work back. They will schedule a revisit.',
      icon: <RotateCcw className="size-4" />,
      tone: 'border-rose-200 bg-rose-50 text-rose-900',
    },
    RESOLUTION_SUBMITTED: {
      text: 'The technician has submitted a resolution. You can close it directly or wait for the service center to review.',
      icon: <Clock className="size-4" />,
      tone: 'border-cyan-200 bg-cyan-50 text-cyan-900',
    },
    ADMIN_CONFIRMATION: {
      text: verified
        ? 'The customer confirmed with their Happy Code. Close the complaint to finish.'
        : 'The service center accepted the work. Call the customer to confirm, then verify their Happy Code.',
      icon: <KeyRound className="size-4" />,
      tone: 'border-teal-200 bg-teal-50 text-teal-900',
    },
    REOPENED: {
      text: hasCentre
        ? 'Reopened and back with its service center, who will assign a technician. Reassign it if another center should take it.'
        : 'Reopened. Assign a service center to start the work again.',
      icon: <RotateCcw className="size-4" />,
      tone: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900',
    },
  };

  const step = copy[status];
  if (!step) return null;

  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm', step.tone)}>
      <span className="mt-0.5 shrink-0">{step.icon}</span>
      <span>{step.text}</span>
    </div>
  );
}

/* ---- Happy Code -------------------------------------------------------- */

/**
 * Workflow F, steps 3-7: call the customer, ask for the code, verify, close.
 *
 * Verification and closure are two separate steps on purpose. A misheard digit
 * is then a recoverable "try again" rather than a failed closure, and the
 * close button only becomes available once the code has actually matched —
 * the same rule the server enforces (section 22).
 */
function HappyCodePanel({
  complaintId,
  verifiedAt,
  lockedAt,
  attempts,
  canClose,
}: {
  complaintId: string;
  verifiedAt: string | undefined;
  lockedAt: string | undefined;
  attempts: number;
  canClose: boolean;
}) {
  const invalidate = useInvalidateComplaint(complaintId);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');

  const verify = useMutation({
    mutationFn: (value: string) =>
      api<{ verified: boolean; attemptsRemaining: number; message: string }>(
        `/complaints/${complaintId}/verify-happy-code`,
        { method: 'POST', body: { code: value } },
      ),
    onSuccess: async (result) => {
      setFeedback(result.verified ? null : result.message);
      if (result.verified) {
        toast.success('Happy Code verified');
        setCode('');
      }
      await invalidate();
    },
    onError: (error) => setFeedback(errorMessage(error)),
  });

  const close = useMutation({
    mutationFn: (body?: { remarks?: string }) =>
      api(`/complaints/${complaintId}/close`, {
        method: 'POST',
        body: body?.remarks ? { remarks: body.remarks } : undefined,
      }),
    onSuccess: async () => {
      toast.success('Complaint closed');
      setRemarks('');
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const regenerate = useMutation({
    mutationFn: () =>
      api<{ happyCode: string }>(`/complaints/${complaintId}/regenerate-happy-code`, {
        method: 'POST',
      }),
    onSuccess: async (result) => {
      toast.success(`New Happy Code: ${result.happyCode}. Send it to the customer.`, {
        duration: 12_000,
      });
      setFeedback(null);
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const onVerify = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setFeedback('The Happy Code is 6 digits.');
      return;
    }
    verify.mutate(code);
  };

  if (verifiedAt) {
    return (
      <Card className="border-emerald-200">
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <ShieldCheck className="size-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Customer confirmed</p>
                <p className="text-sm text-slate-500">Happy Code verified {fromNow(verifiedAt)}</p>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <label htmlFor="close-remarks" className="mb-1.5 block text-sm font-medium text-slate-700">
              Closing remarks <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <textarea
              id="close-remarks"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Why are you closing this complaint?"
              rows={2}
              maxLength={2000}
              className="block w-full rounded-lg border-0 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              icon={<CheckCircle2 className="size-4" />}
              loading={close.isPending}
              disabled={!canClose}
              onClick={() => close.mutate({ remarks: remarks.trim() || undefined })}
            >
              Close complaint
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (lockedAt) {
    return (
      <Card className="border-red-200">
        <div className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
              <Lock className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">Happy Code locked</p>
              <p className="mt-0.5 text-sm text-slate-600">
                Too many incorrect attempts. Issue a new code and send it to the customer again —
                the old one no longer works.
              </p>
              <Button
                className="mt-4"
                variant="secondary"
                icon={<RefreshCw className="size-4" />}
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                Issue a new code
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const remaining = Math.max(0, 5 - attempts);

  return (
    <Card className="border-teal-200">
      <CardHeader
        title="Confirm with the customer"
        description="Ask the customer for the 6-digit code they received, and enter it here."
      />
      <form onSubmit={onVerify} className="px-5 py-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-[220px]">
            <label htmlFor="happy-code" className="mb-1.5 block text-sm font-medium text-slate-700">
              Happy Code
            </label>
            <input
              id="happy-code"
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                setFeedback(null);
              }}
              inputMode="numeric"
              autoComplete="off"
              placeholder="••••••"
              aria-invalid={feedback ? true : undefined}
              aria-describedby="happy-code-feedback"
              className="tabular block h-12 w-full rounded-lg border-0 text-center text-2xl font-semibold tracking-[0.4em] ring-1 ring-inset ring-slate-300 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <Button type="submit" size="lg" loading={verify.isPending} icon={<KeyRound className="size-4" />}>
            Verify
          </Button>
        </div>

        <div id="happy-code-feedback" className="mt-3 min-h-5 text-sm" aria-live="polite">
          {feedback ? (
            <p className="flex items-center gap-1.5 text-red-600">
              <AlertTriangle className="size-4" />
              {feedback}
            </p>
          ) : attempts > 0 ? (
            <p className="text-slate-500">
              {remaining} {remaining === 1 ? 'attempt' : 'attempts'} left before the code locks.
            </p>
          ) : null}
        </div>
      </form>

      {canClose && (
        <div className="border-t border-slate-200 px-5 py-4">
          <p className="mb-2 text-sm font-medium text-slate-600">Or close directly</p>
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Why are you closing this complaint? (optional)"
            rows={2}
            maxLength={2000}
            className="block w-full rounded-lg border-0 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
          <div className="mt-3 flex justify-end">
            <Button
              icon={<CheckCircle2 className="size-4" />}
              loading={close.isPending}
              onClick={() => close.mutate({ remarks: remarks.trim() || undefined })}
            >
              Close complaint
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---- WhatsApp ---------------------------------------------------------- */

/**
 * Opens WhatsApp with the message pre-filled (sections 6.4, 15).
 *
 * The link is fetched on click rather than on page load, because fetching it
 * decrypts the Happy Code and writes an audit entry — merely opening a
 * complaint should not count as viewing the code.
 *
 * Nothing here claims the message was sent. Section 6.4: "Never claim that the
 * message was delivered/read." Pressing send is a human action in another app.
 */
function WhatsAppButton({ complaintId }: { complaintId: string }) {
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: () =>
      api<{ available: boolean; url?: string; reason?: string; happyCode?: string }>(
        `/complaints/${complaintId}/whatsapp`,
      ),
    onSuccess: (result) => {
      if (!result.available || !result.url) {
        setUnavailable(result.reason ?? 'WhatsApp is not available for this customer.');
        return;
      }
      setUnavailable(null);
      window.open(result.url, '_blank', 'noopener,noreferrer');
      toast.info('WhatsApp opened with the message ready. Press send in WhatsApp.', {
        duration: 8000,
      });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="border-t border-slate-100 pt-4">
      <Button
        variant="secondary"
        className="w-full"
        icon={<MessageCircle className="size-4" />}
        loading={open.isPending}
        onClick={() => open.mutate()}
      >
        Send via WhatsApp
      </Button>
      {unavailable ? (
        <p className="mt-2 flex gap-1.5 text-xs text-red-600" role="alert">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {unavailable}
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          Includes the complaint number and Happy Code. You send it from WhatsApp.
        </p>
      )}
    </div>
  );
}

/* ---- Assignment -------------------------------------------------------- */

function AssignmentCard({
  complaintId,
  serviceCenterId,
  technicianId,
}: {
  complaintId: string;
  serviceCenterId: string | undefined;
  technicianId: string | undefined;
}) {
  const centre = useQuery({
    queryKey: ['service-center', serviceCenterId],
    queryFn: () =>
      api<{ items: Array<{ id: string; name: string; code: string; mobile: string }> }>(
        '/service-centers',
        { query: { limit: 200, includeInactive: true } },
      ),
    enabled: Boolean(serviceCenterId),
    select: (result) => result.items.find((item) => item.id === serviceCenterId),
  });

  const technician = useQuery({
    queryKey: ['user', technicianId],
    queryFn: () => api<{ user: { name: string; mobile: string } }>(`/users/${technicianId}`),
    enabled: Boolean(technicianId),
  });

  void complaintId;

  return (
    <Card>
      <CardHeader title="Assignment" />
      <dl className="space-y-4 px-5 py-5">
        <Detail label="Service center">
          {!serviceCenterId ? (
            <span className="text-slate-500">Not assigned yet</span>
          ) : centre.data ? (
            <span>
              {centre.data.name}
              <span className="ml-1.5 text-xs text-slate-500">{centre.data.code}</span>
            </span>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </Detail>
        <Detail label="Technician">
          {!technicianId ? (
            <span className="text-slate-500">Not assigned yet</span>
          ) : technician.data ? (
            <span>
              {technician.data.user.name}
              <a
                href={`tel:+91${technician.data.user.mobile}`}
                className="tabular ml-1.5 text-xs text-brand-700 hover:underline"
              >
                {formatMobile(technician.data.user.mobile)}
              </a>
            </span>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
        </Detail>
      </dl>
    </Card>
  );
}

/* ---- Service center rating (DECISIONS.md section 31) ------------------- */

/**
 * Admin's star rating of the centre's work, once the complaint is closed.
 *
 * Read-only until the dialog is opened: the card itself never submits
 * anything, so glancing at a rating can never accidentally change it.
 */
function ServiceRatingCard({
  complaintId,
  rating,
}: {
  complaintId: string;
  rating: Complaint['serviceRating'];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader title="Service center rating" />
      <div className="space-y-3 px-5 py-5">
        {rating ? (
          <>
            <RatingValue value={rating.stars} />
            {rating.note && <p className="text-sm text-slate-700">{rating.note}</p>}
            <p className="text-xs text-slate-500">
              by {rating.ratedByName} on {formatDate(rating.ratedAt)}
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-500">Not rated yet.</p>
        )}
        <Button
          variant="secondary"
          size="sm"
          icon={<Star className="size-3.5" />}
          onClick={() => setOpen(true)}
        >
          {rating ? 'Change rating' : 'Rate service center'}
        </Button>
      </div>

      <RatingDialog open={open} onClose={() => setOpen(false)} complaintId={complaintId} rating={rating} />
    </Card>
  );
}

function RatingDialog({
  open,
  onClose,
  complaintId,
  rating,
}: {
  open: boolean;
  onClose: () => void;
  complaintId: string;
  rating: Complaint['serviceRating'];
}) {
  const invalidate = useInvalidateComplaint(complaintId);
  const [stars, setStars] = useState<number | null>(rating?.stars ?? null);
  const [note, setNote] = useState(rating?.note ?? '');

  /* Re-seed the draft from the current rating each time the dialog opens,
     rather than once at mount — the rating on screen may have changed since
     the last time it was opened. */
  useEffect(() => {
    if (!open) return;
    setStars(rating?.stars ?? null);
    setNote(rating?.note ?? '');
  }, [open, rating?.stars, rating?.note]);

  const save = useMutation({
    mutationFn: () =>
      api(`/complaints/${complaintId}/rating`, {
        method: 'POST',
        /* Omitting a blank note clears it — the same explicit-clear
           convention the server already uses for the customer's email. */
        body: { stars, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: async () => {
      toast.success(rating ? 'Rating updated' : 'Service center rated');
      onClose();
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={rating ? 'Change rating' : 'Rate service center'}
      description="The rating and note can be changed again later."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={stars === null} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <StarPicker value={stars} onChange={setStars} />
        <Textarea
          label="Note"
          hint="Optional. Up to 1000 characters."
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          placeholder="Anything about the service center's work worth recording?"
        />
      </div>
    </Dialog>
  );
}

/* ---- Service center picker (section 8) --------------------------------- */

/**
 * Section 8's hybrid model: the server recommends, Admin decides.
 *
 * Recommendations are listed first with the reason each one matched; every
 * other active centre follows, so a manual choice is always possible. Nothing
 * is preselected — section 8 says "never automatically assign", and a
 * preselected option is one careless click away from exactly that.
 */
function ServiceCenterPicker({
  open,
  onClose,
  complaintId,
  reassigning,
}: {
  open: boolean;
  onClose: () => void;
  complaintId: string;
  reassigning: boolean;
}) {
  const invalidate = useInvalidateComplaint(complaintId);
  const { data: detail } = useComplaint(complaintId);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const pincode = detail?.complaint.serviceAddress.pincode;
  const cityId = detail?.complaint.serviceAddress.cityId;

  const recommendations = useQuery({
    queryKey: ['recommendations', pincode, cityId],
    queryFn: () =>
      api<{ recommended: Recommendation[]; others: Recommendation[]; fellBackToAll: boolean }>(
        '/complaints/recommendations',
        { query: { pincode, cityId } },
      ),
    enabled: open && Boolean(pincode),
  });

  const assign = useMutation({
    mutationFn: () =>
      api(`/complaints/${complaintId}/assign-service-center`, {
        method: 'POST',
        body: { serviceCenterId: selected, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: async () => {
      toast.success(reassigning ? 'Service center changed' : 'Service center assigned');
      setSelected(null);
      setReason('');
      onClose();
      await invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const current = detail?.complaint.serviceCenterId;
  const reasonMissing = reassigning && reason.trim().length < 3;

  const renderOption = (option: Recommendation) => {
    const isCurrent = option.id === current;
    return (
      <label
        key={option.id}
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
          selected === option.id
            ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600'
            : 'border-slate-200 hover:bg-slate-50',
          isCurrent && 'cursor-not-allowed opacity-50',
        )}
      >
        <input
          type="radio"
          name="service-center"
          value={option.id}
          checked={selected === option.id}
          disabled={isCurrent}
          onChange={() => setSelected(option.id)}
          className="mt-1 accent-brand-700"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="text-sm font-medium text-slate-900">{option.name}</span>
            <span className="text-xs text-slate-500">{option.code}</span>
            {isCurrent && <span className="text-xs text-slate-500">(current)</span>}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {option.address} · {option.pincode}
          </span>
          {option.reason !== 'NO_MATCH' && (
            <span className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700">
              <CheckCircle2 className="size-3.5" />
              {option.explanation}
            </span>
          )}
        </span>
      </label>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={reassigning ? 'Reassign service center' : 'Assign service center'}
      description="Recommended centers are listed first. The choice is yours — nothing is assigned automatically."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected || reasonMissing}
            loading={assign.isPending}
            onClick={() => assign.mutate()}
          >
            {reassigning ? 'Reassign' : 'Assign'}
          </Button>
        </>
      }
    >
      {recommendations.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : recommendations.error ? (
        <ErrorState error={recommendations.error} onRetry={() => void recommendations.refetch()} />
      ) : recommendations.data ? (
        <div className="space-y-5">
          {recommendations.data.fellBackToAll && (
            <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              No center covers pincode {pincode}. All active centers are listed below.
            </p>
          )}

          {recommendations.data.recommended.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Recommended
              </p>
              <div className="space-y-2">{recommendations.data.recommended.map(renderOption)}</div>
            </div>
          )}

          {recommendations.data.others.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {recommendations.data.fellBackToAll ? 'Active centers' : 'Other centers'}
              </p>
              <div className="space-y-2">{recommendations.data.others.map(renderOption)}</div>
            </div>
          )}

          {reassigning && (
            <Textarea
              label="Reason for reassigning"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this complaint moving to another center?"
              hint="The technician is unassigned, booked visits are cancelled and part requests not yet issued are withdrawn. All of it is recorded on the timeline."
              required
            />
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

/* ---- Reopen / cancel --------------------------------------------------- */

function ReasonDialog({
  action,
  complaintId,
  onClose,
}: {
  action: ReasonAction;
  complaintId: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidateComplaint(complaintId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();

  const copy = {
    reopen: {
      title: 'Reopen complaint',
      description:
        'The previous closure is kept in the history. A new Happy Code and a fresh SLA clock are issued.',
      button: 'Reopen',
      placeholder: 'What has gone wrong since it was closed?',
      success: 'Complaint reopened — send the customer their new Happy Code',
    },
    cancel: {
      title: 'Cancel complaint',
      description: 'The complaint stays on record. It can be reopened later if this was a mistake.',
      button: 'Cancel complaint',
      placeholder: 'Why is this complaint being cancelled?',
      success: 'Complaint cancelled',
    },
    'require-rework': {
      title: 'Send back for rework',
      description:
        'The service center books a revisit. When the work is accepted again, you confirm with the customer again — an earlier Happy Code check no longer counts.',
      button: 'Send back',
      placeholder: 'What does the customer say is still wrong?',
      success: 'Sent back to the service center for rework',
    },
  }[action];

  const submit = useMutation({
    mutationFn: () =>
      api(`/complaints/${complaintId}/${action}`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: async () => {
      toast.success(copy.success);
      onClose();
      await invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.issueFor('reason')) setError(err.issueFor('reason'));
      else toast.error(errorMessage(err));
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button
            variant={action === 'cancel' ? 'danger' : 'primary'}
            disabled={reason.trim().length < 3}
            loading={submit.isPending}
            onClick={() => submit.mutate()}
          >
            {copy.button}
          </Button>
        </>
      }
    >
      <Textarea
        label="Reason"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          setError(undefined);
        }}
        placeholder={copy.placeholder}
        error={error}
        hint="Required. Recorded on the complaint timeline."
        required
        autoFocus
      />
    </Dialog>
  );
}

