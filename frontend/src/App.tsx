import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Suspense, lazy, type ReactNode } from "react";

import { Center, Loader } from "@mantine/core";
import LoginPage from "./pages/LoginPage";
import { MantineProvider } from "@mantine/core";
import { MusicProvider } from "./providers/MusicProvider";
import { Notifications } from "@mantine/notifications";
import { ObservabilityReporter } from "./components/ObservabilityReporter";
import { PwaInstallProvider } from "./providers/PwaInstallProvider";

// Lazy-loaded routes for code splitting
const AuthedLayout = lazy(() => import("./layouts/AuthedLayout"));
const HomePage = lazy(() => import("./pages/HomePage"));
const ScorePage = lazy(() => import("./pages/ScorePage"));
const SyncPage = lazy(() => import("./pages/SyncPage"));
const AdminLayout = lazy(() => import("./pages/admin/AdminLayout"));
const AdminRealtimePage = lazy(() => import("./pages/admin/AdminRealtimePage"));
const AdminHistoryPage = lazy(() => import("./pages/admin/AdminHistoryPage"));
const AdminProberExportsPage = lazy(
  () => import("./pages/admin/AdminProberExportsPage"),
);
const AdminJobDebugPage = lazy(() => import("./pages/admin/AdminJobDebugPage"));
const AdminSyncPage = lazy(() => import("./pages/admin/AdminSyncPage"));
const AdminUsersPage = lazy(() => import("./pages/admin/AdminUsersPage"));
const AdminWorkerLogsPage = lazy(
  () => import("./pages/admin/AdminWorkerLogsPage"),
);
const AboutPage = lazy(() => import("./pages/AboutPage"));

function PageLoader() {
  return (
    <Center h="100vh">
      <Loader size="lg" type="bars" />
    </Center>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { token, offline } = useAuth();
  if (!token && !offline) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Redirect to /app if logged in, otherwise to /login */
function DefaultRedirect() {
  const { token, offline } = useAuth();
  return <Navigate to={token || offline ? "/app" : "/login"} replace />;
}

function App() {
  const systemSans =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";
  return (
    <MantineProvider
      // defaultColorScheme="dark"
      theme={{ fontFamily: systemSans, headings: { fontFamily: systemSans } }}
    >
      <Notifications position="top-center" />
      <PwaInstallProvider>
        <MusicProvider>
          <BrowserRouter>
            <AuthProvider>
              <ObservabilityReporter />
              <Suspense fallback={<PageLoader />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/admin" element={<AdminLayout />}>
                    <Route index element={<AdminRealtimePage />} />
                    <Route path="history" element={<AdminHistoryPage />} />
                    <Route
                      path="prober-exports"
                      element={<AdminProberExportsPage />}
                    />
                    <Route path="sync" element={<AdminSyncPage />} />
                    <Route path="job-debug" element={<AdminJobDebugPage />} />
                    <Route path="users" element={<AdminUsersPage />} />
                    <Route
                      path="history/logs"
                      element={<AdminWorkerLogsPage />}
                    />
                  </Route>
                  <Route
                    element={
                      <RequireAuth>
                        <AuthedLayout />
                      </RequireAuth>
                    }
                  >
                    <Route path="/app" element={<HomePage />} />
                    <Route path="/app/sync" element={<SyncPage />} />
                    <Route path="/app/scores" element={<ScorePage />} />
                  </Route>
                  <Route path="/about" element={<AboutPage />} />
                  <Route path="*" element={<DefaultRedirect />} />
                </Routes>
              </Suspense>
            </AuthProvider>
          </BrowserRouter>
        </MusicProvider>
      </PwaInstallProvider>
    </MantineProvider>
  );
}

export default App;
