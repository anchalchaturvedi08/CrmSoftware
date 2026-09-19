/**
 * The parts of a complaint's detail page that read the same in every portal.
 *
 * Admin and the Service Center see the same customer, product, SLA and
 * timeline — what differs is what each may *do*. So the reading parts live
 * here once, and each portal's page adds only its own actions.
 */
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, MapPin, Package, ShieldCheck, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardHeader, Detail } from '@/components/ui/Card';
import { ContactButtons } from '@/components/ui/ContactButtons';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { ROLE_LABEL, activityLabel, activityValue, foldStatusChanges, readableNote } from '@/lib/activity';
import { api } from '@/lib/api';
import {
  cn,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMobile,
  humanize,
  STATUS_META,
  WARRANTY_LABEL,
  type ComplaintStatus,
} from '@/lib/format';
import { warrantyPeriod } from '@/lib/warranty';
import type { Complaint, TimelineEntry } from '@/lib/types';

/* ---- SLA --------------------------------------------------------------- */

export function SlaCard({ complaint }: { complaint: Complaint }) {
  const snapshot = complaint.slaSnapshot;
  const done = complaint.status === 'CLOSED' || complaint.status === 'CANCELLED';

  const breached = snapshot?.resolutionBreached ?? false;
  const remaining = snapshot?.resolutionRemainingMs ?? null;

  return (
    <Card className={cn(breached && !done && 'border-red-200')}>
      <CardHeader title="SLA" />
      <div className="px-5 py-5">
        {done ? (
          <p className="text-sm text-slate-600">
            {complaint.status === 'CLOSED'
              ? `Closed ${formatDateTime(complaint.closedAt)}`
              : 'Cancelled — SLA no longer tracked'}
          </p>
        ) : snapshot?.state === 'PAUSED' ? (
          <p className="text-sm text-slate-600">Paused</p>
        ) : (
          <>
            <p
              className={cn(
                'flex items-center gap-2 text-lg font-semibold',
                breached ? 'text-red-600' : 'text-slate-900',
              )}
            >
              {breached ? <AlertTriangle className="size-5" /> : <Clock className="size-5 text-slate-400" />}
              {formatDuration(remaining)}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Resolution due {formatDateTime(snapshot?.resolutionDueAt ?? complaint.sla.resolutionDueAt)}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

/* ---- Customer and product ---------------------------------------------- */

export function CustomerCard({ complaint, children }: { complaint: Complaint; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader title="Customer" />
      <dl className="space-y-4 px-5 py-5">
        <Detail label="Name">
          <span className="flex items-center gap-2">
            <User className="size-4 text-slate-400" />
            {complaint.customerSnapshot.name}
          </span>
        </Detail>
        <Detail label="Mobile">
          <span className="tabular font-medium">{formatMobile(complaint.customerSnapshot.mobile)}</span>
          <ContactButtons
            mobile={complaint.customerSnapshot.mobile}
            name={complaint.customerSnapshot.name}
            className="mt-2"
          />
        </Detail>
        <Detail label="Service address">
          <span className="flex gap-2">
            <MapPin className="mt-0.5 size-4 shrink-0 text-slate-400" />
            <span>
              {complaint.serviceAddress.address}
              <br />
              {complaint.serviceAddress.cityName}, {complaint.serviceAddress.state}{' '}
              {complaint.serviceAddress.pincode}
            </span>
          </span>
        </Detail>
        {children}
      </dl>
    </Card>
  );
}

/** `listPath` is the portal's complaint list, searched for this serial number. */
export function ProductCard({ complaint, listPath }: { complaint: Complaint; listPath: string }) {
  return (
    <Card>
      <CardHeader title="Product" />
      <dl className="grid grid-cols-2 gap-4 px-5 py-5">
        <Detail label="Product" className="col-span-2">
          <span className="flex items-center gap-2">
            <Package className="size-4 text-slate-400" />
            {complaint.productSnapshot.productName}
          </span>
        </Detail>
        <Detail label="Model">{complaint.productSnapshot.modelNumber}</Detail>
        <Detail label="Serial no.">
          <Link
            to={`${listPath}?search=${encodeURIComponent(complaint.serialNumber)}`}
            className="tabular text-brand-700 hover:underline"
            title="Other complaints for this unit"
          >
            {complaint.serialNumber}
          </Link>
        </Detail>
        <Detail label="Warranty">{WARRANTY_LABEL[complaint.warrantyStatus]}</Detail>
        <Detail label="Purchased">{formatDate(complaint.purchaseDate)}</Detail>
        <WarrantyPeriodDetail complaint={complaint} />
      </dl>
    </Card>
  );
}

/**
 * What the purchase date says about the warranty (DECISIONS.md section 32).
 *
 * Read from the dates, and shown beside the warranty the complaint was raised
 * with: `warrantyStatus` is Admin's decision for this job (spec section 12)
 * and stays what billing follows. When the two disagree — a unit bought
 * fourteen months ago but taken in warranty as a goodwill repair — the card
 * says so rather than quietly preferring one of them.
 */
function WarrantyPeriodDetail({ complaint }: { complaint: Complaint }) {
  const period = warrantyPeriod(complaint.purchaseDate, complaint.productSnapshot.warrantyMonths);

  if (!period) {
    return (
      <Detail label="Warranty period" className="col-span-2">
        <span className="text-slate-500">No purchase date recorded, so it cannot be worked out.</span>
      </Detail>
    );
  }

  const recordedInWarranty = complaint.warrantyStatus === 'IN_WARRANTY';

  return (
    <Detail label="Warranty period" className="col-span-2">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 font-medium',
          period.inWarranty ? 'text-emerald-700' : 'text-slate-700',
        )}
      >
        <ShieldCheck className={cn('size-4', period.inWarranty ? 'text-emerald-600' : 'text-slate-400')} aria-hidden />
        {period.inWarranty ? `In warranty · ${period.text}` : `Out of warranty · ${period.text}`}
      </span>
      <p className="mt-0.5 text-xs text-slate-500">
        {period.months} {period.months === 1 ? 'month' : 'months'} from purchase
        {period.inWarranty && `, ends ${formatDate(period.endsAt)}`}
      </p>
      {period.inWarranty !== recordedInWarranty && (
        <p className="mt-1 text-xs text-amber-700">
          This complaint was raised as {(WARRANTY_LABEL[complaint.warrantyStatus] ?? 'recorded').toLowerCase()}, which
          is what applies to the job.
        </p>
      )}
    </Detail>
  );
}

/* ---- Description ------------------------------------------------------- */

export function DescriptionCard({ complaint }: { complaint: Complaint }) {
  return (
    <Card>
      <CardHeader title="Complaint" />
      <div className="px-5 py-5">
        <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">
          {complaint.description}
        </p>

        {complaint.resolutionReview?.outcome === 'REVISIT_REQUIRED' && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <p className="font-medium">Sent back for a revisit</p>
            {complaint.resolutionReview.rejectionReason && (
              <p className="mt-0.5">{complaint.resolutionReview.rejectionReason}</p>
            )}
          </div>
        )}

        {complaint.cancellationReason && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <p className="font-medium">Cancelled</p>
            <p className="mt-0.5">{complaint.cancellationReason}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---- Timeline (section 17) --------------------------------------------- */

export function useTimeline(id: string) {
  return useQuery({
    queryKey: ['timeline', id],
    queryFn: () =>
      api<{ items: TimelineEntry[]; total: number }>(`/complaints/${id}/timeline`),
  });
}

/**
 * The complaint's story, oldest first.
 *
 * Status changes are folded into the action that caused them. The server
 * records both so the audit trail is complete, but showing "Technician
 * assigned" and then "Status changed to Technician assigned" one after the
 * other would double the timeline for no information. A status change with no
 * action of its own — work resuming once parts arrive — is kept; hiding every
 * status change used to drop it from the story entirely.
 */
export function Timeline({ complaintId }: { complaintId: string }) {
  const { data, error, refetch } = useTimeline(complaintId);

  const entries = foldStatusChanges(data?.items ?? []);

  return (
    <Card>
      <CardHeader
        title="Timeline"
        description={data ? `${entries.length} events` : undefined}
      />
      <div className="px-5 py-5">
        {!data && !error ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : error && !data ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : entries.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing recorded yet.</p>
        ) : (
          <ol className="relative">
            {entries.map((entry, index) => {
              const last = index === entries.length - 1;
              const statusMeta =
                entry.newValue && entry.fieldChanged === 'status'
                  ? STATUS_META[entry.newValue as ComplaintStatus]
                  : undefined;

              return (
                <li key={entry.id} className="relative flex gap-4 pb-6 last:pb-0">
                  {!last && (
                    <span
                      className="absolute left-[7px] top-5 h-full w-px bg-slate-200"
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      'relative mt-1 size-[15px] shrink-0 rounded-full border-[3px] border-white ring-1 ring-slate-200',
                      statusMeta?.dot ?? 'bg-slate-300',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="text-sm font-medium text-slate-900">{activityLabel(entry)}</p>
                      <time
                        dateTime={entry.at}
                        title={formatDateTime(entry.at)}
                        className="text-xs text-slate-500"
                      >
                        {formatDateTime(entry.at)}
                      </time>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {entry.actorName} · {ROLE_LABEL[entry.actorRole] ?? humanize(entry.actorRole)}
                    </p>
                    <ChangeLine entry={entry} />
                    {entry.note && <p className="mt-1.5 text-sm text-slate-700">{readableNote(entry.note)}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
}

/** Changes the timeline spells out; a status change already shows as its dot. */
const SPELLED_OUT = new Set(['technicianId', 'serviceCenterId', 'scheduledAt', 'serviceRating.stars']);

/**
 * "From Field Technician to Second Tech" — what a change moved from and to.
 *
 * `always` also spells out status changes, for lists with no status dot.
 */
export function ChangeLine({
  entry,
  always = false,
}: {
  entry: Pick<TimelineEntry, 'fieldChanged' | 'oldValue' | 'newValue'>;
  always?: boolean;
}) {
  if (!entry.fieldChanged || (!always && !SPELLED_OUT.has(entry.fieldChanged))) return null;

  const from = activityValue(entry.fieldChanged, entry.oldValue);
  const to = activityValue(entry.fieldChanged, entry.newValue);
  if (!from && !to) return null;

  return (
    <p className="mt-1 text-sm text-slate-600">
      {from ? (
        <>
          From <span className="font-medium text-slate-800">{from}</span> to{' '}
        </>
      ) : (
        'To '
      )}
      <span className="font-medium text-slate-800">{to ?? '—'}</span>
    </p>
  );
}

/* ---- Loading and not found --------------------------------------------- */

export function DetailSkeleton() {
  return (
    <div aria-busy aria-label="Loading complaint">
      <Skeleton className="mb-4 h-4 w-24" />
      <Skeleton className="mb-8 h-8 w-80" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-40 rounded-[var(--radius-card)]" />
          <Skeleton className="h-80 rounded-[var(--radius-card)]" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-28 rounded-[var(--radius-card)]" />
          <Skeleton className="h-56 rounded-[var(--radius-card)]" />
        </div>
      </div>
    </div>
  );
}

/** A 404 here usually means a stale link or another centre's complaint. */
export function ComplaintNotFound({ listPath }: { listPath: string }) {
  return (
    <Card>
      <EmptyState
        title="Complaint not found"
        description="It may have been a mistyped link, or it is not assigned to you."
        action={
          <Link to={listPath} className="text-sm font-medium text-brand-700">
            Back to complaints
          </Link>
        }
      />
    </Card>
  );
}
