/**
 * Service Center shell (spec sections 4, 9 and 21).
 *
 * The shared portal layout with section 4's seven Service Center items. The
 * sidebar names the Owner's own centre, because every number in this portal is
 * scoped to it and the Owner should never have to wonder whose data they see.
 */
import {
  BarChart3,
  Boxes,
  CalendarClock,
  ClipboardList,
  Gauge,
  UserCog,
  UserRound,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Paged, ServiceCenter } from '@/lib/types';
import { PortalLayout, type NavGroup } from './PortalLayout';

const NAV: NavGroup[] = [
  {
    items: [
      { to: '/center', label: 'Dashboard', icon: Gauge, end: true },
      { to: '/center/complaints', label: 'My Complaints', icon: ClipboardList },
      { to: '/center/visits', label: 'Visits / Schedule', icon: CalendarClock },
      { to: '/center/technicians', label: 'Technicians', icon: UserCog },
      { to: '/center/parts', label: 'Parts & Inventory', icon: Boxes },
      { to: '/center/reports', label: 'Reports', icon: BarChart3 },
      { to: '/center/profile', label: 'Profile', icon: UserRound },
    ],
  },
];

/** The Owner's own centre, from the (small, cached) centre directory. */
export function useMyCenter() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['service-centers', 'directory'],
    queryFn: () => api<Paged<ServiceCenter>>('/service-centers', { query: { limit: 200 } }),
    enabled: Boolean(user?.serviceCenterId),
    staleTime: 60 * 60_000,
    select: (result) => result.items.find((item) => item.id === user?.serviceCenterId),
  });
}

export function CenterLayout() {
  const centre = useMyCenter();

  return (
    <PortalLayout
      config={{
        name: 'Service Center',
        subtitle: centre.data?.name ?? 'Service Center',
        nav: NAV,
        searchPath: '/center/complaints',
        roleLabel: 'Service Center Owner',
      }}
    />
  );
}
