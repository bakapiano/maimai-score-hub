import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { adminApi, coverApi, musicApi } from "../../api/appClient";
import {
  IconArrowsExchange,
  IconDatabase,
  IconMusic,
  IconPhoto,
  IconRefresh,
} from "@tabler/icons-react";
import { useAdminContext } from "./adminUtils";
import { useCallback, useEffect, useState } from "react";

export default function AdminSyncPage() {
  const { password } = useAdminContext();

  const [coverSyncing, setCoverSyncing] = useState(false);
  const [coverSyncResult, setCoverSyncResult] = useState("");

  const [coverForceSyncing, setCoverForceSyncing] = useState(false);
  const [coverForceSyncResult, setCoverForceSyncResult] = useState("");

  const [coverBackfilling, setCoverBackfilling] = useState(false);
  const [coverBackfillResult, setCoverBackfillResult] = useState("");

  const [musicSyncing, setMusicSyncing] = useState(false);
  const [musicSyncResult, setMusicSyncResult] = useState("");

  const [dataSource, setDataSource] = useState<"diving-fish" | "lxns" | null>(
    null,
  );
  const [dataSourceLoading, setDataSourceLoading] = useState(false);
  const [dataSourceSwitching, setDataSourceSwitching] = useState(false);

  const loadDataSource = useCallback(async () => {
    if (!password) return;
    setDataSourceLoading(true);
    try {
      const res = await musicApi.getDataSource({
        headers: { "x-api-secret": password },
      });
      if (res.status === 200) {
        setDataSource(res.body.source);
      }
    } catch {
      // ignore
    }
    setDataSourceLoading(false);
  }, [password]);

  const switchDataSource = useCallback(
    async (newSource: "diving-fish" | "lxns") => {
      if (!password) return;
      setDataSourceSwitching(true);
      const res = await musicApi.setDataSource({
        headers: { "x-api-secret": password },
        body: { source: newSource },
      });
      setDataSourceSwitching(false);
      if (res.status === 200) {
        setDataSource(res.body.source);
      }
    },
    [password],
  );

  const syncCovers = useCallback(async () => {
    if (!password) return;
    setCoverSyncing(true);
    setCoverSyncResult("");
    const res = await adminApi.syncCovers({
      headers: { "x-api-secret": password },
    });
    setCoverSyncing(false);
    if (res.status === 201) {
      setCoverSyncResult(
        `完成: 总计 ${res.body.total}, 保存 ${res.body.saved}, 跳过 ${res.body.skipped}, 失败 ${res.body.failed}`,
      );
    } else {
      setCoverSyncResult(`失败: HTTP ${res.status}`);
    }
  }, [password]);

  const forceSyncCovers = useCallback(async () => {
    if (!password) return;
    setCoverForceSyncing(true);
    setCoverForceSyncResult("");
    const res = await adminApi.forceSyncCovers({
      headers: { "x-api-secret": password },
    });
    setCoverForceSyncing(false);
    if (res.status === 201) {
      setCoverForceSyncResult(
        `完成: 总计 ${res.body.total}, 保存 ${res.body.saved}, 跳过 ${res.body.skipped}, 失败 ${res.body.failed}`,
      );
    } else {
      setCoverForceSyncResult(`失败: HTTP ${res.status}`);
    }
  }, [password]);

  const backfillCoverVariants = useCallback(async () => {
    if (!password) return;
    setCoverBackfilling(true);
    setCoverBackfillResult("");
    const res = await coverApi.backfillVariants({
      headers: { "x-api-secret": password },
    });
    if (res.status === 201) {
      setCoverBackfillResult(
        `补齐完成: 总计 ${res.body.total}, 新增 ${res.body.saved}, 跳过 ${res.body.skipped}, 失败 ${res.body.failed}`,
      );
    } else {
      setCoverBackfillResult(`补齐失败: HTTP ${res.status}`);
    }
    setCoverBackfilling(false);
  }, [password]);

  const syncMusic = useCallback(async () => {
    if (!password) return;
    setMusicSyncing(true);
    setMusicSyncResult("");
    const res = await adminApi.syncMusic({
      headers: { "x-api-secret": password },
    });
    setMusicSyncing(false);
    if (res.status === 201) {
      setMusicSyncResult(
        `完成: 总计 ${res.body.total}, 新增 ${res.body.added}, 更新 ${res.body.updated}`,
      );
    } else {
      setMusicSyncResult(`失败: HTTP ${res.status}`);
    }
  }, [password]);

  useEffect(() => {
    if (dataSource === null) {
      void loadDataSource();
    }
  }, [dataSource, loadDataSource]);

  return (
    <Stack gap="lg">
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Group gap="xs" mb="md">
          <IconArrowsExchange size={20} />
          <Text fw={600}>数据同步</Text>
        </Group>
        <Group gap="md">
          <div>
            <Group gap="sm" mb={4}>
              <Button
                variant="light"
                leftSection={<IconPhoto size={16} />}
                onClick={syncCovers}
                loading={coverSyncing}
              >
                同步封面
              </Button>
              <Button
                variant="light"
                color="orange"
                leftSection={<IconRefresh size={16} />}
                onClick={forceSyncCovers}
                loading={coverForceSyncing}
              >
                强制重新同步封面
              </Button>
              <Button
                variant="light"
                color="teal"
                leftSection={<IconRefresh size={16} />}
                onClick={backfillCoverVariants}
                loading={coverBackfilling}
              >
                补齐封面格式
              </Button>
            </Group>
            {coverSyncResult && (
              <Text size="sm" c="dimmed">
                {coverSyncResult}
              </Text>
            )}
            {coverForceSyncResult && (
              <Text size="sm" c="dimmed">
                {coverForceSyncResult}
              </Text>
            )}
            {coverBackfillResult && (
              <Text size="sm" c="dimmed">
                {coverBackfillResult}
              </Text>
            )}
          </div>

          <div>
            <Group gap="sm" mb={4}>
              <Button
                variant="light"
                leftSection={<IconMusic size={16} />}
                onClick={syncMusic}
                loading={musicSyncing}
              >
                同步歌曲数据
              </Button>
            </Group>
            {musicSyncResult && (
              <Text size="sm" c="dimmed">
                {musicSyncResult}
              </Text>
            )}
          </div>
        </Group>
      </Card>

      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Group gap="xs" mb="md">
          <IconDatabase size={20} />
          <Text fw={600}>歌曲数据源</Text>
        </Group>
        <Group gap="md" align="center">
          <Group gap="xs">
            <Text size="sm" c="dimmed">
              当前数据源:
            </Text>
            {dataSourceLoading ? (
              <Text size="sm">加载中...</Text>
            ) : (
              <Text size="sm" fw={600}>
                {dataSource === "diving-fish"
                  ? "Diving-Fish (水鱼)"
                  : dataSource === "lxns"
                    ? "落雪 (LXNS)"
                    : "未知"}
              </Text>
            )}
          </Group>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={loadDataSource}
            loading={dataSourceLoading}
          >
            刷新
          </Button>
          <Button
            variant={dataSource === "diving-fish" ? "filled" : "outline"}
            size="xs"
            onClick={() => switchDataSource("diving-fish")}
            loading={dataSourceSwitching}
            disabled={dataSource === "diving-fish"}
          >
            Diving-Fish
          </Button>
          <Button
            variant={dataSource === "lxns" ? "filled" : "outline"}
            size="xs"
            onClick={() => switchDataSource("lxns")}
            loading={dataSourceSwitching}
            disabled={dataSource === "lxns"}
          >
            落雪 (LXNS)
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
