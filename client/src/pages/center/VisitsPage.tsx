/**
 * Service Center visits — the shared schedule, scoped by the server to this
 * centre (see components/visits/VisitSchedule.tsx).
 */
import { VisitSchedule } from '@/components/visits/VisitSchedule';

export function VisitsPage() {
  return <VisitSchedule portal="center" />;
}
