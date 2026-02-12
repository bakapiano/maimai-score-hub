import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Progress,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { IconClock, IconInfoCircle } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useState } from "react";

import { ProfileCard, type UserProfile } from "../components/ProfileCard";
import { useAuth } from "../providers/AuthProvider";

type UserProfileResponse = {
  friendCode: string;
  divingFishImportToken: string | null;
  lxnsImportToken: string | null;
  profile: UserProfile | null;
};

type LastSyncInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
  scores: unknown[];
};

type IdleUpdateStatusResponse = {
  enabled: boolean;
  botFriendCode: string | null;
  pendingJob: boolean;
  activeJob?: {
    id: string;
    jobType: "idle_add_friend" | "idle_update_score";
    status: string;
    stage: string;
    scoreProgress?: { completedDiffs: number[]; totalDiffs: number } | null;
    friendRequestSentAt?: string | null;
    pickedAt?: string | null;
  } | null;
};

type JobStatus = {
  id: string;
  friendCode: string;
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  stage: "send_request" | "wait_acceptance" | "update_score";
  error?: string | null;
  scoreProgress?: {
    completedDiffs: number[];
    totalDiffs: number;
  } | null;
  updatedAt: string;
  friendRequestSentAt?: string;
  pickedAt?: string;
};

const DIFFICULTY_NAMES: Record<number, string> = {
  0: "BASIC",
  1: "ADVANCED",
  2: "EXPERT",
  3: "MASTER",
  4: "Re:MASTER",
  10: "宴会场",
};

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}

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

export default function SyncPage() {
  const { token } = useAuth();

  // Profile state
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Last sync info
  const [lastSync, setLastSync] = useState<LastSyncInfo | null>(null);

  // Token settings
  const [divingFishToken, setDivingFishToken] = useState("");
  const [lxnsToken, setLxnsToken] = useState("");

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
  const [timeLeft, setTimeLeft] = useState(0);

  // Idle update state
  const [idleUpdateStatus, setIdleUpdateStatus] =
    useState<IdleUpdateStatusResponse | null>(null);
  const [idleUpdateLoading, setIdleUpdateLoading] = useState(false);
  const [lowSuccessRate, setLowSuccessRate] = useState(false);

  const totalWaitSeconds = 5 * 60;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / totalWaitSeconds) * 100),
  );

  // Export state
  const [exportLoading, setExportLoading] = useState<
    "diving-fish" | "lxns" | null
  >(null);

  // Loading state
  const [loading, setLoading] = useState(true);

  // Fetch last sync info
  const loadLastSync = useCallback(async () => {
    if (!token) return;

    const res = await fetchJson<LastSyncInfo>("/api/sync/latest", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok && res.data) {
      setLastSync(res.data);
    } else {
      // No sync found is normal, just don't set lastSync
      setLastSync(null);
    }
  }, [token]);

  // Fetch profile
  const loadProfile = useCallback(async () => {
    if (!token) return;

    setProfileError(null);

    const res = await fetchJson<UserProfileResponse>("/api/users/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok && res.data) {
      setProfile(res.data);
      setDivingFishToken(res.data.divingFishImportToken ?? "");
      setLxnsToken(res.data.lxnsImportToken ?? "");
    } else {
      setProfileError(`加载失败 (HTTP ${res.status})`);
    }
  }, [token]);

  // Load profile and last sync on mount
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const doLoad = async () => {
      setLoading(true);
      setProfileError(null);

      const res = await fetchJson<UserProfileResponse>("/api/users/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (cancelled) return;

      if (res.ok && res.data) {
        setProfile(res.data);
        setDivingFishToken(res.data.divingFishImportToken ?? "");
        setLxnsToken(res.data.lxnsImportToken ?? "");

        // Check for active job after getting friendCode
        if (res.data.friendCode) {
          const activeJobRes = await fetchJson<{ job: JobStatus | null }>(
            `/api/job/by-friend-code/${res.data.friendCode}/active`,
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          );

          if (cancelled) return;

          if (activeJobRes.ok && activeJobRes.data?.job) {
            // Found an active job, restore the state
            const activeJob = activeJobRes.data.job;
            setSyncJobId(activeJob.id);
            setSyncStatus(activeJob);
            // Only set syncing to true if it's still in progress
            if (
              activeJob.status === "queued" ||
              activeJob.status === "processing"
            ) {
              setSyncing(true);
            }
          }
        }
      } else {
        setProfileError(`加载失败 (HTTP ${res.status})`);
      }

      // Also load last sync info
      const syncRes = await fetchJson<LastSyncInfo>("/api/sync/latest", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (cancelled) return;

      if (syncRes.ok && syncRes.data) {
        setLastSync(syncRes.data);
      }

      // Load idle update status
      const idleRes = await fetchJson<IdleUpdateStatusResponse>(
        "/api/users/idle-update/status",
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (cancelled) return;

      if (idleRes.ok && idleRes.data) {
        setIdleUpdateStatus(idleRes.data);
      }

      // Check success rate for recommendation
      try {
        const statsRes = await fetchJson<{
          totalCount: number;
          successRate: number;
        }>("/api/job/stats/recent");
        if (
          statsRes.ok &&
          statsRes.data &&
          statsRes.data.totalCount >= 5 &&
          statsRes.data.successRate <= 50
        ) {
          setLowSuccessRate(true);
        }
      } catch {}

      setLoading(false);
    };

    doLoad();

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Save tokens (silent, returns success)
  const saveTokens = async (): Promise<boolean> => {
    if (!token) return false;

    const res = await fetchJson<unknown>("/api/users/profile", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        divingFishImportToken: divingFishToken || null,
        lxnsImportToken: lxnsToken || null,
      }),
    });

    if (res.ok) {
      loadProfile();
      return true;
    }
    return false;
  };

  // Poll job status
  useEffect(() => {
    if (!syncJobId || !syncing) return;

    const interval = setInterval(async () => {
      const res = await fetchJson<JobStatus>(`/api/job/${syncJobId}`);

      if (!res.ok) {
        setSyncError(`轮询失败 (HTTP ${res.status})`);
        return;
      }

      if (res.data) {
        setSyncStatus(res.data);

        if (
          res.data.status === "completed" ||
          res.data.status === "failed" ||
          res.data.status === "canceled"
        ) {
          setSyncing(false);
          if (res.data.status === "completed") {
            // Refresh profile and last sync info
            loadProfile();
            loadLastSync();
          }
        }
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [syncJobId, syncing, loadProfile, loadLastSync]);

  // Poll idle update status when pendingJob is true
  useEffect(() => {
    if (!token || !idleUpdateStatus?.pendingJob) return;

    const interval = setInterval(async () => {
      const res = await fetchJson<IdleUpdateStatusResponse>(
        "/api/users/idle-update/status",
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (res.ok && res.data) {
        setIdleUpdateStatus(res.data);
        // Stop polling once pendingJob is resolved
        if (!res.data.pendingJob) {
          clearInterval(interval);
          if (res.data.enabled) {
            notifications.show({
              title: "闲时更新",
              message: "Bot 已成功添加好友，闲时更新已开启",
              color: "green",
            });
          }
        }
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [token, idleUpdateStatus?.pendingJob]);

  // Handle timeout countdown for wait_acceptance stage
  useEffect(() => {
    if (
      !syncStatus ||
      syncStatus.stage !== "wait_acceptance" ||
      !syncStatus.pickedAt
    ) {
      if (timeLeft !== 0) setTimeLeft(0);
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const picked = new Date(syncStatus.pickedAt!).getTime();
      const end = picked + totalWaitSeconds * 1000;
      const left = Math.max(0, Math.ceil((end - now) / 1000));
      setTimeLeft(left);
    }, 500);

    return () => clearInterval(interval);
  }, [syncStatus?.stage, syncStatus?.pickedAt]);

  // Start sync
  const startSync = async () => {
    if (!profile?.friendCode) return;

    // 如果已开启闲时更新，提示用户立即更新会取消闲时更新
    if (idleUpdateStatus?.enabled) {
      const confirmed = window.confirm(
        "你已开启闲时更新，立即更新将会取消闲时更新。是否继续？",
      );
      if (!confirmed) return;
    }

    setSyncing(true);
    setSyncError(null);
    setSyncStatus(null);

    const res = await fetchJson<{ jobId: string; job: JobStatus }>(
      "/api/job/create",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          friendCode: profile.friendCode,
          skipUpdateScore: false, // We want to sync scores
        }),
      },
    );

    if (res.ok && res.data?.jobId) {
      setSyncJobId(res.data.jobId);
      setSyncStatus(res.data.job);

      // 立即更新成功创建后，如果之前开启了闲时更新，更新前端状态
      if (idleUpdateStatus?.enabled) {
        setIdleUpdateStatus({
          enabled: false,
          botFriendCode: null,
          pendingJob: false,
        });
        notifications.show({
          title: "闲时更新已取消",
          message: "已自动关闭闲时更新，如需使用请在同步完成后重新开启",
          color: "yellow",
        });
      }
    } else {
      setSyncing(false);
      const errorData = res.data as { message?: string; error?: string } | null;
      const errorMessage =
        errorData?.message || errorData?.error || `HTTP ${res.status}`;
      setSyncError(`创建同步任务失败: ${errorMessage}`);
    }
  };

  // Enable idle update
  const enableIdleUpdate = async () => {
    if (!token) return;

    setIdleUpdateLoading(true);
    const res = await fetchJson<{ message?: string }>(
      "/api/users/idle-update/enable",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (res.ok) {
      notifications.show({
        title: "闲时更新",
        message: "闲时更新任务已创建，等待 Bot 添加好友",
        color: "blue",
      });
      // Refresh idle update status
      const idleRes = await fetchJson<IdleUpdateStatusResponse>(
        "/api/users/idle-update/status",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (idleRes.ok && idleRes.data) {
        setIdleUpdateStatus(idleRes.data);
      }
    } else {
      const errorData = res.data as { message?: string; error?: string } | null;
      notifications.show({
        title: "开启失败",
        message: errorData?.message || errorData?.error || `HTTP ${res.status}`,
        color: "red",
      });
    }
    setIdleUpdateLoading(false);
  };

  // Disable idle update
  const disableIdleUpdate = async () => {
    if (!token) return;

    setIdleUpdateLoading(true);
    const res = await fetchJson<{ message?: string }>(
      "/api/users/idle-update/disable",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (res.ok) {
      notifications.show({
        title: "闲时更新",
        message: "闲时更新已关闭",
        color: "green",
      });
      setIdleUpdateStatus({
        enabled: false,
        botFriendCode: null,
        pendingJob: false,
      });
    } else {
      const errorData = res.data as { message?: string; error?: string } | null;
      notifications.show({
        title: "关闭失败",
        message: errorData?.message || errorData?.error || `HTTP ${res.status}`,
        color: "red",
      });
    }
    setIdleUpdateLoading(false);
  };

  // Export to diving-fish
  const exportToDivingFish = async () => {
    if (!token) return;

    setExportLoading("diving-fish");

    // Save token first
    await saveTokens();

    const res = await fetchJson<{
      success?: boolean;
      message?: string;
      exported?: number;
      response?: { creates?: number; updates?: number; message?: string };
    }>("/api/sync/latest/diving-fish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    setExportLoading(null);

    if (res.ok) {
      const creates = res.data?.response?.creates ?? 0;
      const updates = res.data?.response?.updates ?? 0;
      notifications.show({
        title: "导出成功",
        message: `成绩已导出到 Diving-Fish（新增 ${creates} 条，更新 ${updates} 条）`,
        color: "green",
      });
    } else {
      const data = res.data as { message?: string } | null;
      notifications.show({
        title: "导出失败",
        message:
          (data?.message || `HTTP ${res.status}`) + " 请检查 Token 是否正确！",
        color: "red",
      });
    }
  };

  // Export to LXNS
  const exportToLxns = async () => {
    if (!token) return;

    setExportLoading("lxns");

    // Save token first
    await saveTokens();

    const res = await fetchJson<{
      success?: boolean;
      message?: string;
      exported?: number;
      response?: { success?: boolean; code?: number; data?: unknown[] };
    }>("/api/sync/latest/lxns", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    setExportLoading(null);

    if (res.ok) {
      const dataCount = Array.isArray(res.data?.response?.data)
        ? res.data?.response?.data.length
        : undefined;
      const exported = res.data?.exported;
      const count = dataCount ?? exported;
      notifications.show({
        title: "导出成功",
        message:
          count !== undefined
            ? `成绩已导出到 落雪查分器（${count} 条）`
            : "成绩已导出到 落雪查分器",
        color: "green",
      });
    } else {
      const data = res.data as { message?: string } | null;
      notifications.show({
        title: "导出失败",
        message:
          (data?.message || `HTTP ${res.status}`) + " 请检查 Token 是否正确！",
        color: "red",
      });
    }
  };

  // Compute sync progress
  const getSyncProgress = () => {
    if (!syncStatus?.scoreProgress) return null;
    const { completedDiffs, totalDiffs } = syncStatus.scoreProgress;
    const percent =
      totalDiffs > 0 ? (completedDiffs.length / totalDiffs) * 100 : 0;
    return { completedDiffs, totalDiffs, percent };
  };

  const progress = getSyncProgress();

  return (
    <Stack gap="xl" mx="auto" w="100%">
      {/* Profile Section */}

      {profileError && <Alert color="red">{profileError}</Alert>}

      {loading && !profile?.profile && (
        <Card withBorder padding="md" radius="md" h={160}>
          <Group justify="center" py="md" h={160}>
            <Loader size="sm" />
          </Group>
        </Card>
      )}

      {profile?.profile && <ProfileCard profile={profile.profile} />}

      {/* Sync Section */}
      <Stack gap="md">
        <Text fw={600} size="lg">
          同步成绩
        </Text>

        <Text size="sm" c="dimmed">
          从 maimai DX NET 同步你的最新游戏成绩数据。
        </Text>

        {lastSync && (
          <Card withBorder padding="sm" radius="md">
            <Group justify="space-between" align="center">
              <Group gap="xl">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    上次同步
                  </Text>
                  <Text size="sm" fw={500}>
                    {formatDate(lastSync.createdAt)}
                  </Text>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    记录条数
                  </Text>
                  <Badge variant="light" size="lg" radius="md">
                    {lastSync.scores.length} 条
                  </Badge>
                </Stack>
              </Group>
              <Button
                onClick={startSync}
                loading={syncing}
                disabled={!profile?.friendCode || syncing}
                variant="light"
                size="sm"
              >
                {syncing ? "同步中..." : "更新数据"}
              </Button>
            </Group>
          </Card>
        )}

        {loading && (
          <Card withBorder padding="md" radius="md">
            <Stack gap="sm" align="center">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                加载中...
              </Text>
            </Stack>
          </Card>
        )}

        {!loading && !lastSync && !syncStatus && (
          <Card withBorder padding="md" radius="md">
            <Stack gap="sm" align="center">
              <Text size="sm" c="dimmed" ta="center">
                暂无同步记录，点击下方按钮开始首次同步。
              </Text>
              <Button
                onClick={startSync}
                loading={syncing}
                disabled={!profile?.friendCode || syncing}
                variant="filled"
              >
                {syncing ? "同步中..." : "开始同步"}
              </Button>
            </Stack>
          </Card>
        )}

        {syncError && <Alert color="red">{syncError}</Alert>}

        {syncStatus && (
          <Card
            withBorder
            padding="md"
            radius="md"
            style={{
              borderLeft:
                syncStatus.status === "completed"
                  ? "4px solid var(--mantine-color-green-6)"
                  : syncStatus.status === "failed" ||
                      syncStatus.status === "canceled"
                    ? "4px solid var(--mantine-color-red-6)"
                    : syncStatus.status === "processing"
                      ? "4px solid var(--mantine-color-blue-6)"
                      : "4px solid var(--mantine-color-gray-4)",
            }}
          >
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <Group gap="xs">
                  <Text size="sm" fw={500} c="dimmed">
                    状态
                  </Text>
                </Group>
                <Badge
                  size="lg"
                  radius="sm"
                  variant="light"
                  color={
                    syncStatus.status === "completed"
                      ? "green"
                      : syncStatus.status === "failed" ||
                          syncStatus.status === "canceled"
                        ? "red"
                        : syncStatus.status === "queued"
                          ? "gray"
                          : "blue"
                  }
                >
                  {syncStatus.status === "completed"
                    ? "✓ 已完成"
                    : syncStatus.status === "failed"
                      ? "✗ 失败"
                      : syncStatus.status === "canceled"
                        ? "已取消"
                        : syncStatus.status === "queued"
                          ? "排队中"
                          : "● 进行中"}
                </Badge>
              </Group>

              {/* <Group justify="space-between" align="center">
                <Text size="sm" fw={500} c="dimmed">
                  当前阶段
                </Text>
                <Text size="sm" fw={500}>
                  {getStageLabel(syncStatus.stage)}
                </Text>
              </Group> */}

              {syncStatus.error && (
                <Alert color="red" variant="light" title="错误" radius="md">
                  {syncStatus.error}
                </Alert>
              )}

              {progress && syncStatus.stage === "update_score" && (
                <Stack gap="xs">
                  <Divider />
                  <Group justify="space-between" align="center">
                    <Text size="sm" fw={500} c="dimmed">
                      更新进度
                    </Text>
                    <Text size="sm" fw={600}>
                      {progress.completedDiffs.length} / {progress.totalDiffs}
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
                    <Group gap="xs" mt={4}>
                      {progress.completedDiffs.map((diff) => (
                        <Badge
                          radius={"md"}
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

              {syncing && syncStatus.stage === "wait_acceptance" && (
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
                        若申请时间不是 {syncStatus.friendRequestSentAt}
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
                  </Stack>
                </Alert>
              )}
            </Stack>
          </Card>
        )}
      </Stack>

      {/* Idle Update Section */}
      <Stack gap="md">
        <Group gap="xs">
          <Text fw={600} size="lg">
            闲时更新 (测试中)
          </Text>
        </Group>

        <Text size="sm" c="dimmed">
          先和 Bot 添加好友，在当日凌晨空闲时段自动更新成绩，成功率更高。
        </Text>

        {lowSuccessRate && !idleUpdateStatus?.enabled && (
          <Alert
            variant="light"
            color="yellow"
            title="推荐使用闲时更新"
            icon={<IconInfoCircle size={16} />}
            radius="md"
          >
            <Text size="sm">
              当前立即更新成功率较低，建议使用闲时更新以获得更好的体验。
            </Text>
          </Alert>
        )}

        {idleUpdateStatus?.enabled && (
          <Card
            withBorder
            padding="md"
            radius="md"
            style={{
              borderLeft: "4px solid var(--mantine-color-green-6)",
            }}
          >
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <Group gap="xs">
                  <Badge color="green" variant="light" size="lg">
                    已开启
                  </Badge>
                  <Text size="sm" c="dimmed">
                    Bot 将在今日凌晨自动更新成绩，请勿解除好友关系
                  </Text>
                </Group>
                <Button
                  variant="light"
                  color="red"
                  size="xs"
                  onClick={disableIdleUpdate}
                  loading={idleUpdateLoading}
                >
                  关闭
                </Button>
              </Group>
            </Stack>
          </Card>
        )}

        {idleUpdateStatus?.pendingJob && !idleUpdateStatus?.enabled && (
          <Card
            withBorder
            padding="md"
            radius="md"
            style={{
              borderLeft: "4px solid var(--mantine-color-blue-6)",
            }}
          >
            <Stack gap="sm">
              <Group gap="xs">
                <Loader size="xs" />
                <Text size="sm" fw={500}>
                  {idleUpdateStatus.activeJob?.jobType === "idle_add_friend"
                    ? idleUpdateStatus.activeJob?.stage === "wait_acceptance"
                      ? "Bot 已发送好友申请，请登录 NET 接受好友请求"
                      : idleUpdateStatus.activeJob?.stage === "send_request"
                        ? "Bot 正在发送好友申请，请稍候..."
                        : "闲时更新任务进行中..."
                    : idleUpdateStatus.activeJob?.jobType ===
                        "idle_update_score"
                      ? idleUpdateStatus.activeJob?.stage === "update_score"
                        ? "Bot 正在更新成绩..."
                        : "闲时更新任务进行中..."
                      : "闲时更新任务进行中..."}
                </Text>
              </Group>
              {idleUpdateStatus.activeJob?.jobType === "idle_add_friend" &&
                idleUpdateStatus.activeJob?.stage === "wait_acceptance" &&
                idleUpdateStatus.activeJob?.friendRequestSentAt && (
                  <Text size="sm" c="red" fw={700}>
                    若申请时间不是{" "}
                    {idleUpdateStatus.activeJob.friendRequestSentAt}
                    ，请勿接受，可能是他人尝试登录！
                  </Text>
                )}
              {idleUpdateStatus.activeJob?.jobType === "idle_update_score" &&
                idleUpdateStatus.activeJob?.stage === "update_score" &&
                idleUpdateStatus.activeJob?.scoreProgress && (
                  <Stack gap="xs">
                    <Group justify="space-between" align="center">
                      <Text size="sm" c="dimmed">
                        更新进度
                      </Text>
                      <Text size="sm" fw={600}>
                        {
                          idleUpdateStatus.activeJob.scoreProgress
                            .completedDiffs.length
                        }{" "}
                        / {idleUpdateStatus.activeJob.scoreProgress.totalDiffs}
                      </Text>
                    </Group>
                    <Progress
                      value={
                        idleUpdateStatus.activeJob.scoreProgress.totalDiffs > 0
                          ? (idleUpdateStatus.activeJob.scoreProgress
                              .completedDiffs.length /
                              idleUpdateStatus.activeJob.scoreProgress
                                .totalDiffs) *
                            100
                          : 0
                      }
                      animated
                      size="md"
                      radius="xl"
                    />
                    {idleUpdateStatus.activeJob.scoreProgress.completedDiffs
                      .length > 0 && (
                      <Group gap="xs" mt={4}>
                        {idleUpdateStatus.activeJob.scoreProgress.completedDiffs.map(
                          (diff) => (
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
                          ),
                        )}
                      </Group>
                    )}
                  </Stack>
                )}
            </Stack>
          </Card>
        )}

        {!idleUpdateStatus?.enabled && !idleUpdateStatus?.pendingJob && (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                开启后 Bot 将在每日凌晨自动更新你的成绩
              </Text>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconClock size={14} />}
                onClick={enableIdleUpdate}
                loading={idleUpdateLoading}
                disabled={!profile?.friendCode || idleUpdateLoading}
              >
                开启
              </Button>
            </Group>
          </Card>
        )}
      </Stack>

      <Divider />

      {/* Token Settings & Export Section */}
      <Stack gap="md">
        <Text fw={600} size="lg">
          更新查分器
        </Text>

        <Text size="sm" c="dimmed">
          将同步的成绩导出到查分器，方便你在更多平台查看和分析成绩。
        </Text>

        {/* Diving-Fish Section */}
        <Card withBorder padding="md" radius="md">
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
                <Group align="flex-end" gap="xs">
                  <PasswordInput
                    label="Import Token"
                    placeholder="输入 import token"
                    value={divingFishToken}
                    onChange={(e) => setDivingFishToken(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    onClick={exportToDivingFish}
                    loading={exportLoading === "diving-fish"}
                    disabled={!divingFishToken || exportLoading !== null}
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
              </Tabs.Panel>

              <Tabs.Panel value="login" pt="md">
                <Stack gap="sm">
                  <Text size="xs" c="red">
                    账号密码仅用于获取成绩导入 token，不会保存在服务器或浏览器中
                  </Text>
                  <TextInput
                    label="用户名"
                    placeholder="水鱼账号用户名"
                    value={divingFishUsername}
                    onChange={(e) => setDivingFishUsername(e.target.value)}
                  />
                  <PasswordInput
                    label="密码"
                    placeholder="水鱼账号密码"
                    value={divingFishPassword}
                    onChange={(e) => setDivingFishPassword(e.target.value)}
                  />
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
                        const res = await fetchJson<{
                          importToken?: string;
                          nickname?: string;
                          message?: string;
                        }>("/api/users/diving-fish/token", {
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
                          const saveRes = await fetchJson<unknown>(
                            "/api/users/profile",
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
                            // Step 3: Export to diving-fish
                            const exportRes = await fetchJson<{
                              success?: boolean;
                              message?: string;
                              exported?: number;
                              response?: {
                                creates?: number;
                                updates?: number;
                                message?: string;
                              };
                            }>("/api/sync/latest/diving-fish", {
                              method: "POST",
                              headers: {
                                Authorization: `Bearer ${token}`,
                                "Content-Type": "application/json",
                              },
                            });

                            if (exportRes.ok) {
                              const creates =
                                exportRes.data?.response?.creates ?? 0;
                              const updates =
                                exportRes.data?.response?.updates ?? 0;
                              notifications.show({
                                title: "更新成功",
                                message: `成绩已导出到 Diving-Fish（新增 ${creates} 条，更新 ${updates} 条）`,
                                color: "green",
                              });
                              // Switch to token mode
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
                      } catch {
                        notifications.show({
                          title: "操作失败",
                          message: "网络错误，请稍后重试",
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
                </Stack>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </Card>

        {/* LXNS Section */}
        <Card withBorder padding="md" radius="md">
          <Stack gap="md">
            <Anchor
              href="https://maimai.lxns.net/"
              target="_blank"
              fw={500}
              size="sm"
            >
              落雪查分器
            </Anchor>
            <Group align="flex-end" gap="xs">
              <PasswordInput
                label="Personal Token"
                placeholder="输入 personal token"
                value={lxnsToken}
                onChange={(e) => setLxnsToken(e.target.value)}
                style={{ flex: 1 }}
              />
              <Button
                onClick={exportToLxns}
                loading={exportLoading === "lxns"}
                disabled={!lxnsToken || exportLoading !== null}
                variant="light"
                size="sm"
              >
                {exportLoading === "lxns" ? <Loader size="xs" /> : "更新"}
              </Button>
            </Group>
          </Stack>
        </Card>
      </Stack>
    </Stack>
  );
}
