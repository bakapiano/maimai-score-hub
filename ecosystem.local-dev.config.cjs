const path = require("node:path");
const fs = require("node:fs");

const root = __dirname;
const env = readEnvFile(path.join(root, ".env.local-dev"));

function readEnvFile(file) {
  if (!fs.existsSync(file)) {
    return {};
  }
  const result = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

module.exports = {
  apps: [
    {
      name: "msh-memurai",
      script: "C:\\ProgramData\\chocolatey\\bin\\memurai.exe",
      args: "--port 6379 --dir C:\\ProgramData\\MemuraiDev",
      cwd: root,
      interpreter: "none",
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-backend",
      script: path.join(root, "backend", "dist", "main.js"),
      cwd: path.join(root, "backend"),
      env: {
        NODE_OPTIONS: "--max-old-space-size=4096",
        PORT: "9050",
        HOST: "127.0.0.1",
        MONGO_HOST: "127.0.0.1",
        MONGO_PORT: "27017",
        MONGO_DB: "maimai_web",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        REDIS_DB: "0",
        REDIS_KEY_PREFIX: "maimai:",
        AUTH_JWT_SECRET: "change-me-local",
        SKIP_AUTH: "true",
        OBSERVABILITY_ENV: "dev",
        OBSERVABILITY_INSTANCE: "local-admin-dashboard",
        CLICKHOUSE_DATABASE: "maimai_observability",
        CLICKHOUSE_FLUSH_INTERVAL_MS: "1000",
        ...env,
      },
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-frontend",
      script: path.join(root, "frontend", "node_modules", "vite", "bin", "vite.js"),
      args: "--host 127.0.0.1 --port 3001",
      cwd: path.join(root, "frontend"),
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-worker",
      script: process.execPath,
      args: "--enable-source-maps --experimental-strip-types src/index.ts",
      cwd: path.join(root, "worker"),
      env: {
        NODE_ENV: "dev",
        WORKER_ID: "dxnet-worker-local-dev",
        JOB_SERVICE_BASE_URL: "http://127.0.0.1:9050/",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        REDIS_DB: "0",
        REDIS_KEY_PREFIX: "maimai:",
        API_SHARED_SECRET:
          env.API_SHARED_SECRET || env.ADMIN_PASSWORD || "change-me-local-admin",
        ADMIN_PASSWORD:
          env.ADMIN_PASSWORD || env.API_SHARED_SECRET || "change-me-local-admin",
        ...env,
      },
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-sdgb-worker",
      script: process.execPath,
      args: "--enable-source-maps --experimental-strip-types src/index.ts",
      cwd: path.join(root, "sdgb-worker"),
      env: {
        NODE_ENV: "dev",
        WORKER_ID: "sdgb-worker-local-dev",
        BACKEND_URL: "http://127.0.0.1:9050",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: "6379",
        REDIS_DB: "0",
        REDIS_KEY_PREFIX: "maimai:",
        API_SHARED_SECRET:
          env.API_SHARED_SECRET || env.ADMIN_PASSWORD || "change-me-local-admin",
        ADMIN_PASSWORD:
          env.ADMIN_PASSWORD || env.API_SHARED_SECRET || "change-me-local-admin",
        ...env,
      },
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-devtunnel",
      script: "devtunnel.exe",
      args:
        'host -p 3001 --protocol http --allow-anonymous --description "maimai-score-hub-local-frontend"',
      cwd: root,
      interpreter: "none",
      autorestart: true,
      max_restarts: 5,
    },
  ],
};
