export type AndroidUpdateMode = "recent" | "full";
export type AndroidOperationMode = AndroidUpdateMode | "login";

export type AndroidUpdateStatus = {
  message: string;
  terminal: boolean;
  success: boolean;
  mode?: AndroidOperationMode;
  stage?: string;
  progress?: number;
  details?: { current?: number; total?: number };
  workflowVersion?: string;
};

export type AndroidDxnetRequest = {
  method: "GET" | "POST";
  path: string;
  form?: Record<string, string>;
  attachCsrfToken?: boolean;
};

export type AndroidDxnetResponse = {
  status: number;
  url: string;
  body: string;
};

export type AndroidAppUpdateStatus = {
  requestId: string;
  message: string;
  stage: string;
  progress: number;
  terminal: boolean;
  success: boolean;
  error?: string;
  releaseId?: string;
  versionName?: string;
};

export interface AndroidHostBridge {
  isAvailable(): boolean;
  getVersion(): string;
  getBridgeApiVersion(): number;
  isOAuthRunning(): boolean;
  startOAuth(requestId: string): void;
  dxnetRequest(requestId: string, requestJson: string): void;
  getVersionCode?(): number;
  getPackageName?(): string;
  getReleaseChannel?(): "debug" | "beta" | "stable";
  isAppUpdateRunning?(): boolean;
  startAppUpdate?(requestId: string, releaseId: string): void;
}

export interface AndroidAppUpdateBridge extends AndroidHostBridge {
  getVersionCode(): number;
  getPackageName(): string;
  getReleaseChannel(): "debug" | "beta" | "stable";
  isAppUpdateRunning(): boolean;
  startAppUpdate(requestId: string, releaseId: string): void;
}

declare global {
  interface Window {
    MaiScoreHubAndroid?: AndroidHostBridge;
  }
}

export const ANDROID_READY_EVENT = "msh-android-ready";
export const ANDROID_STATUS_EVENT = "msh-android-update-status";
export const ANDROID_OAUTH_STATUS_EVENT = "msh-android-oauth-status";
export const ANDROID_HTTP_RESULT_EVENT = "msh-android-http-result";
export const ANDROID_APP_UPDATE_STATUS_EVENT =
  "msh-android-app-update-status";

const OAUTH_TIMEOUT_MS = 6 * 60_000;
const HTTP_TIMEOUT_MS = 2 * 60_000;
const APP_UPDATE_TIMEOUT_MS = 15 * 60_000;

export function isAndroidHostBridge(
  value: unknown,
): value is AndroidHostBridge {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AndroidHostBridge>;
  return (
    typeof candidate.isAvailable === "function" &&
    typeof candidate.getVersion === "function" &&
    typeof candidate.getBridgeApiVersion === "function" &&
    typeof candidate.isOAuthRunning === "function" &&
    typeof candidate.startOAuth === "function" &&
    typeof candidate.dxnetRequest === "function"
  );
}

export function getAndroidHostBridge(): AndroidHostBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = window.MaiScoreHubAndroid;
  if (!isAndroidHostBridge(bridge)) {
    return null;
  }
  try {
    return bridge.isAvailable() ? bridge : null;
  } catch {
    return null;
  }
}

export const getAndroidUpdateBridge = getAndroidHostBridge;
export const getAndroidLoginBridge = getAndroidHostBridge;

export function getAndroidAppUpdateBridge(): AndroidAppUpdateBridge | null {
  const bridge = getAndroidHostBridge();
  if (!bridge || bridge.getBridgeApiVersion() < 2) {
    return null;
  }
  if (
    typeof bridge.getVersionCode !== "function" ||
    typeof bridge.getPackageName !== "function" ||
    typeof bridge.getReleaseChannel !== "function" ||
    typeof bridge.isAppUpdateRunning !== "function" ||
    typeof bridge.startAppUpdate !== "function"
  ) {
    return null;
  }
  return bridge as AndroidAppUpdateBridge;
}

export async function startAndroidAppUpdate(
  releaseId: string,
  onStatus?: (status: AndroidAppUpdateStatus) => void,
): Promise<void> {
  const bridge = getAndroidAppUpdateBridge();
  if (!bridge) {
    throw new Error("当前 Android 版本尚未提供应用更新安装器");
  }
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("等待 Android 应用更新超时"));
    }, APP_UPDATE_TIMEOUT_MS);
    const handler = (event: Event) => {
      const status = parseAndroidAppUpdateStatus(
        (event as CustomEvent<unknown>).detail,
      );
      if (!status || status.requestId !== requestId) {
        return;
      }
      onStatus?.(status);
      if (!status.terminal) {
        return;
      }
      cleanup();
      if (status.success) {
        resolve();
      } else {
        reject(new Error(status.error || status.message));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(ANDROID_APP_UPDATE_STATUS_EVENT, handler);
    };
    window.addEventListener(ANDROID_APP_UPDATE_STATUS_EVENT, handler);
    try {
      bridge.startAppUpdate(requestId, releaseId);
    } catch (error) {
      cleanup();
      reject(toError(error));
    }
  });
}

export async function startAndroidOAuth(
  onStatus?: (status: AndroidNativeOAuthStatus) => void,
): Promise<void> {
  const bridge = requireBridge();
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("等待手机 OAuth 超时"));
    }, OAUTH_TIMEOUT_MS);
    const handler = (event: Event) => {
      const status = parseOAuthStatus((event as CustomEvent<unknown>).detail);
      if (!status || status.requestId !== requestId) {
        return;
      }
      onStatus?.(status);
      if (!status.terminal) {
        return;
      }
      cleanup();
      if (status.success) {
        resolve();
      } else {
        reject(new Error(status.error || status.message || "微信授权失败"));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(ANDROID_OAUTH_STATUS_EVENT, handler);
    };
    window.addEventListener(ANDROID_OAUTH_STATUS_EVENT, handler);
    try {
      bridge.startOAuth(requestId);
    } catch (error) {
      cleanup();
      reject(toError(error));
    }
  });
}

export async function requestAndroidDxnet(
  request: AndroidDxnetRequest,
): Promise<AndroidDxnetResponse> {
  const bridge = requireBridge();
  const requestId = crypto.randomUUID();
  return new Promise<AndroidDxnetResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("手机 DXNET 请求超时"));
    }, HTTP_TIMEOUT_MS);
    const handler = (event: Event) => {
      const result = parseHttpResult((event as CustomEvent<unknown>).detail);
      if (!result || result.requestId !== requestId) {
        return;
      }
      cleanup();
      if (result.success && result.response) {
        resolve(result.response);
      } else {
        reject(new Error(result.error || "手机 DXNET 请求失败"));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(ANDROID_HTTP_RESULT_EVENT, handler);
    };
    window.addEventListener(ANDROID_HTTP_RESULT_EVENT, handler);
    try {
      bridge.dxnetRequest(requestId, JSON.stringify(request));
    } catch (error) {
      cleanup();
      reject(toError(error));
    }
  });
}

export function parseAndroidUpdateStatus(
  value: unknown,
): AndroidUpdateStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AndroidUpdateStatus>;
  if (
    typeof candidate.message !== "string" ||
    typeof candidate.terminal !== "boolean" ||
    typeof candidate.success !== "boolean"
  ) {
    return null;
  }
  const mode = isOperationMode(candidate.mode) ? candidate.mode : undefined;
  const progress =
    typeof candidate.progress === "number" &&
    Number.isFinite(candidate.progress)
      ? Math.max(0, Math.min(100, candidate.progress))
      : undefined;
  const details =
    candidate.details && typeof candidate.details === "object"
      ? {
          ...(typeof candidate.details.current === "number"
            ? { current: candidate.details.current }
            : {}),
          ...(typeof candidate.details.total === "number"
            ? { total: candidate.details.total }
            : {}),
        }
      : undefined;
  return {
    message: candidate.message,
    terminal: candidate.terminal,
    success: candidate.success,
    ...(mode ? { mode } : {}),
    ...(typeof candidate.stage === "string" ? { stage: candidate.stage } : {}),
    ...(progress === undefined ? {} : { progress }),
    ...(details ? { details } : {}),
    ...(typeof candidate.workflowVersion === "string"
      ? { workflowVersion: candidate.workflowVersion }
      : {}),
  };
}

export function parseAndroidAppUpdateStatus(
  value: unknown,
): AndroidAppUpdateStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AndroidAppUpdateStatus>;
  if (
    typeof candidate.requestId !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.stage !== "string" ||
    typeof candidate.progress !== "number" ||
    !Number.isFinite(candidate.progress) ||
    typeof candidate.terminal !== "boolean" ||
    typeof candidate.success !== "boolean"
  ) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    message: candidate.message,
    stage: candidate.stage,
    progress: Math.max(0, Math.min(100, candidate.progress)),
    terminal: candidate.terminal,
    success: candidate.success,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
    ...(typeof candidate.releaseId === "string"
      ? { releaseId: candidate.releaseId }
      : {}),
    ...(typeof candidate.versionName === "string"
      ? { versionName: candidate.versionName }
      : {}),
  };
}

export type AndroidNativeOAuthStatus = {
  requestId: string;
  message: string;
  terminal: boolean;
  success: boolean;
  error?: string;
};

function parseOAuthStatus(value: unknown): AndroidNativeOAuthStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AndroidNativeOAuthStatus>;
  if (
    typeof candidate.requestId !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.terminal !== "boolean" ||
    typeof candidate.success !== "boolean"
  ) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    message: candidate.message,
    terminal: candidate.terminal,
    success: candidate.success,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
  };
}

function parseHttpResult(value: unknown): {
  requestId: string;
  success: boolean;
  response?: AndroidDxnetResponse;
  error?: string;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    requestId?: unknown;
    success?: unknown;
    status?: unknown;
    url?: unknown;
    body?: unknown;
    error?: unknown;
  };
  if (
    typeof candidate.requestId !== "string" ||
    typeof candidate.success !== "boolean"
  ) {
    return null;
  }
  if (candidate.success) {
    if (
      typeof candidate.status !== "number" ||
      typeof candidate.url !== "string" ||
      typeof candidate.body !== "string"
    ) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      success: true,
      response: {
        status: candidate.status,
        url: candidate.url,
        body: candidate.body,
      },
    };
  }
  return {
    requestId: candidate.requestId,
    success: false,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
  };
}

function requireBridge(): AndroidHostBridge {
  const bridge = getAndroidHostBridge();
  if (!bridge) {
    throw new Error("Android 原生桥接暂时不可用，请重新打开页面");
  }
  return bridge;
}

function isOperationMode(value: unknown): value is AndroidOperationMode {
  return value === "recent" || value === "full" || value === "login";
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
