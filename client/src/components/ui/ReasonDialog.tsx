/**
 * Asks for a written reason before an action.
 *
 * Section 17 wants the timeline to record *why*, and the server refuses a
 * reason that is blank or a stray keystroke (three characters minimum), so the
 * confirm button stays disabled until there is something to record.
 */
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Textarea } from './Field';

export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  label = 'Reason',
  placeholder,
  confirmLabel,
  tone = 'primary',
  optional = false,
  children,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  label?: string;
  placeholder?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** When true the action may go ahead without a reason. */
  optional?: boolean;
  /** Extra fields rendered above the reason. */
  children?: ReactNode;
  /** Resolve to close; throw to keep the dialog open (the error is shown). */
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setReason('');
    setError(undefined);
    onClose();
  };

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(reason.trim());
      close();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.issueFor('reason') ?? err.issueFor('remarks') ?? err.message)
          : err instanceof Error
            ? err.message
            : 'Something went wrong',
      );
    } finally {
      setBusy(false);
    }
  };

  const tooShort = !optional && reason.trim().length < 3;

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Back
          </Button>
          <Button variant={tone} disabled={tooShort} loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        <Textarea
          label={optional ? `${label} (optional)` : label}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(undefined);
          }}
          placeholder={placeholder}
          error={error}
          hint={optional ? 'Recorded on the complaint timeline.' : 'Required. Recorded on the complaint timeline.'}
          required={!optional}
          autoFocus
        />
      </div>
    </Dialog>
  );
}
