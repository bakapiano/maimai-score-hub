import {
  Alert,
  Badge,
  Box,
  Button,
  FileButton,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
} from "@mantine/core";
import {
  HttpClientError,
  PollDead,
  PollTimeout,
  fetchForPoll,
  pollWithBackoff,
} from "../utils/poll";
import { IconQrcode, IconUpload } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { notifications } from "@mantine/notifications";

const QR_ATTEMPT_KEY = "pendingQrLoginAttemptId";

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
  const abortRef = useRef<AbortController | null>(null);

  const STATUS_LABEL: Record<string, string> = {
    pending: "正在准备登录…",
    adding_rival: "正在添加好友…",
    waiting_snapshot: "确认好友身份中（通常需要 1 分钟）…",
  };

  // Bubble busy state up so the parent can disable other login modes.
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  /**
   * Poll the slow-path attempt status until terminal. Returns a token on
   * success; throws on failure or timeout.
   */
  const pollAttempt = useCallback(
    async (attemptId: string, signal?: AbortSignal): Promise<string> => {
      return pollWithBackoff<string>(
        async () => {
          const { body } = await fetchForPoll(
            `/api/auth/login-by-qr/${attemptId}`,
            { signal },
          );
          const json = body as {
            status?: string;
            token?: string | null;
            error?: string | null;
          } | null;
          const status = json?.status ?? "pending";
          setProgress(STATUS_LABEL[status] ?? status);
          if (status === "matched" && json?.token) {
            return { done: true, value: String(json.token) };
          }
          if (status === "failed") {
            throw new HttpClientError(
              400,
              { message: json?.error },
              json?.error || "神秘二维码登录失败",
            );
          }
          return { done: false };
        },
        { intervalMs: 1_000, maxFailures: 5, signal, timeoutMs: 5 * 60_000 },
      );
    },
    [STATUS_LABEL],
  );

  // Resume an in-flight attempt persisted in localStorage. Runs once
  // on mount; if the attempt has already terminated we surface the
  // result and clear the cache.
  useEffect(() => {
    let cached: string | null = null;
    try {
      cached = localStorage.getItem(QR_ATTEMPT_KEY);
    } catch {
      // ignore
    }
    if (!cached) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setProgress(STATUS_LABEL.pending);
    pollAttempt(cached, ctrl.signal)
      .then((token) => {
        try {
          localStorage.removeItem(QR_ATTEMPT_KEY);
        } catch {
          // ignore
        }
        notifications.show({ color: "green", message: "神秘二维码登录成功" });
        onSuccess(token);
      })
      .catch((err) => {
        try {
          localStorage.removeItem(QR_ATTEMPT_KEY);
        } catch {
          // ignore
        }
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

  async function submit(payload: FormData | string) {
    setBusy(true);
    setProgress(null);
    try {
      const res = await fetch("/api/auth/login-by-qr", {
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
      const json = text ? JSON.parse(text) : null;
      if (res.ok && json?.kind === "fast" && json?.token) {
        notifications.show({ color: "green", message: "神秘二维码登录成功" });
        onSuccess(String(json.token));
        return;
      }
      if (res.ok && json?.kind === "async" && json?.attemptId) {
        const attemptId = String(json.attemptId);
        // Persist so a reload / navigation can resume the same attempt
        // instead of starting another one. Cleared in both success and
        // failure branches below.
        try {
          localStorage.setItem(QR_ATTEMPT_KEY, attemptId);
        } catch {
          // ignore
        }
        setProgress(STATUS_LABEL.pending);
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          const token = await pollAttempt(attemptId, ctrl.signal);
          try {
            localStorage.removeItem(QR_ATTEMPT_KEY);
          } catch {
            // ignore
          }
          notifications.show({ color: "green", message: "神秘二维码登录成功" });
          onSuccess(token);
        } catch (pollErr) {
          try {
            localStorage.removeItem(QR_ATTEMPT_KEY);
          } catch {
            // ignore
          }
          notifications.show({
            color: "red",
            title: "神秘二维码登录失败",
            message:
              pollErr instanceof Error ? pollErr.message : String(pollErr),
          });
        } finally {
          abortRef.current = null;
        }
        return;
      }
      // Backwards-compat for the old (non-async) backend that returned
      // {token, user} directly without a `kind` discriminator. Remove
      // once all backend instances ship the new flow.
      if (res.ok && json?.token) {
        notifications.show({ color: "green", message: "神秘二维码登录成功" });
        onSuccess(String(json.token));
        return;
      }
      // Backend returns BadRequestException({code,message}) for known
      // error categories so we can render targeted UI here.
      if (json?.message?.code === "qr_expired") {
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
      const msg =
        (typeof json?.message === "object" && json.message?.message) ||
        (typeof json?.message === "string" && json.message) ||
        json?.error ||
        `HTTP ${res.status}`;
      notifications.show({
        color: "red",
        title: "神秘二维码登录失败",
        message: msg,
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
      <Group justify="space-between" align="center" mb={4}>
        <Group gap="xs">
          <Box
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--mantine-color-grape-light)",
              color: "var(--mantine-color-grape-filled)",
            }}
          >
            <IconQrcode size={18} />
          </Box>
          <Stack gap={0}>
            <Text fw={700} size="md" style={{ lineHeight: 1.2 }}>
              神秘二维码登录
            </Text>
            <Text size="xs" c="dimmed">
              首次登陆可能会需要 30–60 秒，请耐心等待
            </Text>
          </Stack>
        </Group>
        <Badge color="orange" variant="light" size="sm">
          测试中
        </Badge>
      </Group>

      <Stack gap="sm">
        <FileButton
          onChange={(file) => {
            if (!file) return;
            const fd = new FormData();
            fd.append("image", file);
            void submit(fd);
          }}
          accept="image/png,image/jpeg,image/webp"
        >
          {(p) => (
            <Button
              {...p}
              variant="light"
              fullWidth
              size="md"
              leftSection={<IconUpload size={16} />}
              loading={busy}
              disabled={disabled}
            >
              上传二维码图片
            </Button>
          )}
        </FileButton>

        <Group gap={6} c="dimmed">
          <Box
            style={{
              flex: 1,
              height: 1,
              background: "var(--mantine-color-default-border)",
            }}
          />
          <Text size="xs">或粘贴字符串</Text>
          <Box
            style={{
              flex: 1,
              height: 1,
              background: "var(--mantine-color-default-border)",
            }}
          />
        </Group>

        <Group gap="xs" wrap="nowrap">
          <PasswordInput
            placeholder="SGWCMAID..."
            value={qrText}
            onChange={(e) => setQrText(e.currentTarget.value)}
            style={{ flex: 1 }}
            size="md"
            disabled={disabled || busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && qrText.trim() && !busy) {
                void submit(qrText.trim());
              }
            }}
          />
          <Button
            size="md"
            onClick={() => void submit(qrText.trim())}
            disabled={!qrText.trim() || busy || disabled}
            loading={busy}
          >
            提交
          </Button>
        </Group>
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
    </Stack>
  );
}
