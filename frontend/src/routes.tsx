import { lazy, Suspense } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { AppLayout } from '@/components/AppLayout';
import { RequireAuth } from '@/components/RequireAuth';
import Landing from '@/pages/Landing';
import AuthCallback from '@/pages/AuthCallback';
import NotFound from '@/pages/NotFound';
import Placeholder from '@/pages/Placeholder';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const ProjectDetail = lazy(() => import('@/pages/ProjectDetail'));

function PageSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-slate-400">
      <Spinner size="lg" />
    </div>
  );
}

function LayoutShell() {
  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route element={<RequireAuth />}>
        <Route element={<LayoutShell />}>
          <Route
            path="/dashboard"
            element={
              <Suspense fallback={<PageSpinner />}>
                <Dashboard />
              </Suspense>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <Suspense fallback={<PageSpinner />}>
                <ProjectDetail />
              </Suspense>
            }
          />
          <Route
            path="/projects/:id/builds/:buildId"
            element={<Placeholder title="Build logs" subtitle="Live logs ship in M4." />}
          />
          <Route
            path="/deployments"
            element={<Placeholder title="Deployments" subtitle="All deployments in M5." />}
          />
          <Route
            path="/activity"
            element={<Placeholder title="Activity" subtitle="Activity feed in M5." />}
          />
          <Route
            path="/settings"
            element={<Placeholder title="Settings" subtitle="Account settings in M5." />}
          />
          <Route
            path="/integrations"
            element={<Placeholder title="Integrations" subtitle="Integrations in M5." />}
          />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
