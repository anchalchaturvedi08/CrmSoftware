/**
 * Profile (spec section 4, Service Center navigation).
 *
 * Who is signed in and the centre they run, with password change and sign-out.
 * The centre's details are Admin's to edit (section 3.1), so they are shown
 * here read-only rather than as a form that would be refused.
 */
import { Building2, KeyRound, LogOut, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useMyCenter } from '@/components/layout/CenterLayout';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, Detail, PageHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/States';
import { useAuth } from '@/lib/auth';
import { formatMobile } from '@/lib/format';

export function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const centre = useMyCenter();

  if (!user) return null;

  return (
    <>
      <PageHeader title="Profile" />

      <div className="grid max-w-4xl gap-6 md:grid-cols-2">
        <Card>
          <CardHeader title="You" />
          <dl className="space-y-4 px-5 py-5">
            <Detail label="Name">
              <span className="flex items-center gap-2">
                <UserRound className="size-4 text-slate-400" />
                {user.name}
              </span>
            </Detail>
            <Detail label="Mobile (your sign-in)">
              <span className="tabular">{formatMobile(user.mobile)}</span>
            </Detail>
            <Detail label="Role">Service Center Owner</Detail>
          </dl>
          <div className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-4">
            <Button
              variant="secondary"
              icon={<KeyRound className="size-4" />}
              onClick={() => navigate('/center/profile/password')}
            >
              Change password
            </Button>
            <Button
              variant="ghost"
              icon={<LogOut className="size-4" />}
              onClick={() => {
                logout();
                navigate('/login', { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Your service center" description="Changes to these details go through Admin." />
          <dl className="space-y-4 px-5 py-5">
            {!centre.data && !centre.error ? (
              <>
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </>
            ) : centre.data ? (
              <>
                <Detail label="Name">
                  <span className="flex items-center gap-2">
                    <Building2 className="size-4 text-slate-400" />
                    {centre.data.name}
                    <span className="text-xs text-slate-500">{centre.data.code}</span>
                  </span>
                </Detail>
                <Detail label="Phone">
                  <span className="tabular">{formatMobile(centre.data.mobile)}</span>
                </Detail>
                <Detail label="Address">
                  {centre.data.address}, {centre.data.pincode}
                </Detail>
              </>
            ) : (
              <p className="text-sm text-slate-500">Details unavailable.</p>
            )}
          </dl>
        </Card>
      </div>
    </>
  );
}
