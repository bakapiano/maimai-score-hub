import {
  IconChartBar,
  IconList,
  IconRefresh,
  IconTrophy,
  IconVersions,
} from "@tabler/icons-react";
import { Anchor, Box, Group, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { syncApi } from "../api/appClient";

import { AllScoresTab } from "./score/AllScoresTab";
import { Best50Tab } from "./score/Best50Tab";
import { LevelScoresTab } from "./score/LevelScoresTab";
import type { SyncScore } from "../types/syncScore";
import { VersionScoresTab } from "./score/VersionScoresTab";
import { useAuth } from "../providers/AuthProvider";
import { useMusic } from "../providers/MusicProvider";
import { cacheSyncLatest, getCachedSyncLatest } from "../utils/offlineCache";

export default function ScorePage() {
  const { token, offline } = useAuth();
  const { musics } = useMusic();
  const [scores, setScores] = useState<SyncScore[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSync = Boolean(lastSyncAt) || scores.length > 0;

  const loadScores = async () => {
    // Offline mode: load from cache
    if (offline) {
      const cached = getCachedSyncLatest();
      if (cached) {
        setScores((cached.scores ?? []) as SyncScore[]);
        setLastSyncAt(cached.createdAt ?? cached.updatedAt ?? null);
      } else {
        setScores([]);
        setLastSyncAt(null);
      }
      return;
    }

    if (!token) return;

    setLoading(true);
    setError(null);

    try {
      const latestRes = await syncApi.latest({
        headers: { authorization: `Bearer ${token}` },
      });

      if (latestRes.status !== 200) {
        if (latestRes.status === 404) {
          setError(null);
          setScores([]);
          setLastSyncAt(null);
          return;
        }
        setError(`获取成绩失败 (HTTP ${latestRes.status})`);
        setScores([]);
        setLastSyncAt(null);
      } else if (latestRes.body) {
        const { scores: syncScores, createdAt, updatedAt } = latestRes.body as {
          scores?: SyncScore[];
          createdAt?: string;
          updatedAt?: string;
        };
        if (Array.isArray(syncScores)) {
          setScores(syncScores);
          // Cache for offline use
          cacheSyncLatest({ scores: syncScores, createdAt, updatedAt });
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
  }, [token, offline]);

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
      <Box style={{ position: "relative" }}>
        <Box
          style={{
            pointerEvents: !hasSync && !error ? "none" : "auto",
            filter: !hasSync && !error ? "blur(1px)" : "none",
            opacity: !hasSync && !error ? 0.6 : 1,
            transition: "filter 120ms ease, opacity 120ms ease",
          }}
        >
          <Tabs defaultValue="best">
            <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
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
        </Box>

        {!hasSync && !error && (
          <Box
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backdropFilter: "blur(2px)",
              backgroundColor: "rgba(255, 255, 255, 0.35)",
              borderRadius: 8,
              zIndex: 1,
            }}
          >
            <Stack align="center" gap="xs">
              {offline ? (
                <Text size="sm" c="dimmed">暂无离线缓存的成绩数据</Text>
              ) : (
              <Anchor component={Link} to="/app/sync">
                <Group gap={6} align="center">
                  <IconRefresh size={16} />
                  <span>同步数据以查看成绩</span>
                </Group>
              </Anchor>
              )}
            </Stack>
          </Box>
        )}
      </Box>
    </Stack>
  );
}
