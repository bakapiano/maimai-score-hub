import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Progress,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import {
  IconChartBar,
  IconCheck,
  IconCloudUpload,
  IconClock,
  IconAlertTriangle,
  IconLogin,
  IconQrcode,
  IconRefresh,
  IconSend,
  IconX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CabinetScoreJob,
  JobRecentStats,
  JobResponse as JobStatus,
} from "@maimai-score-hub/shared";

import { getStatistics } from "../api/appClient";
import { fetchLatestSync } from "../api/syncLatest";
import {
  createCabinetScoreJob,
  getActiveCabinetScoreJob,
} from "../api/cabinetScoreJobClient";
import {
  cacheSyncLatest,
  getCachedSyncLatest,
  getCachedSyncLatestSummary,
} from "../utils/offlineCache";
import {
  JobApiError,
  createJob,
  getActiveJobByFriendCode,
  getFriendshipStatus,
  verifyJob,
} from "../api/jobClient";
import { ProfileCard } from "../components/ProfileCard";
import { CabinetBindingCard } from "../components/CabinetBindingCard";
import { AppCard } from "../components/AppCard";
import { ProberUpdateCard } from "../components/ProberUpdateCard";
import { RadioCardGroup } from "../components/RadioCardGroup";
import { QrCredentialInput } from "../components/QrCredentialInput";
import { SyncMetric } from "../components/SyncMetric";
import { FriendRequestAcceptanceAlert } from "../components/FriendRequestVerification";
import { recordAnalyticsEvent } from "../utils/observability";
import { type AuthProfile, useAuth } from "../providers/AuthContext";
import { useNavigate } from "react-router-dom";
import { runWhenIdle, scheduleIdleTask } from "../utils/idle";
import {
  hasExistingDxnetScores,
  selectDxnetDifficulties,
} from "../utils/dxnetDifficultySelection";
import {
  useCabinetJobPolling,
  useDxnetJobPolling,
} from "../hooks/useSyncJobPolling";

type UserProfileResponse = AuthProfile;

type LastSyncInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastMergedAt?: string;
  scoreUpdatedAt?: string;
  scoreVersion?: number;
  scoreCount: number;
  autoExportResult?: {
    divingFish?: { status: string; message?: string } | null;
    lxns?: { status: string; message?: string } | null;
  } | null;
};

type LatestSyncPayload = Partial<Omit<LastSyncInfo, "scoreCount">> & {
  scores?: unknown[];
  scoreCount?: number;
};

type SyncMethod = "dxnet_bot" | "cabinet_qr";

const DXNET_LOW_SUCCESS_RATE_THRESHOLD = 60;
const DXNET_STATS_MIN_TERMINAL_COUNT = 10;

const DIFFICULTY_NAMES: Record<number, string> = {
  0: "BASIC",
  1: "ADVANCED",
  2: "EXPERT",
  3: "MASTER",
  4: "Re:MASTER",
  10: "宴会场",
};

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeDate(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const daysAgo = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (daysAgo === 0) {
    return `今天 ${time}`;
  }
  if (daysAgo === 1) {
    return `昨天 ${time}`;
  }
  return formatDate(dateString);
}

function formatElapsedTime(dateString: string) {
  const elapsedMs = Math.max(0, Date.now() - new Date(dateString).getTime());
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  if (elapsedHours < 24) {
    return `${Math.max(1, elapsedHours)} 小时前`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) {
    return `${elapsedDays} 天前`;
  }

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) {
    return `${elapsedMonths} 个月前`;
  }

  return `${Math.floor(elapsedMonths / 12)} 年前`;
}

function exportStatusColor(status: string) {
  return status === "success"
    ? "green"
    : status === "skipped"
      ? "yellow"
      : status === "pending" || status === "processing"
        ? "blue"
        : "red";
}

function exportStatusSymbol(status: string) {
  if (status === "success") {
    return "✓";
  }
  if (status === "skipped") {
    return "—";
  }
  if (status === "pending" || status === "processing") {
    return "…";
  }
  return "✗";
}

function normalizeLastSync(
  data: LatestSyncPayload | null | undefined,
): LastSyncInfo | null {
  if (!data) {
    return null;
  }

  const createdAt = data.createdAt ?? data.updatedAt;
  const updatedAt = data.updatedAt ?? data.createdAt;
  if (!createdAt || !updatedAt) {
    return null;
  }

  return {
    id: data.id ?? "cached-latest-sync",
    createdAt,
    updatedAt,
    lastMergedAt: data.lastMergedAt ?? updatedAt,
    scoreUpdatedAt: data.scoreUpdatedAt ?? updatedAt,
    scoreVersion: data.scoreVersion,
    scoreCount:
      typeof data.scoreCount === "number"
        ? data.scoreCount
        : Array.isArray(data.scores)
          ? data.scores.length
          : 0,
    autoExportResult: data.autoExportResult ?? null,
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function readCachedLastSyncSummary(): LastSyncInfo | null {
  return normalizeLastSync(getCachedSyncLatestSummary());
}

function readCachedLastSyncWhenIdle() {
  return runWhenIdle(() => normalizeLastSync(getCachedSyncLatest()), 300);
}

function rememberLastSync(data: LatestSyncPayload | null | undefined) {
  const normalized = normalizeLastSync(data);
  if (!normalized) {
    return null;
  }

  if (Array.isArray(data?.scores)) {
    scheduleIdleTask(
      () =>
        cacheSyncLatest({
          id: normalized.id,
          scores: data.scores ?? [],
          createdAt: normalized.createdAt,
          updatedAt: normalized.updatedAt,
          lastMergedAt: normalized.lastMergedAt,
          scoreUpdatedAt: normalized.scoreUpdatedAt,
          scoreVersion: normalized.scoreVersion,
          autoExportResult: normalized.autoExportResult,
        }),
      1000,
    );
  }
  return normalized;
}

/**
 * Section heading used at the top level of SyncPage. Keeps the visual
 * rhythm consistent across "同步成绩 / 二维码绑定 /
 * 更新查分器" without each section reinventing its own title row.
 */
function SectionHeader({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <Group gap="xs" align="center">
      <Box
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--mantine-color-gray-light)",
          color: "var(--mantine-color-gray-light-color)",
        }}
      >
        {icon}
      </Box>
      <Text fw={700} size="md" style={{ lineHeight: 1.2 }}>
        {title}
      </Text>
    </Group>
  );
}

function getSyncStatusView({
  lastSync,
  loading,
  syncStatus,
}: {
  lastSync: LastSyncInfo | null;
  loading: boolean;
  syncStatus: JobStatus | null;
}) {
  if (loading) {
    return { color: "gray", label: "加载中", text: "正在获取同步状态" };
  }
  if (!syncStatus) {
    return lastSync
      ? {
          color: "green",
          label: `上次更新 ${formatElapsedTime(
            lastSync.lastMergedAt ?? lastSync.updatedAt,
          )}`,
          text: "点击开始同步数据",
        }
      : { color: "gray", label: "未同步", text: "完成首次同步后即可查看成绩" };
  }
  if (syncStatus.status === "completed") {
    return { color: "green", label: "已完成", text: "本次同步已完成" };
  }
  if (syncStatus.status === "failed" || syncStatus.status === "canceled") {
    return { color: "red", label: "失败", text: "同步任务未完成" };
  }
  if (syncStatus.status === "queued") {
    return { color: "gray", label: "排队中", text: "任务正在等待执行" };
  }
  return {
    color: "blue",
    label: "同步中",
    text: "正在从 maimai DX NET 更新成绩",
  };
}

function getSyncStageText(syncStatus: JobStatus | null) {
  if (!syncStatus) {
    return "等待开始";
  }
  if (syncStatus.stage === "send_request") {
    return "发送好友申请";
  }
  if (syncStatus.stage === "wait_acceptance") {
    return "等待好友确认";
  }
  if (syncStatus.stage === "update_score") {
    return "更新成绩";
  }
  if (syncStatus.status === "queued") {
    return "排队中";
  }
  if (syncStatus.status === "completed") {
    return "已完成";
  }
  if (syncStatus.status === "failed") {
    return "失败";
  }
  if (syncStatus.status === "canceled") {
    return "已取消";
  }
  return "同步中";
}

function getCabinetSyncStatusView(job: CabinetScoreJob | null) {
  if (!job) {
    return {
      color: "gray",
      label: "等待二维码",
      text: "请上传或粘贴当前二维码",
    };
  }
  if (job.cleanupStatus === "pending") {
    return {
      color: "orange",
      label: "清理中",
      text: "正在安全退出机台登录状态",
    };
  }
  if (job.cleanupStatus === "unconfirmed") {
    return {
      color: "red",
      label: "等待会话释放",
      text: "暂时无法确认已安全退出",
    };
  }
  if (job.status === "completed") {
    return { color: "green", label: "已完成", text: "二维码成绩更新完成" };
  }
  if (job.status === "failed") {
    return { color: "red", label: "失败", text: "二维码成绩任务未完成" };
  }
  if (job.status === "queued") {
    return { color: "gray", label: "排队中", text: "正在等待 sdgb-worker" };
  }
  return { color: "blue", label: "同步中", text: "正在读取完整机台成绩" };
}

function getCabinetStageText(job: CabinetScoreJob | null) {
  const labels: Record<CabinetScoreJob["stage"], string> = {
    queued: "排队中",
    qr_auth: "验证二维码",
    preview: "检查登录状态",
    login: "登录机台服务",
    get_music: "读取完整成绩",
    logout: "安全退出",
    cleanup: "清理登录状态",
    persist: "保存成绩",
  };
  return job ? labels[job.stage] : "等待开始";
}

function getSyncProgress(syncStatus: JobStatus | null) {
  if (!syncStatus?.scoreProgress) {
    return null;
  }
  const { completedDiffs, totalDiffs } = syncStatus.scoreProgress;
  const percent =
    totalDiffs > 0 ? (completedDiffs.length / totalDiffs) * 100 : 0;
  return { completedDiffs, totalDiffs, percent };
}

function getSyncPageViewState(input: {
  syncMethod: SyncMethod;
  cabinetStatus: CabinetScoreJob | null;
  syncStatus: JobStatus | null;
  cabinetSyncing: boolean;
  dxnetSyncing: boolean;
  hasCabinetUserId: boolean;
  dxnetStats: JobRecentStats | null;
  lastSync: LastSyncInfo | null;
  pageLoading: boolean;
}) {
  const isCabinet = input.syncMethod === "cabinet_qr";
  const dxnetTerminalCount =
    (input.dxnetStats?.completedCount ?? 0) +
    (input.dxnetStats?.failedCount ?? 0);
  return {
    syncStatusView: isCabinet
      ? getCabinetSyncStatusView(input.cabinetStatus)
      : getSyncStatusView({
          lastSync: input.lastSync,
          loading: input.pageLoading,
          syncStatus: input.syncStatus,
        }),
    syncStageText: isCabinet
      ? getCabinetStageText(input.cabinetStatus)
      : getSyncStageText(input.syncStatus),
    effectiveSyncJobStatus: isCabinet
      ? input.cabinetStatus?.status
      : input.syncStatus?.status,
    selectedSyncing: isCabinet
      ? input.cabinetSyncing
      : input.dxnetSyncing,
    cabinetBindingRequired: isCabinet && !input.hasCabinetUserId,
    dxnetTerminalCount,
    dxnetSuccessRate: input.dxnetStats?.successRate ?? 0,
    showDxnetHealthWarning:
      input.dxnetStats !== null &&
      dxnetTerminalCount >= DXNET_STATS_MIN_TERMINAL_COUNT &&
      input.dxnetStats.successRate < DXNET_LOW_SUCCESS_RATE_THRESHOLD,
  };
}

function AutoExportBadges({
  result,
}: {
  result: LastSyncInfo["autoExportResult"];
}) {
  if (!result) {
    return (
      <Text size="sm" c="dimmed">
        未启用
      </Text>
    );
  }

  return (
    <Group gap={4}>
      {result.divingFish && (
        <Badge
          variant="light"
          radius="md"
          color={exportStatusColor(result.divingFish.status)}
        >
          水鱼 {exportStatusSymbol(result.divingFish.status)}
        </Badge>
      )}
      {result.lxns && (
        <Badge
          variant="light"
          radius="md"
          color={exportStatusColor(result.lxns.status)}
        >
          落雪 {exportStatusSymbol(result.lxns.status)}
        </Badge>
      )}
    </Group>
  );
}

function DxnetDifficultySwitch({
  isDxnet,
  hasExistingScores,
  checked,
  disabled,
  onChange,
}: {
  isDxnet: boolean;
  hasExistingScores: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (!isDxnet || !hasExistingScores) {
    return null;
  }
  return (
    <Switch
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
      disabled={disabled}
      label="更新全部难度"
      description="开启后同时更新 BASIC 与 ADVANCED"
    />
  );
}

export default function SyncPage() {
  const {
    token,
    offline,
    setOffline,
    profile,
    profileLoading,
    profileError: authProfileError,
    refreshProfile,
  } = useAuth();
  const navigate = useNavigate();

  // Profile state
  const [profileError, setProfileError] = useState<string | null>(null);

  // Last sync info
  const [lastSync, setLastSync] = useState<LastSyncInfo | null>(() =>
    readCachedLastSyncSummary(),
  );
  const hasExistingScores = hasExistingDxnetScores(lastSync?.scoreCount);

  // Sync job state
  const [syncMethod, setSyncMethod] = useState<SyncMethod>(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("sync_update_method") === "cabinet_qr"
        ? "cabinet_qr"
        : "dxnet_bot",
  );
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<JobStatus | null>(null);
  const [cabinetJobId, setCabinetJobId] = useState<string | null>(null);
  const [cabinetStatus, setCabinetStatus] = useState<CabinetScoreJob | null>(
    null,
  );
  const [qrText, setQrText] = useState("");
  const [dxnetSyncing, setDxnetSyncing] = useState(false);
  const [cabinetSyncing, setCabinetSyncing] = useState(false);
  const [dxnetError, setDxnetError] = useState<string | null>(null);
  const [cabinetError, setCabinetError] = useState<string | null>(null);
  const [dxnetStats, setDxnetStats] = useState<JobRecentStats | null>(null);
  const [updateAllDifficulties, setUpdateAllDifficulties] = useState(false);
  const latestRequestSeqRef = useRef(0);

  // Loading state
  const [loading, setLoading] = useState(true);
  const effectiveProfileError = profileError ?? authProfileError;
  const pageLoading = loading || profileLoading;

  // Fetch last sync info
  const loadLastSync = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!token) {
        return;
      }

      const requestSeq = ++latestRequestSeqRef.current;
      const res = await fetchLatestSync<LatestSyncPayload>(token, options);
      if (requestSeq !== latestRequestSeqRef.current) {
        return;
      }

      const nextLastSync = res.ok ? rememberLastSync(res.data) : null;
      if (res.ok && nextLastSync) {
        setLastSync(nextLastSync);
      } else {
        // Keep the last known sync visible across transient mobile resume
        // failures. A real first-time no-sync user still has no cached value.
        setLastSync((current) => current ?? readCachedLastSyncSummary());
      }
    },
    [token],
  );

  // Fetch profile
  const loadProfile = useCallback(async () => {
    if (!token) {
      return null;
    }

    setProfileError(null);

    try {
      const nextProfile = await refreshProfile({ force: true });
      if (!nextProfile) {
        setProfileError("加载失败");
      }
      return nextProfile;
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "加载失败");
      return null;
    }
  }, [token, refreshProfile]);

  // Load profile and last sync on mount
  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;

    const doLoad = async () => {
      setLoading(true);
      setProfileError(null);

      // Kick off independent requests in parallel. Profile comes from
      // AuthProvider so /me is deduped across the app and StrictMode.
      const profilePromise = refreshProfile();
      const syncPromise = fetchLatestSync<LatestSyncPayload>(token);

      let loadedProfile: UserProfileResponse | null = null;
      try {
        loadedProfile = await profilePromise;
      } catch (err) {
        if (!cancelled) {
          setProfileError(err instanceof Error ? err.message : "加载失败");
        }
      }
      if (cancelled) {
        return;
      }

      if (loadedProfile) {
        // Active-job lookup needs friendCode, so it chains off profile.
        if (loadedProfile.friendCode) {
          const [activeJobResult, cabinetActiveResult] =
            await Promise.allSettled([
            getActiveJobByFriendCode(loadedProfile.friendCode, token),
            getActiveCabinetScoreJob(token),
          ]);
          if (cancelled) {
            return;
          }

          const cabinetActiveJob = settledValue(cabinetActiveResult)?.job;
          if (cabinetActiveJob) {
            setSyncMethod("cabinet_qr");
            setCabinetJobId(cabinetActiveJob.id);
            setCabinetStatus(cabinetActiveJob);
            setCabinetSyncing(true);
          }
          const activeJob = settledValue(activeJobResult)?.job;
          if (activeJob) {
            setSyncJobId(activeJob.id);
            setSyncStatus(activeJob);
            if (
              activeJob.status === "queued" ||
              activeJob.status === "processing"
            ) {
              setDxnetSyncing(true);
            }
          }
        }
      }

      const syncRes = await syncPromise.catch(() => null);
      if (cancelled) {
        return;
      }
      const nextLastSync = syncRes?.ok
        ? rememberLastSync(syncRes.data)
        : null;
      if (syncRes?.ok && nextLastSync) {
        setLastSync(nextLastSync);
      } else {
        const cachedLastSync = await readCachedLastSyncWhenIdle();
        if (cancelled) {
          return;
        }
        setLastSync((current) => current ?? cachedLastSync);
      }

      setLoading(false);
    };

    doLoad();

    return () => {
      cancelled = true;
    };
  }, [token, refreshProfile]);

  useEffect(() => {
    window.localStorage.setItem("sync_update_method", syncMethod);
  }, [syncMethod]);

  useEffect(() => {
    if (syncMethod !== "dxnet_bot") {
      return;
    }

    let cancelled = false;

    void getStatistics()
      .then((statistics) => {
        if (!cancelled) {
          setDxnetStats(statistics.dxnetJobs);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDxnetStats(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [syncMethod]);

  const clearPreviousDxnetJob = useCallback(() => {
    setDxnetError(null);
    setSyncJobId(null);
    setSyncStatus(null);
  }, []);

  const clearPreviousCabinetJob = useCallback(() => {
    setCabinetError(null);
    setCabinetJobId(null);
    setCabinetStatus(null);
  }, []);

  const startUpdateScoreJob = useCallback(
    async (friendshipJobId?: string) => {
      if (!token) {
        return;
      }
      clearPreviousDxnetJob();
      const diffsToScrape = selectDxnetDifficulties(
        hasExistingScores,
        updateAllDifficulties,
      );
      const res = await createJob(
        {
          jobType: "update_score",
          ...(friendshipJobId ? { friendshipJobId } : {}),
          ...(diffsToScrape ? { diffsToScrape } : {}),
        },
        token,
      );
      setSyncJobId(res.jobId);
      setSyncStatus(res.job);
    },
    [clearPreviousDxnetJob, hasExistingScores, token, updateAllDifficulties],
  );

  const startFriendshipJob = useCallback(async () => {
    if (!token) {
      return;
    }
    clearPreviousDxnetJob();
    notifications.show({
      title: "需要先成为好友",
      message: "Bot 将先发送好友申请，接受后会自动开始更新成绩",
      color: "blue",
    });
    const res = await createJob({ jobType: "send_friend_request" }, token);
    setSyncJobId(res.jobId);
    setSyncStatus(res.job);
  }, [clearPreviousDxnetJob, token]);

  const startCabinetSync = useCallback(
    async (payload: string | FormData) => {
      if (!token || !profile?.hasCabinetUserId) {
        return;
      }
      clearPreviousCabinetJob();
      setCabinetSyncing(true);
      try {
        const created = await createCabinetScoreJob(payload, token);
        setCabinetJobId(created.jobId);
        setCabinetStatus(created.job);
        setQrText("");
        recordAnalyticsEvent("sync_started", { method: "cabinet_qr" });
      } catch (error) {
        setCabinetSyncing(false);
        const message =
          error instanceof Error ? error.message : "二维码任务创建失败";
        setCabinetError(message);
      }
    },
    [clearPreviousCabinetJob, profile?.hasCabinetUserId, token],
  );

  // Start sync
  const startSync = useCallback(async () => {
    if (!token) {
      return;
    }
    if (syncMethod === "cabinet_qr") {
      const value = qrText.trim();
      if (!value || !profile?.hasCabinetUserId) {
        return;
      }
      await startCabinetSync(value);
      return;
    }
    if (!profile?.friendCode) {
      return;
    }

    clearPreviousDxnetJob();
    setDxnetSyncing(true);
    recordAnalyticsEvent("sync_started", {
      friendCode: profile.friendCode,
    });

    try {
      const friendship = await getFriendshipStatus(token);
      if (friendship.isFriend || friendship.hasCabinetUserId) {
        await startUpdateScoreJob();
      } else {
        await startFriendshipJob();
      }
    } catch (error) {
      let finalError: unknown = error;
      if (error instanceof JobApiError && error.code === "needs_friendship") {
        try {
          await startFriendshipJob();
          return;
        } catch (fallbackError) {
          finalError = fallbackError;
        }
      }
      setDxnetSyncing(false);
      const errorMessage =
        finalError instanceof Error ? finalError.message : "未知错误";
      setDxnetError(`创建同步任务失败: ${errorMessage}`);
    }
  }, [
    clearPreviousDxnetJob,
    profile,
    qrText,
    startCabinetSync,
    startFriendshipJob,
    startUpdateScoreJob,
    syncMethod,
    token,
  ]);

  useDxnetJobPolling({
    jobId: syncJobId,
    syncing: dxnetSyncing,
    token,
    deadlineAt: syncStatus?.deadlineAt,
    setStatus: setSyncStatus,
    setError: setDxnetError,
    stop: () => setDxnetSyncing(false),
    startScoreJob: startUpdateScoreJob,
    completed: (job) => {
      recordAnalyticsEvent("sync_completed", {
        jobId: job.id,
        jobType: job.jobType,
      });
      void loadProfile();
      void loadLastSync({ force: true });
      window.setTimeout(
        () => void loadLastSync({ force: true }).catch(() => undefined),
        3_000,
      );
    },
    failed: (job) => {
      recordAnalyticsEvent("sync_failed", {
        jobId: job.id,
        jobType: job.jobType,
        status: job.status,
      });
    },
  });

  useCabinetJobPolling({
    jobId: cabinetJobId,
    syncing: cabinetSyncing,
    token,
    createdAt: cabinetStatus?.createdAt,
    setStatus: setCabinetStatus,
    setError: setCabinetError,
    stop: () => setCabinetSyncing(false),
    completed: (job) => {
      recordAnalyticsEvent("sync_completed", {
        jobId: job.id,
        method: "cabinet_qr",
      });
      void loadProfile();
      void loadLastSync({ force: true });
    },
    failed: (job) => {
      recordAnalyticsEvent("sync_failed", {
        jobId: job.id,
        method: "cabinet_qr",
        errorCode: job.error?.code ?? "",
      });
    },
  });

  const verifySyncJob = async () => {
    if (!syncJobId || !token) {
      throw new Error("同步任务不存在或已过期");
    }

    const res = await verifyJob(syncJobId, token);
    setSyncStatus(res.job);
    setDxnetSyncing(true);
  };

  const progress = getSyncProgress(syncStatus);
  const {
    syncStatusView,
    syncStageText,
    effectiveSyncJobStatus,
    selectedSyncing,
    cabinetBindingRequired,
    dxnetTerminalCount,
    dxnetSuccessRate,
    showDxnetHealthWarning,
  } = getSyncPageViewState({
    syncMethod,
    cabinetStatus,
    syncStatus,
    cabinetSyncing,
    dxnetSyncing,
    hasCabinetUserId: profile?.hasCabinetUserId ?? false,
    dxnetStats,
    lastSync,
    pageLoading,
  });
  return (
    <Box style={{ position: "relative" }}>
      {offline && (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            paddingTop: 48,
            gap: 12,
            backdropFilter: "blur(4px)",
            backgroundColor: "rgba(255, 255, 255, 0.3)",
            borderRadius: 8,
            zIndex: 10,
          }}
        >
          <Text fw={600} size="lg">
            需要登录
          </Text>
          <Text size="sm" c="dimmed">
            同步数据功能需要登录后才能使用
          </Text>
          <Button
            leftSection={<IconLogin size={16} />}
            onClick={() => {
              setOffline(false);
              navigate("/login", { replace: true });
            }}
          >
            前往登录
          </Button>
        </Box>
      )}
      <Stack gap="xl" mx="auto" w="100%">
        {/* Profile Section */}

        {effectiveProfileError && (
          <Alert color="red">{effectiveProfileError}</Alert>
        )}

        {pageLoading && !profile?.profile && (
          <AppCard h={160}>
            <Group justify="center" h="100%">
              <Loader size="sm" />
            </Group>
          </AppCard>
        )}

        {profile?.profile && <ProfileCard profile={profile.profile} />}

        {/* Sync Section */}
        <Stack gap="md">
          <Stack gap="xs">
            <AppCard compact>
              <Stack gap="md">
                <SectionHeader
                  icon={<IconCloudUpload size={16} />}
                  title="同步成绩"
                />
                <RadioCardGroup
                  value={syncMethod}
                  onChange={(value) => {
                    const nextMethod = value as "dxnet_bot" | "cabinet_qr";
                    if (nextMethod === "dxnet_bot") {
                      setDxnetStats(null);
                    }
                    setSyncMethod(nextMethod);
                    if (nextMethod !== "cabinet_qr") {
                      setQrText("");
                    }
                  }}
                  data={[
                    {
                      value: "dxnet_bot",
                      name: "DX Net",
                      description: "通过 DX Net 好友成绩同步游戏数据",
                    },
                    {
                      value: "cabinet_qr",
                      name: "二维码",
                      description: "使用机台二维码读取完整游戏成绩",
                    },
                  ]}
                />

                {syncMethod === "dxnet_bot" && showDxnetHealthWarning && (
                  <Alert
                    color="orange"
                    variant="light"
                    icon={<IconAlertTriangle size={18} />}
                    title={`DX Net 近 1 小时成功率仅 ${dxnetSuccessRate.toFixed(1)}%（${dxnetTerminalCount} 个已结束任务），建议改用二维码更新`}
                    radius="md"
                  />
                )}

                {syncMethod === "cabinet_qr" &&
                  (cabinetBindingRequired ? (
                    <Alert color="orange" variant="light">
                      请先在下方完成二维码绑定后再使用。
                    </Alert>
                  ) : (
                    <Stack gap="sm">
                      <QrCredentialInput
                        value={qrText}
                        onChange={setQrText}
                        onFile={(file) => {
                          const form = new FormData();
                          form.append("image", file);
                          void startCabinetSync(form);
                        }}
                        disabled={
                          cabinetSyncing ||
                          pageLoading ||
                          !profile?.hasCabinetUserId
                        }
                        loading={cabinetSyncing}
                      />
                      {cabinetStatus?.progress && (
                        <Text size="sm" c="dimmed">
                          已读取 {cabinetStatus.progress.detailsFetched}{" "}
                          条成绩详情
                        </Text>
                      )}
                    </Stack>
                  ))}

                <DxnetDifficultySwitch
                  isDxnet={syncMethod === "dxnet_bot"}
                  hasExistingScores={hasExistingScores}
                  checked={updateAllDifficulties}
                  disabled={dxnetSyncing || pageLoading}
                  onChange={setUpdateAllDifficulties}
                />

                {!cabinetBindingRequired && (
                  <Group justify="space-between" align="center" wrap="wrap">
                    <Group gap="sm" align="center" wrap="nowrap">
                      <Box
                        style={{
                          width: 42,
                          height: 42,
                          flex: "0 0 auto",
                          borderRadius: 14,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: `var(--mantine-color-${syncStatusView.color}-7)`,
                          background: `var(--mantine-color-${syncStatusView.color}-light)`,
                        }}
                      >
                        {pageLoading ||
                        selectedSyncing ||
                        effectiveSyncJobStatus === "queued" ||
                        effectiveSyncJobStatus === "processing" ? (
                          <Loader size="sm" color={syncStatusView.color} />
                        ) : effectiveSyncJobStatus === "failed" ||
                          effectiveSyncJobStatus === "canceled" ? (
                          <IconX size={22} />
                        ) : effectiveSyncJobStatus === "completed" ? (
                          <IconCheck size={22} />
                        ) : (
                          <IconRefresh size={22} />
                        )}
                      </Box>
                      <Stack gap={1}>
                        <Group gap="xs">
                          <Text fw={700} size="md">
                            {syncStatusView.label}
                          </Text>
                          {effectiveSyncJobStatus && (
                            <Badge
                              variant="light"
                              color={syncStatusView.color}
                              radius="xl"
                              size="sm"
                            >
                              {syncStageText}
                            </Badge>
                          )}
                        </Group>
                        <Text size="sm" c="dimmed">
                          {syncStatusView.text}
                        </Text>
                      </Stack>
                    </Group>
                    <Button
                      onClick={startSync}
                      disabled={
                        selectedSyncing ||
                        pageLoading ||
                        (syncMethod === "dxnet_bot"
                          ? !profile?.friendCode
                          : !profile?.hasCabinetUserId || !qrText.trim())
                      }
                      loading={selectedSyncing}
                      variant="light"
                      leftSection={<IconRefresh size={16} />}
                      w={{ base: "100%", xs: "auto" }}
                      styles={{ root: { flexShrink: 0 } }}
                    >
                      {syncMethod === "cabinet_qr"
                        ? "更新成绩"
                        : lastSync
                          ? "更新成绩"
                          : "开始同步"}
                    </Button>
                  </Group>
                )}

                {syncMethod === "dxnet_bot" &&
                  progress &&
                  syncStatus?.status === "processing" &&
                  syncStatus?.stage === "update_score" && (
                    <Stack gap="xs">
                      <Group justify="space-between" align="center">
                        <Text size="sm" fw={600}>
                          正在更新成绩
                        </Text>
                        <Text size="sm" fw={700} c="blue.7">
                          {Math.round(progress.percent)}%
                        </Text>
                      </Group>
                      <Progress
                        value={progress.percent}
                        animated={dxnetSyncing}
                        size="md"
                        radius="xl"
                        color={progress.percent === 100 ? "green" : "blue"}
                      />
                      {progress.completedDiffs.length > 0 && (
                        <Group gap="xs">
                          {progress.completedDiffs.map((diff) => (
                            <Badge
                              radius="md"
                              key={diff}
                              size="sm"
                              variant="filled"
                              color={
                                diff === 0
                                  ? "green"
                                  : diff === 1
                                    ? "yellow"
                                    : diff === 2
                                      ? "red"
                                      : diff === 3
                                        ? "grape"
                                        : diff === 4
                                          ? "violet"
                                          : "pink"
                              }
                            >
                              {DIFFICULTY_NAMES[diff] ?? `Diff ${diff}`}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Stack>
                  )}

                {syncMethod === "dxnet_bot" && dxnetError && (
                  <Alert color="red">{dxnetError}</Alert>
                )}

                {syncMethod === "dxnet_bot" &&
                  (syncStatus?.cabinetFriendshipStatus === "pending" ||
                    syncStatus?.cabinetFriendshipStatus === "running") && (
                    <Alert color="blue" variant="light">
                      正在准备 Bot 好友关系，完成后会自动开始更新成绩。
                    </Alert>
                  )}

                {syncMethod === "dxnet_bot" &&
                  syncStatus?.cabinetFriendshipStatus === "uncertain" && (
                    <Alert color="yellow" variant="light">
                      机台请求结果暂不确定，正在通过 DXNet 确认好友关系。
                    </Alert>
                  )}

                {syncMethod === "dxnet_bot" &&
                  [
                    "cabinet_bot_unavailable",
                    "cabinet_friendship_failed",
                    "cabinet_friendship_unconfirmed",
                  ].includes(syncStatus?.errorCode ?? "") && (
                    <Alert color="orange" variant="light" title="可改用好友申请">
                      <Stack gap="xs">
                        <Text size="sm">
                          自动建立好友关系未成功，可以改用传统好友申请流程。
                        </Text>
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => void startFriendshipJob()}
                        >
                          发起好友申请
                        </Button>
                      </Stack>
                    </Alert>
                  )}

                {syncMethod === "dxnet_bot" && syncStatus?.error && (
                  <Alert color="red" variant="light" title="错误" radius="md">
                    {syncStatus.error}
                  </Alert>
                )}

                {syncMethod === "cabinet_qr" && cabinetError && (
                  <Alert color="red">{cabinetError}</Alert>
                )}

                {syncMethod === "cabinet_qr" && cabinetStatus?.error && (
                  <Alert color="red" variant="light" title="错误" radius="md">
                    {cabinetStatus.error.message}
                    {cabinetStatus.error.retryAfter
                      ? `（${new Date(cabinetStatus.error.retryAfter).toLocaleString("zh-CN")} 后可重试）`
                      : ""}
                  </Alert>
                )}

                <Divider />

                <SimpleGrid
                  cols={{ base: 1, xs: 3 }}
                  spacing={{ base: "xs", xs: "md" }}
                >
                  <SyncMetric icon={<IconClock size={18} />} label="最近同步">
                    <Text size="sm" fw={600}>
                      {lastSync
                        ? formatRelativeDate(
                            lastSync.lastMergedAt ?? lastSync.updatedAt,
                          )
                        : "暂无记录"}
                    </Text>
                  </SyncMetric>
                  <SyncMetric
                    icon={<IconChartBar size={18} />}
                    label="成绩记录"
                  >
                    <Text size="sm" fw={600}>
                      {lastSync
                        ? lastSync.scoreCount.toLocaleString("zh-CN")
                        : "-"}
                      {lastSync && (
                        <Text
                          component="span"
                          size="xs"
                          fw={400}
                          c="dimmed"
                          ml={4}
                        >
                          条
                        </Text>
                      )}
                    </Text>
                  </SyncMetric>
                  <SyncMetric icon={<IconSend size={18} />} label="自动导出">
                    <AutoExportBadges result={lastSync?.autoExportResult} />
                  </SyncMetric>
                </SimpleGrid>
              </Stack>
            </AppCard>
          </Stack>

          {dxnetSyncing && syncStatus?.stage === "wait_acceptance" && (
            <FriendRequestAcceptanceAlert
              key={syncJobId}
              friendRequestSentAt={syncStatus.friendRequestSentAt}
              onVerify={verifySyncJob}
              disabled={!syncJobId || !token}
            />
          )}
        </Stack>

        {/* Cabinet QR Section */}
        {token && profile && (
          <Stack gap="md">
            <CabinetBindingCard
              token={token}
              hasCabinetUserId={profile.hasCabinetUserId ?? false}
              autoUpdate={profile.autoUpdate ?? false}
              header={
                <SectionHeader
                  icon={<IconQrcode size={16} />}
                  title="二维码绑定"
                />
              }
              onChanged={() => {
                void loadProfile();
              }}
            />
          </Stack>
        )}
        {/* Token Settings & Export Section */}
        <Stack gap="md">
          <ProberUpdateCard
            token={token}
            profile={profile}
            onProfileChanged={loadProfile}
            header={
              <SectionHeader icon={<IconSend size={16} />} title="更新查分器" />
            }
          />
        </Stack>
      </Stack>
    </Box>
  );
}
