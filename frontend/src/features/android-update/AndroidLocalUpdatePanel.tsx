import {
  Alert,
  Badge,
  Button,
  Group,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { SyncStatusSummary } from "../../components/SyncStatusSummary";
import {
  ANDROID_STATUS_EVENT,
  getAndroidHostBridge,
  parseAndroidUpdateStatus,
  type AndroidUpdateMode,
  type AndroidUpdateStatus,
} from "./androidUpdateBridge";
import { getAndroidUpdatePresentation } from "./androidUpdatePresentation";
import {
  getActiveAndroidWorkflowMode,
  getAndroidRuntimeSnapshot,
  runAndroidWorkflow,
} from "./androidWorkflowRuntime";

type AndroidLocalUpdatePanelProps = {
  onCompleted?: () => void | Promise<void>;
};

function readBridgeSnapshot() {
  const bridge = getAndroidHostBridge();
  if (!bridge) {
    return { running: false, version: "" };
  }
  try {
    const activeMode = getActiveAndroidWorkflowMode();
    const runtime = getAndroidRuntimeSnapshot(
      activeMode === "full" ? "full" : "recent",
    );
    return {
      running: runtime.running,
      version: bridge.getVersion(),
    };
  } catch {
    return { running: false, version: "" };
  }
}

export function AndroidLocalUpdatePanel({
  onCompleted,
}: AndroidLocalUpdatePanelProps) {
  const [initialBridgeState] = useState(readBridgeSnapshot);
  const [mode, setMode] = useState<AndroidUpdateMode>("recent");
  const [running, setRunning] = useState(initialBridgeState.running);
  const [version] = useState(initialBridgeState.version);
  const [status, setStatus] = useState<AndroidUpdateStatus | null>(() =>
    initialBridgeState.running
      ? {
          message: "代理更新正在进行",
          terminal: false,
          success: false,
        }
      : null,
  );
  const onCompletedRef = useRef(onCompleted);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    const handleStatus = (event: Event) => {
      const next = parseAndroidUpdateStatus(
        (event as CustomEvent<unknown>).detail,
      );
      if (!next) {
        return;
      }
      if (next.mode === "login") {
        return;
      }
      setStatus(next);
      setRunning(!next.terminal);
      if (next.mode) {
        setMode(next.mode);
      }
      if (next.terminal && next.success) {
        void onCompletedRef.current?.();
      }
    };

    window.addEventListener(ANDROID_STATUS_EVENT, handleStatus);
    return () => {
      window.removeEventListener(ANDROID_STATUS_EVENT, handleStatus);
    };
  }, []);

  const startUpdate = () => {
    const bridge = getAndroidHostBridge();
    if (!bridge) {
      setStatus({
        message: "Android 代理桥接暂时不可用，请重新打开页面",
        terminal: true,
        success: false,
      });
      return;
    }
    setRunning(true);
    setStatus({
      message: "正在启动代理更新…",
      terminal: false,
      success: false,
      mode,
    });
    void runAndroidWorkflow(mode);
  };

  const presentation = getAndroidUpdatePresentation({ mode, running, status });

  return (
    <Stack gap="md" data-testid="android-local-update-panel">
      <Group justify="space-between" align="center">
        <Text size="sm" fw={600}>
          更新范围
        </Text>
        <Badge variant="light" color="teal">
          Android{version ? ` ${version}` : ""}
        </Badge>
      </Group>

      <SegmentedControl
        fullWidth
        value={mode}
        disabled={running}
        onChange={(value) => setMode(value as AndroidUpdateMode)}
        data={[
          { value: "recent", label: "最近游玩" },
          { value: "full", label: "全部成绩" },
        ]}
      />

      <SyncStatusSummary
        color={presentation.color}
        label={presentation.label}
        text={presentation.text}
        badge={presentation.badge}
        state={presentation.state}
        action={
          <Button
            loading={running}
            disabled={running}
            variant="light"
            leftSection={<IconRefresh size={16} />}
            onClick={startUpdate}
            w={{ base: "100%", xs: "auto" }}
            styles={{ root: { flexShrink: 0 } }}
          >
            {mode === "recent" ? "更新最近游玩" : "更新全部成绩"}
          </Button>
        }
      />

      {running && (
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Text size="sm" fw={600}>
              {presentation.badge ?? "正在更新成绩"}
            </Text>
            <Text size="sm" fw={700} c="blue.7">
              {Math.round(presentation.progress)}%
            </Text>
          </Group>
          <Progress
            value={presentation.progress}
            animated
            size="md"
            radius="xl"
            color="blue"
          />
        </Stack>
      )}

      {status?.terminal && !status.success && (
        <Alert color="red" variant="light" title="错误" radius="md">
          {status.message}
        </Alert>
      )}
    </Stack>
  );
}
