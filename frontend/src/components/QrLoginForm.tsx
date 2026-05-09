import {
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconQrcode } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

/**
 * QR-code login form. Mirrors the dual file/text input pattern from
 * CabinetBindingCard but submits to /api/auth/login-by-qr (no auth required;
 * returns a fresh JWT on success).
 *
 * The actual reverse-mapping from QR → friendCode happens server-side via
 * sdgb addRival + bot friend-list snapshot lookup; the user just sees a
 * spinner until the token arrives. ~5–60s slow path on first login,
 * ~1s on subsequent logins (cabinetUserId already bound).
 */
export interface QrLoginFormProps {
  onSuccess: (token: string) => void;
}

export function QrLoginForm({ onSuccess }: QrLoginFormProps) {
  const [qrText, setQrText] = useState("");
  const [busy, setBusy] = useState(false);
  // Slow-path progress message rendered to the user while we poll.
  const [progress, setProgress] = useState<string | null>(null);

  const STATUS_LABEL: Record<string, string> = {
    pending: "正在准备...",
    fetching_before: "正在拉取 bot 当前好友列表 (1/2)...",
    adding_rival: "正在让 bot 添加你为好友...",
    fetching_after: "正在拉取 bot 最新好友列表 (2/2)...",
  };

  /**
   * Poll the slow-path attempt status until terminal. Returns a token on
   * success; throws on failure or timeout.
   */
  async function pollAttempt(attemptId: string): Promise<string> {
    const deadline = Date.now() + 5 * 60_000; // generous 5 min
    while (Date.now() < deadline) {
      const res = await fetch(`/api/auth/login-by-qr/${attemptId}`);
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(
          json?.message?.message ?? json?.message ?? `HTTP ${res.status}`,
        );
      }
      const status: string = json?.status ?? "pending";
      setProgress(STATUS_LABEL[status] ?? status);
      if (status === "matched" && json?.token) {
        return String(json.token);
      }
      if (status === "failed") {
        throw new Error(json?.error ?? "扫码登录失败");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("扫码登录超时，请稍后重试");
  }

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
        notifications.show({ color: "green", message: "扫码登录成功" });
        onSuccess(String(json.token));
        return;
      }
      if (res.ok && json?.kind === "async" && json?.attemptId) {
        setProgress(STATUS_LABEL.pending);
        try {
          const token = await pollAttempt(String(json.attemptId));
          notifications.show({ color: "green", message: "扫码登录成功" });
          onSuccess(token);
        } catch (pollErr) {
          notifications.show({
            color: "red",
            title: "扫码登录失败",
            message:
              pollErr instanceof Error ? pollErr.message : String(pollErr),
          });
        }
        return;
      }
      // Backwards-compat for the old (non-async) backend that returned
      // {token, user} directly without a `kind` discriminator. Remove
      // once all backend instances ship the new flow.
      if (res.ok && json?.token) {
        notifications.show({ color: "green", message: "扫码登录成功" });
        onSuccess(String(json.token));
        return;
      }
      // Backend returns BadRequestException({code,message}) for known
      // error categories so we can render targeted UI here.
      if (json?.message?.code === "qr_expired") {
        notifications.show({
          color: "orange",
          title: "二维码已过期",
          message:
            "机台二维码每隔几分钟会换新，请回到机台刷新二维码后重新上传。",
          autoClose: 8000,
        });
        return;
      }
      const msg =
        json?.message?.message ??
        json?.error ??
        json?.message ??
        `HTTP ${res.status}`;
      notifications.show({ color: "red", title: "扫码登录失败", message: msg });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "扫码登录失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Group gap="xs">
          <IconQrcode size={18} />
          <Text fw={600}>扫码登录</Text>
        </Group>
        <Badge color="orange" variant="light" size="sm">
          测试中
        </Badge>
      </Group>

      <Text size="xs" c="dimmed">
        上传你卡牌上的二维码图片，或直接粘贴 QR
        字符串。首次扫码登录会自动绑定，后续扫同一张卡可秒登。
      </Text>

      <Group gap="sm" wrap="wrap">
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
            <Button {...p} variant="light" loading={busy}>
              上传二维码图片
            </Button>
          )}
        </FileButton>
        <TextInput
          placeholder="或粘贴 SGWCMAID... 字符串"
          value={qrText}
          onChange={(e) => setQrText(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 220 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && qrText.trim() && !busy) {
              void submit(qrText.trim());
            }
          }}
        />
        <Button
          onClick={() => void submit(qrText.trim())}
          disabled={!qrText.trim() || busy}
          loading={busy}
        >
          提交字符串
        </Button>
      </Group>

      {progress && (
        <Alert variant="light" color="blue" radius="md">
          <Text size="sm">{progress}</Text>
        </Alert>
      )}

      <Alert variant="light" color="gray" radius="md">
        <Text size="xs">
          首次登录可能需要 30–60 秒（系统需要让 bot 添加你为好友再反查）。
          若反复失败，请改用上方的好友码登录。
        </Text>
      </Alert>
    </Stack>
  );
}
