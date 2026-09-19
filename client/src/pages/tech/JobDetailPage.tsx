/**
 * Job detail, technician view (spec section 10).
 *
 * Section 10 lists what to show — customer, mobile, address, product, model,
 * serial, purchase date, warranty, complaint, history, service center,
 * schedule — and exactly three actions: Call Customer, Start Visit, View
 * History.
 *
 * The main action changes with the job's state, and there is only ever one:
 * start it, continue it, or a plain explanation of what it is waiting on.
 * Section 10 asks for "very few options per screen", and a technician on a
 * doorstep should not have to choose between buttons.
 *
 * One addition beyond the spec's list: a "Directions" link that opens the
 * phone's maps app at the address. It sends nothing back — section 22 rules out
 * GPS tracking, and this is not that; it is the address, handed to the maps
 * app the technician was going to open anyway.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  Clock,
  History,
  MapPin,
  MessageCircle,
  Navigation,
  Package,
  Phone,
  PlayCircle,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { TechHeader } from '@/components/layout/TechLayout';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { callLink, dialableMobile, whatsAppChatLink } from '@/components/ui/ContactButtons';
import { ErrorState, Skeleton, errorMessage } from '@/components/ui/States';
import { api, ApiError } from '@/lib/api';
import { cn, formatDate, formatMobile, WARRANTY_LABEL } from '@/lib/format';
import { warrantyPeriod } from '@/lib/warranty';
import type { Complaint, ComplaintDetail, VisitCard } from '@/lib/types';
import { visitOutcome, visitWhen } from './JobCard';
import { complaintQuery, isJobGone, visitsQuery } from './queries';
import { StaleNote } from './StaleNote';
import { forgetFinishedDrafts } from './visit/useVisitDraft';

/** A large, thumb-sized action: icon above its label so three fit across a phone. */
const QUICK_ACTION =
  'flex h-16 flex-col items-center justify-center gap-1 rounded-2xl bg-white text-sm font-semibold text-brand-700 shadow-sm ring-1 ring-slate-200 active:bg-slate-50';

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-3">
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <div className="mt-0.5 text-[15px] text-slate-900">{children}</div>
      </div>
    </div>
  );
}

/**
 * How much warranty the dates leave, so the technician knows before touching
 * anything (DECISIONS.md section 32). The status above it is what the job was
 * raised with and is what applies; this line only adds the dates' reading.
 */
function WarrantyLeft({ complaint }: { complaint: Complaint }) {
  const period = warrantyPeriod(complaint.purchaseDate, complaint.productSnapshot.warrantyMonths);
  if (!period) return null;
  return (
    <span className={cn('block text-sm', period.inWarranty ? 'text-emerald-700' : 'text-slate-500')}>
      {period.inWarranty ? `${period.text} (ends ${formatDate(period.endsAt)})` : `Out of warranty — ${period.text.toLowerCase()}`}
    </span>
  );
}

export function JobDetailPage() {
  const { complaintId = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);

  const detail = useQuery(complaintQuery(complaintId));
  const visits = useQuery(visitsQuery(complaintId));

  const serial = detail.data?.complaint.serialNumber;
  const history = useQuery({
    queryKey: ['serial-history', serial],
    queryFn: () =>
      api<{ complaints: Complaint[]; total: number }>(
        `/serial-history/${encodeURIComponent(serial!)}`,
      ),
    enabled: historyOpen && Boolean(serial),
  });

  /**
   * A 404 from the history is normally "no history" — the unit is outside
   * this technician's work. It is also exactly what a job moved to someone
   * else since the screen loaded looks like, so the job is re-checked: a moved
   * job then shows as moved instead of as a unit with no past (review).
   */
  const historyNotFound = history.error instanceof ApiError && history.error.status === 404;
  const recheckJob = detail.refetch;
  useEffect(() => {
    if (historyNotFound) void recheckJob();
  }, [historyNotFound, recheckJob]);

  const resume = useMutation({
    mutationFn: () => api<ComplaintDetail>(`/complaints/${complaintId}/resume-work`, { method: 'POST' }),
    onSuccess: async (result) => {
      toast.success('Work resumed');
      /* The reply is the complaint as it now stands. Stored first, so the
         visit flow opens on it even if the refresh below finds no signal. */
      client.setQueryData(complaintQuery(complaintId).queryKey, result);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['complaint', complaintId] }),
        client.invalidateQueries({ queryKey: ['my-jobs'] }),
      ]);
      navigate(`/tech/jobs/${complaintId}/visit`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /* The job is opened here before any visit flow, so this is where a draft
     left over from a finished visit is cleared (see useVisitDraft.ts). */
  useEffect(() => {
    if (!visits.data) return;
    const finishedVisitIds = visits.data.items
      .filter((visit) => visit.status === 'COMPLETED' || visit.status === 'CANCELLED')
      .map((visit) => visit.id);
    forgetFinishedDrafts(complaintId, finishedVisitIds);
  }, [complaintId, visits.data]);

  if (!detail.data && !detail.error) {
    return (
      <>
        <TechHeader title="Job" back="/tech" />
        <div className="space-y-3 p-4" aria-busy>
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </>
    );
  }

  /* Only a job with nothing loaded, or one the server says is no longer this
     technician's, is replaced by an error. A failed background refresh keeps
     the job on screen (see StaleNote) — the address and the Call button are
     what a technician without signal needs most. */
  const gone = isJobGone(detail.error);
  if (!detail.data || gone) {
    return (
      <>
        <TechHeader title="Job" back="/tech" />
        <div className="m-4 rounded-2xl bg-white">
          {gone ? (
            <div className="px-6 py-12 text-center">
              <p className="font-semibold text-slate-900">This job is not assigned to you</p>
              <p className="mt-1 text-sm text-slate-500">
                It may have been moved to another technician.
              </p>
            </div>
          ) : (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          )}
        </div>
      </>
    );
  }

  const { complaint } = detail.data;
  /* The visit list failing with nothing loaded has its own retry, in place of
     the main action below. */
  const stale = Boolean(detail.error) || Boolean(visits.error && visits.data);
  /* Newest first by visit number: booking times can tie. */
  const ordered = [...(visits.data?.items ?? [])].sort((a, b) => b.sequence - a.sequence);
  const current = ordered.find((v) => v.status === 'SCHEDULED' || v.status === 'IN_PROGRESS');
  /* The most recent finished trip, when it ended with no work. Most useful
     when the next visit is already booked: it is the cue to call ahead. */
  const latest = ordered.find((v) => v.status === 'COMPLETED');
  const endedWithoutWork = latest ? visitOutcome(latest) : null;
  const mobile = dialableMobile(complaint.customerSnapshot.mobile);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${complaint.serviceAddress.address}, ${complaint.serviceAddress.cityName} ${complaint.serviceAddress.pincode}`,
  )}`;

  return (
    <>
      <TechHeader title={complaint.customerSnapshot.name} subtitle={complaint.complaintNumber} back="/tech" />
      {stale && (
        <StaleNote
          retrying={detail.isFetching || visits.isFetching}
          onRetry={() => void Promise.all([detail.refetch(), visits.refetch()])}
        />
      )}

      <div className="space-y-3 p-4 pb-40">
        {/* ---- Status and schedule ----------------------------------- */}
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={complaint.status} />
            <PriorityBadge priority={complaint.priority} />
          </div>
          {current && (
            <p className="mt-3 flex items-center gap-2 text-base font-semibold text-slate-900">
              <CalendarClock className="size-5 text-slate-400" />
              {current.status === 'IN_PROGRESS'
                ? `Started ${visitWhen(current.startedAt, true)}`
                : visitWhen(current.scheduledAt)}
            </p>
          )}
          <p className="mt-3 text-[15px] font-medium text-slate-900">{complaint.category}</p>
          <p className="mt-1 whitespace-pre-line text-[15px] leading-relaxed text-slate-600">
            {complaint.description}
          </p>

          {endedWithoutWork?.tone === 'none' && (
            <div className="mt-3 rounded-xl bg-slate-100 p-3 text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Last visit: {visitWhen(latest!.completedAt)}</p>
              <p className="mt-0.5">{endedWithoutWork.text}</p>
            </div>
          )}

          {complaint.resolutionReview?.outcome === 'REVISIT_REQUIRED' &&
            complaint.resolutionReview.rejectionReason && (
              <div className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-900">
                <p className="font-semibold">Sent back by your service center</p>
                <p className="mt-0.5">{complaint.resolutionReview.rejectionReason}</p>
              </div>
            )}
        </div>

        {/* ---- Call, WhatsApp and directions: what is done first on site -- */}
        <div className="grid grid-cols-3 gap-3">
          {mobile ? (
            <>
              <a href={callLink(mobile)} className={QUICK_ACTION}>
                <Phone className="size-5" aria-hidden />
                Call
              </a>
              {/* Opens the customer's chat; nothing is typed or sent for them. */}
              <a href={whatsAppChatLink(mobile)} target="_blank" rel="noopener noreferrer" className={QUICK_ACTION}>
                <MessageCircle className="size-5 text-[#1da851]" aria-hidden />
                WhatsApp
              </a>
            </>
          ) : (
            <p className="col-span-2 flex items-center justify-center rounded-2xl bg-white px-3 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-200">
              No valid mobile number
            </p>
          )}
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={QUICK_ACTION}>
            <Navigation className="size-5" aria-hidden />
            Directions
          </a>
        </div>

        {/* ---- Customer and product ----------------------------------- */}
        <div className="divide-y divide-slate-100 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-slate-200">
          <Row icon={<Phone className="size-5" />} label="Mobile">
            <span className="tabular">{formatMobile(complaint.customerSnapshot.mobile)}</span>
          </Row>
          <Row icon={<MapPin className="size-5" />} label="Address">
            {complaint.serviceAddress.address}
            <br />
            {complaint.serviceAddress.cityName}, {complaint.serviceAddress.pincode}
          </Row>
          <Row icon={<Package className="size-5" />} label="Product">
            {complaint.productSnapshot.productName}
            <span className="block text-sm text-slate-500">
              Model {complaint.productSnapshot.modelNumber} · Serial{' '}
              <span className="tabular">{complaint.serialNumber}</span>
            </span>
          </Row>
          <Row icon={<ShieldCheck className="size-5" />} label="Warranty">
            {WARRANTY_LABEL[complaint.warrantyStatus]}
            {complaint.purchaseDate && (
              <span className="block text-sm text-slate-500">
                Purchased {formatDate(complaint.purchaseDate)}
              </span>
            )}
            <WarrantyLeft complaint={complaint} />
          </Row>
        </div>

        {/* ---- History (section 10: "View History") ------------------- */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            className="flex min-h-14 w-full items-center gap-3 px-4 text-left"
          >
            <History className="size-5 text-slate-400" />
            <span className="flex-1 text-[15px] font-medium text-slate-900">
              Service history for this unit
            </span>
            <ChevronDown className={cn('size-5 text-slate-400 transition-transform', historyOpen && 'rotate-180')} />
          </button>

          {historyOpen && (
            <div className="border-t border-slate-100 px-4 py-3">
              {history.isLoading ? (
                <Skeleton className="h-16" />
              ) : history.error && !history.data && !(history.error instanceof ApiError && history.error.status === 404) ? (
                /* Not "no earlier complaints": the app does not know that.
                   A 404, unlike any other failure, does mean exactly that —
                   the server returns it for units outside this technician's
                   own work, which reads the same as no history to show. */
                <div className="flex items-center justify-between gap-3 py-1">
                  <p className="text-sm text-slate-600">
                    Couldn’t load the history.
                    <span className="block text-xs text-slate-500">{errorMessage(history.error)}</span>
                  </p>
                  <Button
                    variant="secondary"
                    className="h-11 shrink-0"
                    loading={history.isFetching}
                    onClick={() => void history.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (history.data?.complaints ?? []).filter((c) => c.id !== complaint.id).length === 0 ? (
                <p className="py-2 text-sm text-slate-500">No earlier complaints for this unit.</p>
              ) : (
                <ul className="space-y-3">
                  {history
                    .data!.complaints.filter((c) => c.id !== complaint.id)
                    .map((previous) => (
                      <li key={previous.id} className="rounded-xl bg-slate-50 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="tabular text-sm font-medium text-slate-900">
                            {previous.complaintNumber}
                          </span>
                          <StatusBadge status={previous.status} />
                        </div>
                        <p className="mt-1 text-sm text-slate-700">{previous.category}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{formatDate(previous.createdAt)}</p>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---- The one main action, pinned above the tab bar ------------ */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 mx-auto w-full max-w-md border-t border-slate-200 bg-white/95 p-4 backdrop-blur">
        <PrimaryAction
          status={complaint.status}
          openVisit={visits.data ? current : undefined}
          visitsReady={Boolean(visits.data)}
          visitsFailed={Boolean(visits.error) && !visits.data}
          onRetryVisits={() => void visits.refetch()}
          onStart={() => navigate(`/tech/jobs/${complaintId}/visit`)}
          onContinue={() => navigate(`/tech/jobs/${complaintId}/visit`)}
          onResume={() => resume.mutate()}
          resuming={resume.isPending}
        />
      </div>
    </>
  );
}

/**
 * Exactly one thing to do, or a plain reason there is nothing to do.
 *
 * Work needs an open visit, not just a complaint in the right status: after a
 * trip that ended at the door the complaint is still IN_PROGRESS, but there is
 * nothing to continue until the service center books the next visit.
 */
function PrimaryAction({
  status,
  openVisit,
  visitsReady,
  visitsFailed,
  onRetryVisits,
  onStart,
  onContinue,
  onResume,
  resuming,
}: {
  status: Complaint['status'];
  openVisit: VisitCard | undefined;
  visitsReady: boolean;
  visitsFailed: boolean;
  onRetryVisits: () => void;
  onStart: () => void;
  onContinue: () => void;
  onResume: () => void;
  resuming: boolean;
}) {
  const needsVisit = status === 'VISIT_SCHEDULED' || status === 'IN_PROGRESS' || status === 'WAITING_FOR_PARTS';
  if (needsVisit && visitsFailed) {
    return (
      <Button variant="secondary" size="lg" className="h-14 w-full text-base" onClick={onRetryVisits}>
        Could not load the visit — try again
      </Button>
    );
  }
  if (needsVisit && !visitsReady) {
    return <Skeleton className="h-14 w-full rounded-lg" />;
  }

  const working = openVisit?.status === 'IN_PROGRESS';

  switch (status) {
    case 'VISIT_SCHEDULED':
      return (
        <Button size="lg" className="h-14 w-full text-base" icon={<PlayCircle className="size-5" />} onClick={onStart}>
          Start visit
        </Button>
      );

    case 'IN_PROGRESS':
      if (working) {
        return (
          <Button size="lg" className="h-14 w-full text-base" icon={<Wrench className="size-5" />} onClick={onContinue}>
            Continue visit
          </Button>
        );
      }
      return <Waiting text="Your service center will book the next visit." />;

    case 'WAITING_FOR_PARTS':
      if (working) {
        return (
          <Button size="lg" className="h-14 w-full text-base" icon={<Wrench className="size-5" />} loading={resuming} onClick={onResume}>
            Parts arrived — resume work
          </Button>
        );
      }
      return <Waiting text="Waiting for parts. Your service center will book the next visit." />;

    default: {
      const waiting: Partial<Record<Complaint['status'], string>> = {
        TECHNICIAN_ASSIGNED: 'Waiting for your service center to schedule a visit.',
        RESOLUTION_SUBMITTED: 'Submitted. Your service center is reviewing the work.',
        ADMIN_CONFIRMATION: 'Accepted. Waiting for the customer to confirm.',
        REVISIT_REQUIRED: 'Sent back. Your service center will schedule a revisit.',
        CLOSED: 'This job is closed.',
        CANCELLED: 'This job was cancelled.',
      };

      return (
        <Waiting
          text={waiting[status] ?? 'Nothing to do on this job right now.'}
          alert={status === 'REVISIT_REQUIRED'}
        />
      );
    }
  }
}

function Waiting({ text, alert = false }: { text: string; alert?: boolean }) {
  return (
    <p className="flex items-center justify-center gap-2 py-2 text-center text-sm text-slate-600">
      {alert ? (
        <AlertTriangle className="size-4 shrink-0 text-rose-500" />
      ) : (
        <Clock className="size-4 shrink-0 text-slate-400" />
      )}
      {text}
    </p>
  );
}
