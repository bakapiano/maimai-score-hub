import {
  IconCalendarStar,
  IconChartBar,
  IconList,
  IconRefresh,
  IconTrophy,
} from "@tabler/icons-react";
import { Anchor, Box, Group, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { AllScoresTab } from "./score/AllScoresTab";
import { Best50Tab } from "./score/Best50Tab";
import { LevelScoresTab } from "./score/LevelScoresTab";
import type { SyncScore } from "../types/syncScore";
import { VersionScoresTab } from "./score/VersionScoresTab";
import { useAuth } from "../providers/AuthProvider";
import { useMusic } from "../providers/MusicProvider";
import { cacheSyncLatest, getCachedSyncLatest } from "../utils/offlineCache";
import { fetchLatestSync } from "../api/syncLatest";

function readCachedScores() {
  const cached = getCachedSyncLatest();
  if (!cached) return null;

  return {
    scores: Array.isArray(cached.scores) ? (cached.scores as SyncScore[]) : [],
    lastSyncAt: cached.createdAt ?? cached.updatedAt ?? null,
  };
}

export default function ScorePage() {
  const { token, offline } = useAuth();
  const { musics } = useMusic();
  const [initialCachedSync] = useState(() => readCachedScores());
  const [scores, setScores] = useState<SyncScore[]>(
    () => initialCachedSync?.scores ?? [],
  );
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(
    () => initialCachedSync?.lastSyncAt ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSync = Boolean(lastSyncAt) || scores.length > 0;
  const hasSyncRef = useRef(hasSync);

  useEffect(() => {
    hasSyncRef.current = hasSync;
  }, [hasSync]);

  const applyCachedScores = useCallback(() => {
    const cached = readCachedScores();
    if (!cached) return false;

    setScores(cached.scores);
    setLastSyncAt(cached.lastSyncAt);
    return true;
  }, []);

  const clearScoresIfEmpty = useCallback(() => {
    if (hasSyncRef.current) return;
    setScores([]);
    setLastSyncAt(null);
  }, []);

  const loadScores = useCallback(async (options: { force?: boolean } = {}) => {
    // Offline mode: load from cache
    if (offline) {
      if (!applyCachedScores()) clearScoresIfEmpty();
      return;
    }

    if (!token) return;

    setLoading(!hasSyncRef.current);
    setError(null);

    try {
      const latestRes = await fetchLatestSync<{
        id?: string;
        scores?: SyncScore[];
        createdAt?: string;
        updatedAt?: string;
      }>(token, options);

      if (latestRes.status !== 200) {
        if (latestRes.status === 404) {
          setError(null);
          if (!applyCachedScores()) clearScoresIfEmpty();
          return;
        }
        if (!hasSyncRef.current) {
          setError(`获取成绩失败 (HTTP ${latestRes.status})`);
        }
        if (!applyCachedScores()) clearScoresIfEmpty();
      } else if (latestRes.data) {
        const { id, scores: syncScores, createdAt, updatedAt } = latestRes.data;
        if (Array.isArray(syncScores)) {
          setScores(syncScores);
          // Cache for offline use
          cacheSyncLatest({ id, scores: syncScores, createdAt, updatedAt });
        } else {
          setScores([]);
        }
        setLastSyncAt(createdAt ?? updatedAt ?? null);
      } else {
        clearScoresIfEmpty();
      }
    } catch (err) {
      if (!hasSyncRef.current) {
        setError((err as Error)?.message ?? "请求失败");
      }
      if (!applyCachedScores()) clearScoresIfEmpty();
    } finally {
      setLoading(false);
    }
  }, [applyCachedScores, clearScoresIfEmpty, offline, token]);

  useEffect(() => {
    void loadScores();
  }, [loadScores]);

  useEffect(() => {
    if (!token || offline) return;

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void loadScores({ force: true });
      }
    };
    const refreshFromPageCache = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void loadScores({ force: true });
      }
    };

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("pageshow", refreshFromPageCache);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshFromPageCache);
    };
  }, [loadScores, offline, token]);

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
              <Tabs.Tab
                value="versions"
                leftSection={<IconCalendarStar size={16} />}
              >
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
                <Text size="sm" c="dimmed">
                  暂无离线缓存的成绩数据
                </Text>
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
