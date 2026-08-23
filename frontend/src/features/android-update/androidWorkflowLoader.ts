import { apiUrl } from "../../api/baseUrl";
import { getAndroidHostBridge } from "./androidUpdateBridge";
import { sha256Hex } from "./androidWorkflowIntegrity";

export type AndroidWorkflowManifest = {
  workflowVersion: string;
  workflowApiVersion: number;
  bridgeApiVersion: number;
  entry: string;
  sha256: string;
  bytes: number;
};

export type AndroidWorkflowModule = {
  workflowMetadata: {
    workflowVersion: string;
    workflowApiVersion: number;
    bridgeApiVersion: number;
    parserVersion: string;
  };
  run(context: AndroidWorkflowContext): Promise<AndroidWorkflowResult>;
};

export type AndroidWorkflowContext = {
  mode: "recent" | "full" | "login";
  startOAuth(): Promise<void>;
  dxnetRequest(request: unknown): Promise<unknown>;
  scoreHubRequest(request: AndroidScoreHubRequest): Promise<unknown>;
  report(status: AndroidWorkflowProgress): void;
  sleep(milliseconds: number): Promise<void>;
  log?(level: string, message: string): void;
};

export type AndroidWorkflowProgress = {
  mode?: "recent" | "full" | "login";
  message: string;
  stage?: string;
  progress?: number;
  details?: { current?: number; total?: number };
};

export type AndroidWorkflowResult = {
  message?: string;
  token?: string;
  workflowVersion?: string;
  parserVersion?: string;
  submitted?: number;
  changed?: number;
  scoreVersion?: number;
};

export type AndroidScoreHubRequest = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  authenticated?: boolean;
};

let cachedWorkflow:
  { version: string; module: AndroidWorkflowModule } | undefined;

export async function loadAndroidWorkflow(): Promise<AndroidWorkflowModule> {
  const bridge = getAndroidHostBridge();
  if (!bridge) {
    throw new Error("Android 原生桥接暂时不可用");
  }
  const manifest = await fetchManifest();
  if (manifest.bridgeApiVersion > bridge.getBridgeApiVersion()) {
    throw new Error(
      `当前 MaiScoreHub APK Bridge v${bridge.getBridgeApiVersion()}，动态流程需要 v${manifest.bridgeApiVersion}`,
    );
  }
  if (manifest.workflowApiVersion !== 1) {
    throw new Error(
      `动态 Workflow API v${manifest.workflowApiVersion} 暂未适配`,
    );
  }
  if (cachedWorkflow?.version === manifest.workflowVersion) {
    return cachedWorkflow.module;
  }

  const response = await fetch(apiUrl(manifest.entry), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`下载动态 Workflow 失败：HTTP ${response.status}`);
  }
  const source = await response.text();
  if (new TextEncoder().encode(source).byteLength !== manifest.bytes) {
    throw new Error("动态 Workflow 文件长度校验失败");
  }
  const digest = await sha256Hex(source);
  if (digest !== manifest.sha256.toLowerCase()) {
    throw new Error("动态 Workflow SHA-256 校验失败");
  }

  const moduleUrl = URL.createObjectURL(
    new Blob([source], { type: "application/javascript" }),
  );
  try {
    const loaded = (await import(
      /* @vite-ignore */ moduleUrl
    )) as Partial<AndroidWorkflowModule>;
    if (
      typeof loaded.run !== "function" ||
      loaded.workflowMetadata?.workflowVersion !== manifest.workflowVersion ||
      loaded.workflowMetadata.workflowApiVersion !==
        manifest.workflowApiVersion ||
      loaded.workflowMetadata.bridgeApiVersion !== manifest.bridgeApiVersion
    ) {
      throw new Error("动态 Workflow 导出契约无效");
    }
    const module = loaded as AndroidWorkflowModule;
    cachedWorkflow = { version: manifest.workflowVersion, module };
    return module;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

async function fetchManifest(): Promise<AndroidWorkflowManifest> {
  const response = await fetch(apiUrl("/android/workflow/manifest"), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`获取动态 Workflow Manifest 失败：HTTP ${response.status}`);
  }
  const value = (await response.json()) as unknown;
  if (!isManifest(value)) {
    throw new Error("动态 Workflow Manifest 格式无效");
  }
  return value;
}

function isManifest(value: unknown): value is AndroidWorkflowManifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AndroidWorkflowManifest>;
  return (
    typeof candidate.workflowVersion === "string" &&
    typeof candidate.workflowApiVersion === "number" &&
    typeof candidate.bridgeApiVersion === "number" &&
    typeof candidate.entry === "string" &&
    candidate.entry.startsWith("/android/workflow/") &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(candidate.sha256) &&
    typeof candidate.bytes === "number" &&
    candidate.bytes > 0
  );
}
