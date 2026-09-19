/**
 * SLA settings (spec section 14).
 *
 * Section 14 makes the windows configuration, not constants: how long to the
 * first visit (response) and to closure (resolution) for each priority, and
 * whether waiting for parts or a revisit pauses the clock.
 *
 * ## Changes are not retroactive
 *
 * A complaint keeps the deadlines it was given when it was created
 * (DECISIONS.md section 18) — tightening the policy must not breach work that
 * was on time under the old one. The page says so where the change is made,
 * because the obvious assumption is the opposite.
 *
 * Pausing ships off (DECISIONS.md section 5.4): a paused clock improves the
 * breach figures without improving any service, so switching it on is worth a
 * sentence of warning.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { Info, Pencil } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RecordsTable, TH, useFieldErrors, useRefreshRecords } from '@/components/records/Records';
import { PriorityBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Field';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { SlaRule } from '@/lib/types';

/** 2 -> "2 hours", 48 -> "2 days", 36 -> "1 day 12 hours". */
function duration(hours: number): string {
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  const rest = Math.round((hours - days * 24) * 100) / 100;
  const dayText = `${days} ${days === 1 ? 'day' : 'days'}`;
  return rest > 0 ? `${dayText} ${rest} ${rest === 1 ? 'hour' : 'hours'}` : dayText;
}

export function SlaPage() {
  const [editing, setEditing] = useState<SlaRule | null>(null);

  const rules = useQuery({
    queryKey: ['sla-rules'],
    queryFn: () => api<{ items: SlaRule[] }>('/sla-rules'),
  });

  return (
    <>
      <PageHeader title="SLA" description="How quickly complaints must be attended to and resolved, by priority." />

      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          New time limits apply to complaints created <strong>after</strong> you save, and to a complaint when it is
          reopened. Existing complaints keep the deadlines they were given, so a stricter rule never makes past work
          late. Pause settings are different: they take effect the next time any open complaint goes on hold for parts
          or is sent back.
        </span>
      </div>

      <Card className="overflow-hidden">
        {rules.error && !rules.data ? (
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
        ) : !rules.data ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <RecordsTable minWidth={820}>
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <th scope="col" className={TH}>Priority</th>
                <th scope="col" className={TH}>First visit within</th>
                <th scope="col" className={TH}>Resolved within</th>
                <th scope="col" className={TH}>Clock pauses for</th>
                <th scope="col" className={TH}>Last changed</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.data.items.map((rule) => {
                const pauses = [
                  rule.pauseOnWaitingParts && 'Waiting for parts',
                  rule.pauseOnRevisitRequired && 'Revisit required',
                ].filter(Boolean);
                return (
                  <tr key={rule.id}>
                    <td className="px-5 py-3.5">
                      <PriorityBadge priority={rule.priority} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 font-medium text-slate-900">{duration(rule.responseHours)}</td>
                    <td className="whitespace-nowrap px-5 py-3.5 font-medium text-slate-900">{duration(rule.resolutionHours)}</td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-700">
                      {pauses.length > 0 ? pauses.join(', ') : <span className="text-slate-400">Never</span>}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-500">{formatDate(rule.updatedAt)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(rule)}>
                          Edit
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </RecordsTable>
        )}
      </Card>

      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RuleDialog({ rule, onClose }: { rule: SlaRule; onClose: () => void }) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();
  const [response, setResponse] = useState(String(rule.responseHours));
  const [resolution, setResolution] = useState(String(rule.resolutionHours));
  const [pauseParts, setPauseParts] = useState(rule.pauseOnWaitingParts);
  const [pauseRevisit, setPauseRevisit] = useState(rule.pauseOnRevisitRequired);
  const [notes, setNotes] = useState(rule.notes ?? '');

  const save = useMutation({
    mutationFn: (hours: { responseHours: number; resolutionHours: number }) =>
      api(`/sla-rules/${rule.priority}`, {
        method: 'PATCH',
        body: {
          ...hours,
          pauseOnWaitingParts: pauseParts,
          pauseOnRevisitRequired: pauseRevisit,
          ...(notes.trim() !== (rule.notes ?? '') ? { notes: notes.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      toast.success('SLA updated for new complaints');
      onClose();
      await refresh();
    },
    onError: fromError,
  });

  const submit = () => {
    const responseHours = Number(response);
    const resolutionHours = Number(resolution);
    const found: Record<string, string> = {};
    if (!(responseHours > 0 && responseHours <= 720)) found['responseHours'] = 'Between 0 and 720 hours';
    if (!(resolutionHours > 0 && resolutionHours <= 2160)) found['resolutionHours'] = 'Between 0 and 2160 hours';
    if (!found['responseHours'] && !found['resolutionHours'] && resolutionHours < responseHours) {
      found['resolutionHours'] = 'Cannot be shorter than the time to the first visit';
    }
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate({ responseHours, resolutionHours });
  };

  const turningOnPause = (pauseParts && !rule.pauseOnWaitingParts) || (pauseRevisit && !rule.pauseOnRevisitRequired);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Edit ${rule.priority.toLowerCase()} priority`}
      description="Applies to complaints created after you save."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="First visit within (hours)"
            inputMode="decimal"
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            error={errors['responseHours']}
            required
            autoFocus
          />
          <Input
            label="Resolved within (hours)"
            inputMode="decimal"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            error={errors['resolutionHours']}
            required
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-slate-700">Pause the clock while</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={pauseParts} onChange={(e) => setPauseParts(e.target.checked)} className="size-4 rounded accent-brand-700" />
            Waiting for parts
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={pauseRevisit} onChange={(e) => setPauseRevisit(e.target.checked)} className="size-4 rounded accent-brand-700" />
            Revisit required
          </label>
          {turningOnPause && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              A paused clock makes the breach figures look better without the customer waiting any less. Switch it on
              only if that time genuinely should not count.
            </p>
          )}
        </fieldset>

        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors['notes']} className="min-h-[64px]" />
      </div>
    </Dialog>
  );
}
