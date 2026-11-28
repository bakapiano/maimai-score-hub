import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const apiProxyTarget =
  process.env.FRONTEND_API_PROXY_TARGET ?? "http://127.0.0.1:9050";
const apiProxyOrigin =
  /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(apiProxyTarget)
    ? "http://localhost:3001"
    : "https://maiscorehub.bakapiano.com";
const cdnBaseUrl = (
  process.env.VITE_CDN_BASE_URL ?? "https://cdn.maiscorehub.bakapiano.com"
).replace(/\/+$/, "");

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  experimental:
    command === "build" && cdnBaseUrl
      ? {
          renderBuiltUrl(filename, { hostType }) {
            if (
              filename.startsWith("assets/") &&
              (hostType === "html" || hostType === "js" || hostType === "css")
            ) {
              return `${cdnBaseUrl}/${filename}`;
            }
            return { relative: true };
          },
        }
      : undefined,
  resolve: {
    alias: {
      "@maimai-score-hub/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
      // Avoid loading thousands of icon chunk files in Vite dev mode
      "@tabler/icons-react": "@tabler/icons-react/dist/esm/icons/index.mjs",
    },
  },
  build: {
    // QQ's embedded browser still reaches production with a Chrome 77 WebView.
    // Keep the entry bundle parseable there so users see the app instead of a
    // blank screen before React and frontend observability can start.
    target: "chrome77",
    cssCodeSplit: false,
  },
  server: {
    port: 3001,
    host: "127.0.0.1",
    proxy: {
      "/stats/": {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => "/api/v1" + path,
      },
      "/admin": {
        target: "http://127.0.0.1:3002",
        changeOrigin: true,
      },
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: true,
        headers: {
          Origin: apiProxyOrigin,
        },
      },
      "/maimai-mobile/img": {
        target: "https://maimai.wahlap.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
}));
