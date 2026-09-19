/**
 * My Complaints — the shared list with the Service Center's columns: the
 * technician and visit date section 9 asks for, and a technician filter
 * (see components/complaint/ComplaintList.tsx).
 */
import { ComplaintList } from '@/components/complaint/ComplaintList';

export function ComplaintsPage() {
  return <ComplaintList portal="center" />;
}
