import { Button, Card, Group, Stack, Text } from "@mantine/core";
import {
  IconArrowsExchange,
  IconDatabase,
  IconMusic,
  IconPhoto,
  IconRefresh,
} from "@tabler/icons-react";
import { adminFetch, useAdminContext } from "./adminUtils";
import { useCallback, useEffect, useState } from "react";

export default function AdminSyncPage() {
  const { password } = useAdminContext();

  const [coverSyncing, setCoverSyncing] = useState(false);
  const [coverSyncResult, setCoverSyncResult] = useState("");

  const [musicSyncing, setMusicSyncing] = useState(false);
  const [musicSyncResult, setMusicSyncResult] = useState("");

  const [dataSource, setDataSource] = useState<"diving-fish" | "lxns" | null>(
    null,
  );
  const [dataSourceLoading, setDataSourceLoading] = useState(false);
  const [dataSourceSwitching, setDataSourceSwitching] = useState(false);

  const loadDataSource = useCallback(async () => {
    setDataSourceLoading(true);
    try {
      const res = await fetch("/api/music/source");
      if (res.ok) {
        const data = await res.json();
        setDataSource(data.source);
      }
    } catch {
      // ignore
    }
    setDataSourceLoading(false);
  }, []);

  const switchDataSource = useCallback(
    async (newSource: "diving-fish" | "lxns") => {
      if (!password) return;
      setDataSourceSwitching(true);
      const res = await adminFetch<{ ok: boolean; source: string }>(
        "/api/music/source",
        password,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: newSource }),
        },
      );
      setDataSourceSwitching(false);
      if (res.ok && res.data) {
        setDataSource(res.data.source as "diving-fish" | "lxns");
      }
    },
    [password],
  );

  const syncCovers = useCallback(async () => {
    if (!password) return;
    setCoverSyncing(true);
    setCoverSyncResult("");
    const res = await adminFetch<{
      ok: boolean;
      total: number;
      saved: number;
      skipped: number;
      failed: number;
    }>("/api/admin/sync-covers", password, { method: "POST" });
    setCoverSyncing(false);
    if (res.ok && res.data) {
      setCoverSyncResult(
        `完成: 总计 ${res.data.total}, 保存 ${res.data.saved}, 跳过 ${res.data.skipped}, 失败 ${res.data.failed}`,
      );
    } else {
      setCoverSyncResult(`失败: ${res.error}`);
    }
  }, [password]);

  const syncMusic = useCallback(async () => {
    if (!password) return;
    setMusicSyncing(true);
    setMusicSyncResult("");
    const res = await adminFetch<{
      ok: boolean;
      total: number;
      added: number;
      updated: number;
    }>("/api/admin/sync-music", password, { method: "POST" });
    setMusicSyncing(false);
    if (res.ok && res.data) {
      setMusicSyncResult(
        `完成: 总计 ${res.data.total}, 新增 ${res.data.added}, 更新 ${res.data.updated}`,
      );
    } else {
      setMusicSyncResult(`失败: ${res.error}`);
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
            </Group>
            {coverSyncResult && (
              <Text size="sm" c="dimmed">
                {coverSyncResult}
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
