/**
 * Technicians and users (spec sections 3.1, 9, 25 Phase 2).
 *
 * Section 3.1 lets Admin manage every account; section 3.2 gives Owners their
 * own technicians only (that screen lives in the Service Center portal). So
 * this is the one place to add a Service Center Owner or another Admin — and
 * to give someone a login with their own mobile number.
 *
 * Every new account, and every password reset, gets a temporary password that
 * is shown once and must be replaced at first sign-in (DECISIONS.md section
 * 4.5). Your own account is not reset or deactivated from here: the server
 * refuses both, and change-password is the right door for your own password.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Power, UserCog } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  ActiveBadge,
  ActiveToggleDialog,
  IssuedPasswordDialog,
  RecordsTable,
  RecordsToolbar,
  StrandedWorkDialog,
  TH,
  useFieldErrors,
  useRefreshRecords,
  useServiceCenters,
} from '@/components/records/Records';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton, errorMessage } from '@/components/ui/States';
import { api, ApiError, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, formatMobile, fromNow } from '@/lib/format';
import type { IssuedPassword, Paged, ServiceCenter, StrandedWork, User } from '@/lib/types';

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  SERVICE_CENTER_OWNER: 'Service Center Owner',
  TECHNICIAN: 'Technician',
};

const ROLE_TONE: Record<Role, string> = {
  ADMIN: 'bg-slate-900 text-white ring-slate-900/10',
  SERVICE_CENTER_OWNER: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  TECHNICIAN: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

const TABS: Array<{ key: Role | ''; label: string }> = [
  { key: '', label: 'All' },
  { key: 'TECHNICIAN', label: 'Technicians' },
  { key: 'SERVICE_CENTER_OWNER', label: 'Service Center Owners' },
  { key: 'ADMIN', label: 'Admins' },
];

export function UsersPage() {
  const { user: me } = useAuth();
  const [searchParams] = useSearchParams();
  const [role, setRole] = useState<Role | ''>('');
  /* A service center's own page links here with `?serviceCenterId=`, to open
     this list already narrowed to its people. Read once, as the starting
     value — the select below is what drives it afterwards. */
  const [centreId, setCentreId] = useState(() => searchParams.get('serviceCenterId') ?? '');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const [stranded, setStranded] = useState<{ name: string; items: StrandedWork[] } | null>(null);
  const refresh = useRefreshRecords();

  const centres = useServiceCenters({ includeInactive: true });
  const centreName = (id?: string) => centres.data?.items.find((c) => c.id === id)?.name;

  const users = useQuery({
    queryKey: ['users', { role, centreId, search, showInactive }],
    queryFn: () =>
      api<Paged<User>>('/users', {
        query: {
          role,
          serviceCenterId: centreId,
          search,
          limit: 100,
          ...(showInactive ? { includeInactive: true } : {}),
        },
      }),
  });

  const rows = users.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Technicians & Users"
        description="Everyone who can sign in: Admins, Service Center Owners and technicians."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add user
          </Button>
        }
      />

      <div className="mb-4 flex gap-6 border-b border-slate-200" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key || 'all'}
            type="button"
            role="tab"
            aria-selected={role === tab.key}
            onClick={() => setRole(tab.key)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
              role === tab.key ? 'border-brand-600 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <RecordsToolbar
        search={search}
        onSearch={setSearch}
        placeholder="Search by name or mobile"
        showInactive={showInactive}
        onShowInactive={setShowInactive}
      >
        <select
          value={centreId}
          onChange={(event) => setCentreId(event.target.value)}
          aria-label="Filter by service center"
          className="h-9 rounded-lg border-0 bg-white pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
        >
          <option value="">All service centers</option>
          {(centres.data?.items ?? []).map((centre) => (
            <option key={centre.id} value={centre.id}>
              {centre.name}
            </option>
          ))}
        </select>
      </RecordsToolbar>

      <Card className="overflow-hidden">
        {users.error && !users.data ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : !users.data ? (
          <div className="space-y-2 p-5" aria-busy aria-label="Loading users">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<UserCog className="size-5" />} title="No users match" description="Try another tab or search." />
        ) : (
          <RecordsTable minWidth={1040}>
            <thead className="border-b border-slate-200 bg-slate-50/70">
              <tr>
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={TH}>Role</th>
                <th scope="col" className={TH}>Service center</th>
                <th scope="col" className={TH}>Mobile (sign-in)</th>
                <th scope="col" className={cn(TH, 'text-right')}>Open jobs</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={TH}>Last sign-in</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((user) => {
                const self = user.id === me?.id;
                const userRole = user.role as Role;
                return (
                  <tr key={user.id} className={cn(!user.isActive && 'bg-slate-50/60')}>
                    <td className="whitespace-nowrap px-5 py-3.5">
                      <p className={cn('font-medium', user.isActive ? 'text-slate-900' : 'text-slate-500')}>
                        {user.name}
                        {self && <span className="ml-1.5 text-xs font-normal text-slate-500">(you)</span>}
                      </p>
                      {user.email && <p className="text-xs text-slate-500">{user.email}</p>}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge className={ROLE_TONE[userRole]}>{ROLE_LABEL[userRole] ?? user.role}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-700">
                      {user.serviceCenterId ? centreName(user.serviceCenterId) ?? '—' : <span className="text-slate-400">All (Admin)</span>}
                    </td>
                    <td className="tabular whitespace-nowrap px-5 py-3.5 text-slate-700">{formatMobile(user.mobile)}</td>
                    <td className="tabular px-5 py-3.5 text-right">
                      {user.workload ? (
                        <span className={user.workload.openJobs > 0 ? 'font-medium text-slate-900' : 'text-slate-400'}>
                          {user.workload.openJobs}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1.5">
                        <ActiveBadge active={user.isActive} />
                        {user.isActive && user.mustChangePassword && (
                          <Badge className="bg-amber-50 text-amber-800 ring-amber-600/25">
                            {/* A password reset sets this flag on someone who has
                                signed in plenty of times before — "not signed in
                                yet" next to a real last-sign-in time said otherwise. */}
                            {user.lastLoginAt ? 'Must set a new password' : 'Not signed in yet'}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-slate-500">
                      {user.lastLoginAt ? fromNow(user.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(user)}>
                          Edit
                        </Button>
                        {!self && user.isActive && (
                          <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setResetting(user)}>
                            Reset password
                          </Button>
                        )}
                        {!self && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Power className="size-3.5" />}
                            className={user.isActive ? 'text-red-600 hover:bg-red-50 hover:text-red-700' : ''}
                            onClick={() => setToggling(user)}
                          >
                            {user.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </RecordsTable>
        )}
        {users.data && users.data.total > rows.length && (
          <p className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">
            Showing the first {rows.length} of {users.data.total}. Search or filter to narrow it down.
          </p>
        )}
      </Card>

      {adding && (
        <AddUserDialog
          centres={(centres.data?.items ?? []).filter((c) => c.isActive)}
          defaultRole={role || 'TECHNICIAN'}
          onClose={() => setAdding(false)}
          onCreated={setIssued}
        />
      )}

      {editing && <EditUserDialog user={editing} onClose={() => setEditing(null)} />}

      {toggling && (
        <ActiveToggleDialog
          name={toggling.name}
          active={toggling.isActive}
          consequence={
            toggling.role === 'TECHNICIAN'
              ? 'They can no longer sign in or be given jobs. Their open jobs will need another technician.'
              : 'They can no longer sign in.'
          }
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            const result = await api<{ openJobsNeedingReassignment?: StrandedWork[] }>(`/users/${toggling.id}`, {
              method: 'PATCH',
              body: { isActive: !toggling.isActive },
            });
            toast.success(toggling.isActive ? `${toggling.name} deactivated` : `${toggling.name} can sign in again`);
            if (result.openJobsNeedingReassignment?.length) {
              setStranded({ name: toggling.name, items: result.openJobsNeedingReassignment });
            }
            await refresh();
          }}
        />
      )}

      {resetting && (
        <Dialog
          open
          onClose={() => setResetting(null)}
          size="sm"
          title={`Reset password for ${resetting.name}?`}
          description="For when they have forgotten it. They are signed out everywhere, and choose a new password the next time they sign in."
          footer={
            <>
              <Button variant="secondary" onClick={() => setResetting(null)}>
                Cancel
              </Button>
              <ResetButton user={resetting} onDone={(result) => {
                setResetting(null);
                setIssued(result);
              }} />
            </>
          }
        >
          <p className="text-sm text-slate-600">A new temporary password is shown once, for you to give them.</p>
        </Dialog>
      )}

      {issued && <IssuedPasswordDialog issued={issued} onClose={() => setIssued(null)} />}

      {stranded && (
        <StrandedWorkDialog
          title="Reassign these jobs"
          description={`${stranded.name} is deactivated but still has ${stranded.items.length} open ${
            stranded.items.length === 1 ? 'job' : 'jobs'
          }. Their service center needs to give each one to another technician.`}
          items={stranded.items}
          linkBase="/admin/complaints"
          /* Admin cannot give a job to another technician — only the centre's
             Owner can — so the links open the complaint rather than promising
             a "Reassign" Admin has no button for. */
          assignable={false}
          onClose={() => setStranded(null)}
        />
      )}
    </>
  );
}

function ResetButton({ user, onDone }: { user: User; onDone: (issued: IssuedPassword) => void }) {
  const refresh = useRefreshRecords();
  const reset = useMutation({
    mutationFn: () => api<IssuedPassword>(`/users/${user.id}/reset-password`, { method: 'POST', body: {} }),
    onSuccess: async (result) => {
      onDone(result);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Button loading={reset.isPending} onClick={() => reset.mutate()}>
      Reset password
    </Button>
  );
}

/* ---- Add ---------------------------------------------------------------- */

const MOBILE = /^[6-9]\d{9}$/;

const ROLE_HELP: Record<Role, string> = {
  TECHNICIAN: 'Works jobs from the technician app. Belongs to one service center.',
  SERVICE_CENTER_OWNER: 'Runs one service center: assigns technicians, books visits, reviews work, manages parts.',
  ADMIN: 'Full access: creates complaints, confirms with customers, closes, and manages everything here.',
};

function AddUserDialog({
  centres,
  defaultRole,
  onClose,
  onCreated,
}: {
  centres: ServiceCenter[];
  defaultRole: Role;
  onClose: () => void;
  onCreated: (issued: IssuedPassword) => void;
}) {
  const refresh = useRefreshRecords();
  const { errors, setErrors, fromError } = useFieldErrors();
  const [role, setRole] = useState<Role>(defaultRole);
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [serviceCenterId, setServiceCenterId] = useState('');

  const needsCentre = role !== 'ADMIN';

  const create = useMutation({
    mutationFn: () =>
      api<IssuedPassword>('/users', {
        method: 'POST',
        body: {
          role,
          name: name.trim(),
          mobile: mobile.replace(/\D/g, ''),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(needsCentre ? { serviceCenterId } : {}),
        },
      }),
    onSuccess: async (result) => {
      onClose();
      onCreated(result);
      await refresh();
    },
    onError: (error) => {
      /* "An account already exists with that mobile number" belongs beside
         the mobile field, not in a toast. */
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ mobile: error.message });
        return;
      }
      fromError(error);
    },
  });

  const submit = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found['name'] = 'Enter their name';
    if (!MOBILE.test(mobile.replace(/\D/g, ''))) found['mobile'] = 'Enter a valid 10-digit mobile number';
    if (needsCentre && !serviceCenterId) found['serviceCenterId'] = 'Choose their service center';
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title="Add user"
      description="They sign in with their mobile number. A temporary password is created for you to give them."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            Add user
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">Role</legend>
          <div className="space-y-2">
            {(['TECHNICIAN', 'SERVICE_CENTER_OWNER', 'ADMIN'] as const).map((option) => (
              <label
                key={option}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  role === option ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600' : 'border-slate-200 hover:bg-slate-50',
                )}
              >
                <input
                  type="radio"
                  name="role"
                  value={option}
                  checked={role === option}
                  onChange={() => setRole(option)}
                  className="mt-1 accent-brand-700"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900">{ROLE_LABEL[option]}</span>
                  <span className="block text-xs text-slate-500">{ROLE_HELP[option]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} autoComplete="off" required />
        <Input
          label="Mobile number"
          type="tel"
          inputMode="numeric"
          placeholder="98765 43210"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          error={errors['mobile']}
          hint="This is what they sign in with."
          autoComplete="off"
          required
        />
        <Input label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors['email']} autoComplete="off" />
        {needsCentre && (
          <Select
            label="Service center"
            value={serviceCenterId}
            onChange={(e) => setServiceCenterId(e.target.value)}
            error={errors['serviceCenterId']}
            required
          >
            <option value="">Choose a service center</option>
            {centres.map((centre) => (
              <option key={centre.id} value={centre.id}>
                {centre.name}
              </option>
            ))}
          </Select>
        )}
      </div>
    </Dialog>
  );
}

/* ---- Edit --------------------------------------------------------------- */

function EditUserDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const refresh = useRefreshRecords();
  const { errors, fromError } = useFieldErrors();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? '');

  const save = useMutation({
    mutationFn: () =>
      /* Email is sent even when blank — `""` is how the server is told to
         remove it (users.validation.ts), rather than leaving it as it was. */
      api(`/users/${user.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), email: email.trim() },
      }),
    onSuccess: async () => {
      toast.success('User updated');
      onClose();
      await refresh();
    },
    onError: fromError,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Edit ${user.name}`}
      description={`Mobile ${formatMobile(user.mobile)} is their sign-in and is not changed here.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors['name']} required autoFocus />
        <Input label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors['email']} />
      </div>
    </Dialog>
  );
}
