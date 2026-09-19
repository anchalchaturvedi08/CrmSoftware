/**
 * One job, as a technician sees it in a list (spec section 10).
 *
 * Section 10 lists what the card must show: complaint number, customer, city,
 * product/model, priority, visit time and status. The hierarchy puts *when*
 * and *who* first — a technician scanning their day needs "11:30, Anita Sharma,
 * Jaipur" before they need the complaint number.
 *
 * The whole card is one link, so the tap target is the full card rather than a
 * small button inside it.
 */
import { AlertCircle, CheckCircle2, ChevronRight, Clock, MapPin, Package, UserX } from 'lucide-react';
import { Link } from 'react-router';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { cn, NO_WORK_REASON } from '@/lib/format';
import type { VisitCard } from '@/lib/types';
import dayjs from 'dayjs';

/**
 * "Today, 11:30 AM", "Tomorrow, 9:00 AM", "Thu 18 Sep, 2:00 PM".
 *
 * `midSentence` lower-cases the relative words, for "Started yesterday, …".
 */
export function visitWhen(value: string | undefined, midSentence = false): string {
  if (!value) return '';
  const date = dayjs(value);
  const time = date.format('h:mm A');
  const word = (text: string) => (midSentence ? text.toLowerCase() : text);

  if (date.isSame(dayjs(), 'day')) return `${word('Today')}, ${time}`;
  if (date.isSame(dayjs().add(1, 'day'), 'day')) return `${word('Tomorrow')}, ${time}`;
  if (date.isSame(dayjs().subtract(1, 'day'), 'day')) return `${word('Yesterday')}, ${time}`;
  return date.format('ddd D MMM, h:mm A');
}

/**
 * What a finished visit amounts to.
 *
 * A completed visit is not necessarily a repair: the trip may have ended at
 * the door, or stopped to wait for a part. History that shows them all as
 * "completed" would tell the technician they fixed things they never touched.
 */
export function visitOutcome(visit: VisitCard): { tone: 'done' | 'none'; text: string } | null {
  if (visit.status !== 'COMPLETED') return null;
  if (visit.resolutionResult) return { tone: 'done', text: visit.resolutionResult };

  const reason =
    visit.customerAvailability && visit.customerAvailability !== 'CUSTOMER_AVAILABLE'
      ? NO_WORK_REASON[visit.customerAvailability]
      : 'Ended before the work was finished';

  return { tone: 'none', text: visit.availabilityNote ? `${reason} · ${visit.availabilityNote}` : reason };
}

export function JobCard({ visit, emphasis = false }: { visit: VisitCard; emphasis?: boolean }) {
  const complaint = visit.complaint;
  if (!complaint) return null;

  const urgent = complaint.priority === 'CRITICAL' || complaint.priority === 'HIGH';
  const missed = visit.status === 'SCHEDULED' && dayjs(visit.scheduledAt).isBefore(dayjs(), 'day');
  const outcome = visitOutcome(visit);

  return (
    <Link
      to={`/tech/jobs/${complaint.id}`}
      className={cn(
        'block rounded-2xl border bg-white p-4 shadow-sm transition-transform active:scale-[0.99]',
        emphasis ? 'border-amber-300 ring-1 ring-amber-200' : missed ? 'border-rose-300' : 'border-slate-200',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {visit.status !== 'REVISIT_REQUIRED' && (
            <p
              className={cn(
                'flex items-center gap-1.5 text-sm font-semibold',
                missed ? 'text-rose-700' : 'text-slate-900',
              )}
            >
              {missed ? (
                <AlertCircle className="size-4" aria-hidden />
              ) : (
                <Clock className="size-4 text-slate-400" aria-hidden />
              )}
              {visit.status === 'IN_PROGRESS' && visit.startedAt
                ? `Started ${visitWhen(visit.startedAt, true)}`
                : visitWhen(visit.status === 'COMPLETED' ? visit.completedAt : visit.scheduledAt)}
              {missed && <span className="font-medium"> · Missed</span>}
            </p>
          )}
          <p className="mt-1 truncate text-base font-semibold text-slate-900">{complaint.customerName}</p>
          <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{complaint.cityName}</span>
          </p>
        </div>
        <ChevronRight className="mt-1 size-5 shrink-0 text-slate-300" aria-hidden />
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-700">
        <Package className="size-4 shrink-0 text-slate-400" aria-hidden />
        <span className="truncate">
          {complaint.productName} · {complaint.modelNumber}
        </span>
      </p>
      <p className="mt-1 truncate text-sm text-slate-500">{complaint.category}</p>

      {outcome && (
        <p
          className={cn(
            'mt-2 flex items-start gap-1.5 text-sm',
            outcome.tone === 'done' ? 'text-slate-800' : 'text-slate-600',
          )}
        >
          {outcome.tone === 'done' ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <UserX className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
          )}
          <span className="line-clamp-2">{outcome.text}</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={complaint.status} />
        {urgent && <PriorityBadge priority={complaint.priority} />}
        <span className="tabular ml-auto text-xs text-slate-400">{complaint.complaintNumber}</span>
      </div>
    </Link>
  );
}
