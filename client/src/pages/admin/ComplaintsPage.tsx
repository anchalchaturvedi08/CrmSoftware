/**
 * Admin complaint list — the shared list with Admin's columns and the
 * New complaint action (see components/complaint/ComplaintList.tsx).
 */
import { ComplaintList } from '@/components/complaint/ComplaintList';

export function ComplaintsPage() {
  return <ComplaintList portal="admin" />;
}
