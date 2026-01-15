import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Progress,
  Stack,
  Text,
} from "@mantine/core";
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

  // Sync job state
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<JobStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Export state
  const [exportLoading, setExportLoading] = useState<
    "diving-fish" | "lxns" | null
  >(null);

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
      setProfileError(null);

      const res = await fetchJson<UserProfileResponse>("/api/users/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (cancelled) return;

      if (res.ok && res.data) {
        setProfile(res.data);
        setDivingFishToken(res.data.divingFishImportToken ?? "");
        setLxnsToken(res.data.lxnsImportToken ?? "");
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

  // Start sync
  const startSync = async () => {
    if (!profile?.friendCode) return;

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
      }
    );

    if (res.ok && res.data?.jobId) {
      setSyncJobId(res.data.jobId);
      setSyncStatus(res.data.job);
    } else {
      setSyncing(false);
      const errorData = res.data as { message?: string; error?: string } | null;
      const errorMessage =
        errorData?.message || errorData?.error || `HTTP ${res.status}`;
      setSyncError(`创建同步任务失败: ${errorMessage}`);
    }
  };

  // Export to diving-fish
  const exportToDivingFish = async () => {
    if (!token) return;

    setExportLoading("diving-fish");

    // Save token first
    await saveTokens();

    const res = await fetchJson<{ success?: boolean; message?: string }>(
      "/api/sync/latest/diving-fish",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    setExportLoading(null);

    if (res.ok) {
      notifications.show({
        title: "导出成功",
        message: "成绩已导出到 Diving-Fish",
        color: "green",
      });
    } else {
      const data = res.data as { message?: string } | null;
      notifications.show({
        title: "导出失败",
        message: data?.message || `HTTP ${res.status}`,
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

    const res = await fetchJson<{ success?: boolean; message?: string }>(
      "/api/sync/latest/lxns",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    setExportLoading(null);

    if (res.ok) {
      notifications.show({
        title: "导出成功",
        message: "成绩已导出到 落雪查分器",
        color: "green",
      });
    } else {
      const data = res.data as { message?: string } | null;
      notifications.show({
        title: "导出失败",
        message: data?.message || `HTTP ${res.status}`,
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
                  <Badge variant="light" size="lg">
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

        {!lastSync && !syncStatus && (
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
                      Bot 已发送好友申请，请登录 NET 并同意好友申请。
                    </Text>
                  </Stack>
                </Alert>
              )}
            </Stack>
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
          配置 Token 后可将同步的成绩更新到其他查分器。
        </Text>

        <Group align="flex-end" gap="xs">
          <PasswordInput
            label="Diving-Fish Token"
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
            {exportLoading === "diving-fish" ? <Loader size="xs" /> : "更新"}
          </Button>
        </Group>

        <Group align="flex-end" gap="xs">
          <PasswordInput
            label={<>落雪 Token</>}
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
    </Stack>
  );
}
