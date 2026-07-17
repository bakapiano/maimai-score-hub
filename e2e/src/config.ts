import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export type E2eInfraMode = "local" | "containers";

export interface E2eConfig {
  infraMode: E2eInfraMode;
  workerDir: string;
  localEnv: Readonly<Record<string, string>>;
  apiSecret: string;
  timeoutMs: number;
}

export function loadConfig(): E2eConfig {
  const infraMode = process.env.E2E_INFRA ?? "local";
  if (infraMode !== "local" && infraMode !== "containers") {
    throw new Error(
      `E2E_INFRA must be local or containers; received ${infraMode}`,
    );
  }
  const localEnv = readEnvFile(path.join(repoRoot, ".env.local-dev"));
  return {
    infraMode,
    workerDir: path.resolve(
      process.env.SDGB_WORKER_DIR || path.join(repoRoot, "sdgb-worker"),
    ),
    localEnv,
    apiSecret: process.env.E2E_API_SHARED_SECRET || "msh-e2e-local-secret",
    timeoutMs: positiveInt(process.env.E2E_TIMEOUT_MS, 180_000),
  };
}

export function configuredValue(
  localEnv: Readonly<Record<string, string>>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = process.env[key] ?? localEnv[key];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
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

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
