/**
 * Admin reports — the shared reports page with every report and filter
 * (see components/reports/ReportsPage.tsx).
 */
import { ReportsPage as SharedReportsPage } from '@/components/reports/ReportsPage';

export function ReportsPage() {
  return <SharedReportsPage portal="admin" />;
}
