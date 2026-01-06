import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import AuthedLayout from "./layouts/AuthedLayout";
import DebugPage from "./pages/DebugPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import type { ReactNode } from "react";

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <MantineProvider defaultColorScheme="dark">
      <Notifications position="top-center" />
      <BrowserRouter>
        <AuthProvider>
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
              <Route path="/app/debug" element={<DebugPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </MantineProvider>
  );
}

export default App;
