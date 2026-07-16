import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const prodApiProxyTarget =
  process.env.ADMIN_PROD_API_PROXY_TARGET ??
  "https://api.maiscorehub.bakapiano.com";

export default defineConfig({
  base: "/admin/",
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
      "/prod-api": {
        target: prodApiProxyTarget,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/prod-api/, "/api"),
        headers: {
          Origin: "https://maiscorehub.bakapiano.com",
        },
      },
    },
  },
});
