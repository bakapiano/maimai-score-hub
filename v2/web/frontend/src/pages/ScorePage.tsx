import { Group, Loader, Stack, Tabs, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";

import { AllScoresTab } from "./score/AllScoresTab";
import { Best50Tab } from "./score/Best50Tab";
import {
  IconTrophy,
  IconChartBar,
  IconVersions,
  IconList,
} from "@tabler/icons-react";
import { LevelScoresTab } from "./score/LevelScoresTab";
import type { SyncScore } from "../types/syncScore";
import { VersionScoresTab } from "./score/VersionScoresTab";
import { useAuth } from "../providers/AuthProvider";
import { useMusic } from "../providers/MusicProvider";

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}

export default function ScorePage() {
  const { token } = useAuth();
  const { musics } = useMusic();
  const [scores, setScores] = useState<SyncScore[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadScores = async () => {
    if (!token) return;

    setLoading(true);
    setError(null);

    try {
      const headers: HeadersInit = { Authorization: `Bearer ${token}` };
      const latestRes = await fetchJson<{
        scores?: SyncScore[];
        createdAt?: string;
        updatedAt?: string;
      }>("/api/sync/latest", { headers });

      if (!latestRes.ok) {
        setError(`获取成绩失败 (HTTP ${latestRes.status})`);
        setScores([]);
        setLastSyncAt(null);
      } else if (latestRes.data) {
        const { scores: syncScores, createdAt, updatedAt } = latestRes.data;
        if (Array.isArray(syncScores)) {
          setScores(syncScores);
        } else {
          setScores([]);
        }
        setLastSyncAt(createdAt ?? updatedAt ?? null);
      } else {
        setScores([]);
        setLastSyncAt(null);
      }
    } catch (err) {
      setError((err as Error)?.message ?? "请求失败");
      setScores([]);
      setLastSyncAt(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <Stack align="center" justify="center" h={200}>
        <Loader size="lg" />
        <Text c="dimmed">加载中...</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={3}>乐曲成绩</Title>
          <Text size="sm" c="dimmed">
            最近同步时间:{" "}
            {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "N/A"}
          </Text>
        </div>
        {/* <Button
          variant="light"
          size="sm"
          leftSection={
            loading ? <Loader size="xs" /> : <IconRefresh size={16} />
          }
          onClick={loadScores}
          disabled={loading}
        >
          重新获取
        </Button> */}
      </Group>

      <Tabs defaultValue="best">
        <Tabs.List>
          <Tabs.Tab value="best" leftSection={<IconTrophy size={16} />}>
            B50
          </Tabs.Tab>
          <Tabs.Tab value="levels" leftSection={<IconChartBar size={16} />}>
            按等级
          </Tabs.Tab>
          <Tabs.Tab value="versions" leftSection={<IconVersions size={16} />}>
            按版本
          </Tabs.Tab>
          <Tabs.Tab value="all" leftSection={<IconList size={16} />}>
            全部成绩
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="best" pt="md">
          <Best50Tab scores={scores} loading={loading} />
        </Tabs.Panel>

        <Tabs.Panel value="levels" pt="md">
          <LevelScoresTab
            scores={scores}
            musics={musics}
            lastSyncAt={lastSyncAt}
            loading={loading}
          />
        </Tabs.Panel>

        <Tabs.Panel value="versions" pt="md">
          <VersionScoresTab
            scores={scores}
            musics={musics}
            lastSyncAt={lastSyncAt}
            loading={loading}
          />
        </Tabs.Panel>

        <Tabs.Panel value="all" pt="md">
          <AllScoresTab scores={scores} loading={loading} error={error} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
