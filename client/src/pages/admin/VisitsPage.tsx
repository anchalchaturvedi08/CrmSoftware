/**
 * Admin visits — every service center's schedule, with a centre filter
 * (see components/visits/VisitSchedule.tsx).
 */
import { VisitSchedule } from '@/components/visits/VisitSchedule';

export function VisitsPage() {
  return <VisitSchedule portal="admin" />;
}
