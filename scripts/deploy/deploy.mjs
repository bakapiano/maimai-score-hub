#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function usage() {
  console.error(`Usage: node scripts/deploy/deploy.mjs <frontend|backend|admin> [options]

Options:
  --allow-dirty                Allow deploying with uncommitted changes in target paths
  --skip-checks                Skip lint/test checks (build still runs for static targets)
  --dry-run                    Run local checks & packaging, print SSH plan without uploading
  --confirm-dxnet-v2-cutover   (backend) Pass DXNET_V2_CUTOVER_CONFIRMED=true
  -h, --help                   Show this help

Configuration:
  Reads .env.deploy.local from repo root (gitignored; see .env.deploy.example).
  Environment variables override values in .env.deploy.local.
`);
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function run(cmd, args, opts = {}) {
  const display = `${cmd} ${args.join(" ")}`;
  console.log(`\n$ ${display}`);
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    input: opts.input,
    shell: opts.shell ?? false,
    env: opts.env ?? process.env,
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`Command failed with exit code ${res.status}: ${display}`);
  }
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}\n${res.stderr}`);
  }
  return res.stdout.trim();
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpm(prefixDir, args) {
  const fullArgs = prefixDir ? ["--prefix", prefixDir, ...args] : args;
  run(npmCmd(), fullArgs, { shell: process.platform === "win32" });
}

function checkGitState(scopedPaths, allowDirty) {
  const sha = runCapture("git", ["rev-parse", "HEAD"]);
  const shortSha = sha.slice(0, 7);
  const scopedStatus = runCapture("git", ["status", "--porcelain", "--", ...scopedPaths]);
  if (scopedStatus) {
    if (!allowDirty) {
      console.error(
        `\nRefusing to deploy: uncommitted changes detected in target paths (${scopedPaths.join(", ")}):\n${scopedStatus}\n\nCommit your changes first, or pass --allow-dirty to override.`,
      );
      process.exit(1);
    }
    console.warn(
      `\n[WARN] Deploying with dirty working tree (--allow-dirty):\n${scopedStatus}`,
    );
    return `${sha}-dirty-${Math.floor(Date.now() / 1000)}`;
  }
  console.log(`Git HEAD: ${shortSha} (${sha}) [clean in ${scopedPaths.join(", ")}]`);
  return sha;
}

function sshCommonArgs(cfg) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
  ];
  if (cfg.jump) {
    args.push("-o", `ProxyJump=${cfg.jump}`);
  }
  if (cfg.key) {
    args.push("-i", cfg.key);
  }
  return args;
}

function scpUpload(localFile, remoteFile, cfg) {
  const args = [
    ...sshCommonArgs(cfg),
    "-P",
    String(cfg.port),
    localFile,
    `${cfg.user}@${cfg.host}:${remoteFile}`,
  ];
  run("scp", args);
}

function sshRunRemoteScript(scriptFile, remoteArgs, cfg) {
  const scriptContent = fs
    .readFileSync(scriptFile, "utf8")
    .replace(/\r\n/g, "\n");
  const args = [
    ...sshCommonArgs(cfg),
    "-p",
    String(cfg.port),
    `${cfg.user}@${cfg.host}`,
    `bash -s -- ${remoteArgs.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ")}`,
  ];
  run("ssh", args, { input: scriptContent });
}

function copyBackendStaging(stagingDir) {
  const excludes = new Set([
    path.normalize("backend/.env"),
    path.normalize("backend/covers"),
    path.normalize("backend/android-releases"),
    path.normalize("backend/assets"),
    path.normalize("backend/dist"),
    path.normalize("backend/node_modules"),
    path.normalize("shared/dist"),
    path.normalize("shared/node_modules"),
  ]);

  const copyFiltered = (relPath) => {
    const norm = path.normalize(relPath);
    if (excludes.has(norm)) return;
    const src = path.join(REPO_ROOT, norm);
    const dst = path.join(stagingDir, norm);
    const stat = fs.lstatSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyFiltered(path.join(norm, entry));
      }
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  };

  for (const top of ["backend", "shared", "package.json", "package-lock.json"]) {
    if (fs.existsSync(path.join(REPO_ROOT, top))) {
      copyFiltered(top);
    }
  }

  // Re-include the DX score gauge icons expected by backend image build
  const picSrcDir = path.join(REPO_ROOT, "backend", "assets", "mai", "pic");
  const picDstDir = path.join(stagingDir, "backend", "assets", "mai", "pic");
  if (fs.existsSync(picSrcDir)) {
    fs.mkdirSync(picDstDir, { recursive: true });
    for (const file of fs.readdirSync(picSrcDir)) {
      if (file.startsWith("UI_GAM_Gauge_DXScoreIcon_") && file.endsWith(".png")) {
        fs.copyFileSync(path.join(picSrcDir, file), path.join(picDstDir, file));
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const target = args[0];
  if (!["frontend", "backend", "admin"].includes(target)) {
    console.error(`Unknown deploy target: ${target}`);
    usage();
    process.exit(1);
  }

  const allowDirty = args.includes("--allow-dirty");
  const skipChecks = args.includes("--skip-checks");
  const dryRun = args.includes("--dry-run");
  const confirmDxnetV2Cutover = args.includes("--confirm-dxnet-v2-cutover");

  loadLocalEnv(path.join(REPO_ROOT, ".env.deploy.local"));

  const cfg = {
    host: process.env.DEPLOY_HOST || "",
    user: process.env.DEPLOY_USER || "root",
    port: process.env.DEPLOY_PORT || "22",
    jump: process.env.DEPLOY_JUMP || "",
    key: process.env.DEPLOY_SSH_KEY || "",
    webRoot: process.env.DEPLOY_WEB_ROOT || "/var/lib/maimai-score-hub-web",
    backendPath: process.env.DEPLOY_BACKEND_PATH || "/root/maimai-score-hub-backend",
  };

  if (!cfg.host) {
    console.error(
      "Missing DEPLOY_HOST. Copy .env.deploy.example to .env.deploy.local and fill in your server details.",
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `msh-deploy-${target}-`));

  try {
    console.log(
      `==> Deploying [${target}] to ${cfg.user}@${cfg.host}:${cfg.port}${cfg.jump ? ` (via ${cfg.jump})` : ""}${dryRun ? " [DRY-RUN]" : ""}`,
    );

    if (target === "frontend") {
      const release = checkGitState(["frontend", "shared"], allowDirty);
      if (!skipChecks) {
        runNpm("frontend", ["run", "typecheck"]);
        runNpm("frontend", ["run", "lint:check"]);
        runNpm("frontend", ["test"]);
      }
      runNpm("frontend", ["run", "build"]);

      const archiveName = `maimai-score-hub-frontend-${release}.tgz`;
      const localArchive = path.join(tmpDir, archiveName);
      const remoteArchive = `/tmp/${archiveName}`;
      run("tar", ["-czf", localArchive, "-C", path.join(REPO_ROOT, "frontend", "dist"), "."]);
      const sizeKb = (fs.statSync(localArchive).size / 1024).toFixed(1);
      console.log(`Packaged ${archiveName} (${sizeKb} KB)`);

      if (dryRun) {
        console.log(`[DRY-RUN] Would upload to ${remoteArchive} and activate under ${cfg.webRoot}`);
        return;
      }

      scpUpload(localArchive, remoteArchive, cfg);
      sshRunRemoteScript(
        path.join(__dirname, "remote-activate-frontend.sh"),
        [cfg.webRoot, remoteArchive, release],
        cfg,
      );
    } else if (target === "admin") {
      const release = checkGitState(["admin", "shared"], allowDirty);
      if (!skipChecks) {
        runNpm("admin", ["run", "lint"]);
      }
      runNpm("admin", ["run", "build"]);

      const archiveName = `maimai-score-hub-admin-${release}.tgz`;
      const localArchive = path.join(tmpDir, archiveName);
      const remoteArchive = `/tmp/${archiveName}`;
      run("tar", ["-czf", localArchive, "-C", path.join(REPO_ROOT, "admin", "dist"), "."]);
      const sizeKb = (fs.statSync(localArchive).size / 1024).toFixed(1);
      console.log(`Packaged ${archiveName} (${sizeKb} KB)`);

      if (dryRun) {
        console.log(`[DRY-RUN] Would upload to ${remoteArchive} and activate under ${cfg.webRoot}`);
        return;
      }

      scpUpload(localArchive, remoteArchive, cfg);
      sshRunRemoteScript(
        path.join(__dirname, "remote-activate-admin.sh"),
        [cfg.webRoot, remoteArchive, release],
        cfg,
      );
    } else if (target === "backend") {
      const release = checkGitState(["backend", "shared"], allowDirty);
      runNpm("shared", ["run", "build"]);
      if (!skipChecks) {
        runNpm("backend", ["run", "typecheck"]);
        runNpm("backend", ["run", "build"]);
        runNpm("backend", ["test"]);
      }

      const stagingDir = path.join(tmpDir, "staging");
      fs.mkdirSync(stagingDir, { recursive: true });
      copyBackendStaging(stagingDir);

      const archiveName = `maimai-score-hub-backend-${release}.tgz`;
      const localArchive = path.join(tmpDir, archiveName);
      const remoteArchive = `/tmp/${archiveName}`;
      run("tar", ["-czf", localArchive, "-C", stagingDir, "."]);
      const sizeKb = (fs.statSync(localArchive).size / 1024).toFixed(1);
      console.log(`Packaged ${archiveName} (${sizeKb} KB)`);

      if (dryRun) {
        console.log(
          `[DRY-RUN] Would upload to ${remoteArchive} and rolling-deploy under ${cfg.backendPath}`,
        );
        return;
      }

      scpUpload(localArchive, remoteArchive, cfg);
      sshRunRemoteScript(
        path.join(__dirname, "remote-deploy-backend.sh"),
        [cfg.backendPath, remoteArchive, release, String(confirmDxnetV2Cutover)],
        cfg,
      );
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ [${target}] deployed successfully in ${elapsed}s`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
