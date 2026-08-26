import {
  Alert,
  Badge,
  Button,
  Group,
  Progress,
  Stack,
  Text,
} from "@mantine/core";
import { IconDownload, IconRefresh } from "@tabler/icons-react";
import { useCallback, useState } from "react";

import { AppCard } from "../../components/AppCard";
import { SettingsSectionHeader } from "../../components/SettingsSectionHeader";
import { useAndroidAppUpdate } from "./AndroidAppUpdateContext";
import {
  getAndroidAppUpdateBridge,
  startAndroidAppUpdate,
  type AndroidAppUpdateStatus,
} from "./androidUpdateBridge";

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function AndroidAppUpdatePanel() {
  const bridge = getAndroidAppUpdateBridge();
  const {
    release,
    checking,
    error: checkError,
    checkForUpdate,
  } = useAndroidAppUpdate();
  const [running, setRunning] = useState(
    () => bridge?.isAppUpdateRunning() ?? false,
  );
  const [status, setStatus] = useState<AndroidAppUpdateStatus | null>(null);
  const [installError, setInstallError] = useState("");

  const start = useCallback(async (releaseId: string) => {
    setRunning(true);
    setInstallError("");
    setStatus({
      requestId: "pending",
      message: "正在启动应用更新…",
      stage: "starting",
      progress: 0,
      terminal: false,
      success: false,
    });
    try {
      await startAndroidAppUpdate(releaseId, setStatus);
    } catch (value) {
      setInstallError(value instanceof Error ? value.message : String(value));
    } finally {
      setRunning(false);
    }
  }, []);

  if (!bridge) {
    return null;
  }

  return (
    <AppCard compact>
      <Stack gap="md" data-testid="android-app-update-panel">
        <Group justify="space-between" align="center">
          <SettingsSectionHeader
            icon={<IconDownload size={16} />}
            title="MaiScoreHub 更新"
          />
          <Badge variant="light" color="teal">
            {bridge.getVersion()}
          </Badge>
        </Group>

        {release ? (
          <Stack gap="xs">
            <Group justify="space-between" align="center">
              <Text fw={700}>发现 {release.versionName}</Text>
              {release.mandatory && <Badge color="red">重要更新</Badge>}
            </Group>
            <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
              {release.notes || "包含稳定性与兼容性改进。"}
            </Text>
            <Text size="xs" c="dimmed">
              安装包 {formatBytes(release.apkSize)} · {release.channel}
            </Text>
            <Button
              fullWidth
              loading={running}
              disabled={running}
              leftSection={<IconDownload size={16} />}
              onClick={() => void start(release.releaseId)}
            >
              下载并安装
            </Button>
          </Stack>
        ) : (
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              {checking ? "正在检查更新…" : "当前已是最新版本"}
            </Text>
            <Button
              size="xs"
              variant="subtle"
              loading={checking}
              leftSection={<IconRefresh size={14} />}
              onClick={() => void checkForUpdate(true)}
            >
              检查更新
            </Button>
          </Group>
        )}

        {status && !status.terminal && (
          <Stack gap={6}>
            <Group justify="space-between">
              <Text size="sm">{status.message}</Text>
              <Text size="sm" fw={700} c="blue">
                {Math.round(status.progress)}%
              </Text>
            </Group>
            <Progress value={status.progress} animated radius="xl" />
          </Stack>
        )}

        {(installError || checkError) && (
          <Alert color="red" title="应用更新失败">
            {installError || checkError}
          </Alert>
        )}
      </Stack>
    </AppCard>
  );
}
