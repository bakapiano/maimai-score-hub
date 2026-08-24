import {
  Alert,
  Button,
  Group,
  Progress,
  Stack,
  Text,
} from "@mantine/core";
import { IconBrandWechat } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { AppCard } from "../../components/AppCard";
import {
  ANDROID_STATUS_EVENT,
  getAndroidHostBridge,
  parseAndroidUpdateStatus,
  type AndroidUpdateStatus,
} from "./androidUpdateBridge";
import {
  getAndroidRuntimeSnapshot,
  runAndroidWorkflow,
} from "./androidWorkflowRuntime";
import { AndroidAppUpdateBadge } from "./AndroidAppUpdateBadge";

function readBridgeSnapshot() {
  const bridge = getAndroidHostBridge();
  if (!bridge) {
    return { running: false };
  }
  try {
    return {
      running: getAndroidRuntimeSnapshot("login").running,
    };
  } catch {
    return { running: false };
  }
}

export function AndroidAutoLoginPanel() {
  const [initialBridgeState] = useState(readBridgeSnapshot);
  const [running, setRunning] = useState(initialBridgeState.running);
  const [status, setStatus] = useState<AndroidUpdateStatus | null>(() =>
    initialBridgeState.running
      ? {
          message: "微信一键登录正在进行",
          terminal: false,
          success: false,
          mode: "login",
        }
      : null,
  );

  useEffect(() => {
    const handleStatus = (event: Event) => {
      const next = parseAndroidUpdateStatus(
        (event as CustomEvent<unknown>).detail,
      );
      if (!next || next.mode !== "login") {
        return;
      }
      setStatus(next);
      setRunning(!next.terminal);
    };

    window.addEventListener(ANDROID_STATUS_EVENT, handleStatus);
    return () => window.removeEventListener(ANDROID_STATUS_EVENT, handleStatus);
  }, []);

  const startLogin = () => {
    const bridge = getAndroidHostBridge();
    if (!bridge) {
      setStatus({
        message: "Android 登录桥接暂时不可用，请重新打开页面",
        terminal: true,
        success: false,
        mode: "login",
      });
      return;
    }
    setRunning(true);
    setStatus({
      message: "正在启动微信一键登录…",
      terminal: false,
      success: false,
      mode: "login",
    });
    void runAndroidWorkflow("login");
  };

  return (
    <AppCard data-testid="android-auto-login-panel">
      <Stack gap="lg" py="md">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <IconBrandWechat size={22} color="var(--mantine-color-green-6)" />
            <Text fw={700}>微信一键登录</Text>
          </Group>
          <AndroidAppUpdateBadge />
        </Group>

        <Text size="sm" c="dimmed">
          使用当前微信的 DX Net 身份进行登录
        </Text>

        {running && <Progress value={100} animated size="sm" radius="xl" />}

        {status && (
          <Alert
            color={
              status.terminal ? (status.success ? "green" : "red") : "blue"
            }
            variant="light"
          >
            {status.message}
          </Alert>
        )}

        <Button
          fullWidth
          color="green"
          loading={running}
          disabled={running}
          leftSection={<IconBrandWechat size={18} />}
          onClick={startLogin}
        >
          使用微信登录
        </Button>
      </Stack>
    </AppCard>
  );
}
