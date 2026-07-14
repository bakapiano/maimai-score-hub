import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./index.css";

import App from "./App.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "./registerServiceWorker";

const LEGACY_HOST = "maimai.bakapiano.com";
const CANONICAL_ORIGIN = "https://maiscorehub.bakapiano.com";

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
