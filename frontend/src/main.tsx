import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./index.css";

import App from "./App.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "./registerServiceWorker";

const LEGACY_HOST = "maimai.bakapiano.com";
const CANONICAL_ORIGIN = "https://maiscorehub.bakapiano.com";
const PRELOAD_RELOAD_KEY = "msh_preload_reload_at";

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const now = Date.now();
  try {
    const previous = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) ?? 0);
    if (Number.isFinite(previous) && now - previous < 60_000) {
      return;
    }
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now));
  } catch {
    // Reload still provides recovery when session storage is unavailable.
  }
  window.location.reload();
});

if (window.location.hostname === LEGACY_HOST) {
  window.location.replace(
    `${CANONICAL_ORIGIN}${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  registerServiceWorker();
}
