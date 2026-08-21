import { Alert, Button, Loader, Stack, Text } from "@mantine/core";
import {
  HttpClientError,
  PollAborted,
  PollDead,
  PollTimeout,
  fetchForPoll,
  pollWithBackoff,
} from "../utils/poll";
import { IconInfoCircle, IconQrcode } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifications } from "@mantine/notifications";
import { apiUrl } from "../api/baseUrl";
import { QrCredentialInput } from "./QrCredentialInput";
import {
  LOGIN_TASK_CACHE_TTL_MS,
  clearPendingQrLogin,
  persistPendingQrLogin,
  readPendingQrLogin,
} from "../utils/loginTaskCache";

const SLOW_JOB_NOTICE_MS = 30_000;
const STATUS_LABEL: Record<string, string> = {
  pending: "正在准备登录…",
  adding_rival: "正在添加好友…",
  waiting_snapshot: "确认好友身份中（通常需要 1 分钟）…",
};

type QrLoginJson = {
  kind?: "fast" | "async";
  token?: string | null;
  attemptId?: string | null;
  message?: string | { code?: string; message?: string };
  error?: string | null;
};

async function postQrLogin(payload: FormData | string) {
  const res = await fetch(apiUrl("/auth/qr-login"), {
    method: "POST",
    headers:
      typeof payload === "string"
        ? { "Content-Type": "application/json" }
        : undefined,
    body:
      typeof payload === "string"
        ? JSON.stringify({ qrCode: payload })
        : payload,
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : null) as QrLoginJson | null;
  return { res, json };
}

function getQrLoginMessage(json: QrLoginJson | null, status: number) {
  return (
    (typeof json?.message === "object" && json.message?.message) ||
    (typeof json?.message === "string" && json.message) ||
    json?.error ||
    `HTTP ${status}`
  );
}

function isExpiredQr(json: QrLoginJson | null) {
  return (
    typeof json?.message === "object" && json.message?.code === "qr_expired"
  );
}

function showQrLoginSuccess() {
  notifications.show({ color: "green", message: "神秘二维码登录成功" });
}

/**
 * QR-code login form.
 *
 * Resilience design:
 *  - The POST returns either {kind:'fast', token} (binding already
 *    existed) or {kind:'async', attemptId} (slow path queued server-
 *    side). We persist the attemptId to localStorage so a navigation
 *    or full reload can resume the same poll instead of starting a
 *    second login attempt.
 *  - Polling uses pollWithBackoff: 1s steady cadence, 5xx/network
 *    failures get exponentially backed off and only count as a real
 *    failure after 5 in a row. 4xx propagates immediately.
 *  - onBusyChange lets the parent disable the friend-code tab while
 *    a QR attempt is in flight.
 */
export interface QrLoginFormProps {
  onSuccess: (token: string) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Disabled by parent when the friend-code tab has its own job. */
  disabled?: boolean;
}

export function QrLoginForm({
  onSuccess,
  onBusyChange,
  disabled,
}: QrLoginFormProps) {
  const [qrText, setQrText] = useState("");
  const [busy, setBusy] = useState(false);
  // Slow-path progress message rendered to the user while we poll.
  const [progress, setProgress] = useState<string | null>(null);
  const [slowNoticeVisible, setSlowNoticeVisible] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingQrJob = busy && progress !== null;

  // Bubble busy state up so the parent can disable other login modes.
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!pendingQrJob) {
      setSlowNoticeVisible(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setSlowNoticeVisible(true);
    }, SLOW_JOB_NOTICE_MS);

    return () => window.clearTimeout(timeout);
  }, [pendingQrJob]);

  /**
   * Poll the slow-path attempt status until terminal. Returns a token on
   * success; throws on failure or timeout.
   */
  const pollAttempt = useCallback(
    async (
      attemptId: string,
      signal?: AbortSignal,
      timeoutMs = LOGIN_TASK_CACHE_TTL_MS,
    ): Promise<string> => {
      return pollWithBackoff<string>(
        async () => {
          const { body } = await fetchForPoll(
            apiUrl(`/auth/qr-login/${attemptId}`),
            { signal },
          );
          const json = body as {
            status?: string;
            token?: string | null;
            error?: string | null;
          } | null;
          const status = json?.status ?? "pending";
          setProgress(STATUS_LABEL[status] ?? status);
          if (status === "matched") {
            if (json?.token) {
              return { done: true, value: String(json.token) };
            }
            throw new HttpClientError(
              502,
              body,
              "二维码登录已完成，但登录凭证缺失",
            );
          }
          if (status === "failed") {
            throw new HttpClientError(
              400,
              { message: json?.error },
              json?.error || "神秘二维码登录失败",
            );
          }
          if (
            status === "pending" ||
            status === "adding_rival" ||
            status === "waiting_snapshot"
          ) {
            return { done: false };
          }
          throw new HttpClientError(502, body, `未知的二维码任务状态：${status}`);
        },
        { intervalMs: 1_000, maxFailures: 5, signal, timeoutMs },
      );
    },
    [],
  );

  const handleAsyncLogin = useCallback(
    async (attemptId: string) => {
      const pending = persistPendingQrLogin(attemptId);
      setProgress(STATUS_LABEL.pending);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const token = await pollAttempt(
          attemptId,
          ctrl.signal,
          Math.max(1, pending.expiresAt - Date.now()),
        );
        clearPendingQrLogin();
        showQrLoginSuccess();
        onSuccess(token);
      } catch (pollErr) {
        if (pollErr instanceof PollAborted) {
          return;
        }
        clearPendingQrLogin();
        notifications.show({
          color: "red",
          title: "神秘二维码登录失败",
          message: pollErr instanceof Error ? pollErr.message : String(pollErr),
        });
      } finally {
        abortRef.current = null;
      }
    },
    [onSuccess, pollAttempt],
  );

  // Resume an in-flight attempt persisted in localStorage. Runs once
  // on mount; if the attempt has already terminated we surface the
  // result and clear the cache.
  useEffect(() => {
    const cached = readPendingQrLogin();
    if (!cached) {
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setProgress(STATUS_LABEL.pending);
    pollAttempt(
      cached.attemptId,
      ctrl.signal,
      Math.max(1, cached.expiresAt - Date.now()),
    )
      .then((token) => {
        clearPendingQrLogin();
        showQrLoginSuccess();
        onSuccess(token);
      })
      .catch((err) => {
        if (err instanceof PollAborted) {
          return;
        }
        clearPendingQrLogin();
        if (err instanceof PollTimeout || err instanceof PollDead) {
          notifications.show({
            color: "red",
            title: "神秘二维码登录失败",
            message: err.message,
          });
        } else if (err instanceof HttpClientError) {
          notifications.show({
            color: "red",
            title: "神秘二维码登录失败",
            message: err.message,
          });
        }
      })
      .finally(() => {
        setBusy(false);
        setProgress(null);
        abortRef.current = null;
      });
    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function submit(payload: FormData | string) {
    setBusy(true);
    setProgress(null);
    try {
      const { res, json } = await postQrLogin(payload);
      if (res.ok && json?.kind === "fast" && json?.token) {
        clearPendingQrLogin();
        showQrLoginSuccess();
        onSuccess(String(json.token));
        return;
      }
      if (res.ok && json?.kind === "async" && json?.attemptId) {
        await handleAsyncLogin(String(json.attemptId));
        return;
      }
      // Backwards-compat for the old (non-async) backend that returned
      // {token, user} directly without a `kind` discriminator. Remove
      // once all backend instances ship the new flow.
      if (res.ok && json?.token) {
        clearPendingQrLogin();
        showQrLoginSuccess();
        onSuccess(String(json.token));
        return;
      }
      // Backend returns BadRequestException({code,message}) for known
      // error categories so we can render targeted UI here.
      if (isExpiredQr(json)) {
        notifications.show({
          color: "orange",
          title: "神秘二维码已过期",
          message: "神秘二维码每隔几分钟会换新，请刷新二维码后重新上传。",
          autoClose: 8000,
        });
        return;
      }
      // NestJS BadRequestException renders as
      //   { statusCode: 400, message: <string|object>, error: "Bad Request" }
      // so we always prefer the inner message and only fall back to a
      // generic banner. Don't surface "Bad Request" itself — it leaks
      // framework noise to the end user.
      notifications.show({
        color: "red",
        title: "神秘二维码登录失败",
        message: getQrLoginMessage(json, res.status),
      });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "神秘二维码登录失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Stack gap="md">
      <Stack gap="sm">
        <QrCredentialInput
          label="二维码"
          value={qrText}
          onChange={setQrText}
          onFile={(file) => {
            const fd = new FormData();
            fd.append("image", file);
            void submit(fd);
          }}
          onEnter={() => void submit(qrText.trim())}
          disabled={disabled}
          loading={busy}
        />
        <Button
          fullWidth
          onClick={() => void submit(qrText.trim())}
          disabled={!qrText.trim() || busy || disabled}
          loading={busy}
          leftSection={<IconQrcode size={16} />}
        >
          二维码登录
        </Button>
      </Stack>

      {progress && (
        <Alert
          variant="light"
          color="blue"
          radius="md"
          icon={<Loader size="xs" />}
        >
          <Text size="sm">{progress}</Text>
        </Alert>
      )}

      {slowNoticeVisible && (
        <Alert
          variant="light"
          color="yellow"
          radius="md"
          icon={<IconInfoCircle size={18} />}
        >
          <Text size="sm">
            登录任务处理时间较长，请继续等待，不要重复提交二维码。
          </Text>
        </Alert>
      )}
    </Stack>
  );
}
