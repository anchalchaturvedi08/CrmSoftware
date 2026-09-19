/**
 * Complaint detail, Service Center view (spec sections 9, 11; Workflows B-E).
 *
 * Section 9 lists what the Owner sees here — customer, product, complaint,
 * warranty, timeline, technician, visit history, diagnosis, work performed,
 * parts, attachments, resolution — and "review actions". This is where the
 * centre does all of its complaint work: assign a technician, book and move
 * visits, answer part requests, and accept or send back the technician's work.
 *
 * ## One banner, one obvious next step
 *
 * Like the Admin page, the server's `nextActions` decides which moves exist.
 * On top of that the banner says, in words, what this complaint is waiting
 * for — because "In progress" alone hides the case that matters most: the
 * technician went, nobody was home, and nothing is booked. That one gets its
 * own warning and its own button.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  KeyRound,
  Lock,
  PackageSearch,
  PlayCircle,
  RotateCcw,
  Sparkles,
  UserCheck,
  UserCog,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
import { PhotosCard, PhotosGrid } from '@/components/complaint/PhotosCard';
import { RatingValue } from '@/components/complaint/RatingStars';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, Detail } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { ReasonDialog } from '@/components/ui/ReasonDialog';
import { ErrorState, Skeleton, errorMessage } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime, formatMobile, fromNow, humanize, NO_WORK_REASON } from '@/lib/format';
import type {
  Complaint,
  ComplaintDetail,
  NextAction,
  Paged,
  PartRequestRow,
  PartUsage,
  SlaRule,
  VisitCard,
  VisitDetail,
} from '@/lib/types';
import dayjs from 'dayjs';
import {
  CancelVisitDialog,
  PartRequestActions,
  QueueStatusBadge,
  RescheduleVisitDialog,
  VisitTimeField,
  defaultVisitTime,
  usePartsCatalog,
  useRefreshCenter,
  useTechnicians,
} from './shared';

/* ---- Data -------------------------------------------------------------- */

function useComplaintVisits(id: string) {
  return useQuery({
    queryKey: ['visits', 'complaint', id],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', { query: { complaintId: id, sort: 'desc', limit: 20 } }),
  });
}

/* ---- Page -------------------------------------------------------------- */

export function ComplaintDetailPage() {
  const { id = '' } = useParams();

  const detail = useQuery({
    queryKey: ['complaint', id],
    queryFn: () => api<ComplaintDetail>(`/complaints/${id}`),
  });
  const visits = useComplaintVisits(id);

  if (!detail.data && !detail.error) return <DetailSkeleton />;

  if (detail.error || !detail.data) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <ComplaintNotFound listPath="/center/complaints" />;
    }
    return (
      <Card>
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </Card>
    );
  }

  const { complaint, nextActions } = detail.data;
  /* Newest visit first by number, not booking time: a cancelled visit and
     its replacement are often booked for the very same slot. */
  const allVisits = [...(visits.data?.items ?? [])].sort((a, b) => b.sequence - a.sequence);
  const openVisit = allVisits.find((visit) => visit.status === 'SCHEDULED' || visit.status === 'IN_PROGRESS');
  const lastVisit = allVisits[0];

  return (
    <>
      <Link
        to="/center/complaints"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" />
        My Complaints
      </Link>

      {/* ---- Header ------------------------------------------------------ */}
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

        {visits.data && (
          <HeaderActions
            complaint={complaint}
            nextActions={nextActions}
            openVisit={openVisit}
          />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---- Main column ----------------------------------------------- */}
        <div className="space-y-6 lg:col-span-2">
          {visits.data && (
            <NextStep complaint={complaint} openVisit={openVisit} lastVisit={lastVisit} />
          )}

          {complaint.lastResolutionVisitId && (
            <WorkCard
              complaint={complaint}
              visitId={complaint.lastResolutionVisitId}
              reviewing={complaint.status === 'RESOLUTION_SUBMITTED'}
            />
          )}

          <PhotosCard complaintId={id} />

          <PartRequestsCard complaintId={id} />

          <DescriptionCard complaint={complaint} />

          <VisitsCard complaintId={id} visits={visits} />

          <Timeline complaintId={id} />
        </div>

        {/* ---- Side column ----------------------------------------------- */}
        <div className="space-y-6">
          {complaint.status === 'CLOSED' && <ServiceRatingCard complaint={complaint} />}
          <SlaCard complaint={complaint} />
          <TechnicianCard
            technicianId={complaint.technicianId}
            reassignable={REASSIGNABLE.has(complaint.status)}
          />
          <CustomerCard complaint={complaint} />
          <ProductCard complaint={complaint} listPath="/center/complaints" />
        </div>
      </div>
    </>
  );
}

/* ---- Header actions ---------------------------------------------------- */

type Dialogs = 'assign' | 'schedule' | 'hold' | 'happy-code' | null;

/** Statuses in which moving the job to another technician makes sense. */
const REASSIGNABLE = new Set<Complaint['status']>([
  'TECHNICIAN_ASSIGNED',
  'VISIT_SCHEDULED',
  'IN_PROGRESS',
  'WAITING_FOR_PARTS',
  'REVISIT_REQUIRED',
]);

function HeaderActions({
  complaint,
  nextActions,
  openVisit,
}: {
  complaint: Complaint;
  nextActions: NextAction[];
  openVisit: VisitCard | undefined;
}) {
  const refresh = useRefreshCenter();
  const [dialog, setDialog] = useState<Dialogs>(null);

  const can = (to: Complaint['status']) => nextActions.find((action) => action.to === to);
  const needsTechnician = complaint.status === 'ASSIGNED' || complaint.status === 'REOPENED';
  const onSite = openVisit?.status === 'IN_PROGRESS';
  /* Only the assigned technician's own visit can be resumed and submitted. */
  const ownVisitUnderWay = onSite && openVisit?.technicianId === complaint.technicianId;

  /**
   * Offered while a technician is on site too. Reassigning ends the visit
   * under way without a resolution (the server cancels it and says so on the
   * timeline), and the dialog warns first. It used to be hidden then, which
   * left no way to move a job from a technician who fell ill mid-visit or was
   * deactivated — the card said "reassign this job" with no button to do it.
   */
  const canReassign = Boolean(complaint.technicianId) && REASSIGNABLE.has(complaint.status);

  /**
   * Booking a visit is offered when the server allows it and it would not cut
   * across work under way: from IN_PROGRESS only when nobody is on site (the
   * last trip ended without work), since booking closes an open visit.
   */
  const schedule = can('VISIT_SCHEDULED');
  const offerSchedule = Boolean(schedule) && !(complaint.status === 'IN_PROGRESS' && onSite);

  const resume = can('IN_PROGRESS');
  const hold = can('WAITING_FOR_PARTS');

  /* Whether the SLA clock stops on hold is an Admin setting per priority; the
     dialog used to promise it always did (pre-launch review). */
  const slaRules = useQuery({
    queryKey: ['sla-rules'],
    queryFn: () => api<{ items: SlaRule[] }>('/sla-rules'),
    enabled: Boolean(hold),
    staleTime: 5 * 60_000,
  });
  const pausesOnHold = slaRules.data?.items.find((rule) => rule.priority === complaint.priority)?.pauseOnWaitingParts;

  const resumeWork = useMutation({
    mutationFn: () => api(`/complaints/${complaint.id}/resume-work`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Work resumed');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const scheduleLabel: Partial<Record<Complaint['status'], string>> = {
    TECHNICIAN_ASSIGNED: 'Schedule visit',
    REVISIT_REQUIRED: 'Schedule revisit',
    WAITING_FOR_PARTS: 'Book follow-up visit',
    IN_PROGRESS: 'Book another visit',
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {needsTechnician && (
        <Button icon={<UserCheck className="size-4" />} onClick={() => setDialog('assign')}>
          Assign technician
        </Button>
      )}

      {offerSchedule && (
        <Button icon={<CalendarPlus className="size-4" />} onClick={() => setDialog('schedule')}>
          {scheduleLabel[complaint.status] ?? 'Schedule visit'}
        </Button>
      )}

      {/* Resume only continues the technician's own open visit; with none, a
          follow-up is booked. */}
      {resume && complaint.status === 'WAITING_FOR_PARTS' && ownVisitUnderWay && (
        <Button
          variant="secondary"
          icon={<PlayCircle className="size-4" />}
          loading={resumeWork.isPending}
          onClick={() => resumeWork.mutate()}
        >
          Resume work
        </Button>
      )}

      {hold && (
        <Button variant="secondary" icon={<PackageSearch className="size-4" />} onClick={() => setDialog('hold')}>
          Hold for parts
        </Button>
      )}

      {canReassign && (
        <Button variant="secondary" icon={<UserCog className="size-4" />} onClick={() => setDialog('assign')}>
          Reassign
        </Button>
      )}

      {(complaint.status === 'IN_PROGRESS' || complaint.status === 'RESOLUTION_SUBMITTED') && (
        <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setDialog('happy-code')}>
          Close with Happy Code
        </Button>
      )}

      <AssignTechnicianDialog
        open={dialog === 'assign'}
        onClose={() => setDialog(null)}
        complaint={complaint}
        visitUnderWay={onSite}
      />

      {schedule && (
        <ScheduleVisitDialog
          open={dialog === 'schedule'}
          onClose={() => setDialog(null)}
          title={scheduleLabel[complaint.status] ?? schedule.action}
          complaint={complaint}
          rule={schedule}
          closesOpenVisit={complaint.status === 'WAITING_FOR_PARTS' && onSite}
        />
      )}

      <ReasonDialog
        open={dialog === 'hold'}
        onClose={() => setDialog(null)}
        title="Hold for parts"
        description={holdDescription(pausesOnHold)}
        label="Which part, and why is it needed?"
        placeholder="e.g. Fan motor out of stock, delivery expected Friday"
        confirmLabel="Hold for parts"
        onConfirm={async (reason) => {
          await api(`/complaints/${complaint.id}/waiting-for-parts`, { method: 'POST', body: { reason } });
          toast.success('Job on hold for parts');
          await refresh();
        }}
      />

      <HappyCodeCloseDialog
        open={dialog === 'happy-code'}
        onClose={() => setDialog(null)}
        complaintId={complaint.id}
        onClosed={refresh}
      />
    </div>
  );
}

function holdDescription(pauses: boolean | undefined): string {
  const after = 'Resume or book a follow-up once the part arrives.';
  if (pauses === undefined) return after;
  return pauses
    ? `The SLA clock pauses while the job waits for the part. ${after}`
    : `The SLA clock keeps running while the job waits for the part. ${after}`;
}

/* ---- What happens next ------------------------------------------------- */

function NextStep({
  complaint,
  openVisit,
  lastVisit,
}: {
  complaint: Complaint;
  openVisit: VisitCard | undefined;
  lastVisit: VisitCard | undefined;
}) {
  const noWorkReason =
    lastVisit?.status === 'COMPLETED' && !lastVisit.resolutionResult
      ? lastVisit.customerAvailability && lastVisit.customerAvailability !== 'CUSTOMER_AVAILABLE'
        ? NO_WORK_REASON[lastVisit.customerAvailability]
        : 'The visit ended without work'
      : null;

  let step: { text: ReactNode; icon: ReactNode; tone: string } | null = null;

  switch (complaint.status) {
    case 'ASSIGNED':
      step = {
        text: 'New job from Admin. Assign one of your technicians.',
        icon: <Sparkles className="size-4" />,
        tone: 'border-sky-200 bg-sky-50 text-sky-900',
      };
      break;
    case 'REOPENED':
      step = {
        text: 'Reopened by Admin — the fault came back. Assign a technician to restart the work.',
        icon: <RotateCcw className="size-4" />,
        tone: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900',
      };
      break;
    case 'TECHNICIAN_ASSIGNED':
      step = {
        text: 'Call the customer and book a visit.',
        icon: <CalendarClock className="size-4" />,
        tone: 'border-violet-200 bg-violet-50 text-violet-900',
      };
      break;
    case 'VISIT_SCHEDULED':
      step =
        openVisit && dayjs(openVisit.scheduledAt).isBefore(dayjs(), 'day')
          ? {
              /* A visit whose day passed with nobody starting it. */
              text: (
                <>
                  <span className="font-semibold">Missed visit.</span> It was booked for{' '}
                  {formatDateTime(openVisit.scheduledAt)} and never started. Check with the technician, then
                  reschedule it.
                </>
              ),
              icon: <AlertTriangle className="size-4" />,
              tone: 'border-red-200 bg-red-50 text-red-900',
            }
          : {
              text: openVisit
                ? `Visit booked for ${formatDateTime(openVisit.scheduledAt)}. The technician starts it on site.`
                : 'A visit is booked. The technician starts it on site.',
              icon: <Clock className="size-4" />,
              tone: 'border-slate-200 bg-slate-50 text-slate-700',
            };
      break;
    case 'IN_PROGRESS':
      step =
        openVisit?.status === 'IN_PROGRESS'
          ? {
              text: `The technician is on site — started ${fromNow(openVisit.startedAt)}.`,
              icon: <Wrench className="size-4" />,
              tone: 'border-amber-200 bg-amber-50 text-amber-900',
            }
          : {
              text: (
                <>
                  <span className="font-semibold">Nothing is booked.</span>{' '}
                  {noWorkReason ?? 'The last visit ended without work'}
                  {lastVisit?.availabilityNote ? ` (“${lastVisit.availabilityNote}”)` : ''}. Call the customer and
                  book another visit.
                </>
              ),
              icon: <AlertTriangle className="size-4" />,
              tone: 'border-amber-300 bg-amber-50 text-amber-900',
            };
      break;
    case 'WAITING_FOR_PARTS':
      step = {
        text:
          openVisit?.status === 'IN_PROGRESS'
            ? 'On hold for parts. Issue the part, then resume work — or book a follow-up if the technician has left.'
            : 'On hold for parts. Once the part is in, book a follow-up visit.',
        icon: <PackageSearch className="size-4" />,
        tone: 'border-orange-200 bg-orange-50 text-orange-900',
      };
      break;
    case 'REVISIT_REQUIRED':
      step = {
        text: 'You sent this work back. Book a revisit with the technician.',
        icon: <RotateCcw className="size-4" />,
        tone: 'border-rose-200 bg-rose-50 text-rose-900',
      };
      break;
    case 'RESOLUTION_SUBMITTED':
      step = {
        text: 'The technician has submitted their work. Review it below — accept, send back, or close with the Happy Code.',
        icon: <ClipboardCheck className="size-4" />,
        tone: 'border-cyan-200 bg-cyan-50 text-cyan-900',
      };
      break;
    case 'ADMIN_CONFIRMATION':
      step = {
        text: 'You accepted the work. Admin will confirm with the customer and close the complaint.',
        icon: <KeyRound className="size-4" />,
        tone: 'border-teal-200 bg-teal-50 text-teal-900',
      };
      break;
    case 'CLOSED':
      step = {
        text: 'Complaint closed.',
        icon: <CheckCircle2 className="size-4" />,
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-900',
      };
      break;
    case 'CANCELLED':
      step = {
        text: 'Cancelled by Admin.',
        icon: <XCircle className="size-4" />,
        tone: 'border-slate-200 bg-slate-50 text-slate-700',
      };
      break;
  }

  if (!step) return null;

  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm', step.tone)}>
      <span className="mt-0.5 shrink-0">{step.icon}</span>
      <span>{step.text}</span>
    </div>
  );
}

/* ---- Assign / reassign a technician (Workflow B) ----------------------- */

function AssignTechnicianDialog({
  open,
  onClose,
  complaint,
  visitUnderWay,
}: {
  open: boolean;
  onClose: () => void;
  complaint: Complaint;
  /** A technician is on site right now; reassigning ends that visit. */
  visitUnderWay: boolean;
}) {
  const refresh = useRefreshCenter();
  const technicians = useTechnicians();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const reassigning =
    Boolean(complaint.technicianId) && complaint.status !== 'ASSIGNED' && complaint.status !== 'REOPENED';

  const assign = useMutation({
    mutationFn: () =>
      api(`/complaints/${complaint.id}/assign-technician`, {
        method: 'POST',
        body: { technicianId: selected, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: async () => {
      toast.success(reassigning ? 'Technician changed' : 'Technician assigned');
      setSelected(null);
      setReason('');
      onClose();
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /* The reason is optional, but one given must be a real one — the server
     refuses fewer than three characters. */
  const reasonTooShort = reason.trim().length > 0 && reason.trim().length < 3;

  /* Least-loaded first: the order is the recommendation, the choice is yours. */
  const options = [...(technicians.data?.items ?? [])].sort(
    (a, b) => (a.workload?.openJobs ?? 0) - (b.workload?.openJobs ?? 0) || a.name.localeCompare(b.name),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={reassigning ? 'Reassign technician' : 'Assign technician'}
      description={
        reassigning
          ? 'A booked visit moves to the new technician. Visits already made stay on record.'
          : 'Listed with their current workload, lightest first.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!selected || reasonTooShort} loading={assign.isPending} onClick={() => assign.mutate()}>
            {reassigning ? 'Reassign' : 'Assign'}
          </Button>
        </>
      }
    >
      {!technicians.data && !technicians.error ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : technicians.error && !technicians.data ? (
        <ErrorState error={technicians.error} onRetry={() => void technicians.refetch()} />
      ) : options.length === 0 ? (
        <p className="text-sm text-slate-600">
          You have no active technicians.{' '}
          <Link to="/center/technicians" className="font-medium text-brand-700 hover:underline">
            Add one
          </Link>{' '}
          first.
        </p>
      ) : (
        <div className="space-y-4">
          {reassigning && visitUnderWay && (
            <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                A visit is under way. Reassigning ends it without a resolution — book a visit for the new technician
                afterwards.
              </span>
            </p>
          )}
          <div className="space-y-2" role="radiogroup" aria-label="Technician">
            {options.map((technician) => {
              /* Naming the current technician again is refused as a no-op,
                 except when it restarts a reopened complaint. */
              const isCurrent = technician.id === complaint.technicianId && reassigning;
              return (
                <label
                  key={technician.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors',
                    selected === technician.id
                      ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600'
                      : 'border-slate-200 hover:bg-slate-50',
                    isCurrent && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name="technician"
                    value={technician.id}
                    checked={selected === technician.id}
                    disabled={isCurrent}
                    onChange={() => setSelected(technician.id)}
                    className="accent-brand-700"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-900">
                      {technician.name}
                      {isCurrent && <span className="ml-1.5 text-xs font-normal text-slate-500">(current)</span>}
                    </span>
                    <span className="tabular block text-xs text-slate-500">{formatMobile(technician.mobile)}</span>
                  </span>
                  <span className="text-right text-xs text-slate-600">
                    <span className="block">
                      <span className="tabular font-semibold text-slate-900">{technician.workload?.openJobs ?? 0}</span>{' '}
                      open {technician.workload?.openJobs === 1 ? 'job' : 'jobs'}
                    </span>
                    <span className="block text-slate-500">
                      {technician.workload?.visitsToday ?? 0} today
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          {reassigning && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">Reason (optional)</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Rajesh is on leave this week"
                aria-invalid={reasonTooShort || undefined}
                className="block min-h-[72px] w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
              {reasonTooShort && (
                <span className="mt-1 block text-xs text-red-600">Write at least 3 characters, or leave it empty.</span>
              )}
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ---- Book a visit (section 9) ------------------------------------------ */

function ScheduleVisitDialog({
  open,
  onClose,
  title,
  complaint,
  rule,
  closesOpenVisit,
}: {
  open: boolean;
  onClose: () => void;
  /** The same words as the button that opened it. */
  title: string;
  complaint: Complaint;
  rule: NextAction;
  closesOpenVisit: boolean;
}) {
  const refresh = useRefreshCenter();
  const [when, setWhen] = useState(defaultVisitTime);
  const [dateError, setDateError] = useState<string | undefined>();

  const description = closesOpenVisit
    ? 'The technician’s current visit is closed, and a new one is booked for the time below.'
    : rule.requiresReason
      ? 'Say why a new visit is needed — it is recorded on the timeline.'
      : 'The technician sees the job in their schedule straight away.';

  return (
    <ReasonDialog
      open={open}
      onClose={() => {
        setDateError(undefined);
        onClose();
      }}
      title={title}
      description={description}
      label={rule.requiresReason ? 'Why another visit?' : 'Note for the timeline'}
      placeholder={rule.requiresReason ? 'e.g. Customer was not home, rebooked for Saturday' : 'e.g. Customer prefers mornings'}
      confirmLabel="Book visit"
      optional={!rule.requiresReason}
      onConfirm={async (reason) => {
        if (!when || new Date(when).getTime() < Date.now() - 60_000) {
          setDateError('Choose a time in the future');
          throw new Error('Choose a time in the future');
        }
        await api(`/complaints/${complaint.id}/visits`, {
          method: 'POST',
          body: {
            scheduledAt: new Date(when).toISOString(),
            /* Sent as `reason` either way: it is what the timeline records. */
            ...(reason ? { reason } : {}),
          },
        });
        toast.success(`Visit booked for ${formatDateTime(new Date(when))}`);
        setWhen(defaultVisitTime());
        await refresh();
      }}
    >
      <VisitTimeField
        value={when}
        onChange={(next) => {
          setWhen(next);
          setDateError(undefined);
        }}
        error={dateError}
      />
    </ReasonDialog>
  );
}

/* ---- The technician's work (Workflow E) -------------------------------- */

/**
 * What the technician found, did and fitted — and, while it awaits review,
 * the Owner's two choices.
 *
 * Parts are confirmed here, one by one. Confirming is what deducts stock
 * (section 11: "decremented only when usage is finalized"), so it is a
 * deliberate act on each line rather than a side effect of accepting.
 */
function WorkCard({
  complaint,
  visitId,
  reviewing,
}: {
  complaint: Complaint;
  visitId: string;
  reviewing: boolean;
}) {
  const refresh = useRefreshCenter();
  const [sendBack, setSendBack] = useState(false);
  const [showHappyCode, setShowHappyCode] = useState(false);

  const visit = useQuery({
    queryKey: ['visit', visitId],
    queryFn: () => api<{ visit: VisitDetail }>(`/visits/${visitId}`),
  });

  const accept = useMutation({
    mutationFn: () =>
      api(`/complaints/${complaint.id}/review-resolution`, { method: 'POST', body: { outcome: 'ACCEPTED' } }),
    onSuccess: async () => {
      toast.success('Work accepted — sent to Admin for customer confirmation');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const work = visit.data?.visit;

  return (
    <Card className={cn(reviewing && 'border-cyan-300 ring-1 ring-cyan-200')}>
      <CardHeader
        title={reviewing ? 'Review the technician’s work' : 'Last submitted work'}
        description={
          work?.resolution ? `Submitted ${formatDateTime(work.resolution.submittedAt)} · visit ${work.sequence}` : undefined
        }
      />

      {!visit.data && !visit.error ? (
        <div className="space-y-3 px-5 py-5">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : visit.error && !visit.data ? (
        <ErrorState error={visit.error} onRetry={() => void visit.refetch()} />
      ) : work ? (
        <div className="divide-y divide-slate-100">
          <dl className="grid gap-5 px-5 py-5 sm:grid-cols-2">
            <Detail label="Problem found">
              {work.diagnosis?.problemFound ?? '—'}
              {work.diagnosis?.notes && <span className="mt-1 block text-slate-500">{work.diagnosis.notes}</span>}
            </Detail>
            <Detail label="Work done">
              {work.workPerformed?.details ?? '—'}
              {work.workPerformed?.remarks && (
                <span className="mt-1 block text-slate-500">{work.workPerformed.remarks}</span>
              )}
            </Detail>
            <Detail label="Result">
              {work.resolution?.result ?? '—'}
              {work.resolution?.remarks && <span className="mt-1 block text-slate-500">{work.resolution.remarks}</span>}
            </Detail>
            <Detail label="Customer said">
              {work.resolution?.customerFeedback ?? <span className="text-slate-400">Nothing recorded</span>}
            </Detail>
          </dl>

          <PartsUsed complaintId={complaint.id} visitId={visitId} complaint={complaint} />

          <div className="px-5 py-5">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Photos</p>
            {/* This visit's photos: an earlier trip's are that trip's record. */}
            <PhotosGrid
              complaintId={complaint.id}
              visitId={visitId}
              emptyText="No photos from this visit."
            />
          </div>

          {reviewing && (
            <div className="flex flex-wrap items-center justify-end gap-2 bg-slate-50/70 px-5 py-4">
              <Button
                variant="secondary"
                icon={<RotateCcw className="size-4" />}
                onClick={() => setSendBack(true)}
              >
                Send back for revisit
              </Button>
              <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setShowHappyCode(true)}>
                Close with Happy Code
              </Button>
              <Button icon={<CheckCircle2 className="size-4" />} loading={accept.isPending} onClick={() => accept.mutate()}>
                Accept work
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <ReasonDialog
        open={sendBack}
        onClose={() => setSendBack(false)}
        title="Send back for revisit"
        description="The technician sees your reason. Book the revisit afterwards from this page."
        label="What still needs doing?"
        placeholder="e.g. Cooler still blows warm air after 10 minutes"
        confirmLabel="Send back"
        tone="danger"
        onConfirm={async (reason) => {
          await api(`/complaints/${complaint.id}/review-resolution`, {
            method: 'POST',
            body: { outcome: 'REVISIT_REQUIRED', reason },
          });
          toast.success('Sent back for a revisit');
          await refresh();
        }}
      />

      <HappyCodeCloseDialog
        open={showHappyCode}
        onClose={() => setShowHappyCode(false)}
        complaintId={complaint.id}
        onClosed={refresh}
      />
    </Card>
  );
}

function PartsUsed({
  complaintId,
  visitId,
  complaint,
}: {
  complaintId: string;
  visitId: string;
  complaint: Complaint;
}) {
  const refresh = useRefreshCenter();
  const catalog = usePartsCatalog();

  const usage = useQuery({
    queryKey: ['part-usage', complaintId],
    queryFn: () => api<{ items: PartUsage[] }>(`/complaints/${complaintId}/part-usage`),
  });

  const finalize = useMutation({
    mutationFn: (usageId: string) =>
      api<{ remainingStock: number; isLowStock: boolean }>(`/parts/usage/${usageId}/finalize`, { method: 'POST' }),
    onSuccess: async (result) => {
      toast.success(
        `Stock updated — ${result.remainingStock} left${result.isLowStock ? ' (low stock)' : ''}`,
      );
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const nameOf = (partId: string) => catalog.data?.items.find((part) => part.id === partId)?.name ?? 'Part';
  /* Parts recorded on this visit first; anything from earlier visits after. */
  const rows = [...(usage.data?.items ?? [])].sort(
    (a, b) => Number(b.visitId === visitId) - Number(a.visitId === visitId),
  );
  const pending = rows.filter((row) => !row.finalizedAt).length;

  /**
   * Whether a not-yet-finalised line can still be confirmed, mirroring the
   * server's own check in `finalizeUsage`.
   *
   * A closed or cancelled complaint refuses *new* usage, but a part really
   * fitted before that must still be confirmable — Admin closing the job
   * before the centre confirmed a line must not leave stock wrong for good.
   * Only a line somehow recorded after the job ended (the old gap the server
   * now closes off) stays locked.
   */
  const ended = complaint.status === 'CLOSED' || complaint.status === 'CANCELLED';
  const endedAt = complaint.status === 'CLOSED' ? complaint.closedAt : complaint.cancelledAt;
  const canConfirm = (row: PartUsage) =>
    !ended || (endedAt !== undefined && new Date(row.createdAt).getTime() <= new Date(endedAt).getTime());

  return (
    <div className="px-5 py-5">
      <p className="mb-3 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500">
        Parts used
        {pending > 0 && rows.some((row) => !row.finalizedAt && canConfirm(row)) && (
          <span className="normal-case tracking-normal text-amber-700">
            {pending} not yet confirmed — stock is deducted when you confirm
          </span>
        )}
      </p>

      {!usage.data && !usage.error ? (
        <Skeleton className="h-10" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No parts recorded.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 text-sm text-slate-900">
                {nameOf(row.partId)} <span className="tabular text-slate-500">× {row.quantity}</span>
                {row.remarks && <span className="block text-xs text-slate-500">{row.remarks}</span>}
              </span>
              {row.finalizedAt ? (
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
                  <CheckCircle2 className="size-3.5" />
                  Stock deducted
                </span>
              ) : canConfirm(row) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={finalize.isPending && finalize.variables === row.id}
                  onClick={() => finalize.mutate(row.id)}
                >
                  Confirm & deduct stock
                </Button>
              ) : (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Lock className="size-3.5" />
                  Not confirmed
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---- Part requests for this complaint (section 11) --------------------- */

function PartRequestsCard({ complaintId }: { complaintId: string }) {
  const requests = useQuery({
    queryKey: ['part-requests', 'complaint', complaintId],
    queryFn: () =>
      api<Paged<PartRequestRow>>('/parts/requests/list', { query: { complaintId, limit: 50 } }),
  });

  const rows = requests.data?.items ?? [];
  if (rows.length === 0) return null;

  const open = rows.filter((row) => row.status === 'REQUESTED' || row.status === 'APPROVED').length;

  return (
    <Card className={cn(open > 0 && 'border-amber-200')}>
      <CardHeader
        title="Part requests"
        description={open > 0 ? `${open} waiting for your decision` : 'All answered'}
      />
      <ul className="divide-y divide-slate-100">
        {rows.map((row) => {
          /* The server refuses to approve or issue for a finished job, but
             lets the request be rejected so it stops waiting. Same rule as
             the centre's Requests queue. */
          const jobEnded =
            (row.status === 'REQUESTED' || row.status === 'APPROVED') &&
            (row.complaint?.status === 'CLOSED' || row.complaint?.status === 'CANCELLED');

          return (
          <li key={row.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900">
                {row.part?.name ?? 'Part'}{' '}
                <span className="tabular font-normal text-slate-500">× {row.quantityRequested}</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {row.requestedByName ?? 'Technician'} · {fromNow(row.createdAt)}
                {row.reason && ` · “${row.reason}”`}
              </p>
              {row.decisionRemarks && (
                <p className="mt-1 text-xs text-slate-600">Your note: {row.decisionRemarks}</p>
              )}
              {jobEnded && (
                <p className="mt-1 text-xs text-amber-700">
                  This complaint is {row.complaint?.status === 'CLOSED' ? 'closed' : 'cancelled'}, so no part can be
                  approved or issued for it. Reject the request to clear it from this list.
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <QueueStatusBadge status={row.status} />
              <PartRequestActions request={row} />
            </div>
          </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ---- Visit history (section 9) ----------------------------------------- */

function VisitsCard({
  complaintId,
  visits,
}: {
  complaintId: string;
  visits: ReturnType<typeof useComplaintVisits>;
}) {
  const technicians = useTechnicians({ includeInactive: true });
  const [moving, setMoving] = useState<VisitCard | null>(null);
  const [cancelling, setCancelling] = useState<VisitCard | null>(null);

  const nameOf = (id: string) => technicians.data?.items.find((t) => t.id === id)?.name ?? 'Technician';
  const rows = [...(visits.data?.items ?? [])].sort((a, b) => b.sequence - a.sequence);

  void complaintId;

  return (
    <Card>
      <CardHeader title="Visits" description={visits.data ? `${rows.length} ${rows.length === 1 ? 'visit' : 'visits'}` : undefined} />
      {!visits.data && !visits.error ? (
        <div className="px-5 py-5">
          <Skeleton className="h-12" />
        </div>
      ) : visits.error && !visits.data ? (
        <ErrorState error={visits.error} onRetry={() => void visits.refetch()} />
      ) : rows.length === 0 ? (
        <p className="px-5 py-5 text-sm text-slate-500">No visits booked yet.</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {rows.map((visit) => (
            <li key={visit.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
              <span className="tabular mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                {visit.sequence}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">
                  {humanize(visit.status)}
                  <span className="font-normal text-slate-500">
                    {' '}
                    · {nameOf(visit.technicianId)}
                  </span>
                </p>
                <p className="tabular mt-0.5 text-xs text-slate-500">
                  {visit.status === 'COMPLETED' && visit.completedAt
                    ? `Finished ${formatDateTime(visit.completedAt)}`
                    : visit.status === 'IN_PROGRESS' && visit.startedAt
                      ? `Started ${formatDateTime(visit.startedAt)}`
                      : `Booked for ${formatDateTime(visit.scheduledAt)}`}
                </p>
                <VisitOutcome visit={visit} />
              </div>
              {visit.status === 'SCHEDULED' && (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setMoving(visit)}>
                    Reschedule
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => setCancelling(visit)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {moving && (
        <RescheduleVisitDialog
          visitId={moving.id}
          currentAt={moving.scheduledAt}
          open
          onClose={() => setMoving(null)}
        />
      )}
      {cancelling && (
        <CancelVisitDialog visitId={cancelling.id} open onClose={() => setCancelling(null)} />
      )}
    </Card>
  );
}

function VisitOutcome({ visit }: { visit: VisitCard }) {
  if (visit.status !== 'COMPLETED') return null;

  if (visit.resolutionResult) {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-sm text-slate-700">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
        {visit.resolutionResult}
      </p>
    );
  }

  const reason =
    visit.customerAvailability && visit.customerAvailability !== 'CUSTOMER_AVAILABLE'
      ? NO_WORK_REASON[visit.customerAvailability]
      : 'Ended without work';

  return (
    <p className="mt-1 flex items-start gap-1.5 text-sm text-amber-800">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      {reason}
      {visit.availabilityNote ? ` — “${visit.availabilityNote}”` : ''}
    </p>
  );
}

/* ---- Technician -------------------------------------------------------- */

function TechnicianCard({
  technicianId,
  reassignable,
}: {
  technicianId: string | undefined;
  /** Whether the header offers Reassign for this complaint's status. */
  reassignable: boolean;
}) {
  const technicians = useTechnicians({ includeInactive: true });
  const technician = technicians.data?.items.find((item) => item.id === technicianId);

  return (
    <Card>
      <CardHeader title="Technician" />
      <dl className="space-y-4 px-5 py-5">
        {!technicianId ? (
          <p className="text-sm text-slate-500">Not assigned yet.</p>
        ) : !technicians.data ? (
          <Skeleton className="h-10" />
        ) : technician ? (
          <>
            <Detail label="Name">
              {technician.name}
              {!technician.isActive && (
                <span className="ml-2 rounded bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">
                  {/* Only point at a button that is there: submitted, closed and
                      cancelled work keeps its technician for the record. */}
                  {reassignable ? 'Deactivated — use Reassign above' : 'Deactivated'}
                </span>
              )}
            </Detail>
            <Detail label="Mobile">
              <a href={`tel:+91${technician.mobile}`} className="tabular font-medium text-brand-700 hover:underline">
                {formatMobile(technician.mobile)}
              </a>
            </Detail>
            {technician.workload && (
              <Detail label="Workload">
                {technician.workload.openJobs} open {technician.workload.openJobs === 1 ? 'job' : 'jobs'} ·{' '}
                {technician.workload.visitsToday} {technician.workload.visitsToday === 1 ? 'visit' : 'visits'} today
              </Detail>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-500">Details unavailable.</p>
        )}
      </dl>
    </Card>
  );
}

/* ---- Admin's rating of the finished job (DECISIONS.md section 31) ------ */

/**
 * Read-only: only Admin rates a centre's work, once a complaint is closed,
 * so the centre sees what Admin thought of the job but has no way to change
 * it. Hidden entirely for a complaint that is not closed — a rating judges
 * finished work, not work still under way.
 */
function ServiceRatingCard({ complaint }: { complaint: Complaint }) {
  const rating = complaint.serviceRating;

  return (
    <Card>
      <CardHeader title="Admin's rating" />
      <div className="px-5 py-5">
        {!rating ? (
          <p className="text-sm text-slate-500">Admin has not rated this job yet.</p>
        ) : (
          <div className="space-y-2.5">
            <RatingValue value={rating.stars} size="md" />
            {rating.note && <p className="text-sm text-slate-700">{rating.note}</p>}
            <p className="text-xs text-slate-500">
              {rating.ratedByName} · {formatDateTime(rating.ratedAt)}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---- Happy Code close dialog ------------------------------------------ */

function HappyCodeCloseDialog({
  open,
  onClose,
  complaintId,
  onClosed,
}: {
  open: boolean;
  onClose: () => void;
  complaintId: string;
  onClosed: () => Promise<unknown>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const close = useMutation({
    mutationFn: () =>
      api<{ verified?: boolean; attemptsRemaining?: number; message?: string }>(
        `/complaints/${complaintId}/close`,
        { method: 'POST', body: { code } },
      ),
    onSuccess: async (result) => {
      if (result.verified === false) {
        setError(result.message ?? 'Incorrect code');
        return;
      }
      toast.success('Complaint closed');
      setCode('');
      setError('');
      onClose();
      await onClosed();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not close');
    },
  });

  return (
    <Dialog
      open={open}
      onClose={() => { onClose(); setCode(''); setError(''); }}
      size="sm"
      title="Close with Happy Code"
      description="Enter the 6-digit code the customer received."
      footer={
        <>
          <Button variant="secondary" onClick={() => { onClose(); setCode(''); setError(''); }}>
            Cancel
          </Button>
          <Button
            disabled={code.length !== 6}
            loading={close.isPending}
            onClick={() => { setError(''); close.mutate(); }}
          >
            Verify & Close
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
          className="h-14 w-full rounded-lg border-0 bg-slate-50 text-center font-mono text-2xl tracking-[0.4em] text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-red-600">
            <Lock className="size-4" />
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
