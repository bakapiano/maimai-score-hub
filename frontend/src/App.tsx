import { AuthProvider } from "./providers/AuthProvider";
import { useAuth } from "./providers/AuthContext";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Suspense, lazy, type ReactNode } from "react";

import { Center, Loader } from "@mantine/core";
import LoginPage from "./pages/LoginPage";
import { MantineProvider } from "@mantine/core";
import { MusicProvider } from "./providers/MusicProvider";
import { Notifications } from "@mantine/notifications";
import { ObservabilityReporter } from "./components/ObservabilityReporter";
import { PwaInstallProvider } from "./providers/PwaInstallProvider";
import { appTheme } from "./theme";

// Lazy-loaded routes for code splitting
const AuthedLayout = lazy(() => import("./layouts/AuthedLayout"));
const HomePage = lazy(() => import("./pages/HomePage"));
const ScorePage = lazy(() => import("./pages/ScorePage"));
const SyncPage = lazy(() => import("./pages/SyncPage"));
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
  if (!token && !offline) {return <Navigate to="/login" replace />;}
  return <>{children}</>;
}

/** Redirect to /app if logged in, otherwise to /login */
function DefaultRedirect() {
  const { token, offline } = useAuth();
  return <Navigate to={token || offline ? "/app" : "/login"} replace />;
}

function App() {
  return (
    <MantineProvider
      // defaultColorScheme="dark"
      theme={appTheme}
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
