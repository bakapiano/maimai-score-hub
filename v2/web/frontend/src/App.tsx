import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import AuthedLayout from "./layouts/AuthedLayout";
import DebugPage from "./pages/DebugPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import { MantineProvider } from "@mantine/core";
import { MusicProvider } from "./providers/MusicProvider";
import { Notifications } from "@mantine/notifications";
import type { ReactNode } from "react";
import ScorePage from "./pages/ScorePage";

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
              <Route
                element={
                  <RequireAuth>
                    <AuthedLayout />
                  </RequireAuth>
                }
              >
                <Route path="/app" element={<HomePage />} />
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
