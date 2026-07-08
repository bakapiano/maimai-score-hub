import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import {
  installObservability,
  recordPageView,
  setObservabilityContext,
} from "../utils/observability";
import { useAuth } from "../providers/AuthContext";

export function ObservabilityReporter() {
  const location = useLocation();
  const { profile } = useAuth();

  useEffect(() => {
    installObservability();
  }, []);

  useEffect(() => {
    setObservabilityContext({
      routeTemplate: normalizeRoute(location.pathname),
      friendCode: profile?.friendCode ?? null,
    });
  }, [location.pathname, profile?.friendCode]);

  useEffect(() => {
    recordPageView(normalizeRoute(location.pathname));
  }, [location.pathname]);

  return null;
}

function normalizeRoute(pathname: string): string {
  return pathname || "/";
}
