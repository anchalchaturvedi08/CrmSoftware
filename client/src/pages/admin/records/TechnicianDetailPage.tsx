import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Mail, Phone } from 'lucide-react';
import { Link, useLocation, useParams } from 'react-router';
import { Badge, PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { Card, CardHeader, PageHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { api } from '@/lib/api';
import { formatDate, formatMobile, fromNow } from '@/lib/format';
import type { Complaint, Paged, User } from '@/lib/types';

export function TechnicianDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const backTo = pathname.startsWith('/center') ? '/center/technicians' : '/admin/technicians';
  const complaintBase = pathname.startsWith('/center') ? '/center/complaints' : '/admin/complaints';

  const technician = useQuery({
    queryKey: ['technician-detail', id],
    queryFn: () => api<{ user: User }>(`/users/${id}`),
    enabled: Boolean(id),
  });

  const complaints = useQuery({
    queryKey: ['technician-complaints', id],
    queryFn: () =>
      api<Paged<Complaint>>('/complaints', {
        query: { technicianId: id, limit: 200 },
      }),
    enabled: Boolean(id),
  });

  const user = technician.data?.user;
  const items = complaints.data?.items ?? [];
  const openCount = items.filter((c) => !['CLOSED', 'CANCELLED'].includes(c.status)).length;

  return (
    <>
      <div className="mb-4">
        <Link to={backTo} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-700">
          <ArrowLeft className="size-4" />
          Back to technicians
        </Link>
      </div>

      {technician.error && !user ? (
        <ErrorState error={technician.error} onRetry={() => void technician.refetch()} />
      ) : !user ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <PageHeader
            title={user.name}
            description={`${user.role === 'TECHNICIAN' ? 'Technician' : user.role} · ${openCount} open ${openCount === 1 ? 'complaint' : 'complaints'}`}
          />

          <Card className="mb-6">
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <Phone className="size-4 text-slate-400" />
                <a href={`tel:+91${user.mobile}`} className="hover:text-brand-700 hover:underline">
                  {formatMobile(user.mobile)}
                </a>
              </div>
              {user.email && (
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <Mail className="size-4 text-slate-400" />
                  <span>{user.email}</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-sm">
                {user.isActive ? (
                  <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-600/20">Active</Badge>
                ) : (
                  <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20">Deactivated</Badge>
                )}
                {user.lastLoginAt && (
                  <span className="text-slate-500">Last sign-in {fromNow(user.lastLoginAt)}</span>
                )}
              </div>
            </div>
          </Card>

          <CardHeader title="Assigned complaints" description={`${items.length} total, ${openCount} open`} />
          <Card className="overflow-hidden">
            {complaints.error ? (
              <ErrorState error={complaints.error} onRetry={() => void complaints.refetch()} />
            ) : !complaints.data ? (
              <div className="divide-y divide-slate-100">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="flex items-center gap-4 px-5 py-4">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="h-6 w-20" />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState title="No complaints assigned" description="This technician has no complaints assigned to them." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[800px] text-left text-sm">
                  <thead className="whitespace-nowrap border-b border-slate-200 bg-slate-50/70 text-xs font-medium uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3">Complaint #</th>
                      <th scope="col" className="px-5 py-3">Customer</th>
                      <th scope="col" className="px-5 py-3">Product</th>
                      <th scope="col" className="px-5 py-3">Priority</th>
                      <th scope="col" className="px-5 py-3">Status</th>
                      <th scope="col" className="px-5 py-3">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((c) => (
                      <tr key={c.id} className="hover:bg-slate-50/60">
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <Link
                            to={`${complaintBase}/${c.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {c.complaintNumber}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-slate-700">
                          {c.customerSnapshot.name}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-slate-700">
                          {c.productSnapshot.productName}
                          {c.productSnapshot.modelNumber && (
                            <span className="ml-1 text-xs text-slate-400">{c.productSnapshot.modelNumber}</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5">
                          <PriorityBadge priority={c.priority} />
                        </td>
                        <td className="px-5 py-3.5">
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-slate-500">
                          {formatDate(c.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
