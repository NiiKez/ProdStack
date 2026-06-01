import { lazy, Suspense } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { AppLayout } from '@/components/AppLayout';
import { RequireAuth } from '@/components/RequireAuth';
import Landing from '@/pages/Landing';
import AuthCallback from '@/pages/AuthCallback';
import NotFound from '@/pages/NotFound';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const ProjectDetail = lazy(() => import('@/pages/ProjectDetail'));
const BuildLogs = lazy(() => import('@/pages/BuildLogs'));
const Deployments = lazy(() => import('@/pages/Deployments'));
const Activity = lazy(() => import('@/pages/Activity'));
const Settings = lazy(() => import('@/pages/Settings'));
const Integrations = lazy(() => import('@/pages/Integrations'));

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
            element={
              <Suspense fallback={<PageSpinner />}>
                <BuildLogs />
              </Suspense>
            }
          />
          <Route
            path="/deployments"
            element={
              <Suspense fallback={<PageSpinner />}>
                <Deployments />
              </Suspense>
            }
          />
          <Route
            path="/activity"
            element={
              <Suspense fallback={<PageSpinner />}>
                <Activity />
              </Suspense>
            }
          />
          <Route
            path="/settings"
            element={
              <Suspense fallback={<PageSpinner />}>
                <Settings />
              </Suspense>
            }
          />
          <Route
            path="/integrations"
            element={
              <Suspense fallback={<PageSpinner />}>
                <Integrations />
              </Suspense>
            }
          />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
