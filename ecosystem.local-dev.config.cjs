const path = require("node:path");
const fs = require("node:fs");

const root = __dirname;
const env = readEnvFile(path.join(root, ".env.local-dev"));
const ocrMode = env.OCR_MODE || "real";
const ocrPipelineRoot =
  env.OCR_PIPELINE_ROOT || path.join(root, "ocr-api", "pipeline");
const apiPythonCandidate = path.join(
  root,
  "ocr-api",
  ".venv",
  "Scripts",
  "python.exe",
);
const pipelinePythonCandidate =
  env.OCR_PYTHON || "D:\\ocr\\ocr\\.venv\\Scripts\\python.exe";
const selectedOcrPython = ocrMode === "real" ? pipelinePythonCandidate : apiPythonCandidate;
const ocrPython = fs.existsSync(selectedOcrPython)
  ? selectedOcrPython
  : "python";
const fakeSdgb = env.SDGB_FAKE_UPSTREAM === "1";
const sdgbDesiredActiveCount = fakeSdgb ? "2" : "1";

function sdgbWorkerApp(name, workerId, workerClass) {
  return {
    name,
    script: process.execPath,
    args: "--enable-source-maps --experimental-strip-types src/index.ts",
    cwd: path.join(root, "sdgb-worker"),
    env: {
      ...env,
      NODE_ENV: "dev",
      ENV_PATH: path.join(root, "sdgb-worker", ".env"),
      WORKER_ID: workerId,
      SDGB_WORKER_CLASS: workerClass,
      SDGB_WORKER_CAPABILITIES: "probe,interactive",
      SDGB_WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      SDGB_MEMBERSHIP_TTL_MS: "5000",
      SDGB_MEMBERSHIP_RENEW_MS: "1000",
      SDGB_RECOVERY_HEALTH_INTERVAL_MS: "100",
      SDGB_RECOVERY_CLEAN_WINDOW_MS: "500",
      ...(workerClass === "recoverable"
        ? { SDGB_AUTO_RECOVERY_HOOK_KIND: "noop" }
        : {}),
      SDGB_FAKE_UPSTREAM: fakeSdgb ? "1" : "0",
      BACKEND_URL: "http://127.0.0.1:9050",
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: "6379",
      REDIS_DB: "0",
      REDIS_KEY_PREFIX: "maimai:",
      API_SHARED_SECRET:
        env.API_SHARED_SECRET || env.ADMIN_PASSWORD || "change-me-local-admin",
      ADMIN_PASSWORD:
        env.ADMIN_PASSWORD || env.API_SHARED_SECRET || "change-me-local-admin",
    },
    autorestart: true,
    max_restarts: 5,
  };
}

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
      name: "msh-ocr-api",
      script: ocrPython,
      args: "-m uvicorn app.main:app --host 127.0.0.1 --port 19100",
      cwd: path.join(root, "ocr-api"),
      interpreter: "none",
      env: {
        OCR_MODE: ocrMode,
        OCR_API_TOKEN: env.OCR_API_TOKEN || "change-me-local-ocr",
        OCR_MAX_FILES: env.OCR_MAX_FILES || "20",
        OCR_MAX_FILE_BYTES: env.OCR_MAX_FILE_BYTES || "8388608",
        OCR_CONCURRENCY: env.OCR_CONCURRENCY || "2",
        OCR_PIPELINE_ROOT: ocrPipelineRoot,
        OCR_DEVICE: env.OCR_DEVICE || "cuda",
        OCR_CATALOG_ENABLED: env.OCR_CATALOG_ENABLED || "false",
        OCR_CATALOG_ROOT:
          env.OCR_CATALOG_ROOT || path.join(root, ".local-dev", "ocr-catalog"),
      },
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
        OCR_API_URL: "http://127.0.0.1:19100",
        OCR_API_TOKEN: env.OCR_API_TOKEN || "change-me-local-ocr",
        OCR_API_TIMEOUT_MS: env.OCR_API_TIMEOUT_MS || "180000",
        SKIP_AUTH: "true",
        PROBER_AUTO_EXPORT_ENABLED: "false",
        OBSERVABILITY_ENV: "dev",
        OBSERVABILITY_INSTANCE: "local-admin-dashboard",
        CLICKHOUSE_DATABASE: "maimai_observability",
        CLICKHOUSE_FLUSH_INTERVAL_MS: "1000",
        SDGB_PROBE_PREFERRED_ACTIVE_COUNT: sdgbDesiredActiveCount,
        SDGB_PROBE_FALLBACK_ACTIVE_COUNT: sdgbDesiredActiveCount,
        SDGB_INTERACTIVE_PREFERRED_ACTIVE_COUNT: sdgbDesiredActiveCount,
        SDGB_INTERACTIVE_FALLBACK_ACTIVE_COUNT: sdgbDesiredActiveCount,
        SDGB_WORKER_STALE_MS: "3000",
        SDGB_WORKER_REGISTRY_TTL_SECONDS: "10",
        SDGB_DESIRED_MEMBERS_TTL_SECONDS: "10",
        SDGB_MEMBERSHIP_RECONCILE_INTERVAL_MS: "1000",
        SDGB_RECOVERY_HEALTH_INTERVAL_MS: "100",
        SDGB_RECOVERY_CLEAN_WINDOW_MS: "500",
        ...env,
      },
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-frontend",
      script: path.join(
        root,
        "frontend",
        "node_modules",
        "vite",
        "bin",
        "vite.js",
      ),
      args: "--host 127.0.0.1 --port 3001",
      cwd: path.join(root, "frontend"),
      env: {
        FRONTEND_API_PROXY_TARGET:
          env.FRONTEND_API_PROXY_TARGET || "http://127.0.0.1:9050",
      },
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-admin",
      script: path.join(
        root,
        "admin",
        "node_modules",
        "vite",
        "bin",
        "vite.js",
      ),
      args: "--host 127.0.0.1 --port 3002",
      cwd: path.join(root, "admin"),
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
          env.API_SHARED_SECRET ||
          env.ADMIN_PASSWORD ||
          "change-me-local-admin",
        ADMIN_PASSWORD:
          env.ADMIN_PASSWORD ||
          env.API_SHARED_SECRET ||
          "change-me-local-admin",
        ...env,
      },
      autorestart: true,
      max_restarts: 5,
    },
    sdgbWorkerApp("msh-sdgb-stable-a", "sdgb-stable-local-a", "stable"),
    sdgbWorkerApp("msh-sdgb-stable-b", "sdgb-stable-local-b", "stable"),
    sdgbWorkerApp(
      "msh-sdgb-recoverable-a",
      "sdgb-recoverable-local-a",
      "recoverable",
    ),
    sdgbWorkerApp(
      "msh-sdgb-recoverable-b",
      "sdgb-recoverable-local-b",
      "recoverable",
    ),
    {
      name: "msh-devtunnel",
      script: path.join(root, "scripts", "dev", "run-devtunnel.cjs"),
      args: "frontend",
      cwd: root,
      interpreter: process.execPath,
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-admin-devtunnel",
      script: path.join(root, "scripts", "dev", "run-devtunnel.cjs"),
      args: "admin",
      cwd: root,
      interpreter: process.execPath,
      autorestart: true,
      max_restarts: 5,
    },
  ],
};
