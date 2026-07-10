import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Progress,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconChartBar,
  IconCheck,
  IconCloudUpload,
  IconClock,
  IconKey,
  IconLogin,
  IconPassword,
  IconRefresh,
  IconSend,
  IconUser,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobResponse as JobStatus } from "@maimai-score-hub/shared";

import { fetchLatestSync } from "../api/syncLatest";
import { fetchSyncPageJson } from "./syncPageApi";
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
  getJobById,
  verifyJob,
} from "../api/jobClient";
import { ProfileCard } from "../components/ProfileCard";
import { CabinetBindingCard } from "../components/CabinetBindingCard";
import { SyncMetric } from "../components/SyncMetric";
import { formatFriendRequestSentAt } from "../utils/formatDate";
import { recordAnalyticsEvent } from "../utils/observability";
import { type AuthProfile, useAuth } from "../providers/AuthContext";
import { useNavigate } from "react-router-dom";
import { runWhenIdle, scheduleIdleTask } from "../utils/idle";

type UserProfileResponse = AuthProfile;

type ExportTarget = "diving-fish" | "lxns";
type ExportProviderKey = "divingFish" | "lxns";
type ProberExportProviderResult = {
  status: "success" | "failed" | "skipped";
  exported?: number;
  skipped?: number;
  scores?: number;
  message?: string;
  response?: { creates?: number; updates?: number; data?: unknown[] };
};
type ProberExportJob = {
  id: string;
  status:
    | "queued"
    | "processing"
    | "completed"
    | "partial_failed"
    | "failed"
    | "skipped";
  result?: {
    divingFish?: ProberExportProviderResult | null;
    lxns?: ProberExportProviderResult | null;
  } | null;
  error?: string | null;
};
type ProberExportCreateResponse = {
  exportJobId: string;
  status: ProberExportJob["status"];
  job: ProberExportJob;
};

type LastSyncInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
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

const DIFFICULTY_NAMES: Record<number, string> = {
  0: "BASIC",
  1: "ADVANCED",
  2: "EXPERT",
  3: "MASTER",
  4: "Re:MASTER",
  10: "宴会场",
};
const SYNC_WAIT_SECONDS = 5 * 60;

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
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (daysAgo === 0) {return `今天 ${time}`;}
  if (daysAgo === 1) {return `昨天 ${time}`;}
  return formatDate(dateString);
}

function formatElapsedTime(dateString: string) {
  const elapsedMs = Math.max(0, Date.now() - new Date(dateString).getTime());
  const elapsedHours = Math.floor(elapsedMs / (60 * 60 * 1000));
  if (elapsedHours < 24) {return `${Math.max(1, elapsedHours)} 小时前`;}

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) {return `${elapsedDays} 天前`;}

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) {return `${elapsedMonths} 个月前`;}

  return `${Math.floor(elapsedMonths / 12)} 年前`;
}

function exportStatusColor(status: string) {
  return status === "success" ? "green" : status === "skipped" ? "yellow" : "red";
}

function normalizeLastSync(
  data: LatestSyncPayload | null | undefined,
): LastSyncInfo | null {
  if (!data) {return null;}

  const createdAt = data.createdAt ?? data.updatedAt;
  const updatedAt = data.updatedAt ?? data.createdAt;
  if (!createdAt || !updatedAt) {return null;}

  return {
    id: data.id ?? "cached-latest-sync",
    createdAt,
    updatedAt,
    scoreCount:
      typeof data.scoreCount === "number"
        ? data.scoreCount
        : Array.isArray(data.scores)
          ? data.scores.length
          : 0,
    autoExportResult: data.autoExportResult ?? null,
  };
}

function readCachedLastSyncSummary(): LastSyncInfo | null {
  return normalizeLastSync(getCachedSyncLatestSummary());
}

function readCachedLastSyncWhenIdle() {
  return runWhenIdle(() => normalizeLastSync(getCachedSyncLatest()), 300);
}

function rememberLastSync(data: LatestSyncPayload | null | undefined) {
  const normalized = normalizeLastSync(data);
  if (!normalized) {return null;}

  if (Array.isArray(data?.scores)) {
    scheduleIdleTask(() =>
      cacheSyncLatest({
        id: normalized.id,
        scores: data.scores ?? [],
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
        autoExportResult: normalized.autoExportResult,
      }),
    1000);
  }
  return normalized;
}

/**
 * Section heading used at the top level of SyncPage. Keeps the visual
 * rhythm consistent across "同步成绩 / 神秘二维码绑定 /
 * 更新查分器" without each section reinventing its own title row.
 */
function SectionHeader({
  icon,
  color,
  title,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
}) {
  return (
    <Group gap="sm" align="center" mb={4}>
      <Box
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `var(--mantine-color-${color}-light)`,
          color: `var(--mantine-color-${color}-filled)`,
        }}
      >
        {icon}
      </Box>
      <Text fw={700} size="lg" style={{ lineHeight: 1.2 }}>
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
          label: `上次更新 ${formatElapsedTime(lastSync.createdAt)}`,
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
  return { color: "blue", label: "同步中", text: "正在从 maimai DX NET 更新成绩" };
}

function getSyncStageText(syncStatus: JobStatus | null) {
  if (!syncStatus) {return "等待开始";}
  if (syncStatus.stage === "send_request") {return "发送好友申请";}
  if (syncStatus.stage === "wait_acceptance") {return "等待好友确认";}
  if (syncStatus.stage === "update_score") {return "更新成绩";}
  if (syncStatus.status === "queued") {return "排队中";}
  if (syncStatus.status === "completed") {return "已完成";}
  if (syncStatus.status === "failed") {return "失败";}
  if (syncStatus.status === "canceled") {return "已取消";}
  return "同步中";
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
          水鱼{" "}
          {result.divingFish.status === "success"
            ? "✓"
            : result.divingFish.status === "skipped"
              ? "—"
              : "✗"}
        </Badge>
      )}
      {result.lxns && (
        <Badge
          variant="light"
          radius="md"
          color={exportStatusColor(result.lxns.status)}
        >
          落雪{" "}
          {result.lxns.status === "success"
            ? "✓"
            : result.lxns.status === "skipped"
              ? "—"
              : "✗"}
        </Badge>
      )}
    </Group>
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

  // Token settings
  const [divingFishToken, setDivingFishToken] = useState("");
  const [lxnsToken, setLxnsToken] = useState("");
  const [editingDivingFishToken, setEditingDivingFishToken] = useState(false);
  const [editingLxnsToken, setEditingLxnsToken] = useState(false);

  // Diving-Fish login mode: "token" or "login"
  const [divingFishMode, setDivingFishMode] = useState<"token" | "login">(
    "token",
  );
  // Diving-Fish login credentials (not saved, only used to fetch token)
  const [divingFishUsername, setDivingFishUsername] = useState("");
  const [divingFishPassword, setDivingFishPassword] = useState("");
  const [fetchingDivingFishToken, setFetchingDivingFishToken] = useState(false);

  // Sync job state
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<JobStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const chainedFriendshipJobIdRef = useRef<string | null>(null);

  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / SYNC_WAIT_SECONDS) * 100),
  );
  const syncStage = syncStatus?.stage;
  const syncFriendRequestSentAt = syncStatus?.friendRequestSentAt;

  // Export state
  const [exportLoading, setExportLoading] = useState<
    "diving-fish" | "lxns" | null
  >(null);

  // Loading state
  const [loading, setLoading] = useState(true);
  const effectiveProfileError = profileError ?? authProfileError;
  const pageLoading = loading || profileLoading;

  // Fetch last sync info
  const loadLastSync = useCallback(async (options: { force?: boolean } = {}) => {
    if (!token) {return;}

    const res = await fetchLatestSync<LatestSyncPayload>(token, options);

    const nextLastSync = res.ok ? rememberLastSync(res.data) : null;
    if (res.ok && nextLastSync) {
      setLastSync(nextLastSync);
    } else {
      // Keep the last known sync visible across transient mobile resume
      // failures. A real first-time no-sync user still has no cached value.
      setLastSync((current) => current ?? readCachedLastSyncSummary());
    }
  }, [token]);

  // Fetch profile
  const loadProfile = useCallback(async () => {
    if (!token) {return null;}

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
    if (!token) {return;}

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
      if (cancelled) {return;}

      if (loadedProfile) {
        // Active-job lookup needs friendCode, so it chains off profile.
        if (loadedProfile.friendCode) {
          const activeJobRes = await getActiveJobByFriendCode(
            loadedProfile.friendCode,
            token,
          );
          if (cancelled) {return;}

          if (activeJobRes.job) {
            const activeJob = activeJobRes.job;
            setSyncJobId(activeJob.id);
            setSyncStatus(activeJob);
            if (
              activeJob.status === "queued" ||
              activeJob.status === "processing"
            ) {
              setSyncing(true);
            }
          }
        }
      }

      const syncRes = await syncPromise;
      if (cancelled) {return;}
      const nextLastSync = syncRes.ok ? rememberLastSync(syncRes.data) : null;
      if (syncRes.ok && nextLastSync) {
        setLastSync(nextLastSync);
      } else {
        const cachedLastSync = await readCachedLastSyncWhenIdle();
        if (cancelled) {return;}
        setLastSync((current) => current ?? cachedLastSync);
      }

      setLoading(false);
    };

    doLoad();

    return () => {
      cancelled = true;
    };
  }, [token, refreshProfile]);

  // Save tokens (silent, returns success)
  // Only sends token fields that the user has actually entered a value for
  const saveTokens = async (): Promise<boolean> => {
    if (!token) {return false;}

    const body: Record<string, string | null> = {};
    if (divingFishToken) {body.divingFishImportToken = divingFishToken;}
    if (lxnsToken) {body.lxnsImportToken = lxnsToken;}

    // Nothing to save
    if (Object.keys(body).length === 0) {return true;}

    const res = await fetchSyncPageJson<unknown>("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      loadProfile();
      return true;
    }
    return false;
  };

  const startUpdateScoreJob = useCallback(
    async (friendshipJobId?: string) => {
      if (!token) {return;}
      const res = await createJob(
        {
          jobType: "update_score",
          ...(friendshipJobId ? { friendshipJobId } : {}),
        },
        token,
      );
      setSyncJobId(res.jobId);
      setSyncStatus(res.job);
    },
    [token],
  );

  const startFriendshipJob = useCallback(async () => {
    if (!token) {return;}
    notifications.show({
      title: "需要先成为好友",
      message: "Bot 将先发送好友申请，接受后会自动开始更新成绩",
      color: "blue",
    });
    const res = await createJob({ jobType: "send_friend_request" }, token);
    setSyncJobId(res.jobId);
    setSyncStatus(res.job);
  }, [token]);

  // Start sync
  const startSync = useCallback(async () => {
    if (!profile?.friendCode || !token) {return;}

    setSyncing(true);
    setSyncError(null);
    setSyncStatus(null);
    chainedFriendshipJobIdRef.current = null;
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
      setSyncing(false);
      const errorMessage =
        finalError instanceof Error ? finalError.message : "未知错误";
      setSyncError(`创建同步任务失败: ${errorMessage}`);
    }
  }, [profile?.friendCode, token, startFriendshipJob, startUpdateScoreJob]);

  // Poll job status
  useEffect(() => {
    if (!syncJobId || !syncing || !token) {return;}

    const interval = setInterval(async () => {
      try {
        const job = await getJobById(syncJobId, token);
        setSyncStatus(job);

        if (
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "canceled"
        ) {
          if (job.status === "completed") {
            if (job.jobType === "send_friend_request") {
              if (chainedFriendshipJobIdRef.current === job.id) {
                return;
              }
              chainedFriendshipJobIdRef.current = job.id;
              try {
                await startUpdateScoreJob(job.id);
              } catch (error) {
                chainedFriendshipJobIdRef.current = null;
                setSyncing(false);
                const errorMessage =
                  error instanceof Error ? error.message : "未知错误";
                setSyncError(`创建成绩更新任务失败: ${errorMessage}`);
              }
              return;
            }
            setSyncing(false);
            recordAnalyticsEvent("sync_completed", {
              jobId: job.id,
              jobType: job.jobType,
            });
            loadProfile();
            loadLastSync({ force: true });

            // Refresh latest sync after a delay to pick up queued export results
            setTimeout(async () => {
              try {
                await loadLastSync({ force: true });
              } catch {
                // ignore
              }
            }, 3000);
          } else {
            setSyncing(false);
            recordAnalyticsEvent("sync_failed", {
              jobId: job.id,
              jobType: job.jobType,
              status: job.status,
            });
          }
        }
      } catch {
        setSyncError("轮询失败");
        return;
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [
    syncJobId,
    syncing,
    token,
    loadProfile,
    loadLastSync,
    startUpdateScoreJob,
  ]);

  // Handle timeout countdown for wait_acceptance stage
  useEffect(() => {
    if (
      syncStage !== "wait_acceptance" ||
      !syncFriendRequestSentAt
    ) {
      setTimeLeft((current) => (current === 0 ? current : 0));
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const sentAt = new Date(syncFriendRequestSentAt).getTime();
      const end = sentAt + SYNC_WAIT_SECONDS * 1000;
      const left = Math.max(0, Math.ceil((end - now) / 1000));
      setTimeLeft(left);
    }, 500);

    return () => clearInterval(interval);
  }, [syncStage, syncFriendRequestSentAt]);

  const verifySyncJob = async () => {
    if (!syncJobId || !token) {return;}

    setVerifyLoading(true);
    try {
      const res = await verifyJob(syncJobId, token);
      setSyncStatus(res.job);
      setSyncing(true);
      notifications.show({
        title: "已提交验证",
        message: "后台将立即重新检查好友状态",
        color: "green",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      notifications.show({
        title: "提交失败",
        message,
        color: "red",
      });
    } finally {
      setVerifyLoading(false);
    }
  };

  const exportProviderKey = (target: ExportTarget): ExportProviderKey =>
    target === "diving-fish" ? "divingFish" : "lxns";

  const exportProviderName = (target: ExportTarget) =>
    target === "diving-fish" ? "Diving-Fish" : "落雪查分器";

  const pollProberExportJob = async (
    exportJobId: string,
    target: ExportTarget,
  ): Promise<ProberExportJob> => {
    if (!token) {throw new Error("需要登录");}
    const terminal = new Set([
      "completed",
      "partial_failed",
      "failed",
      "skipped",
    ]);
    for (let i = 0; i < 240; i++) {
      const res = await fetchSyncPageJson<ProberExportJob>(
        `/api/v1/me/sync/prober-export-jobs/${encodeURIComponent(exportJobId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok || !res.data) {
        throw new Error(`查询导出任务失败 (HTTP ${res.status})`);
      }
      if (terminal.has(res.data.status)) {
        const result = res.data.result?.[exportProviderKey(target)];
        if (result?.status === "failed" || res.data.status === "failed") {
          throw new Error(result?.message || res.data.error || "导出失败");
        }
        return res.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("导出仍在处理中，请稍后查看结果");
  };

  const queueExport = async (target: ExportTarget) => {
    if (!token) {return;}
    setExportLoading(target);
    recordAnalyticsEvent("export_started", { provider: target });
    try {
      const saved = await saveTokens();
      if (!saved) {
        throw new Error("Token 保存失败");
      }

      const path =
        target === "diving-fish"
          ? "/api/v1/me/sync/latest/exports/diving-fish"
          : "/api/v1/me/sync/latest/exports/lxns";
      const res = await fetchSyncPageJson<ProberExportCreateResponse>(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok || !res.data?.exportJobId) {
        const data = res.data as { message?: string } | null;
        throw new Error(
          (data?.message || `HTTP ${res.status}`) + " 请检查 Token 是否正确！",
        );
      }

      notifications.show({
        title: "已加入导出队列",
        message: `正在导出到 ${exportProviderName(target)}`,
        color: "blue",
      });

      const job = await pollProberExportJob(res.data.exportJobId, target);
      const result = job.result?.[exportProviderKey(target)];
      const scores = result?.scores;
      const exported = result?.exported;

      notifications.show({
        title: result?.status === "skipped" ? "无需导出" : "导出成功",
        message:
          exported !== undefined
            ? `成绩已导出到 ${exportProviderName(target)}（共 ${scores ?? "?"} 条成绩，导出 ${exported} 条）`
            : result?.message || `成绩已导出到 ${exportProviderName(target)}`,
        color: result?.status === "skipped" ? "yellow" : "green",
      });
      recordAnalyticsEvent("export_completed", {
        provider: target,
        status: result?.status ?? job.status,
      });
    } catch (error) {
      recordAnalyticsEvent("export_failed", {
        provider: target,
        errorClass: error instanceof Error ? error.name : "Error",
      });
      notifications.show({
        title: "导出失败",
        message: error instanceof Error ? error.message : "未知错误",
        color: "red",
      });
    } finally {
      setExportLoading(null);
    }
  };

  const exportToDivingFish = () => queueExport("diving-fish");
  const exportToLxns = () => queueExport("lxns");

  // Compute sync progress
  const getSyncProgress = () => {
    if (!syncStatus?.scoreProgress) {return null;}
    const { completedDiffs, totalDiffs } = syncStatus.scoreProgress;
    const percent =
      totalDiffs > 0 ? (completedDiffs.length / totalDiffs) * 100 : 0;
    return { completedDiffs, totalDiffs, percent };
  };

  const progress = getSyncProgress();
  const syncStatusView = getSyncStatusView({
    lastSync,
    loading: pageLoading,
    syncStatus,
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
          <Card withBorder padding="md" h={160}>
            <Group justify="center" py="md" h={160}>
              <Loader size="sm" />
            </Group>
          </Card>
        )}

        {profile?.profile && <ProfileCard profile={profile.profile} />}

        {/* Sync Section */}
        <Stack gap="md">
          <SectionHeader
            icon={<IconCloudUpload size={18} />}
            color="blue"
            title="同步成绩"
          />

          <Card
            withBorder
            padding="lg"
          >
            <Stack gap="lg">
              <SimpleGrid cols={{ base: 1, xs: 3 }} spacing={{ base: "xs", xs: "lg" }}>
                <SyncMetric icon={<IconClock size={18} />} label="最近同步">
                  <Text size="sm" fw={600}>
                    {lastSync ? formatRelativeDate(lastSync.createdAt) : "暂无记录"}
                  </Text>
                </SyncMetric>
                <SyncMetric icon={<IconChartBar size={18} />} label="成绩记录">
                  <Text size="sm" fw={600}>
                    {lastSync ? lastSync.scoreCount.toLocaleString("zh-CN") : "-"}
                    {lastSync && (
                      <Text component="span" size="xs" fw={400} c="dimmed" ml={4}>
                        条
                      </Text>
                    )}
                  </Text>
                </SyncMetric>
                <SyncMetric icon={<IconSend size={18} />} label="自动导出">
                  <AutoExportBadges result={lastSync?.autoExportResult} />
                </SyncMetric>
              </SimpleGrid>

              <Divider />

              {progress && syncStatus?.stage === "update_score" && (
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
                    animated={syncing}
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
                    {pageLoading || syncing ? (
                      <Loader size="sm" color={syncStatusView.color} />
                    ) : (
                      <IconCheck size={22} />
                    )}
                  </Box>
                  <Stack gap={1}>
                    <Group gap="xs">
                      <Text fw={700} size="md">
                        {syncStatusView.label}
                      </Text>
                      {syncStatus && (
                        <Badge
                          variant="light"
                          color={syncStatusView.color}
                          radius="xl"
                          size="sm"
                        >
                          {getSyncStageText(syncStatus)}
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
                  disabled={!profile?.friendCode || syncing || pageLoading}
                  loading={syncing}
                  variant="filled"
                  leftSection={<IconRefresh size={16} />}
                  w={{ base: "100%", xs: "auto" }}
                  styles={{ root: { flexShrink: 0 } }}
                >
                  {lastSync ? "更新成绩" : "开始同步"}
                </Button>
              </Group>
            </Stack>
          </Card>

          {pageLoading && (
            <Card withBorder padding="md">
              <Stack gap="sm" align="center">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  加载中...
                </Text>
              </Stack>
            </Card>
          )}

          {syncError && <Alert color="red">{syncError}</Alert>}

          {syncStatus?.error && (
            <Alert color="red" variant="light" title="错误" radius="md">
              {syncStatus.error}
            </Alert>
          )}

          {syncing && syncStatus?.stage === "wait_acceptance" && (
            <Alert
              variant="outline"
              radius="md"
              color="blue"
              title="好友请求已发送！"
            >
              <Stack gap="sm">
                <Text size="sm">
                  Bot 已发送好友申请，请登录 NET
                  并在核对时间一致后同意好友申请。
                </Text>
                {syncStatus.friendRequestSentAt && (
                  <Text size="sm" c="red" fw={700}>
                    若申请时间不是{" "}
                    {formatFriendRequestSentAt(syncStatus.friendRequestSentAt)}
                    ，请勿接受，可能是他人尝试登录！
                  </Text>
                )}
                <Progress.Root size="xl" mt={4}>
                  <Progress.Section
                    animated
                    value={remainingPercent}
                    title={`${timeLeft} 秒后过期`}
                  >
                    <Progress.Label>{timeLeft} 秒后过期</Progress.Label>
                  </Progress.Section>
                </Progress.Root>
                <Button
                  onClick={verifySyncJob}
                  loading={verifyLoading}
                  disabled={!syncJobId}
                >
                  我已接受请求
                </Button>
              </Stack>
            </Alert>
          )}

        </Stack>

        {/* Cabinet QR Section */}
        {token && profile && (
          <Stack gap="md">
            <SectionHeader
              icon={<IconRefresh size={18} />}
              color="grape"
              title="神秘二维码绑定"
            />
            <CabinetBindingCard
              token={token}
              hasCabinetUserId={profile.hasCabinetUserId ?? false}
              autoUpdate={profile.autoUpdate ?? false}
              onChanged={() => {
                void loadProfile();
              }}
            />
          </Stack>
        )}
        {/* Token Settings & Export Section */}
        <Stack gap="md">
          <SectionHeader
            icon={<IconCloudUpload size={18} />}
            color="teal"
            title="更新查分器"
          />

          {/* Diving-Fish Section */}
          <Card withBorder padding="md">
            <Stack gap="md">
              <Anchor
                href="https://www.diving-fish.com/maimaidx/prober/"
                target="_blank"
                fw={500}
                size="sm"
              >
                水鱼查分器
              </Anchor>

              <Tabs
                keepMounted={false}
                value={divingFishMode}
                onChange={(v) =>
                  setDivingFishMode((v as "token" | "login") ?? "token")
                }
              >
                <Tabs.List>
                  <Tabs.Tab value="token">Token</Tabs.Tab>
                  <Tabs.Tab value="login">账号密码</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="token" pt="md">
                  <Stack gap="sm">
                    <PasswordInput
                      label="Import Token"
                      placeholder="输入 import token"
                      leftSection={<IconKey size={16} />}
                      value={
                        profile?.hasDivingFishImportToken &&
                        !editingDivingFishToken
                          ? "••••••••••••••••••••••••••••••••"
                          : divingFishToken
                      }
                      disabled={
                        !!profile?.hasDivingFishImportToken &&
                        !editingDivingFishToken
                      }
                      onChange={(e) => setDivingFishToken(e.target.value)}
                    />
                    <Group justify="flex-end" gap="xs">
                      {profile?.hasDivingFishImportToken &&
                      !editingDivingFishToken ? (
                        <Button
                          onClick={() => {
                            setEditingDivingFishToken(true);
                            setDivingFishToken("");
                          }}
                          variant="subtle"
                          size="sm"
                        >
                          修改
                        </Button>
                      ) : null}
                      <Button
                        onClick={exportToDivingFish}
                        loading={exportLoading === "diving-fish"}
                        disabled={
                          (!divingFishToken &&
                            !profile?.hasDivingFishImportToken) ||
                          (editingDivingFishToken && !divingFishToken) ||
                          exportLoading !== null
                        }
                        variant="light"
                        size="sm"
                      >
                        {exportLoading === "diving-fish" ? (
                          <Loader size="xs" />
                        ) : (
                          "更新"
                        )}
                      </Button>
                    </Group>
                  </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="login" pt="md">
                  <Stack gap="sm">
                    <Text size="xs" c="red">
                      账号密码仅用于获取成绩导入
                      token，不会保存在服务器或浏览器中
                    </Text>
                    <TextInput
                      label="用户名"
                      placeholder="水鱼账号用户名"
                      leftSection={<IconUser size={16} />}
                      value={divingFishUsername}
                      onChange={(e) => setDivingFishUsername(e.target.value)}
                    />
                    <PasswordInput
                      label="密码"
                      placeholder="水鱼账号密码"
                      leftSection={<IconPassword size={16} />}
                      value={divingFishPassword}
                      onChange={(e) => setDivingFishPassword(e.target.value)}
                    />
                    <Group justify="flex-end">
                      <Button
                        onClick={async () => {
                        if (!divingFishUsername || !divingFishPassword) {
                          notifications.show({
                            title: "错误",
                            message: "请填写用户名和密码",
                            color: "red",
                          });
                          return;
                        }

                        setFetchingDivingFishToken(true);
                        try {
                          // Step 1: Get token
                          const res = await fetchSyncPageJson<{
                            importToken?: string;
                            nickname?: string;
                            message?: string;
                          }>("/api/v1/me/prober-tokens/diving-fish", {
                            method: "POST",
                            headers: {
                              Authorization: `Bearer ${token}`,
                              "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                              username: divingFishUsername,
                              password: divingFishPassword,
                            }),
                          });

                          if (res.ok && res.data?.importToken) {
                            const fetchedToken = res.data.importToken;
                            setDivingFishToken(fetchedToken);
                            // Clear credentials after successful fetch
                            setDivingFishUsername("");
                            setDivingFishPassword("");

                            // Step 2: Save token and export
                            const saveRes = await fetchSyncPageJson<unknown>(
                              "/api/v1/me",
                              {
                                method: "PATCH",
                                headers: {
                                  Authorization: `Bearer ${token}`,
                                  "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                  divingFishImportToken: fetchedToken,
                                  lxnsImportToken: lxnsToken || null,
                                }),
                              },
                            );

                            if (saveRes.ok) {
                              // Step 3: Queue export to diving-fish
                              const exportRes =
                                await fetchSyncPageJson<ProberExportCreateResponse>(
                                  "/api/v1/me/sync/latest/exports/diving-fish",
                                  {
                                    method: "POST",
                                    headers: {
                                      Authorization: `Bearer ${token}`,
                                      "Content-Type": "application/json",
                                    },
                                  },
                                );

                              if (exportRes.ok && exportRes.data?.exportJobId) {
                                notifications.show({
                                  title: "已加入导出队列",
                                  message: "正在导出到 Diving-Fish",
                                  color: "blue",
                                });
                                const job = await pollProberExportJob(
                                  exportRes.data.exportJobId,
                                  "diving-fish",
                                );
                                const result = job.result?.divingFish;
                                notifications.show({
                                  title:
                                    result?.status === "skipped"
                                      ? "无需导出"
                                      : "更新成功",
                                  message:
                                    result?.message ||
                                    `成绩已导出到 Diving-Fish（导出 ${
                                      result?.exported ?? "?"
                                    } 条）`,
                                  color:
                                    result?.status === "skipped"
                                      ? "yellow"
                                      : "green",
                                });
                                setDivingFishMode("token");
                              } else {
                                const data = exportRes.data as {
                                  message?: string;
                                } | null;
                                notifications.show({
                                  title: "导出失败",
                                  message:
                                    (data?.message ||
                                      `HTTP ${exportRes.status}`) +
                                    " 请检查 Token 是否正确！",
                                  color: "red",
                                });
                              }
                            } else {
                              notifications.show({
                                title: "获取成功，但保存失败",
                                message: res.data.nickname
                                  ? `已获取 ${res.data.nickname} 的 Import Token，但保存失败`
                                  : "已成功获取 Import Token，但保存失败",
                                color: "yellow",
                              });
                            }
                          } else {
                            const errorMsg =
                              res.data?.message || `HTTP ${res.status}`;
                            notifications.show({
                              title: "获取失败",
                              message: errorMsg,
                              color: "red",
                            });
                          }
                        } catch (error) {
                          notifications.show({
                            title: "操作失败",
                            message:
                              error instanceof Error
                                ? error.message
                                : "网络错误，请稍后重试",
                            color: "red",
                          });
                        } finally {
                          setFetchingDivingFishToken(false);
                        }
                        }}
                        loading={fetchingDivingFishToken}
                        disabled={
                          !divingFishUsername ||
                          !divingFishPassword ||
                          fetchingDivingFishToken
                        }
                        variant="filled"
                        size="sm"
                      >
                        获取 Token 并更新
                      </Button>
                    </Group>
                  </Stack>
                </Tabs.Panel>
              </Tabs>
            </Stack>
          </Card>

          {/* LXNS Section */}
          <Card withBorder padding="md">
            <Stack gap="md">
              <Anchor
                href="https://maimai.lxns.net/"
                target="_blank"
                fw={500}
                size="sm"
              >
                落雪查分器
              </Anchor>
              <Stack gap="sm">
                <PasswordInput
                  label="Personal Token"
                  placeholder="输入 personal token"
                  leftSection={<IconKey size={16} />}
                  value={
                    profile?.hasLxnsImportToken && !editingLxnsToken
                      ? "••••••••••••••••••••••••••••••••"
                      : lxnsToken
                  }
                  disabled={!!profile?.hasLxnsImportToken && !editingLxnsToken}
                  onChange={(e) => setLxnsToken(e.target.value)}
                />
                <Group justify="flex-end" gap="xs">
                  {profile?.hasLxnsImportToken && !editingLxnsToken ? (
                    <Button
                      onClick={() => {
                        setEditingLxnsToken(true);
                        setLxnsToken("");
                      }}
                      variant="subtle"
                      size="sm"
                    >
                      修改
                    </Button>
                  ) : null}
                  <Button
                    onClick={exportToLxns}
                    loading={exportLoading === "lxns"}
                    disabled={
                      (!lxnsToken && !profile?.hasLxnsImportToken) ||
                      (editingLxnsToken && !lxnsToken) ||
                      exportLoading !== null
                    }
                    variant="light"
                    size="sm"
                  >
                    {exportLoading === "lxns" ? <Loader size="xs" /> : "更新"}
                  </Button>
                </Group>
              </Stack>
            </Stack>
          </Card>
        </Stack>
      </Stack>
    </Box>
  );
}
