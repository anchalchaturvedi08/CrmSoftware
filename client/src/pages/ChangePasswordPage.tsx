/**
 * Change password — both the forced first-login step and the voluntary one.
 *
 * An Owner creates a technician with a temporary password, and the server
 * refuses every request except this one until it is replaced
 * (DECISIONS.md section 4.5). Without this screen as a gate, a brand-new
 * technician would sign in and see nothing but permission errors, with no way
 * to find out why.
 *
 * Changing a password revokes every existing session on the server, including
 * the one making the request. So success signs the user out and asks them to
 * sign in with the new password, rather than pretending they are still in.
 */
import { CheckCircle2, KeyRound, LogOut } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const MIN_LENGTH = 12;

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};

    if (!current) found['currentPassword'] = 'Enter your current password';
    /* Length-led, matching the server's policy — see auth.validation.ts. */
    if (next.length < MIN_LENGTH) {
      found['newPassword'] = `Use at least ${MIN_LENGTH} characters`;
    }
    if (next && next === current) found['newPassword'] = 'Choose a different password';
    if (confirm !== next) found['confirm'] = 'Passwords do not match';

    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.issues.length > 0) {
        setErrors(Object.fromEntries(err.issues.map((i) => [i.field, i.message])));
      } else {
        setErrors({ form: err instanceof Error ? err.message : 'Could not change password' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="size-7" />
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Password changed</h1>
          <p className="mt-2 text-sm text-slate-500">
            For your security you have been signed out everywhere. Sign in again with your new
            password.
          </p>
          <Button
            size="lg"
            className="mt-6 w-full"
            onClick={() => {
              logout();
              navigate('/login', { replace: true });
            }}
          >
            Sign in again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex size-12 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <KeyRound className="size-6" />
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          {forced ? 'Set your own password' : 'Change password'}
        </h1>
        <p className="mt-1.5 text-sm text-slate-500">
          {forced
            ? `Welcome${user ? `, ${user.name}` : ''}. You signed in with a temporary password. Choose your own to continue.`
            : 'You will be signed out on every device afterwards.'}
        </p>

        {errors['form'] && (
          <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errors['form']}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
          <Input
            label={forced ? 'Temporary password' : 'Current password'}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            error={errors['currentPassword']}
            required
            autoFocus
          />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            error={errors['newPassword']}
            hint={`At least ${MIN_LENGTH} characters. A few words together work well.`}
            required
          />
          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={errors['confirm']}
            required
          />

          <Button type="submit" size="lg" className="w-full" loading={submitting}>
            {forced ? 'Save and continue' : 'Change password'}
          </Button>
        </form>

        {forced && (
          <button
            type="button"
            onClick={logout}
            className="mt-6 inline-flex w-full items-center justify-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
