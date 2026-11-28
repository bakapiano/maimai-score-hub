import {
  IconCalendarStar,
  IconChartBar,
  IconHistory,
  IconList,
  IconRefresh,
  IconTrophy,
} from "@tabler/icons-react";
import {
  Anchor,
  Box,
  Center,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AllScoresTab } from "./score/AllScoresTab";
import { Best50Tab } from "./score/Best50Tab";
import { LevelScoresTab } from "./score/LevelScoresTab";
import { ScoreHistoryTab } from "./score/ScoreHistoryTab";
import type { SyncScore } from "../types/syncScore";
import { VersionScoresTab } from "./score/VersionScoresTab";
import { useAuth } from "../providers/AuthContext";
import { useMusic } from "../providers/MusicContext";
import {
  cacheSyncLatest,
  getCachedProfile,
  getCachedSyncLatest,
} from "../utils/offlineCache";
import { fetchLatestSync } from "../api/syncLatest";
import { runWhenIdle, scheduleIdleTask } from "../utils/idle";
import classes from "./ScorePage.module.css";

const SCORE_TABS = ["best", "levels", "versions", "history", "all"] as const;
type ScoreTab = (typeof SCORE_TABS)[number];

function parseScoreTab(value: string | null): ScoreTab {
  return SCORE_TABS.includes(value as ScoreTab) ? (value as ScoreTab) : "best";
}

function readLastFriendCode() {
  try {
    return localStorage.getItem("lastFriendCode");
  } catch {
    return null;
  }
}

function isCacheOwnedByCurrentUser(
  offline: boolean,
  friendCode?: string | null,
) {
  if (offline) {
    return true;
  }
  const cachedFriendCode = getCachedProfile()?.friendCode;
  const knownFriendCode = friendCode ?? readLastFriendCode();
  return Boolean(
    cachedFriendCode && knownFriendCode && cachedFriendCode === knownFriendCode,
  );
}

function readCachedScores(offline: boolean, friendCode?: string | null) {
  if (!isCacheOwnedByCurrentUser(offline, friendCode)) {
    return null;
  }
  const cached = getCachedSyncLatest();
  if (!cached) {
    return null;
  }

  return {
    scores: Array.isArray(cached.scores) ? (cached.scores as SyncScore[]) : [],
    lastSyncAt:
      cached.lastMergedAt ?? cached.updatedAt ?? cached.createdAt ?? null,
  };
}

function readCachedScoresWhenIdle(
  offline: boolean,
  friendCode?: string | null,
) {
  return runWhenIdle(() => readCachedScores(offline, friendCode), 300);
}

function cacheSyncLatestWhenIdle(data: Parameters<typeof cacheSyncLatest>[0]) {
  scheduleIdleTask(() => cacheSyncLatest(data), 1000);
}

function useScoreTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseScoreTab(searchParams.get("tab"));
  const setActiveTab = useCallback(
    (next: string | null) => {
      const tab = parseScoreTab(next);
      setSearchParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          if (tab === "best") {
            updated.delete("tab");
          } else {
            updated.set("tab", tab);
          }
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return { activeTab, setActiveTab };
}

function EmptySyncOverlay({ offline }: { offline: boolean }) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(2px)",
        backgroundColor:
          "light-dark(rgba(255, 255, 255, 0.45), rgba(20, 21, 23, 0.55))",
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
  );
}

export default function ScorePage() {
  const { token, offline, profile } = useAuth();
  const { musics, loading: musicLoading } = useMusic();
  const { activeTab, setActiveTab } = useScoreTab();
  const [scores, setScores] = useState<SyncScore[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => Boolean(token || offline));
  const [error, setError] = useState<string | null>(null);
  const hasSync = Boolean(lastSyncAt) || scores.length > 0;
  const historyActive = activeTab === "history";
  const hasSyncRef = useRef(hasSync);
  const friendCode = profile?.friendCode ?? null;

  useEffect(() => {
    hasSyncRef.current = hasSync;
  }, [hasSync]);

  const applyCachedScores = useCallback(async () => {
    const cached = await readCachedScoresWhenIdle(offline, friendCode);
    if (!cached) {
      return false;
    }

    setScores(cached.scores);
    setLastSyncAt(cached.lastSyncAt);
    return true;
  }, [friendCode, offline]);

  useEffect(() => {
    if (!token || offline || hasSyncRef.current) {
      return;
    }
    let cancelled = false;
    void readCachedScoresWhenIdle(false, friendCode).then((cached) => {
      if (cancelled || !cached || hasSyncRef.current) {
        return;
      }
      setScores(cached.scores);
      setLastSyncAt(cached.lastSyncAt);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [friendCode, offline, token]);

  const clearScoresIfEmpty = useCallback(() => {
    if (hasSyncRef.current) {
      return;
    }
    setScores([]);
    setLastSyncAt(null);
  }, []);

  const loadScores = useCallback(
    async (options: { force?: boolean } = {}) => {
      // Offline mode: load from cache
      if (offline) {
        setLoading(!hasSyncRef.current);
        if (!(await applyCachedScores())) {
          clearScoresIfEmpty();
        }
        setLoading(false);
        return;
      }

      if (!token) {
        setLoading(false);
        return;
      }

      setLoading(!hasSyncRef.current);
      setError(null);

      try {
        const latestRes = await fetchLatestSync<{
          id?: string;
          scores?: SyncScore[];
          createdAt?: string;
          updatedAt?: string;
          lastMergedAt?: string;
          scoreUpdatedAt?: string;
          scoreVersion?: number;
        }>(token, options);

        if (latestRes.status !== 200) {
          if (latestRes.status === 404) {
            setError(null);
            if (!(await applyCachedScores())) {
              clearScoresIfEmpty();
            }
            return;
          }
          if (!hasSyncRef.current) {
            setError(`获取成绩失败 (HTTP ${latestRes.status})`);
          }
          if (!(await applyCachedScores())) {
            clearScoresIfEmpty();
          }
        } else if (latestRes.data) {
          const {
            id,
            scores: syncScores,
            createdAt,
            updatedAt,
            lastMergedAt,
            scoreUpdatedAt,
            scoreVersion,
          } = latestRes.data;
          if (Array.isArray(syncScores)) {
            setScores(syncScores);
            cacheSyncLatestWhenIdle({
              id,
              scores: syncScores,
              createdAt,
              updatedAt,
              lastMergedAt,
              scoreUpdatedAt,
              scoreVersion,
            });
          } else {
            setScores([]);
          }
          setLastSyncAt(lastMergedAt ?? updatedAt ?? createdAt ?? null);
        } else {
          clearScoresIfEmpty();
        }
      } catch (err) {
        if (!hasSyncRef.current) {
          setError((err as Error)?.message ?? "请求失败");
        }
        if (!(await applyCachedScores())) {
          clearScoresIfEmpty();
        }
      } finally {
        setLoading(false);
      }
    },
    [applyCachedScores, clearScoresIfEmpty, offline, token],
  );

  useEffect(() => {
    void loadScores();
  }, [loadScores]);

  useEffect(() => {
    if (!token || offline) {
      return;
    }

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

  const initialMusicLoading = musicLoading && musics.length === 0;

  if (loading || initialMusicLoading) {
    return (
      <Center
        mih={{
          base: "calc(100dvh - 9rem)",
          sm: "calc(100dvh - 13rem)",
        }}
      >
        <Stack align="center" gap="sm">
          <Loader size="lg" />
          <Text c="dimmed">
            {initialMusicLoading && !loading
              ? "正在加载乐曲信息..."
              : "加载中..."}
          </Text>
        </Stack>
      </Center>
    );
  }

  const showEmptyOverlay = !historyActive && !hasSync && !error;

  return (
    <Stack gap="md">
      <Box style={{ position: "relative" }}>
        <Box
          style={{
            pointerEvents: showEmptyOverlay ? "none" : "auto",
            filter: showEmptyOverlay ? "blur(1px)" : "none",
            opacity: showEmptyOverlay ? 0.6 : 1,
            transition: "filter 120ms ease, opacity 120ms ease",
          }}
        >
          <Tabs
            value={activeTab}
            onChange={(value) => setActiveTab(value ?? "best")}
            keepMounted={false}
            classNames={{
              root: classes.tabsRoot,
              list: classes.tabsList,
              tab: classes.tab,
            }}
          >
            <Tabs.List>
              <Tabs.Tab value="best" leftSection={<IconTrophy size={16} />}>
                <span className={classes.tabLabelFull}>B50</span>
                <span className={classes.tabLabelShort}>B50</span>
              </Tabs.Tab>
              <Tabs.Tab value="levels" leftSection={<IconChartBar size={16} />}>
                <span className={classes.tabLabelFull}>按等级</span>
                <span className={classes.tabLabelShort}>等级</span>
              </Tabs.Tab>
              <Tabs.Tab
                value="versions"
                leftSection={<IconCalendarStar size={16} />}
              >
                <span className={classes.tabLabelFull}>按版本</span>
                <span className={classes.tabLabelShort}>版本</span>
              </Tabs.Tab>
              <Tabs.Tab value="history" leftSection={<IconHistory size={16} />}>
                <span className={classes.tabLabelFull}>成绩历史</span>
                <span className={classes.tabLabelShort}>历史</span>
              </Tabs.Tab>
              <Tabs.Tab value="all" leftSection={<IconList size={16} />}>
                <span className={classes.tabLabelFull}>全部成绩</span>
                <span className={classes.tabLabelShort}>全部</span>
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

            <Tabs.Panel value="history" pt="md">
              <ScoreHistoryTab />
            </Tabs.Panel>

            <Tabs.Panel value="all" pt="md">
              <AllScoresTab scores={scores} loading={loading} error={error} />
            </Tabs.Panel>
          </Tabs>
        </Box>

        {showEmptyOverlay && <EmptySyncOverlay offline={offline} />}
      </Box>
    </Stack>
  );
}
