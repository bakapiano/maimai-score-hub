import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

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
      output: {},
    },
  },
  server: {
    port: 3002,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:9050",
    },
  },
});
