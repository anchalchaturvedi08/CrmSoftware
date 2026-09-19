/**
 * The photos a technician took, for whoever is reading the complaint
 * (spec section 10; DECISIONS.md section 31).
 *
 * Shared so Admin and the service center see the same photos in the same way.
 * The Service Center shows them inside the work card of the visit under
 * review; Admin, who reads the whole complaint rather than one visit, gets
 * them as a card of their own.
 *
 * Images are fetched with the session's token (`AuthedImage`) — an attachment
 * is not a public URL, and section 19 scopes who may read one.
 */
import { Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { AuthedImage } from '@/components/ui/AuthedImage';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/States';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, fromNow, humanize } from '@/lib/format';
import type { Attachment } from '@/lib/types';

const kindLabel = (item: Attachment) =>
  item.kind === 'BEFORE_PHOTO' ? 'Old Parts' : humanize(item.kind.replace('_PHOTO', ''));

export function usePhotos(complaintId: string) {
  return useQuery({
    queryKey: ['attachments', complaintId],
    queryFn: () => api<{ items: Attachment[] }>(`/complaints/${complaintId}/attachments`),
  });
}

/**
 * The grid itself, with the full-size viewer.
 *
 * `visitId` narrows it to one visit, which is what a revisit needs: photos
 * from the earlier trip are that trip's record, not this one's.
 */
export function PhotosGrid({
  complaintId,
  visitId,
  emptyText = 'No photos uploaded.',
}: {
  complaintId: string;
  visitId?: string | undefined;
  emptyText?: string;
}) {
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const attachments = usePhotos(complaintId);

  const photos = (attachments.data?.items ?? []).filter(
    (item) => item.mimeType.startsWith('image/') && (!visitId || item.visitId === visitId),
  );

  return (
    <>
      {!attachments.data && !attachments.error ? (
        <Skeleton className="h-24" />
      ) : photos.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <ImageIcon className="size-4" />
          {emptyText}
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setViewing(photo)}
                className="block w-full overflow-hidden rounded-lg ring-1 ring-slate-200 transition hover:ring-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                title={`${kindLabel(photo)} photo — open`}
              >
                <AuthedImage
                  path={`/attachments/${photo.id}/file`}
                  alt={`${kindLabel(photo)} photo`}
                  className="aspect-square w-full"
                />
              </button>
              <p className="mt-1 text-xs text-slate-500">
                {kindLabel(photo)} · {fromNow(photo.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        size="lg"
        title={viewing ? `${kindLabel(viewing)} photo` : ''}
        description={viewing ? `Uploaded ${formatDateTime(viewing.createdAt)}` : undefined}
      >
        {viewing && (
          <AuthedImage
            path={`/attachments/${viewing.id}/file`}
            alt={`${kindLabel(viewing)} photo`}
            className="max-h-[65vh] w-full rounded-lg object-contain"
          />
        )}
      </Dialog>
    </>
  );
}

/** Every photo on the complaint, as its own card. */
export function PhotosCard({ complaintId }: { complaintId: string }) {
  const attachments = usePhotos(complaintId);
  const photos = (attachments.data?.items ?? []).filter((item) => item.mimeType.startsWith('image/'));

  return (
    <Card>
      <CardHeader
        title="Photos"
        description={
          attachments.data
            ? photos.length === 1
              ? '1 photo from the technician'
              : `${photos.length} photos from the technician`
            : 'Taken by the technician on site'
        }
      />
      <div className="px-5 py-5">
        <PhotosGrid complaintId={complaintId} emptyText="The technician has not uploaded any photos yet." />
      </div>
    </Card>
  );
}
