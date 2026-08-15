import {
  Badge,
  Alert,
  Box,
  Button,
  Divider,
  Group,
  Stack,
  Switch,
  Text,
  Loader,
} from "@mantine/core";
import { IconLink, IconLinkOff } from "@tabler/icons-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { notifications } from "@mantine/notifications";
import { apiUrl } from "../api/baseUrl";
import { recordAnalyticsEvent } from "../utils/observability";
import { AppCard } from "./AppCard";
import { QrCredentialInput } from "./QrCredentialInput";
import {
  HttpClientError,
  fetchForPoll,
  pollWithBackoff,
} from "../utils/poll";

const CABINET_BINDING_STATUS: Record<string, string> = {
  pending: "正在排队准备好友关系…",
  adding_rival: "正在通过机台建立好友关系…",
  waiting_snapshot: "正在确认二维码身份…",
};

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
  header?: ReactNode;
  /** Called after a successful bind / toggle so the parent can re-pull profile. */
  onChanged?: () => void;
}

type ProfileResp = {
  hasCabinetUserId: boolean;
  autoUpdate: boolean;
};

function getBindMismatchMessage(json: Record<string, unknown> | null): string {
  return json?.verification === "profile"
    ? "二维码反查出的好友码与当前登录账号不一致"
    : `匹配成绩条数：${json?.matchedRows ?? 0}（需要至少 ${json?.requiredRows ?? 10} 条）`;
}

export function CabinetBindingCard({
  token,
  hasCabinetUserId: initialHasCabinet,
  autoUpdate: initialAutoUpdate,
  header,
  onChanged,
}: CabinetCardProps) {
  const [hasCabinetUserId, setHasCabinetUserId] =
    useState<boolean>(initialHasCabinet);
  const [autoUpdate, setAutoUpdate] = useState<boolean>(initialAutoUpdate);
  const [qrText, setQrText] = useState("");
  const [busy, setBusy] = useState<"bind" | "toggle" | "unbind" | null>(null);
  const [bindingProgress, setBindingProgress] = useState<string | null>(null);

  // Keep state in sync if parent reloads profile.
  useEffect(() => setHasCabinetUserId(initialHasCabinet), [initialHasCabinet]);
  useEffect(() => setAutoUpdate(initialAutoUpdate), [initialAutoUpdate]);

  const refreshFromServer = useCallback(async () => {
    const res = await fetch(apiUrl("/me"), {
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
        const res = await fetch(apiUrl("/me/cabinet"), {
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
        if (res.status === 202 && json?.attemptId) {
          setBindingProgress(CABINET_BINDING_STATUS.pending);
          await pollWithBackoff<void>(
            async () => {
              const { body } = await fetchForPoll(
                apiUrl(`/me/cabinet/attempts/${String(json.attemptId)}`),
                { headers: { Authorization: `Bearer ${token}` } },
              );
              const attempt = body as {
                status?: string;
                ok?: boolean;
                error?: string | null;
              } | null;
              const status = attempt?.status ?? "pending";
              setBindingProgress(CABINET_BINDING_STATUS[status] ?? status);
              if (status === "matched" && attempt?.ok) {
                return { done: true, value: undefined };
              }
              if (status === "failed") {
                throw new HttpClientError(
                  409,
                  { message: attempt?.error },
                  attempt?.error || "二维码身份确认失败",
                );
              }
              return { done: false };
            },
            { intervalMs: 1_000, maxFailures: 5, timeoutMs: 5 * 60_000 },
          );
          notifications.show({
            color: "green",
            title: "绑定成功",
            message: "二维码已绑定",
          });
          setQrText("");
          await refreshFromServer();
          return;
        }
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
            title: "二维码与当前账号不匹配",
            message: getBindMismatchMessage(json),
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
        setBindingProgress(null);
        setBusy(null);
      }
    },
    [token, refreshFromServer],
  );

  const onPickFile = (file: File | null) => {
    if (!file) {
      return;
    }
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
      const res = await fetch(apiUrl("/me"), {
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
      const res = await fetch(apiUrl("/me/cabinet"), {
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
    <AppCard>
      <Stack gap="md">
        {header}
        {bindingProgress && (
          <Alert color="blue" variant="light" icon={<Loader size="xs" />}>
            {bindingProgress}
          </Alert>
        )}
        {hasCabinetUserId ? (
          <>
            <Group justify="space-between" align="center" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" fw={500}>
                  解绑二维码
                </Text>
                <Badge color="green" variant="light" size="sm">
                  已绑定
                </Badge>
              </Group>
              <Button
                variant="light"
                color="red"
                size="sm"
                leftSection={<IconLinkOff size={16} />}
                loading={busy === "unbind"}
                disabled={busy !== null}
                onClick={unbind}
              >
                解绑
              </Button>
            </Group>

            <Divider />

            <Switch
              label="自动更新分数"
              description="开启后会在你推分的时候自动更新成绩。谱面的 FC、FS 状态可能会有延迟。"
              checked={autoUpdate}
              disabled={busy !== null}
              onChange={(e) => toggleAutoUpdate(e.currentTarget.checked)}
            />
          </>
        ) : (
          <Group gap="xs" align="flex-start" wrap="wrap">
            <Box style={{ flex: "1 1 280px", minWidth: 0 }}>
              <QrCredentialInput
                value={qrText}
                onChange={setQrText}
                onFile={onPickFile}
                onEnter={onSubmitText}
                disabled={busy !== null}
                loading={busy === "bind"}
              />
            </Box>
            <Button
              w={{ base: "100%", xs: "auto" }}
              miw={{ xs: 112 }}
              styles={{ root: { flexShrink: 0 } }}
              onClick={onSubmitText}
              loading={busy === "bind"}
              disabled={!qrText.trim() || busy !== null}
              leftSection={<IconLink size={16} />}
            >
              提交绑定
            </Button>
          </Group>
        )}
      </Stack>
    </AppCard>
  );
}
