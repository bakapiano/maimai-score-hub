import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Suspense, lazy, type ReactNode } from "react";

import { Center, Loader } from "@mantine/core";
import LoginPage from "./pages/LoginPage";
import { MantineProvider } from "@mantine/core";
import { MusicProvider } from "./providers/MusicProvider";
import { Notifications } from "@mantine/notifications";

// Lazy-loaded routes for code splitting
const AuthedLayout = lazy(() => import("./layouts/AuthedLayout"));
const HomePage = lazy(() => import("./pages/HomePage"));
const ScorePage = lazy(() => import("./pages/ScorePage"));
const SyncPage = lazy(() => import("./pages/SyncPage"));
const DebugPage = lazy(() => import("./pages/DebugPage"));
const AdminLayout = lazy(() => import("./pages/admin/AdminLayout"));
const AdminActiveJobsPage = lazy(
  () => import("./pages/admin/AdminActiveJobsPage"),
);
const AdminJobDebugPage = lazy(
  () => import("./pages/admin/AdminJobDebugPage"),
);
const AdminSyncPage = lazy(() => import("./pages/admin/AdminSyncPage"));
const AdminUsersPage = lazy(() => import("./pages/admin/AdminUsersPage"));

function PageLoader() {
  return (
    <Center h="100vh">
      <Loader size="lg" type="bars" />
    </Center>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<AdminActiveJobsPage />} />
                <Route path="sync" element={<AdminSyncPage />} />
                <Route path="job-debug" element={<AdminJobDebugPage />} />
                <Route path="users" element={<AdminUsersPage />} />
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
                <Route
                  path="/app/scores"
                  element={
                    <MusicProvider>
                      <ScorePage />
                    </MusicProvider>
                  }
                />
                <Route path="/app/debug" element={<DebugPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </MantineProvider>
  );
}

export default App;
