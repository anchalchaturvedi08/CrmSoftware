/**
 * The technician app's shared queries.
 *
 * The job screen, the visit flow and its steps read the same records. Defining
 * each query once keeps their cache keys in step — so a change on one screen
 * shows on the next — and lets a screen re-ask the server directly with the
 * exact query the others use (`client.fetchQuery`), which is how a lost reply
 * is checked (see `confirmOnServer` in VisitFlowPage).
 */
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { Attachment, ComplaintDetail, Paged, PartUsage, VisitCard } from '@/lib/types';

export const complaintQuery = (complaintId: string) =>
  queryOptions({
    queryKey: ['complaint', complaintId],
    queryFn: () => api<ComplaintDetail>(`/complaints/${complaintId}`),
  });

export const visitsQuery = (complaintId: string) =>
  queryOptions({
    queryKey: ['visits', 'complaint', complaintId],
    queryFn: () =>
      api<Paged<VisitCard>>('/visits', { query: { complaintId, sort: 'desc', limit: 20 } }),
  });

export const partUsageQuery = (complaintId: string) =>
  queryOptions({
    queryKey: ['part-usage', complaintId],
    queryFn: () => api<{ items: PartUsage[] }>(`/complaints/${complaintId}/part-usage`),
  });

export const attachmentsQuery = (complaintId: string) =>
  queryOptions({
    queryKey: ['attachments', complaintId],
    queryFn: () => api<{ items: Attachment[] }>(`/complaints/${complaintId}/attachments`),
  });

/** The newest visit with a given status. Booking times can tie, so by visit number. */
export function newestVisit(
  visits: VisitCard[] | undefined,
  status: VisitCard['status'],
): VisitCard | undefined {
  return (visits ?? [])
    .filter((visit) => visit.status === status)
    .sort((a, b) => b.sequence - a.sequence)[0];
}

/**
 * Whether a failed request was the server saying the job is not this
 * technician's (any more) — the one refusal that should replace a screen
 * already showing the job. Anything else, such as no signal, leaves what was
 * loaded in place.
 */
export function isJobGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
