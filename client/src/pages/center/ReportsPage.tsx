/**
 * Service Center reports — the shared reports page, scoped by the server to
 * this centre (see components/reports/ReportsPage.tsx).
 */
import { ReportsPage as SharedReportsPage } from '@/components/reports/ReportsPage';

export function ReportsPage() {
  return <SharedReportsPage portal="center" />;
}
