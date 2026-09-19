/**
 * Booking times, and moving or calling off a booked visit (spec section 9).
 *
 * Shared by the Service Center portal and Admin's schedule. The server lets
 * both roles reschedule and cancel — an Owner running their calendar, Admin
 * when a customer rings the helpline — so both screens use these same
 * dialogs, and "reschedule" cannot come to mean two different things.
 */
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/Field';
import { ReasonDialog } from '@/components/ui/ReasonDialog';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/**
 * Refreshes everything a visit change can move: the schedule, the complaint
 * and its timeline (cancelling the only visit changes the status), and the
 * counts on the dashboards and reports.
 */
export function useRefreshVisitWork() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [['visits'], ['visit'], ['complaint'], ['complaints'], ['timeline'], ['dashboard'], ['technicians'], ['report']].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ),
    );
}

/* ---- Date and time ----------------------------------------------------- */

/** `datetime-local` wants local time without a zone: 2026-09-18T10:00. */
export const toLocalInput = (date: Date) => dayjs(date).format('YYYY-MM-DDTHH:mm');

/** A sensible default booking: tomorrow at 10 am. */
export function defaultVisitTime(): string {
  return toLocalInput(dayjs().add(1, 'day').hour(10).minute(0).second(0).toDate());
}

export function VisitTimeField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  error?: string | undefined;
}) {
  return (
    <Input
      type="datetime-local"
      label="Visit date and time"
      value={value}
      min={toLocalInput(new Date())}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      required
    />
  );
}

/* ---- Reschedule and cancel a booked visit ------------------------------ */

export function RescheduleVisitDialog({
  visitId,
  currentAt,
  open,
  onClose,
}: {
  visitId: string;
  currentAt: string;
  open: boolean;
  onClose: () => void;
}) {
  const refresh = useRefreshVisitWork();
  const [when, setWhen] = useState(() => toLocalInput(new Date(currentAt)));
  const [dateError, setDateError] = useState<string | undefined>();

  return (
    <ReasonDialog
      open={open}
      onClose={() => {
        setDateError(undefined);
        onClose();
      }}
      title="Reschedule visit"
      description={`Currently booked for ${formatDateTime(currentAt)}. The technician sees the new time straight away.`}
      label="Reason"
      placeholder="e.g. Customer asked for the afternoon"
      confirmLabel="Reschedule"
      optional
      onConfirm={async (reason) => {
        if (!when || new Date(when).getTime() < Date.now() - 60_000) {
          setDateError('Choose a time in the future');
          throw new Error('Choose a time in the future');
        }
        await api(`/visits/${visitId}/reschedule`, {
          method: 'POST',
          body: { scheduledAt: new Date(when).toISOString(), ...(reason ? { reason } : {}) },
        });
        toast.success(`Visit moved to ${formatDateTime(new Date(when))}`);
        await refresh();
      }}
    >
      <VisitTimeField
        value={when}
        onChange={(next) => {
          setWhen(next);
          setDateError(undefined);
        }}
        error={dateError}
      />
    </ReasonDialog>
  );
}

export function CancelVisitDialog({
  visitId,
  open,
  onClose,
}: {
  visitId: string;
  open: boolean;
  onClose: () => void;
}) {
  const refresh = useRefreshVisitWork();

  return (
    <ReasonDialog
      open={open}
      onClose={onClose}
      title="Cancel visit"
      description="Use this when there is no new date yet. The job goes back to needing a visit, so one can be booked later."
      placeholder="e.g. Customer travelling, will call back"
      confirmLabel="Cancel visit"
      tone="danger"
      onConfirm={async (reason) => {
        await api(`/visits/${visitId}/cancel`, { method: 'POST', body: { reason } });
        toast.success('Visit cancelled');
        await refresh();
      }}
    />
  );
}
