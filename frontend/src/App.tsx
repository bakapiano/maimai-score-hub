import { AuthProvider } from "./providers/AuthProvider";
import { useAuth } from "./providers/AuthContext";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { type ReactNode } from "react";

import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ObservabilityReporter } from "./components/ObservabilityReporter";
import { AndroidAppUpdateE2EBridge } from "./features/android-update/AndroidAppUpdateE2EBridge";
import { AndroidAppUpdateProvider } from "./features/android-update/AndroidAppUpdateProvider";
import { getAndroidHostBridge } from "./features/android-update/androidUpdateBridge";
import AuthedLayout from "./layouts/AuthedLayout";
import AboutPage from "./pages/AboutPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import ScorePage from "./pages/ScorePage";
import SettingsPage from "./pages/SettingsPage";
import SyncPage from "./pages/SyncPage";
import { MusicProvider } from "./providers/MusicProvider";
import { PwaInstallProvider } from "./providers/PwaInstallProvider";
import { appTheme } from "./theme";

function RequireAuth({ children }: { children: ReactNode }) {
  const { token, offline } = useAuth();
  if (!token && !offline) {return <Navigate to="/login" replace />;}
  return <>{children}</>;
}

function LoginRoute() {
  const { token } = useAuth();
  return token ? <Navigate to="/app" replace /> : <LoginPage />;
}

/** Redirect to /app if logged in, otherwise to /login */
function DefaultRedirect() {
  const { token, offline } = useAuth();
  return <Navigate to={token || offline ? "/app" : "/login"} replace />;
}

function App() {
  return (
    <MantineProvider
      defaultColorScheme={getAndroidHostBridge() ? "auto" : "light"}
      theme={appTheme}
    >
      <Notifications position="top-center" />
      <PwaInstallProvider>
        <MusicProvider>
          <BrowserRouter>
            <AuthProvider>
              <AndroidAppUpdateProvider>
                <ObservabilityReporter />
                <AndroidAppUpdateE2EBridge />
                <Routes>
                  <Route path="/login" element={<LoginRoute />} />
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
                    <Route path="/app/settings" element={<SettingsPage />} />
                  </Route>
                  <Route path="/about" element={<AboutPage />} />
                  <Route path="*" element={<DefaultRedirect />} />
                </Routes>
              </AndroidAppUpdateProvider>
            </AuthProvider>
          </BrowserRouter>
        </MusicProvider>
      </PwaInstallProvider>
    </MantineProvider>
  );
}

export default App;
