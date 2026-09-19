/**
 * The visit, step by step (spec section 10).
 *
 * Section 10 lays out eight steps: start, customer availability, diagnosis,
 * work performed, parts, attachments, resolution, submit. Section 21 asks for
 * "step-by-step forms", "large action buttons" and "minimal typing".
 *
 * ## Availability is asked before the visit starts
 *
 * The spec lists "start" then "availability". Here they are answered together,
 * availability first, because the answer decides what happens next. If the
 * customer is not home the visit is still recorded — the trip happened, and the
 * service center needs to know to reschedule — but it ends there: the
 * technician is not walked into a diagnosis screen for a unit they never saw,
 * and the server will not accept one (`endsOnArrival` in workflow.service.ts).
 *
 * ## Minimal typing
 *
 * Each written step offers tap-to-add phrases for the common cooler faults and
 * repairs. The text stays editable, so an unusual case is never forced into a
 * wrong phrase — the phrases just save the typing for the usual ones.
 *
 * ## The technician cannot close
 *
 * The final step submits for review and says so. There is no close button
 * anywhere in this app, matching section 3.3 and the server, which would refuse
 * it anyway.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  CalendarX2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  HelpCircle,
  Home,
  KeyRound,
  Send,
  UserCheck,
  UserX,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { TechHeader } from '@/components/layout/TechLayout';
import { Button } from '@/components/ui/Button';
import { ErrorState, Skeleton, errorMessage } from '@/components/ui/States';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/format';
import type { Attachment, CustomerAvailability, PartUsage } from '@/lib/types';
import { StaleNote } from './StaleNote';
import { complaintQuery, newestVisit, visitsQuery } from './queries';
import { PartsStep } from './visit/PartsStep';
import { PhotosStep } from './visit/PhotosStep';
import { usePartNames } from './visit/partNames';
import { useVisitDraft } from './visit/useVisitDraft';

/**
 * Re-asks the server directly whether a start or a submit already went
 * through, for when the *reply* was lost — a dropped connection right as the
 * answer comes back, common on mobile data mid-visit. A plain "try again"
 * would resubmit a mutation the server may have already carried out.
 *
 * `staleTime: 0` bypasses the cache: the copy already held could be only
 * seconds old and would otherwise be handed back unchanged.
 */
async function confirmOnServer(client: QueryClient, complaintId: string) {
  const [detail, visits] = await Promise.all([
    client.fetchQuery({ ...complaintQuery(complaintId), staleTime: 0 }),
    client.fetchQuery({ ...visitsQuery(complaintId), staleTime: 0 }),
  ]);
  return { detail, visits };
}

/* ---- Tap-to-add phrases ------------------------------------------------ */

const DIAGNOSIS_PHRASES = [
  'Water pump not working',
  'Cooling pads clogged',
  'Fan motor faulty',
  'Loose or damaged wiring',
  'Water leaking from tank',
  'Float valve stuck',
  'Capacitor faulty',
  'Swing motor not working',
];

const WORK_PHRASES = [
  'Replaced water pump',
  'Cleaned cooling pads',
  'Replaced cooling pads',
  'Replaced fan motor',
  'Repaired wiring',
  'Sealed water leak',
  'Replaced float valve',
  'Replaced capacitor',
  'General service and cleaning',
];

const RESULT_PHRASES = [
  'Fixed — working normally',
  'Fixed after part replacement',
  'Partially fixed — needs follow-up',
  'Could not fix on this visit',
];

/** Adds a phrase to a field, comma-separated, without repeating it. */
function addPhrase(current: string, phrase: string): string {
  const trimmed = current.trim();
  if (!trimmed) return phrase;
  if (trimmed.toLowerCase().includes(phrase.toLowerCase())) return trimmed;
  return `${trimmed}, ${phrase}`;
}

function Phrases({
  options,
  value,
  onPick,
}: {
  options: string[];
  value: string;
  onPick: (phrase: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((phrase) => {
        const used = value.toLowerCase().includes(phrase.toLowerCase());
        return (
          <button
            key={phrase}
            type="button"
            onClick={() => onPick(phrase)}
            aria-pressed={used}
            className={cn(
              'min-h-10 rounded-full px-3.5 text-sm font-medium transition-colors',
              used
                ? 'bg-brand-700 text-white'
                : 'bg-white text-slate-700 ring-1 ring-slate-300 active:bg-slate-100',
            )}
          >
            {phrase}
          </button>
        );
      })}
    </div>
  );
}

/** A large text area, sized for a thumb rather than a mouse. */
function BigText({
  label,
  value,
  onChange,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const id = `field-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-[15px] font-medium text-slate-800">
        {label}
        {!required && <span className="ml-1 font-normal text-slate-400">(optional)</span>}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="block w-full resize-y rounded-xl border-0 bg-white px-3.5 py-3 text-base text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
      />
    </div>
  );
}

/* ---- Steps ------------------------------------------------------------- */

const STEPS = ['Diagnosis', 'Work done', 'Parts', 'Photos', 'Result', 'Submit'] as const;

type Outcome = { kind: 'submitted' } | { kind: 'closed' } | { kind: 'ended-without-work' };

export function VisitFlowPage() {
  const { complaintId = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { user } = useAuth();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const detail = useQuery(complaintQuery(complaintId));

  /* Shares its cache with the job screen, which has usually just loaded it. */
  const visits = useQuery(visitsQuery(complaintId));

  /* The visit being worked on right now, if any — while it is loading or
     there is none, `undefined`. Drafts and the Parts/Photos steps are keyed
     to it, so a revisit never opens on the last visit's half-finished notes,
     photos or parts (see useVisitDraft.ts and item 5). */
  const visitId = newestVisit(visits.data?.items, 'IN_PROGRESS')?.id;
  const { draft, update, discard } = useVisitDraft({ userId: user?.id, complaintId, visitId });

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['complaint', complaintId] }),
      client.invalidateQueries({ queryKey: ['my-jobs'] }),
      client.invalidateQueries({ queryKey: ['visits'] }),
    ]);

  const submit = useMutation({
    /* The visit being submitted travels as the mutation's own variable, not
       read back out of component state in the callbacks below — see the
       file's note on PartsStep for why that distinction matters. */
    mutationFn: (submittedVisitId: string | undefined) =>
      api<{ closed?: boolean }>(`/complaints/${complaintId}/resolution`, {
        method: 'POST',
        body: {
          diagnosis: {
            problemFound: draft.problemFound.trim(),
            ...(draft.diagnosisNotes.trim() ? { notes: draft.diagnosisNotes.trim() } : {}),
          },
          workPerformed: {
            details: draft.workDetails.trim(),
            ...(draft.workRemarks.trim() ? { remarks: draft.workRemarks.trim() } : {}),
          },
          resolution: {
            result: draft.result.trim(),
            ...(draft.resolutionRemarks.trim() ? { remarks: draft.resolutionRemarks.trim() } : {}),
            ...(draft.customerFeedback.trim()
              ? { customerFeedback: draft.customerFeedback.trim() }
              : {}),
          },
          ...(draft.happyCode.trim() ? { happyCode: draft.happyCode.trim() } : {}),
        },
      }).then((result) => ({ visitId: submittedVisitId, closed: result.closed ?? false })),
    onSuccess: async (result) => {
      if (result.visitId) discard(result.visitId);
      setOutcome({ kind: result.closed ? 'closed' : 'submitted' });
      await refresh();
    },
    onError: async (error, submittedVisitId) => {
      try {
        const { detail: confirmed } = await confirmOnServer(client, complaintId);
        if (confirmed.complaint.status !== 'IN_PROGRESS') {
          if (submittedVisitId) discard(submittedVisitId);
          setOutcome({ kind: confirmed.complaint.status === 'CLOSED' ? 'closed' : 'submitted' });
          await refresh();
          return;
        }
      } catch {
        /* Confirming failed too (still no signal) — fall through below. */
      }
      toast.error(errorMessage(error));
    },
  });

  /* Keep the page at the top when moving between steps on a small screen. */
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [draft.step]);

  if (outcome) {
    return <OutcomeScreen outcome={outcome} onDone={() => navigate('/tech', { replace: true })} />;
  }

  const working = visits.data?.items.some((visit) => visit.status === 'IN_PROGRESS') ?? false;

  /* Only the first load shows a skeleton. A background refetch — the
     technician switching to the dialler and back — must never unmount a
     screen they are halfway through filling in. */
  const loading = (
    <>
      <TechHeader title="Visit" back />
      <div className="space-y-3 p-4" aria-busy>
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </>
  );

  if ((!detail.data && !detail.error) || (!visits.data && !visits.error)) {
    return loading;
  }

  /* Only when neither query has anything cached is the screen replaced by an
     error. A failed background refresh — no signal for a few seconds while
     the technician is mid-visit — must not wipe a half-filled form; it gets a
     small note instead (below). */
  if (!detail.data || !visits.data) {
    return (
      <>
        <TechHeader title="Visit" back />
        <div className="m-4 rounded-2xl bg-white">
          <ErrorState
            error={detail.error ?? visits.error}
            onRetry={() => void Promise.all([detail.refetch(), visits.refetch()])}
          />
        </div>
      </>
    );
  }

  const { complaint } = detail.data;
  const stale = Boolean(detail.error) || Boolean(visits.error);
  const retryingStale = detail.isFetching || visits.isFetching;
  const retryStale = () => void Promise.all([detail.refetch(), visits.refetch()]);

  /* ---- Before the visit starts: is the customer there? ------------------ */
  if (complaint.status === 'VISIT_SCHEDULED') {
    return (
      <ArrivalStep
        complaintId={complaintId}
        customerName={complaint.customerSnapshot.name}
        stale={stale}
        retryingStale={retryingStale}
        onRetryStale={retryStale}
        onStarted={async (ended) => {
          if (ended) {
            /* Set first, so the refetch below cannot flash the "nothing in
               progress" screen before the confirmation appears. */
            setOutcome({ kind: 'ended-without-work' });
            void refresh();
          } else {
            update('step', 0);
            await refresh();
          }
        }}
      />
    );
  }

  /* Just started: the complaint has refetched as IN_PROGRESS but the visit
     list has not caught up yet. */
  if (complaint.status === 'IN_PROGRESS' && !working && visits.isFetching) {
    return loading;
  }

  if (complaint.status !== 'IN_PROGRESS' || !working) {
    /* Reached by a stale link, or the last trip ended at the door and the
       next one is not booked yet. Either way there is nothing to fill in. */
    return (
      <>
        <TechHeader title="Visit" back={`/tech/jobs/${complaintId}`} />
        {stale && <StaleNote retrying={retryingStale} onRetry={retryStale} />}
        <div className="m-4 rounded-2xl bg-white px-6 py-12 text-center shadow-sm">
          <p className="font-semibold text-slate-900">No visit in progress</p>
          <p className="mt-1 text-sm text-slate-500">Go back to the job to see where it stands.</p>
          <Button className="mt-5" onClick={() => navigate(`/tech/jobs/${complaintId}`, { replace: true })}>
            Back to job
          </Button>
        </div>
      </>
    );
  }

  /* ---- The work steps ---------------------------------------------------- */
  const step = Math.min(draft.step, STEPS.length - 1);

  /** Whether the current step has what it needs to move on. */
  const ready = (() => {
    switch (step) {
      case 0:
        return draft.problemFound.trim().length > 0;
      case 1:
        return draft.workDetails.trim().length > 0;
      case 4:
        return draft.result.trim().length > 0;
      default:
        return true;
    }
  })();

  const body: Record<number, ReactNode> = {
    0: (
      <div className="space-y-5">
        <div>
          <p className="mb-2.5 text-[15px] font-medium text-slate-800">What is wrong? Tap all that apply.</p>
          <Phrases
            options={DIAGNOSIS_PHRASES}
            value={draft.problemFound}
            onPick={(phrase) => update('problemFound', addPhrase(draft.problemFound, phrase))}
          />
        </div>
        <BigText
          label="Problem found"
          value={draft.problemFound}
          onChange={(value) => update('problemFound', value)}
          placeholder="Or describe it in your own words"
          required
        />
        <BigText
          label="Notes"
          value={draft.diagnosisNotes}
          onChange={(value) => update('diagnosisNotes', value)}
          placeholder="Anything else worth recording"
        />
      </div>
    ),
    1: (
      <div className="space-y-5">
        <div>
          <p className="mb-2.5 text-[15px] font-medium text-slate-800">What did you do? Tap all that apply.</p>
          <Phrases
            options={WORK_PHRASES}
            value={draft.workDetails}
            onPick={(phrase) => update('workDetails', addPhrase(draft.workDetails, phrase))}
          />
        </div>
        <BigText
          label="Work done"
          value={draft.workDetails}
          onChange={(value) => update('workDetails', value)}
          placeholder="Or describe it in your own words"
          required
        />
        <BigText
          label="Remarks"
          value={draft.workRemarks}
          onChange={(value) => update('workRemarks', value)}
        />
      </div>
    ),
    2: (
      <PartsStep
        complaintId={complaintId}
        visitId={visitId}
        onWaitingForParts={() => navigate(`/tech/jobs/${complaintId}`, { replace: true })}
      />
    ),
    3: <PhotosStep complaintId={complaintId} visitId={visitId} />,
    4: (
      <div className="space-y-5">
        <div>
          <p className="mb-2.5 text-[15px] font-medium text-slate-800">How did it go?</p>
          <div className="space-y-2">
            {RESULT_PHRASES.map((phrase) => (
              <button
                key={phrase}
                type="button"
                onClick={() => update('result', phrase)}
                aria-pressed={draft.result === phrase}
                className={cn(
                  'flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left text-[15px] font-medium transition-colors',
                  draft.result === phrase
                    ? 'bg-brand-700 text-white'
                    : 'bg-white text-slate-800 ring-1 ring-slate-300 active:bg-slate-50',
                )}
              >
                <CheckCircle2
                  className={cn('size-5 shrink-0', draft.result === phrase ? 'text-white' : 'text-slate-300')}
                />
                {phrase}
              </button>
            ))}
          </div>
        </div>
        <BigText
          label="Result"
          value={draft.result}
          onChange={(value) => update('result', value)}
          placeholder="Or describe the outcome"
          required
        />
        <BigText
          label="What the customer said"
          value={draft.customerFeedback}
          onChange={(value) => update('customerFeedback', value)}
        />
        <BigText
          label="Remarks"
          value={draft.resolutionRemarks}
          onChange={(value) => update('resolutionRemarks', value)}
        />
      </div>
    ),
    5: (
      <div className="space-y-3">
        <p className="text-[15px] text-slate-600">Check everything before sending.</p>
        {[
          { label: 'Problem found', value: draft.problemFound, step: 0 },
          { label: 'Work done', value: draft.workDetails, step: 1 },
          { label: 'Result', value: draft.result, step: 4 },
          ...(draft.customerFeedback ? [{ label: 'Customer said', value: draft.customerFeedback, step: 4 }] : []),
        ].map((row) => (
          <button
            key={row.label}
            type="button"
            onClick={() => update('step', row.step)}
            className="block w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
          >
            <span className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{row.label}</span>
              <span className="text-xs font-medium text-brand-700">Edit</span>
            </span>
            <span className="mt-1 block text-[15px] text-slate-900">{row.value}</span>
          </button>
        ))}
        <PartsAndPhotos complaintId={complaintId} visitId={visitId} onEdit={(target) => update('step', target)} />

        {/* Happy Code — enter to close directly, leave blank to submit for review */}
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <KeyRound className="size-4" />
            Happy Code
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Ask the customer for the 6-digit code. If entered, the complaint closes directly.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="Enter 6-digit code"
            value={draft.happyCode}
            onChange={(event) => update('happyCode', event.target.value.replace(/\D/g, '').slice(0, 6))}
            className="mt-2 h-12 w-full rounded-xl border-0 bg-slate-50 px-4 text-center font-mono text-xl tracking-[0.3em] text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 placeholder:tracking-normal placeholder:font-sans placeholder:text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </div>

        <div className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">
          <p className="flex items-center gap-2 font-semibold text-slate-800">
            <ClipboardCheck className="size-4" />
            What happens next
          </p>
          <p className="mt-1">
            {draft.happyCode.length === 6
              ? 'The Happy Code will be verified and the complaint will close.'
              : 'Without the code, the service centre or Admin can close it later with the Happy Code.'}
          </p>
        </div>
      </div>
    ),
  };

  return (
    <>
      <TechHeader
        title={STEPS[step]}
        subtitle={`${complaint.customerSnapshot.name} · ${complaint.complaintNumber}`}
        back={`/tech/jobs/${complaintId}`}
      />
      {stale && <StaleNote retrying={retryingStale} onRetry={retryStale} />}

      {/* Progress: which step, of how many. */}
      <div className="px-4 pt-3" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        <div className="flex gap-1.5">
          {STEPS.map((name, index) => (
            <div
              key={name}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                index <= step ? 'bg-brand-600' : 'bg-slate-200',
              )}
            />
          ))}
        </div>
        <p className="mt-1.5 text-xs font-medium text-slate-500">
          Step {step + 1} of {STEPS.length}
        </p>
      </div>

      <div className="px-4 pb-44 pt-4">{body[step]}</div>

      {/* Back and next, pinned above the tab bar within thumb reach. */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 mx-auto w-full max-w-md border-t border-slate-200 bg-white/95 p-4 backdrop-blur">
        <div className="flex gap-3">
          {step > 0 && (
            <Button
              variant="secondary"
              size="lg"
              className="h-14 w-24 shrink-0"
              icon={<ChevronLeft className="size-5" />}
              onClick={() => update('step', step - 1)}
            >
              Back
            </Button>
          )}

          {step < STEPS.length - 1 ? (
            <Button
              size="lg"
              className="h-14 flex-1 text-base"
              disabled={!ready}
              onClick={() => update('step', step + 1)}
            >
              {step === 2 || step === 3 ? 'Next' : 'Continue'}
              <ChevronRight className="size-5" />
            </Button>
          ) : (
            <Button
              size="lg"
              className="h-14 flex-1 text-base"
              icon={draft.happyCode.length === 6 ? <CheckCircle2 className="size-5" /> : <Send className="size-5" />}
              loading={submit.isPending}
              onClick={() => submit.mutate(visitId)}
            >
              {draft.happyCode.length === 6 ? 'Submit & Close' : 'Submit for review'}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/* ---- Review extras ----------------------------------------------------- */

/**
 * Parts and photos on the review step.
 *
 * Both were saved to the server the moment they were added, so there is
 * nothing to submit here — but a technician checking their work before sending
 * it should see all of it, not just the text. The queries share their cache
 * with the Parts and Photos steps, so this is usually instant.
 *
 * Only this visit's own parts and photos are counted (item 5): a revisit's
 * review must not present an earlier trip's work as if it were done today.
 */
function PartsAndPhotos({
  complaintId,
  visitId,
  onEdit,
}: {
  complaintId: string;
  visitId: string | undefined;
  onEdit: (step: number) => void;
}) {
  const usage = useQuery({
    queryKey: ['part-usage', complaintId],
    queryFn: () => api<{ items: PartUsage[] }>(`/complaints/${complaintId}/part-usage`),
  });
  const attachments = useQuery({
    queryKey: ['attachments', complaintId],
    queryFn: () => api<{ items: Attachment[] }>(`/complaints/${complaintId}/attachments`),
  });

  const used = (usage.data?.items ?? []).filter((item) => item.visitId === visitId);
  const { nameOf, fallback } = usePartNames(used);
  const photos = (attachments.data?.items ?? []).filter(
    (item) => item.visitId === visitId && (item.kind === 'BEFORE_PHOTO' || item.kind === 'AFTER_PHOTO'),
  );
  const before = photos.filter((item) => item.kind === 'BEFORE_PHOTO').length;
  const after = photos.length - before;

  const rows = [
    {
      label: 'Parts used',
      step: 2,
      value: usage.isLoading
        ? '…'
        : used.length === 0
          ? 'None'
          : used.map((item) => `${nameOf(item.partId) ?? fallback} × ${item.quantity}`).join(', '),
    },
    {
      label: 'Photos',
      step: 3,
      value: attachments.isLoading
        ? '…'
        : photos.length === 0
          ? 'None'
          : [before && `${before} old parts`, after && `${after} after`].filter(Boolean).join(', '),
    },
  ];

  return (
    <div className="divide-y divide-slate-100 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      {rows.map((row) => (
        <button
          key={row.label}
          type="button"
          onClick={() => onEdit(row.step)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-50"
        >
          <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {row.label}
          </span>
          <span className="min-w-0 flex-1 text-[15px] text-slate-900">{row.value}</span>
          <span className="text-xs font-medium text-brand-700">Edit</span>
        </button>
      ))}
    </div>
  );
}

/* ---- Arrival ----------------------------------------------------------- */

/**
 * Steps 1 and 2: arrive, and record whether the customer is there.
 *
 * The server stamps the start time itself (section 10 step 1: "record
 * timestamp") — the phone's clock is never trusted for it.
 *
 * Whether the trip ends here is always sent explicitly rather than left to the
 * server's default, so what the button said is exactly what happens.
 */
function ArrivalStep({
  complaintId,
  customerName,
  stale,
  retryingStale,
  onRetryStale,
  onStarted,
}: {
  complaintId: string;
  customerName: string;
  stale: boolean;
  retryingStale: boolean;
  onRetryStale: () => void;
  onStarted: (ended: boolean) => Promise<void>;
}) {
  const client = useQueryClient();
  const [availability, setAvailability] = useState<CustomerAvailability | null>(null);
  const [note, setNote] = useState('');

  const start = useMutation({
    mutationFn: (endVisit: boolean) =>
      api(`/complaints/${complaintId}/start-visit`, {
        method: 'POST',
        body: {
          customerAvailability: availability,
          ...(note.trim() ? { availabilityNote: note.trim() } : {}),
          endVisit,
        },
      }),
    onSuccess: async (_result, endVisit) => {
      await onStarted(endVisit);
    },
    onError: async (error, endVisit) => {
      /* The tap may have reached the server and only its reply got lost — a
         common failure on mobile data right at the doorstep. Ask the server
         directly before telling the technician anything failed, so a retry
         never starts the same visit twice. */
      try {
        const { detail, visits } = await confirmOnServer(client, complaintId);
        if (detail.complaint.status !== 'VISIT_SCHEDULED') {
          const visit = newestVisit(visits.items, 'IN_PROGRESS') ?? newestVisit(visits.items, 'COMPLETED');
          await onStarted(visit ? visit.status === 'COMPLETED' : endVisit);
          return;
        }
      } catch {
        /* Confirming failed too (still no signal) — fall through below. */
      }
      toast.error(errorMessage(error));
    },
  });

  const options: Array<{ value: CustomerAvailability; label: string; hint: string; icon: ReactNode }> = [
    {
      value: 'CUSTOMER_AVAILABLE',
      label: 'Customer is here',
      hint: 'Start the work',
      icon: <UserCheck className="size-6" />,
    },
    {
      value: 'CUSTOMER_UNAVAILABLE',
      label: 'Nobody is home',
      hint: 'Record the trip so it can be rebooked',
      icon: <UserX className="size-6" />,
    },
    {
      value: 'RESCHEDULE_REQUIRED',
      label: 'Customer asked for another day',
      hint: 'Record it so it can be rebooked',
      icon: <CalendarX2 className="size-6" />,
    },
    {
      value: 'OTHER',
      label: 'Something else',
      hint: 'e.g. a neighbour has the key, or no power',
      icon: <HelpCircle className="size-6" />,
    },
  ];

  const needsNote = availability === 'OTHER';
  const noteMissing = needsNote && note.trim().length === 0;

  return (
    <>
      <TechHeader title="Start visit" subtitle={customerName} back={`/tech/jobs/${complaintId}`} />
      {stale && <StaleNote retrying={retryingStale} onRetry={onRetryStale} />}

      <div className="px-4 pb-44 pt-5">
        <p className="text-lg font-semibold text-slate-900">Is the customer available?</p>
        <p className="mt-1 text-[15px] text-slate-500">
          Your arrival time is recorded when you continue.
        </p>

        <div className="mt-5 space-y-2.5" role="radiogroup" aria-label="Customer availability">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={availability === option.value}
              onClick={() => setAvailability(option.value)}
              className={cn(
                'flex min-h-[4.5rem] w-full items-center gap-4 rounded-2xl px-4 text-left transition-colors',
                availability === option.value
                  ? 'bg-brand-700 text-white'
                  : 'bg-white text-slate-900 ring-1 ring-slate-300 active:bg-slate-50',
              )}
            >
              <span className={availability === option.value ? 'text-white' : 'text-slate-400'}>
                {option.icon}
              </span>
              <span>
                <span className="block text-base font-semibold">{option.label}</span>
                <span
                  className={cn(
                    'block text-sm',
                    availability === option.value ? 'text-brand-100' : 'text-slate-500',
                  )}
                >
                  {option.hint}
                </span>
              </span>
            </button>
          ))}
        </div>

        {availability && availability !== 'CUSTOMER_AVAILABLE' && (
          <div className="mt-5">
            <BigText
              label="Note"
              value={note}
              onChange={setNote}
              placeholder={
                availability === 'CUSTOMER_UNAVAILABLE'
                  ? 'e.g. Rang the bell twice, phone not answered'
                  : 'What happened?'
              }
              required={needsNote}
            />
          </div>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 mx-auto w-full max-w-md border-t border-slate-200 bg-white/95 p-4 backdrop-blur">
        {availability === 'OTHER' ? (
          /* The one case that can go either way, so both are offered. */
          <div className="flex gap-3">
            <Button
              variant="secondary"
              size="lg"
              className="h-14 flex-1 text-base"
              disabled={noteMissing || start.isPending}
              loading={start.isPending && start.variables === true}
              onClick={() => start.mutate(true)}
            >
              Can’t work
            </Button>
            <Button
              size="lg"
              className="h-14 flex-1 text-base"
              disabled={noteMissing || start.isPending}
              loading={start.isPending && start.variables === false}
              onClick={() => start.mutate(false)}
            >
              Start work
            </Button>
          </div>
        ) : (
          <Button
            size="lg"
            className="h-14 w-full text-base"
            disabled={!availability}
            loading={start.isPending}
            onClick={() => start.mutate(availability !== 'CUSTOMER_AVAILABLE')}
          >
            {availability === 'CUSTOMER_AVAILABLE' || !availability ? 'Start work' : 'Record and leave'}
          </Button>
        )}
      </div>
    </>
  );
}

/* ---- Outcomes ---------------------------------------------------------- */

function OutcomeScreen({ outcome, onDone }: { outcome: Outcome; onDone: () => void }) {
  const closed = outcome.kind === 'closed';
  const submitted = outcome.kind === 'submitted';

  return (
    <div className="flex min-h-[80dvh] flex-col items-center justify-center px-6 text-center">
      <div
        className={cn(
          'mb-5 flex size-20 items-center justify-center rounded-full',
          closed ? 'bg-emerald-50 text-emerald-600' : submitted ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500',
        )}
      >
        {closed ? <CheckCircle2 className="size-10" /> : submitted ? <Send className="size-10" /> : <Home className="size-10" />}
      </div>

      <h1 className="text-2xl font-semibold text-slate-900">
        {closed ? 'Complaint closed' : submitted ? 'Sent for review' : 'Visit recorded'}
      </h1>
      <p className="mt-2 max-w-xs text-[15px] text-slate-600">
        {closed
          ? 'The Happy Code was verified and the complaint is now closed.'
          : submitted
            ? 'The service centre or Admin can close it once they verify the Happy Code with the customer.'
            : 'Your service center can see why no work was done and will book another visit.'}
      </p>

      <Button size="lg" className="mt-8 h-14 w-full max-w-xs text-base" onClick={onDone}>
        Back to My Jobs
      </Button>
    </div>
  );
}
