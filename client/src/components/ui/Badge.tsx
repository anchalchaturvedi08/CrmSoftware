import type { ReactNode } from 'react';
import {
  cn,
  PRIORITY_META,
  STATUS_META,
  type ComplaintStatus,
  type Priority,
} from '@/lib/format';

export function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5',
        'text-xs font-medium ring-1 ring-inset',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as ComplaintStatus];
  if (!meta) return <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20">{status}</Badge>;

  return (
    <Badge className={meta.className}>
      <span className={cn('size-1.5 rounded-full', meta.dot)} aria-hidden />
      {meta.label}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: string }) {
  const meta = PRIORITY_META[priority as Priority];
  if (!meta) return <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20">{priority}</Badge>;
  return <Badge className={meta.className}>{meta.label}</Badge>;
}
