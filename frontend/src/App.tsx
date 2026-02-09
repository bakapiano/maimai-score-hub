import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import AdminActiveJobsPage from "./pages/admin/AdminActiveJobsPage";
import AdminJobDebugPage from "./pages/admin/AdminJobDebugPage";
import AdminLayout from "./pages/admin/AdminLayout";
import AdminSyncPage from "./pages/admin/AdminSyncPage";
import AdminUsersPage from "./pages/admin/AdminUsersPage";
import AuthedLayout from "./layouts/AuthedLayout";
import DebugPage from "./pages/DebugPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import { MantineProvider } from "@mantine/core";
import { MusicProvider } from "./providers/MusicProvider";
import { Notifications } from "@mantine/notifications";
import type { ReactNode } from "react";
import ScorePage from "./pages/ScorePage";
import SyncPage from "./pages/SyncPage";

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
      defaultColorScheme="dark"
      theme={{ fontFamily: systemSans, headings: { fontFamily: systemSans } }}
    >
      <Notifications position="top-center" />
      <BrowserRouter>
        <AuthProvider>
          <MusicProvider>
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
                <Route path="/app/scores" element={<ScorePage />} />
                <Route path="/app/debug" element={<DebugPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          </MusicProvider>
        </AuthProvider>
      </BrowserRouter>
    </MantineProvider>
  );
}

export default App;
