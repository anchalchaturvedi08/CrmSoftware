/**
 * Sign-in, shared by all three roles.
 *
 * Every role authenticates the same way (Mobile + Password), so there is one
 * page and the role decides where you land afterwards.
 */
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      const signedIn = await login(mobile, password);
      navigate(homeFor(signedIn.role), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        /* Field-level issues go beside their inputs; everything else (wrong
           credentials, a locked account) is shown once, above the form. */
        if (err.issues.length > 0) {
          setFieldErrors(Object.fromEntries(err.issues.map((i) => [i.field, i.message])));
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not reach the server. Check that it is running.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full">
      {/* Brand panel, desktop only. */}
      <div className="relative hidden w-[44%] overflow-hidden bg-sidebar lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(20,184,166,0.28),transparent_55%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(13,148,136,0.18),transparent_50%)]" />

        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <ShieldCheck className="size-5" />
            </div>
            <span className="text-lg font-semibold text-white">Cooler CRM</span>
          </div>

          <div>
            <h1 className="max-w-md text-4xl font-semibold leading-tight tracking-tight text-white">
              Every service call, from complaint to closure.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-slate-400">
              Assign service centres, dispatch technicians, track parts and confirm
              every closure with the customer.
            </p>
          </div>

          <p className="text-sm text-slate-500">After-sales service management</p>
        </div>
      </div>

      {/* Form. */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <ShieldCheck className="size-5" />
            </div>
            <span className="text-lg font-semibold">Cooler CRM</span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
          <p className="mt-1.5 text-sm text-slate-500">
            Use the mobile number registered to your account.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-5" noValidate>
            <Input
              label="Mobile number"
              type="tel"
              inputMode="numeric"
              autoComplete="username"
              placeholder="98765 43210"
              value={mobile}
              onChange={(event) => setMobile(event.target.value)}
              error={fieldErrors['mobile']}
              required
              autoFocus
            />

            <div className="relative">
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                error={fieldErrors['password']}
                className="pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((shown) => !shown)}
                className="absolute right-2.5 top-[34px] rounded p-1 text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>

            <Button type="submit" size="lg" className="w-full" loading={submitting}>
              Sign in
            </Button>
          </form>

          <div className="mt-8 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Demo Accounts
            </p>
            <div className="mt-3 space-y-2">
              {([
                { label: 'Admin', mobile: '9800000001', password: 'DemoAccess@123' },
                { label: 'Service Center', mobile: '9800000002', password: 'DemoAccess@123' },
                { label: 'Technician', mobile: '9800000003', password: 'DemoAccess@123' },
              ] as const).map((demo) => (
                <button
                  key={demo.mobile}
                  type="button"
                  onClick={() => { setMobile(demo.mobile); setPassword(demo.password); setError(null); setFieldErrors({}); }}
                  className="flex w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <span className="font-medium text-slate-700">{demo.label}</span>
                  <span className="font-mono text-xs text-slate-400">{demo.mobile}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-center text-xs text-slate-400">
              Click a role to auto-fill credentials
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
