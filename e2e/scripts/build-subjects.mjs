import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workerDir = path.resolve(
  process.env.SDGB_WORKER_DIR || path.join(repoRoot, "sdgb-worker"),
);

assertPackage(path.join(repoRoot, "backend"), "Backend");
assertPackage(workerDir, "sdgb-worker");

runNpm(path.join(repoRoot, "backend"), ["run", "build"]);
runNpm(workerDir, ["run", "build"]);

function assertPackage(directory, label) {
  if (!existsSync(path.join(directory, "package.json"))) {
    throw new Error(
      `${label} package not found at ${directory}. ` +
        (label === "sdgb-worker"
          ? "Set SDGB_WORKER_DIR to the standalone worker checkout."
          : ""),
    );
  }
}

function runNpm(cwd, args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error("npm_execpath is unavailable; invoke this script through npm");
  }
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
