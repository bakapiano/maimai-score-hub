import { apiUrl } from "../../api/baseUrl";
import {
  ANDROID_STATUS_EVENT,
  getAndroidHostBridge,
  requestAndroidDxnet,
  startAndroidOAuth,
  type AndroidOperationMode,
  type AndroidUpdateStatus,
} from "./androidUpdateBridge";
import {
  loadAndroidWorkflow,
  type AndroidScoreHubRequest,
  type AndroidWorkflowProgress,
  type AndroidWorkflowResult,
} from "./androidWorkflowLoader";

let activeMode: AndroidOperationMode | null = null;
const latestStatus = new Map<AndroidOperationMode, AndroidUpdateStatus>();

export function getAndroidRuntimeSnapshot(mode: AndroidOperationMode) {
  const bridge = getAndroidHostBridge();
  return {
    available: bridge !== null,
    version: bridge?.getVersion() ?? "",
    running: activeMode === mode,
    status: latestStatus.get(mode) ?? null,
  };
}

export function getActiveAndroidWorkflowMode(): AndroidOperationMode | null {
  return activeMode;
}

export async function runAndroidWorkflow(
  mode: AndroidOperationMode,
): Promise<AndroidWorkflowResult | null> {
  if (activeMode) {
    emitStatus({
      mode,
      message: "已有手机操作正在进行",
      terminal: true,
      success: false,
      stage: "busy",
      progress: 0,
    });
    return null;
  }
  const bridge = getAndroidHostBridge();
  if (!bridge) {
    emitStatus({
      mode,
      message: "Android 原生桥接暂时不可用，请重新打开页面",
      terminal: true,
      success: false,
      stage: "bridge",
      progress: 0,
    });
    return null;
  }

  activeMode = mode;
  emitStatus({
    mode,
    message: "正在获取动态更新流程…",
    terminal: false,
    success: false,
    stage: "workflow",
    progress: 2,
  });
  try {
    const workflow = await loadAndroidWorkflow();
    const report = (status: AndroidWorkflowProgress) => {
      emitStatus({
        mode,
        message: status.message,
        terminal: false,
        success: false,
        ...(status.stage ? { stage: status.stage } : {}),
        ...(typeof status.progress === "number"
          ? { progress: status.progress }
          : {}),
        ...(status.details ? { details: status.details } : {}),
        workflowVersion: workflow.workflowMetadata.workflowVersion,
      });
    };
    const result = await workflow.run({
      mode,
      startOAuth: () =>
        startAndroidOAuth((nativeStatus) => {
          report({
            mode,
            stage: "oauth",
            progress: nativeStatus.success && nativeStatus.terminal ? 26 : 14,
            message: nativeStatus.message,
          });
        }),
      dxnetRequest: requestAndroidDxnet,
      scoreHubRequest,
      report,
      sleep: (milliseconds) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
      log: (level, message) => {
        if (level === "warn") {
          console.warn(`[Android Workflow] ${message}`);
        } else {
          console.info(`[Android Workflow] ${message}`);
        }
      },
    });
    const message =
      result.message || (mode === "login" ? "微信登录成功" : "代理更新完成");
    emitStatus({
      mode,
      message,
      terminal: true,
      success: true,
      stage: "completed",
      progress: 100,
      workflowVersion: workflow.workflowMetadata.workflowVersion,
    });
    if (mode === "login" && result.token) {
      window.localStorage.setItem("netbot_token", result.token);
      window.setTimeout(() => window.location.replace("/app"), 120);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStatus({
      mode,
      message: `${mode === "login" ? "登录失败" : "更新失败"}：${message}`,
      terminal: true,
      success: false,
      stage: "failed",
      progress: 0,
    });
    return null;
  } finally {
    activeMode = null;
  }
}

async function scoreHubRequest(request: AndroidScoreHubRequest) {
  const path = normalizeApiPath(request.path);
  const headers = new Headers({ Accept: "application/json" });
  const token = window.localStorage.getItem("netbot_token") ?? "";
  if (request.authenticated !== false && token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let body: string | undefined;
  if (request.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(request.body);
  }
  const response = await fetch(apiUrl(path), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  if (!response.ok) {
    throw new Error(extractApiError(value, response.status));
  }
  return value;
}

function normalizeApiPath(path: string) {
  const value = String(path ?? "");
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error("动态 Workflow 请求了无效的 Score Hub API 路径");
  }
  return value;
}

function extractApiError(value: unknown, status: number) {
  if (value && typeof value === "object") {
    const candidate = value as { message?: unknown; error?: unknown };
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
    if (typeof candidate.error === "string") {
      return candidate.error;
    }
  }
  if (typeof value === "string" && value.trim()) {
    return value.slice(0, 500);
  }
  return `Score Hub API HTTP ${status}`;
}

function emitStatus(status: AndroidUpdateStatus) {
  if (status.mode) {
    latestStatus.set(status.mode, status);
  }
  window.dispatchEvent(
    new CustomEvent(ANDROID_STATUS_EVENT, { detail: status }),
  );
  console.info(`[MaiScoreHubWorkflow] ${JSON.stringify(status)}`);
}

declare global {
  interface Window {
    __mshStartAndroidE2E?: (mode: AndroidOperationMode) => void;
  }
}

if (typeof window !== "undefined") {
  window.__mshStartAndroidE2E = (mode) => {
    if (mode === "recent" || mode === "full" || mode === "login") {
      void runAndroidWorkflow(mode);
    }
  };
}
