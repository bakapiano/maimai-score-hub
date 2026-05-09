import {
  Alert,
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useState } from "react";

/**
 * Cabinet (sdgb) binding + auto-update opt-in.
 *
 * Lives in its own component because SyncPage.tsx is already a 1700-line
 * monolith and the binding flow is self-contained.
 */
export interface CabinetCardProps {
  token: string;
  /** Initial values pulled from /api/users/profile so we can render eagerly. */
  cabinetUserId: number | null;
  autoUpdate: boolean;
  /** Called after a successful bind / toggle so the parent can re-pull profile. */
  onChanged?: () => void;
}

type ProfileResp = {
  cabinetUserId: number | null;
  autoUpdate: boolean;
};

export function CabinetBindingCard({
  token,
  cabinetUserId: initialCabinetUserId,
  autoUpdate: initialAutoUpdate,
  onChanged,
}: CabinetCardProps) {
  const [cabinetUserId, setCabinetUserId] = useState<number | null>(
    initialCabinetUserId,
  );
  const [autoUpdate, setAutoUpdate] = useState<boolean>(initialAutoUpdate);
  const [qrText, setQrText] = useState("");
  const [busy, setBusy] = useState<"bind" | "toggle" | null>(null);

  // Keep state in sync if parent reloads profile.
  useEffect(() => setCabinetUserId(initialCabinetUserId), [initialCabinetUserId]);
  useEffect(() => setAutoUpdate(initialAutoUpdate), [initialAutoUpdate]);

  const refreshFromServer = useCallback(async () => {
    const res = await fetch("/api/users/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as ProfileResp;
      setCabinetUserId(data.cabinetUserId ?? null);
      setAutoUpdate(!!data.autoUpdate);
    }
    onChanged?.();
  }, [token, onChanged]);

  const submitBind = useCallback(
    async (formData: FormData | string) => {
      setBusy("bind");
      try {
        const res = await fetch("/api/users/cabinet/bind-qr", {
          method: "POST",
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
        if (res.status === 201 && json?.cabinetUserId) {
          notifications.show({
            color: "green",
            title: "绑定成功",
            message: `cabinet userId = ${json.cabinetUserId}`,
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
      } catch (err) {
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
    if (!file) return;
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
      const res = await fetch("/api/users/cabinet/auto-update", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.status === 201) {
        setAutoUpdate(!!json?.autoUpdate);
        notifications.show({
          color: "green",
          message: enabled ? "自动更新已开启" : "自动更新已关闭",
        });
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

  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Badge color="orange" variant="light" size="sm">
            测试中
          </Badge>
          {cabinetUserId != null ? (
            <Badge color="green" variant="light">
              已绑定 #{cabinetUserId}
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              未绑定
            </Badge>
          )}
        </Group>

        <Text size="xs" c="dimmed">
          扫描你的神秘二维码以完成绑定。
        </Text>

        {!cabinetUserId && (
          <Alert color="yellow" variant="light">
            必须先完成一次成绩同步，才能绑定二维码（用于身份校验）。
          </Alert>
        )}

        <Group gap="sm" wrap="wrap">
          <FileButton
            onChange={onPickFile}
            accept="image/png,image/jpeg,image/webp"
          >
            {(props) => (
              <Button
                {...props}
                variant="light"
                loading={busy === "bind"}
              >
                上传二维码图片
              </Button>
            )}
          </FileButton>
          <TextInput
            placeholder="或粘贴 SGWCMAID... 字符串"
            value={qrText}
            onChange={(e) => setQrText(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <Button
            onClick={onSubmitText}
            loading={busy === "bind"}
            disabled={!qrText.trim()}
          >
            提交字符串
          </Button>
        </Group>

        <Switch
          label="自动更新分数"
          description="开启后会在你推分的时候自动更新成绩。"
          checked={autoUpdate}
          disabled={cabinetUserId == null || busy !== null}
          onChange={(e) => toggleAutoUpdate(e.currentTarget.checked)}
        />
      </Stack>
    </Card>
  );
}
