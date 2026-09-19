/**
 * Routes.
 *
 * One app, three role-scoped route groups (DECISIONS.md section 5, item 8).
 * `RequireRole` keeps a user in their own portal — but it is a convenience,
 * not the control. The server refuses out-of-role requests regardless of what
 * the client routes allow (spec section 19).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { CenterLayout } from '@/components/layout/CenterLayout';
import { TechHeader, TechLayout } from '@/components/layout/TechLayout';
import { ApiError, type Role } from '@/lib/api';
import { AuthProvider, homeFor, useAuth } from '@/lib/auth';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { LoginPage } from '@/pages/LoginPage';

/**
 * Each portal is its own download.
 *
 * A technician on mobile data should not pay for the Admin dashboard's charts
 * and tables they can never open, and an Admin gains nothing from the visit
 * flow. Each portal's screens load as one chunk the first time any of them is
 * shown; the layouts hold the Suspense boundary, so the navigation stays put
 * while a chunk arrives.
 */
const admin = () => import('@/pages/admin');
const center = () => import('@/pages/center');
const tech = () => import('@/pages/tech');

const DashboardPage = lazy(() => admin().then((m) => ({ default: m.DashboardPage })));
const ComplaintsPage = lazy(() => admin().then((m) => ({ default: m.ComplaintsPage })));
const ComplaintDetailPage = lazy(() => admin().then((m) => ({ default: m.ComplaintDetailPage })));
const CreateComplaintPage = lazy(() => admin().then((m) => ({ default: m.CreateComplaintPage })));
const CustomersPage = lazy(() => admin().then((m) => ({ default: m.CustomersPage })));
const ProductsPage = lazy(() => admin().then((m) => ({ default: m.ProductsPage })));
const ServiceCentersPage = lazy(() => admin().then((m) => ({ default: m.ServiceCentersPage })));
const ServiceCenterDetailPage = lazy(() => admin().then((m) => ({ default: m.ServiceCenterDetailPage })));
const UsersPage = lazy(() => admin().then((m) => ({ default: m.UsersPage })));
const AdminPartsPage = lazy(() => admin().then((m) => ({ default: m.PartsPage })));
const SlaPage = lazy(() => admin().then((m) => ({ default: m.SlaPage })));
const ReportsPage = lazy(() => admin().then((m) => ({ default: m.ReportsPage })));
const VisitsPage = lazy(() => admin().then((m) => ({ default: m.VisitsPage })));
const AuditLogPage = lazy(() => admin().then((m) => ({ default: m.AuditLogPage })));
const SettingsPage = lazy(() => admin().then((m) => ({ default: m.SettingsPage })));

const CenterDashboardPage = lazy(() => center().then((m) => ({ default: m.DashboardPage })));
const CenterComplaintsPage = lazy(() => center().then((m) => ({ default: m.ComplaintsPage })));
const CenterComplaintDetailPage = lazy(() => center().then((m) => ({ default: m.ComplaintDetailPage })));
const CenterVisitsPage = lazy(() => center().then((m) => ({ default: m.VisitsPage })));
const CenterTechniciansPage = lazy(() => center().then((m) => ({ default: m.TechniciansPage })));
const CenterPartsPage = lazy(() => center().then((m) => ({ default: m.PartsPage })));
const CenterProfilePage = lazy(() => center().then((m) => ({ default: m.ProfilePage })));
const CenterReportsPage = lazy(() => center().then((m) => ({ default: m.ReportsPage })));

const MyJobsPage = lazy(() => tech().then((m) => ({ default: m.MyJobsPage })));
const SchedulePage = lazy(() => tech().then((m) => ({ default: m.SchedulePage })));
const HistoryPage = lazy(() => tech().then((m) => ({ default: m.HistoryPage })));
const ProfilePage = lazy(() => tech().then((m) => ({ default: m.ProfilePage })));
const JobDetailPage = lazy(() => tech().then((m) => ({ default: m.JobDetailPage })));
const VisitFlowPage = lazy(() => tech().then((m) => ({ default: m.VisitFlowPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /* Operational data changes as people work, but not second to second. */
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      /* Retrying a 403 or 404 only repeats a refusal; retry network trouble. */
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      /**
       * Always attempt the request, and fail honestly if there is no network.
       *
       * The default pauses requests while the browser believes it is offline,
       * with no error and no data. A screen cannot tell that apart from "still
       * loading" — or worse, from "nothing here", so a technician with no
       * signal would read "Nothing booked" instead of "no connection".
       */
      networkMode: 'always',
    },
    mutations: {
      /* Same reason: a paused mutation is a submit button that spins forever
         with no explanation. Failing lets the screen say what happened while
         the visit draft stays safe on the phone for another try. */
      networkMode: 'always',
    },
  },
});

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user } = useAuth();

  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;

  /* The server refuses everything but a password change until the temporary
     one is replaced. Showing the portal first would mean a screen of
     permission errors with no explanation. */
  if (user.mustChangePassword) return <ChangePasswordPage forced />;

  return <>{children}</>;
}

function RootRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<RootRedirect />} />

            <Route
              path="/admin"
              element={
                <RequireRole role="ADMIN">
                  <AdminLayout />
                </RequireRole>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="complaints" element={<ComplaintsPage />} />
              <Route path="complaints/new" element={<CreateComplaintPage />} />
              <Route path="complaints/:id" element={<ComplaintDetailPage />} />

              <Route path="customers" element={<CustomersPage />} />
              <Route path="products" element={<ProductsPage />} />
              <Route path="service-centers" element={<ServiceCentersPage />} />
              <Route path="service-centers/:id" element={<ServiceCenterDetailPage />} />
              <Route path="technicians" element={<UsersPage />} />
              <Route path="parts" element={<AdminPartsPage />} />
              <Route path="sla" element={<SlaPage />} />
              <Route path="visits" element={<VisitsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="audit" element={<AuditLogPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/password" element={<ChangePasswordPage />} />
            </Route>

            <Route
              path="/center"
              element={
                <RequireRole role="SERVICE_CENTER_OWNER">
                  <CenterLayout />
                </RequireRole>
              }
            >
              <Route index element={<CenterDashboardPage />} />
              <Route path="complaints" element={<CenterComplaintsPage />} />
              <Route path="complaints/:id" element={<CenterComplaintDetailPage />} />
              <Route path="visits" element={<CenterVisitsPage />} />
              <Route path="technicians" element={<CenterTechniciansPage />} />
              <Route path="parts" element={<CenterPartsPage />} />
              {/* The same page as Admin's; the server scopes every figure to this centre. */}
              <Route path="reports" element={<CenterReportsPage />} />
              <Route path="profile" element={<CenterProfilePage />} />
              <Route path="profile/password" element={<ChangePasswordPage />} />
              <Route path="*" element={<Navigate to="/center" replace />} />
            </Route>

            <Route
              path="/tech"
              element={
                <RequireRole role="TECHNICIAN">
                  <TechLayout />
                </RequireRole>
              }
            >
              <Route index element={<MyJobsPage />} />
              <Route path="schedule" element={<SchedulePage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route
                path="profile/password"
                element={
                  <>
                    <TechHeader title="Change password" back="/tech/profile" />
                    <ChangePasswordPage />
                  </>
                }
              />
              <Route path="jobs/:complaintId" element={<JobDetailPage />} />
              <Route path="jobs/:complaintId/visit" element={<VisitFlowPage />} />
              <Route path="*" element={<Navigate to="/tech" replace />} />
            </Route>

            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="top-right" richColors closeButton />
      </AuthProvider>
    </QueryClientProvider>
  );
}
