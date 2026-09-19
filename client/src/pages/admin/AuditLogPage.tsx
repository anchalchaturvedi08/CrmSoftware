/**
 * Audit Log (spec sections 3.1 and 17): who did what, and when.
 *
 * Two views of two records, because they answer different questions:
 *
 *  - **Complaint activity** — every complaint's timeline, newest first:
 *    "who assigned this, who closed that, what happened this morning".
 *  - **System & sign-ins** — accounts, records, stock, SLA settings, Happy
 *    Code views and sign-ins: "who changed that centre's details, who has been
 *    failing to sign in".
 *
 * Nothing here can be edited or deleted; the server has no route for it.
 * Session renewals are recorded but left out — every open screen renews its
 * session every few minutes, and they would bury everything else.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { ChevronLeft, ChevronRight, History, Search, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChangeLine } from '@/components/complaint/ComplaintCards';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import {
  ACTIVITY_GROUPS,
  ENTITY_LABEL,
  ROLE_LABEL,
  SYSTEM_CATEGORIES,
  activityLabel,
  fieldLabel,
  foldStatusChanges,
  readableNote,
  systemLabel,
  systemValue,
} from '@/lib/activity';
import { cn, fromNow, humanize } from '@/lib/format';
import type { ActivityEntry, AuditEntry, Paged, User } from '@/lib/types';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

function rangeStart(range: RangeKey): string | undefined {
  const today = dayjs().startOf('day');
  switch (range) {
    case 'today':
      return today.toISOString();
    case '7d':
      return today.subtract(6, 'day').toISOString();
    case '30d':
      return today.subtract(29, 'day').toISOString();
    case '90d':
      return today.subtract(89, 'day').toISOString();
    case 'all':
      return undefined;
  }
}

const SELECT =
  'h-9 max-w-[260px] rounded-lg border-0 bg-white pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600';

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'system' ? 'system' : 'activity';
  const range = (RANGES.find((r) => r.key === params.get('range'))?.key ?? '7d') as RangeKey;
  const actorId = params.get('actorId') ?? '';
  const group = params.get('group') ?? '';
  const category = params.get('category') ?? '';
  const complaintNumber = params.get('complaint') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  /** Applies changes; any filter change starts again from the first page. */
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  const people = useQuery({
    queryKey: ['users', 'audit-people'],
    queryFn: () => api<Paged<User>>('/users', { query: { limit: 100, includeInactive: true } }),
    staleTime: 60_000,
  });

  const from = rangeStart(range);
  const common = { page, limit: PAGE_SIZE, ...(from ? { from } : {}), ...(actorId ? { actorId } : {}) };

  const activity = useQuery({
    queryKey: ['audit', 'activity', common, group, complaintNumber],
    queryFn: () =>
      api<Paged<ActivityEntry>>('/audit/activity', {
        query: {
          ...common,
          ...(group ? { action: ACTIVITY_GROUPS.find((g) => g.key === group)?.actions.join(',') } : {}),
          ...(complaintNumber ? { complaintNumber } : {}),
        },
      }),
    enabled: view === 'activity',
    placeholderData: keepPreviousData,
  });

  const system = useQuery({
    queryKey: ['audit', 'system', common, category],
    queryFn: () => api<Paged<AuditEntry>>('/audit', { query: { ...common, ...(category ? { category } : {}) } }),
    enabled: view === 'system',
    placeholderData: keepPreviousData,
  });

  const current = view === 'activity' ? activity : system;
  const data = current.data;
  const filtered = Boolean(actorId || (view === 'activity' ? group || complaintNumber : category));

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Who did what, and when. Nothing here can be edited or deleted."
      />

      <div className="mb-5 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-slate-200" role="tablist" aria-label="Log">
        {(
          [
            ['activity', 'Complaint activity'],
            ['system', 'System & sign-ins'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            /* Each view has its own filters; the dates and person carry over. */
            onClick={() => update({ view: key === 'activity' ? '' : key, group: '', category: '', complaint: '' })}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
              view === key ? 'border-brand-600 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* One filter row. */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <select
          value={range}
          onChange={(event) => update({ range: event.target.value === '7d' ? '' : event.target.value })}
          aria-label="Dates"
          className={SELECT}
        >
          {RANGES.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={actorId}
          onChange={(event) => update({ actorId: event.target.value })}
          aria-label="Person"
          className={SELECT}
        >
          <option value="">Everyone</option>
          {(['ADMIN', 'SERVICE_CENTER_OWNER', 'TECHNICIAN'] as const).map((role) => {
            const inRole = (people.data?.items ?? [])
              .filter((person) => person.role === role)
              .sort((a, b) => a.name.localeCompare(b.name));
            return inRole.length === 0 ? null : (
              <optgroup key={role} label={`${ROLE_LABEL[role]}s`}>
                {inRole.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                    {person.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        {view === 'activity' ? (
          <>
            <select
              value={group}
              onChange={(event) => update({ group: event.target.value })}
              aria-label="What happened"
              className={SELECT}
            >
              <option value="">Everything</option>
              {ACTIVITY_GROUPS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <ComplaintNumberSearch value={complaintNumber} onSearch={(value) => update({ complaint: value })} />
          </>
        ) : (
          <select
            value={category}
            onChange={(event) => update({ category: event.target.value })}
            aria-label="What happened"
            className={SELECT}
          >
            <option value="">Everything</option>
            {SYSTEM_CATEGORIES.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        )}

        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => update({ actorId: '', group: '', category: '', complaint: '' })}
          >
            Clear filters
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        {current.error && !data ? (
          <ErrorState error={current.error} onRetry={() => void current.refetch()} />
        ) : !data ? (
          <div className="space-y-3 p-5" aria-busy aria-label="Loading the log">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <EmptyState
            icon={<History className="size-5" />}
            title="Nothing recorded"
            description={
              filtered ? 'Nothing matches these filters in these dates.' : 'Nothing was recorded in these dates.'
            }
          />
        ) : (
          <div className={cn('transition-opacity', current.isFetching && 'opacity-60')}>
            <ul className="divide-y divide-slate-100">
              {view === 'activity'
                ? foldStatusChanges((data as Paged<ActivityEntry>).items).map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))
                : (data as Paged<AuditEntry>).items.map((entry) => <SystemRow key={entry.id} entry={entry} />)}
            </ul>
          </div>
        )}

        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-sm">
            <span className="text-slate-500">
              {data.total.toLocaleString('en-IN')} {data.total === 1 ? 'entry' : 'entries'}
              {data.totalPages > 1 && ` · page ${data.page} of ${data.totalPages}`}
            </span>
            {data.totalPages > 1 && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ChevronLeft className="size-4" />}
                  disabled={page <= 1}
                  onClick={() => update({ page: String(page - 1) })}
                >
                  Newer
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => update({ page: String(page + 1) })}
                >
                  Older
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}

/* ---- Filters ------------------------------------------------------------ */

function ComplaintNumberSearch({ value, onSearch }: { value: string; onSearch: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(draft.trim().toUpperCase());
  };

  return (
    <form onSubmit={submit} role="search" className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Complaint no., then Enter"
        aria-label="Complaint number"
        className="h-9 w-56 rounded-lg border-0 bg-white pl-9 pr-8 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
      />
      {value && (
        <button
          type="button"
          onClick={() => onSearch('')}
          aria-label="Clear complaint number"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
        >
          <X className="size-4" />
        </button>
      )}
    </form>
  );
}

/* ---- Rows --------------------------------------------------------------- */

function Row({
  at,
  who,
  role,
  children,
}: {
  at: string;
  who: string;
  role?: string | undefined;
  children: ReactNode;
}) {
  return (
    <li className="grid gap-x-5 gap-y-1 px-5 py-3.5 sm:grid-cols-[132px_minmax(0,1fr)_180px]">
      <div className="text-sm">
        <time dateTime={at} className="tabular block text-slate-900">
          {dayjs(at).format('D MMM, h:mm A')}
        </time>
        <span className="text-xs text-slate-500">{fromNow(at)}</span>
      </div>
      <div className="min-w-0">{children}</div>
      <div className="text-sm sm:text-right">
        <p className="truncate text-slate-800">{who}</p>
        {role && <p className="text-xs text-slate-500">{ROLE_LABEL[role] ?? humanize(role)}</p>}
      </div>
    </li>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <Row at={entry.at} who={entry.actorName} role={entry.actorRole}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-slate-900">{activityLabel(entry)}</span>
        {entry.complaint ? (
          <Link
            to={`/admin/complaints/${entry.complaint.id}`}
            className="tabular text-brand-700 hover:underline"
          >
            {entry.complaint.complaintNumber}
          </Link>
        ) : (
          <span className="text-slate-500">Complaint unavailable</span>
        )}
      </p>
      <ChangeLine entry={entry} always />
      {entry.note && <p className="mt-1 break-words text-sm text-slate-600">{readableNote(entry.note)}</p>}
    </Row>
  );
}

function SystemRow({ entry }: { entry: AuditEntry }) {
  /* A failed sign-in has no actor yet; the account it was for says who. */
  const signIn = /^LOGIN_|^PASSWORD_CHANGE/.test(entry.action);
  const who =
    entry.actorName ?? (signIn && entry.entityType === 'User' && entry.entityName ? entry.entityName : 'Unknown');

  const subject =
    entry.entityName && !(signIn && !entry.actorName)
      ? entry.entityName
      : undefined;

  return (
    <Row at={entry.at} who={who} role={entry.actorRole}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span
          className={cn(
            'font-medium',
            /FAILED|BLOCKED/.test(entry.action) ? 'text-red-700' : 'text-slate-900',
          )}
        >
          {systemLabel(entry)}
        </span>
        {subject && subject !== who && (
          <span className="text-slate-600">
            {subject}
            {entry.entityType !== 'User' && (
              <span className="text-slate-400"> · {ENTITY_LABEL[entry.entityType] ?? humanize(entry.entityType)}</span>
            )}
          </span>
        )}
      </p>

      {entry.changes.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
          {entry.changes.map((change) => {
            const before = systemValue(change.field, change.oldValue);
            const after = systemValue(change.field, change.newValue);
            return (
              <li key={change.field} className="break-words">
                <span className="text-slate-500">{fieldLabel(change.field)}:</span>{' '}
                {before !== undefined && (
                  <>
                    <span className="text-slate-700">{before}</span> →{' '}
                  </>
                )}
                <span className="font-medium text-slate-800">{after ?? '—'}</span>
              </li>
            );
          })}
        </ul>
      )}

      {entry.note && <p className="mt-1 break-words text-sm text-slate-600">{readableNote(entry.note)}</p>}
      {signIn && entry.ipAddress && (
        /* `::ffff:` is how an IPv4 address looks through an IPv6 socket. */
        <p className="mt-0.5 text-xs text-slate-400">From {entry.ipAddress.replace(/^::ffff:/, '')}</p>
      )}
    </Row>
  );
}
