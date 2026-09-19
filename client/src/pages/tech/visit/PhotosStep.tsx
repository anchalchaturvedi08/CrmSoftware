/**
 * Before and after photos (spec section 10, step 6).
 *
 * The file input uses `capture="environment"`, which opens the rear camera
 * directly on a phone instead of a file browser — one tap to a photo rather
 * than three.
 *
 * ## Photos are shrunk on the phone before upload
 *
 * A modern phone photo is 3–8 MB. On a technician's mobile data that is a
 * minute of uploading per photo, and a large one can exceed the server's
 * 10 MB limit outright. Each photo is redrawn at most 1600px on its long edge
 * as a JPEG, typically 300–500 KB — still ample to show a clogged pad or a
 * scorched terminal, and uploaded in seconds.
 *
 * Re-encoding also strips EXIF metadata, which on a phone photo includes the
 * GPS coordinates of the customer's home. That is a side benefit worth having:
 * section 22 rules out location tracking, and a photo quietly carrying it would
 * be tracking by another route.
 *
 * ## Only this visit's photos
 *
 * `/complaints/:id/attachments` returns every photo ever taken on the job, not
 * just this trip's — on a revisit, that used to make an untouched slot read
 * "3 photos saved" from a visit weeks ago. Every attachment carries the visit
 * it was taken on, so the count and the "already saved" state here are
 * filtered to the visit in progress; earlier visits' photos are not shown here
 * at all (they are that visit's history, not this one's).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, ImagePlus, Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/components/ui/States';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import type { Attachment } from '@/lib/types';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/** Downscales and re-encodes a photo as JPEG. Falls back to the original. */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );

    /* Keep whichever is smaller; an already-small image can grow on re-encode. */
    return blob && blob.size < file.size ? blob : file;
  } catch {
    /* A format the browser cannot decode (some HEIC) goes up as-is, and the
       server will say plainly if it cannot accept it. */
    return file;
  }
}

type Kind = 'BEFORE_PHOTO' | 'AFTER_PHOTO';

function PhotoSlot({
  complaintId,
  kind,
  label,
  hint,
  existing,
}: {
  complaintId: string;
  kind: Kind;
  label: string;
  hint: string;
  existing: number;
}) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const shrunk = await shrink(file);
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', shrunk, file.name.replace(/\.\w+$/, '') + '.jpg');
      return api<{ attachment: Attachment; note?: string }>(
        `/complaints/${complaintId}/attachments`,
        { method: 'POST', body: form },
      );
    },
    onSuccess: async (result) => {
      toast.success(result.note ? 'Already uploaded' : `${label} saved`);
      await client.invalidateQueries({ queryKey: ['attachments', complaintId] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      setPreview(null);
    },
  });

  const onPick = (file: File | undefined) => {
    if (!file) return;
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    upload.mutate(file);
  };

  const saved = upload.isSuccess || (existing > 0 && !preview);

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          onPick(event.target.files?.[0]);
          /* Reset, so photographing the same scene twice still fires. */
          event.target.value = '';
        }}
        aria-label={label}
      />

      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={upload.isPending}
        className={cn(
          'relative flex aspect-[4/3] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed text-center transition-colors',
          saved ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-300 bg-white active:bg-slate-50',
        )}
      >
        {preview ? (
          <img src={preview} alt={`${label} preview`} className="absolute inset-0 size-full object-cover" />
        ) : saved ? (
          <>
            <CheckCircle2 className="size-8 text-emerald-600" />
            <span className="mt-2 text-sm font-medium text-emerald-800">
              {existing} {existing === 1 ? 'photo' : 'photos'} saved
            </span>
          </>
        ) : (
          <>
            <Camera className="size-9 text-slate-400" />
            <span className="mt-2 text-base font-semibold text-slate-800">{label}</span>
            <span className="mt-0.5 px-4 text-xs text-slate-500">{hint}</span>
          </>
        )}

        {upload.isPending && (
          <span className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/50 text-white">
            <Loader2 className="size-8 animate-spin" />
            <span className="mt-2 text-sm font-medium">Uploading…</span>
          </span>
        )}
        {upload.isSuccess && preview && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-1 text-xs font-semibold text-white">
            <CheckCircle2 className="size-3.5" />
            Saved
          </span>
        )}
      </button>

      {(saved || preview) && !upload.isPending && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="mt-2 flex w-full items-center justify-center gap-1.5 py-2 text-sm font-medium text-brand-700"
        >
          {saved ? <ImagePlus className="size-4" /> : <RotateCcw className="size-4" />}
          Add another
        </button>
      )}
    </div>
  );
}

export function PhotosStep({
  complaintId,
  visitId,
}: {
  complaintId: string;
  /** The visit in progress. Only its own photos are shown and counted. */
  visitId: string | undefined;
}) {
  const attachments = useQuery({
    queryKey: ['attachments', complaintId],
    queryFn: () => api<{ items: Attachment[] }>(`/complaints/${complaintId}/attachments`),
  });

  const onThisVisit = attachments.data?.items.filter((item) => item.visitId === visitId) ?? [];
  const count = (kind: Kind) => onThisVisit.filter((item) => item.kind === kind).length;

  return (
    <div className="space-y-5">
      <p className="text-[15px] text-slate-600">
        Photos are optional, but they settle disputes. Take one before you start and one when
        you are done.
      </p>
      <PhotoSlot
        complaintId={complaintId}
        kind="BEFORE_PHOTO"
        label="Old Parts"
        hint="The parts before replacement"
        existing={count('BEFORE_PHOTO')}
      />
      <PhotoSlot
        complaintId={complaintId}
        kind="AFTER_PHOTO"
        label="After photo"
        hint="The unit after your work"
        existing={count('AFTER_PHOTO')}
      />
    </div>
  );
}
