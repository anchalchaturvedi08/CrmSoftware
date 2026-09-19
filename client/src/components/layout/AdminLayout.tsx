/**
 * Admin shell (spec sections 4 and 21): the shared portal layout with the
 * Admin navigation, in the order section 4 lists it.
 */
import {
  BarChart3,
  Boxes,
  CalendarClock,
  ClipboardList,
  FileClock,
  Gauge,
  Package,
  Plus,
  Settings,
  Timer,
  UserCog,
  Users,
  Wrench,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { PortalLayout, type NavGroup } from './PortalLayout';

const NAV: NavGroup[] = [
  {
    items: [
      { to: '/admin', label: 'Dashboard', icon: Gauge, end: true },
      { to: '/admin/complaints', label: 'Complaints', icon: ClipboardList },
      { to: '/admin/visits', label: 'Visits / Schedule', icon: CalendarClock },
    ],
  },
  {
    heading: 'Records',
    items: [
      { to: '/admin/customers', label: 'Customers', icon: Users },
      { to: '/admin/products', label: 'Products', icon: Package },
      { to: '/admin/service-centers', label: 'Service Centers', icon: Wrench },
      { to: '/admin/technicians', label: 'Technicians & Users', icon: UserCog },
      { to: '/admin/parts', label: 'Parts & Inventory', icon: Boxes },
    ],
  },
  {
    heading: 'Insight',
    items: [
      { to: '/admin/reports', label: 'Reports & MIS', icon: BarChart3 },
      { to: '/admin/sla', label: 'SLA', icon: Timer },
      { to: '/admin/audit', label: 'Audit Log', icon: FileClock },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function AdminLayout() {
  const navigate = useNavigate();

  return (
    <PortalLayout
      config={{
        name: 'Admin',
        subtitle: 'Admin',
        nav: NAV,
        searchPath: '/admin/complaints',
        roleLabel: 'Administrator',
        action: (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => navigate('/admin/complaints/new')}>
            New complaint
          </Button>
        ),
      }}
    />
  );
}
