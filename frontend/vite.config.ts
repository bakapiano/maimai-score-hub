import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

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
  server: {
    port: 3001,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:9050",
      "/maimai-mobile/img": {
        target: "https://maimai.wahlap.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
