import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDevices,
  IconLogout,
} from "@tabler/icons-react";
import type { AuthSessionSummary } from "@maimai-score-hub/shared";
import { useCallback, useEffect, useState } from "react";

import { usersApi } from "../api/appClient";

type SessionManagementSectionProps = {
  token: string;
  refreshSignal?: number;
};

function isMobileDeviceLabel(label: string): boolean {
  return /iPhone|iPad|Android|移动/i.test(label);
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 1000),
  );
  if (elapsedSeconds >= 365 * 24 * 60 * 60) {
    return `${Math.floor(elapsedSeconds / (365 * 24 * 60 * 60))}年前`;
  }
  if (elapsedSeconds >= 30 * 24 * 60 * 60) {
    return `${Math.floor(elapsedSeconds / (30 * 24 * 60 * 60))}个月前`;
  }
  if (elapsedSeconds >= 24 * 60 * 60) {
    return `${Math.floor(elapsedSeconds / (24 * 60 * 60))}天前`;
  }
  if (elapsedSeconds >= 60 * 60) {
    return `${Math.floor(elapsedSeconds / (60 * 60))}小时前`;
  }
  if (elapsedSeconds >= 60) {
    return `${Math.floor(elapsedSeconds / 60)}分钟前`;
  }
  return "刚刚";
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN");
}

function getErrorMessage(body: unknown, status: number): string {
  const value = body as {
    message?: string | { message?: string };
    error?: string;
  } | null;
  return (
    (typeof value?.message === "object" && value.message?.message) ||
    (typeof value?.message === "string" && value.message) ||
    value?.error ||
    `HTTP ${status}`
  );
}

function SessionRow({
  session,
  revoking,
  onRevoke,
}: {
  session: AuthSessionSummary;
  revoking: boolean;
  onRevoke: (id: string) => void;
}) {
  const MobileIcon = isMobileDeviceLabel(session.deviceLabel)
    ? IconDeviceMobile
    : IconDeviceDesktop;

  return (
    <Paper withBorder radius="md" p="xs">
      <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              backgroundColor: session.current
                ? "var(--mantine-color-teal-light)"
                : "var(--mantine-color-gray-light)",
              color: session.current
                ? "var(--mantine-color-teal-6)"
                : "var(--mantine-color-dimmed)",
            }}
          >
            <MobileIcon size={16} />
          </Box>
          <Box style={{ minWidth: 0 }}>
            <Group gap={6} wrap="wrap">
              <Text size="sm" fw={600} truncate>
                {session.deviceLabel}
              </Text>
              {session.current && (
                <Badge size="xs" variant="light" color="teal">
                  当前设备
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              最近活跃 {formatRelativeTime(session.lastUsedAt)} · 登录于{" "}
              {formatShortDate(session.createdAt)}
            </Text>
          </Box>
        </Group>
        {!session.current && (
          <Button
            variant="subtle"
            color="red"
            size="compact-xs"
            loading={revoking}
            onClick={() => onRevoke(session.id)}
            style={{ flexShrink: 0 }}
          >
            下线
          </Button>
        )}
      </Group>
    </Paper>
  );
}

export function SessionManagementSection({
  token,
  refreshSignal = 0,
}: SessionManagementSectionProps) {
  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await usersApi.listSessions({
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 200 && Array.isArray(res.body)) {
        setSessions(res.body as AuthSessionSummary[]);
      }
    } catch {
      // Ignore transient load error; list stays empty or prior state.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, refreshSignal]);

  const handleRevokeOne = async (id: string) => {
    setRevokingId(id);
    try {
      const res = await usersApi.revokeSession({
        params: { id },
        headers: { authorization: `Bearer ${token}` },
        body: undefined,
      });
      if (res.status !== 200) {
        notifications.show({
          color: "red",
          title: "下线失败",
          message: getErrorMessage(res.body, res.status),
        });
        return;
      }
      setSessions((prev) => prev.filter((item) => item.id !== id));
      notifications.show({
        color: "green",
        message: "已下线该设备",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "下线失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      const res = await usersApi.revokeOtherSessions({
        headers: { authorization: `Bearer ${token}` },
        body: undefined,
      });
      if (res.status !== 200) {
        notifications.show({
          color: "red",
          title: "操作失败",
          message: getErrorMessage(res.body, res.status),
        });
        return;
      }
      setSessions((prev) => prev.filter((item) => item.current));
      notifications.show({
        color: "green",
        message: "已下线其他所有设备",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "操作失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRevokingOthers(false);
    }
  };

  const otherSessionCount = sessions.filter((item) => !item.current).length;

  return (
    <>
      <Divider my="xs" />
      <Stack gap="xs">
        <Group justify="space-between" align="center" gap="xs">
          <Group gap="xs">
            <IconDevices size={17} />
            <Text fw={600} size="sm">
              登录设备
            </Text>
          </Group>
          {otherSessionCount > 0 && (
            <Button
              variant="subtle"
              color="red"
              size="compact-xs"
              leftSection={<IconLogout size={13} />}
              loading={revokingOthers}
              onClick={() => void handleRevokeOthers()}
            >
              下线其他设备
            </Button>
          )}
        </Group>

        {loading ? (
          <Group gap="xs" py={4}>
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              加载登录设备中...
            </Text>
          </Group>
        ) : sessions.length === 0 ? (
          <Text size="xs" c="dimmed">
            暂无可管理的设备会话
          </Text>
        ) : (
          <Stack gap="xs">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                revoking={revokingId === session.id}
                onRevoke={(id) => void handleRevokeOne(id)}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </>
  );
}
