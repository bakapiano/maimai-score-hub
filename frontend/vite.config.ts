import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const apiProxyTarget =
  process.env.FRONTEND_API_PROXY_TARGET ?? "http://127.0.0.1:9050";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@maimai-score-hub/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          mantine: [
            "@mantine/core",
            "@mantine/hooks",
            "@mantine/notifications",
          ],
          icons: ["@tabler/icons-react"],
        },
      },
    },
  },
  server: {
    port: 3001,
    host: "127.0.0.1",
    proxy: {
      "/admin": {
        target: "http://127.0.0.1:3002",
        changeOrigin: true,
      },
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: true,
      },
      "/maimai-mobile/img": {
        target: "https://maimai.wahlap.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
