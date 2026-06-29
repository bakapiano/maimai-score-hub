import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

const root = path.resolve(process.env.ARTIFACT_ROOT || "/data/artifacts");
const secret = process.env.ARTIFACT_SHARED_SECRET || "";
const maxBodyBytes = positiveInt("RAW_RESPONSE_MAX_BODY_BYTES", 2 * 1024 * 1024);
const maxTotalBytes = positiveInt("RAW_RESPONSE_MAX_TOTAL_BYTES", 20 * 1024 * 1024 * 1024);
const cleanupIntervalMs = positiveInt("ARTIFACT_CLEANUP_INTERVAL_MS", 10 * 60 * 1000);
const defaultTtlHours = positiveInt("RAW_RESPONSE_DEFAULT_TTL_HOURS", 24);
const errorTtlDays = positiveInt("RAW_RESPONSE_ERROR_TTL_DAYS", 7);
const port = positiveInt("PORT", 3901);

await fs.mkdir(root, { recursive: true });
setInterval(() => void cleanupArtifacts(), cleanupIntervalMs).unref();

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && req.url === "/artifacts/raw-response") {
      await handleWrite(req, res);
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/artifacts/")) {
      await handleRead(req, res);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`artifact service listening on ${port}, root=${root}`);
});

async function handleWrite(req, res) {
  const input = await readJson(req, maxBodyBytes * 2);
  const environment = safeEnvironment(input.environment);
  const jobId = safeSegment(input.jobId || "unknown");
  const urlGroup = safeUrlGroup(input.urlGroup || "unknown");
  const statusCode = Number.isFinite(Number(input.statusCode))
    ? Math.max(0, Math.floor(Number(input.statusCode)))
    : 0;
  const body = Buffer.from(String(input.bodyBase64 || ""), "base64");
  if (body.length > maxBodyBytes) {
    sendJson(res, 200, { artifactKey: null, skipped: true, reason: "body_too_large" });
    return;
  }

  const hash = createHash("sha256").update(body).digest("hex");
  const contentType = String(input.contentType || "text/plain");
  const ext = contentType.includes("json") ? "json" : contentType.includes("html") ? "html" : "txt";
  const createdAt = parseDate(input.createdAt);
  const y = String(createdAt.getFullYear()).padStart(4, "0");
  const m = String(createdAt.getMonth() + 1).padStart(2, "0");
  const d = String(createdAt.getDate()).padStart(2, "0");
  const dirKey = `raw-response/${environment}/${y}/${m}/${d}/job_${jobId}`;
  const seq = Date.now().toString(36);
  const file = `${seq}_${urlGroup}_${statusCode}_${hash.slice(0, 8)}.${ext}.gz`;
  const artifactKey = `${dirKey}/${file}`;
  const targetPath = resolveArtifactPath(artifactKey);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const compressed = await gzipAsync(body);
  await fs.writeFile(targetPath, compressed);
  await fs.writeFile(
    `${targetPath}.json`,
    JSON.stringify(
      {
        artifactKey,
        environment,
        jobId,
        workerId: String(input.workerId || ""),
        botFriendCode: String(input.botFriendCode || ""),
        urlGroup,
        statusCode,
        bodyHash: `sha256:${hash}`,
        contentType,
        storedBytes: compressed.length,
        createdAt: createdAt.toISOString(),
        expiresAt: getExpiresAt(createdAt, statusCode).toISOString(),
      },
      null,
      2,
    ),
  );
  sendJson(res, 200, {
    artifactKey,
    storedBytes: compressed.length,
    bodyHash: `sha256:${hash}`,
  });
}

async function handleRead(req, res) {
  const artifactKey = decodeURIComponent(req.url.slice("/artifacts/".length));
  const file = resolveArtifactPath(artifactKey);
  const stat = await fs.stat(file);
  res.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": stat.size,
    "content-disposition": `inline; filename="${path.basename(file)}"`,
  });
  createReadStream(file).pipe(res);
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("request_body_too_large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isAuthorized(req) {
  if (!secret) {
    return false;
  }
  const header = req.headers.authorization || "";
  return header === `Bearer ${secret}`;
}

function resolveArtifactPath(artifactKey) {
  if (!artifactKey.startsWith("raw-response/prod/") && !artifactKey.startsWith("raw-response/dev/")) {
    throw new Error("invalid_artifact_prefix");
  }
  const resolved = path.resolve(root, artifactKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("invalid_artifact_path");
  }
  return resolved;
}

function safeEnvironment(value) {
  return value === "prod" ? "prod" : "dev";
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function safeUrlGroup(value) {
  return String(value).replace(/[^a-z0-9._-]/gi, "_").slice(0, 128) || "unknown";
}

function parseDate(value) {
  const parsed = value ? new Date(String(value)) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getExpiresAt(createdAt, statusCode) {
  const ttlMs =
    statusCode >= 400 || statusCode === 567
      ? errorTtlDays * 24 * 60 * 60 * 1000
      : defaultTtlHours * 60 * 60 * 1000;
  return new Date(createdAt.getTime() + ttlMs);
}

async function cleanupArtifacts() {
  const rows = [];
  await collectFiles(root, rows);
  const now = Date.now();
  let total = 0;
  for (const row of rows) {
    total += row.size;
    if (row.path.endsWith(".json")) {
      continue;
    }
    const meta = await readMeta(row.path);
    if (meta?.expiresAt && new Date(meta.expiresAt).getTime() < now) {
      await removeArtifactPair(row.path);
    }
  }
  if (total <= maxTotalBytes) {
    return;
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const row of rows) {
    if (total <= maxTotalBytes) {
      break;
    }
    if (row.path.endsWith(".json")) {
      continue;
    }
    total -= row.size;
    await removeArtifactPair(row.path);
  }
}

async function collectFiles(dir, rows) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, rows);
      continue;
    }
    const stat = await fs.stat(full);
    rows.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
  }
}

async function readMeta(file) {
  try {
    return JSON.parse(await fs.readFile(`${file}.json`, "utf8"));
  } catch {
    return null;
  }
}

async function removeArtifactPair(file) {
  await fs.rm(file, { force: true });
  await fs.rm(`${file}.json`, { force: true });
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function positiveInt(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
