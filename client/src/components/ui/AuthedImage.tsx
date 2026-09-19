/**
 * An image from a protected endpoint.
 *
 * Attachment files require the Authorization header, which a plain
 * `<img src>` cannot send. The file is fetched with the session instead and
 * shown from an object URL, released again when the image leaves the page.
 */
import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchBlob } from '@/lib/api';
import { cn } from '@/lib/format';
import { Skeleton } from './States';

export function AuthedImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    setUrl(null);
    setFailed(false);

    fetchBlob(path, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (failed) {
    return (
      <div
        className={cn('flex items-center justify-center bg-slate-100 text-slate-400', className)}
        role="img"
        aria-label={`${alt} (could not be loaded)`}
      >
        <ImageOff className="size-5" />
      </div>
    );
  }

  if (!url) return <Skeleton className={className} />;

  /* `onError` covers a file that downloads but will not decode — a truncated
     upload, say — which would otherwise show the browser's broken-image icon. */
  return (
    <img src={url} alt={alt} onError={() => setFailed(true)} className={cn('object-cover', className)} />
  );
}
