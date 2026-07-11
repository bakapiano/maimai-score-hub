import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  FileButton,
  Group,
  PasswordInput,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { IconLinkOff, IconUpload } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import { notifications } from "@mantine/notifications";
import { recordAnalyticsEvent } from "../utils/observability";

/**
 * Cabinet (sdgb) binding + auto-update opt-in.
 *
 * Lives in its own component because SyncPage.tsx is already a 1700-line
 * monolith and the binding flow is self-contained.
 *
 * The cabinetUserId is intentionally NEVER sent to the frontend in any
 * form — backend only exposes hasCabinetUserId.
 */
export interface CabinetCardProps {
  token: string;
  /** Whether the user has bound a cabinet user id at all. */
  hasCabinetUserId: boolean;
  autoUpdate: boolean;
  /** Called after a successful bind / toggle so the parent can re-pull profile. */
  onChanged?: () => void;
}

type ProfileResp = {
  hasCabinetUserId: boolean;
  autoUpdate: boolean;
};

export function CabinetBindingCard({
  token,
  hasCabinetUserId: initialHasCabinet,
  autoUpdate: initialAutoUpdate,
  onChanged,
}: CabinetCardProps) {
  const [hasCabinetUserId, setHasCabinetUserId] =
    useState<boolean>(initialHasCabinet);
  const [autoUpdate, setAutoUpdate] = useState<boolean>(initialAutoUpdate);
  const [qrText, setQrText] = useState("");
  const [busy, setBusy] = useState<"bind" | "toggle" | "unbind" | null>(null);

  // Keep state in sync if parent reloads profile.
  useEffect(() => setHasCabinetUserId(initialHasCabinet), [initialHasCabinet]);
  useEffect(() => setAutoUpdate(initialAutoUpdate), [initialAutoUpdate]);

  const refreshFromServer = useCallback(async () => {
    const res = await fetch("/api/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as ProfileResp;
      setHasCabinetUserId(!!data.hasCabinetUserId);
      setAutoUpdate(!!data.autoUpdate);
    }
    onChanged?.();
  }, [token, onChanged]);

  const submitBind = useCallback(
    async (formData: FormData | string) => {
      setBusy("bind");
      recordAnalyticsEvent("cabinet_bind_started", {
        inputType: typeof formData === "string" ? "text" : "image",
      });
      try {
        const res = await fetch("/api/v1/me/cabinet", {
          method: "PUT",
          headers:
            typeof formData === "string"
              ? {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                }
              : { Authorization: `Bearer ${token}` },
          body:
            typeof formData === "string"
              ? JSON.stringify({ qrCode: formData })
              : formData,
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (res.status === 201 && json?.ok) {
          notifications.show({
            color: "green",
            title: "绑定成功",
            message: "二维码已绑定",
          });
          recordAnalyticsEvent("cabinet_bind_completed", {
            inputType: typeof formData === "string" ? "text" : "image",
          });
          setQrText("");
          await refreshFromServer();
          return;
        }
        if (res.status === 409) {
          notifications.show({
            color: "red",
            title: "user id not match",
            message: `匹配成绩条数: ${json?.matchedRows ?? 0} (需要至少 5 条)`,
          });
          return;
        }
        notifications.show({
          color: "red",
          title: "绑定失败",
          message: json?.message ?? json?.error ?? `HTTP ${res.status}`,
        });
        recordAnalyticsEvent("cabinet_bind_failed", {
          statusCode: res.status,
        });
      } catch (err) {
        recordAnalyticsEvent("cabinet_bind_failed", {
          errorClass: err instanceof Error ? err.name : "Error",
        });
        notifications.show({
          color: "red",
          title: "绑定失败",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [token, refreshFromServer],
  );

  const onPickFile = (file: File | null) => {
    if (!file) {return;}
    const fd = new FormData();
    fd.append("image", file);
    void submitBind(fd);
  };

  const onSubmitText = () => {
    const v = qrText.trim();
    if (!v) {
      notifications.show({
        color: "red",
        message: "请填入 QR 字符串或上传二维码图片",
      });
      return;
    }
    void submitBind(v);
  };

  const toggleAutoUpdate = async (enabled: boolean) => {
    setBusy("toggle");
    try {
      const res = await fetch("/api/v1/me", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ autoUpdate: enabled }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.status === 200) {
        setAutoUpdate(!!json?.autoUpdate);
        notifications.show({
          color: "green",
          message: enabled ? "自动更新已开启" : "自动更新已关闭",
        });
        recordAnalyticsEvent(
          enabled ? "auto_update_enabled" : "auto_update_disabled",
        );
        onChanged?.();
      } else {
        notifications.show({
          color: "red",
          title: "切换失败",
          message: json?.message ?? json?.error ?? `HTTP ${res.status}`,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const unbind = async () => {
    if (
      !window.confirm(
        "确定要解绑当前账号的二维码吗？\n\n解绑后自动更新会一并关闭。",
      )
    ) {
      return;
    }
    setBusy("unbind");
    try {
      const res = await fetch("/api/v1/me/cabinet", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.status === 200 && json?.ok) {
        setHasCabinetUserId(false);
        setAutoUpdate(false);
        notifications.show({ color: "green", message: "已解绑" });
        recordAnalyticsEvent("auto_update_disabled", { reason: "unbind" });
        onChanged?.();
      } else {
        notifications.show({
          color: "red",
          title: "解绑失败",
          message: json?.message ?? json?.error ?? `HTTP ${res.status}`,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card withBorder padding="md">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Badge color="orange" variant="light" size="sm">
            测试中
          </Badge>
          {hasCabinetUserId ? (
            <Badge color="green" variant="light">
              已绑定
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              未绑定
            </Badge>
          )}
        </Group>

        {hasCabinetUserId ? (
          <>
            <Switch
              label="自动更新分数"
              description="开启后会在你推分的时候自动更新成绩。"
              checked={autoUpdate}
              disabled={busy !== null}
              onChange={(e) => toggleAutoUpdate(e.currentTarget.checked)}
            />

            <Group justify="space-between" align="center" wrap="nowrap" mt={4}>
              <Text size="sm" fw={500}>
                解绑二维码
              </Text>
              <Button
                variant="light"
                color="red"
                size="xs"
                leftSection={<IconLinkOff size={14} />}
                loading={busy === "unbind"}
                disabled={busy !== null}
                onClick={unbind}
              >
                解绑
              </Button>
            </Group>
          </>
        ) : (
          <>
            <Alert color="yellow" variant="light">
              请在绑定二维码前至少完成一次成绩同步
            </Alert>

            <Stack gap="sm">
              <FileButton
                onChange={onPickFile}
                accept="image/png,image/jpeg,image/webp"
              >
                {(props) => (
                  <Button
                    {...props}
                    variant="light"
                    fullWidth
                    size="md"
                    leftSection={<IconUpload size={16} />}
                    loading={busy === "bind"}
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
                />
                <Button
                  size="md"
                  onClick={onSubmitText}
                  loading={busy === "bind"}
                  disabled={!qrText.trim()}
                >
                  提交
                </Button>
              </Group>
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}
