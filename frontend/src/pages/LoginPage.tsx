import {
  Alert,
  Anchor,
  AppShell,
  Badge,
  Box,
  Button,
  Collapse,
  Container,
  Group,
  Image,
  Loader,
  Paper,
  Progress,
  Checkbox,
  Stack,
  Text,
  TextInput,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconInfoCircle,
  IconCopy,
  IconClock,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useMemo, useState } from "react";

import { ProfileCard, type UserProfile } from "../components/ProfileCard";
import { formatFriendRequestSentAt } from "../utils/formatDate";
import { AppHeader } from "../components/AppHeader";
import { PageHeader } from "../components/PageHeader";
import { authApi, getHealthStatus } from "../api/appClient";
import { notifications } from "@mantine/notifications";
import { getRecentJobStats } from "../api/jobClient";
import { useAuth } from "../providers/AuthProvider";
import { useNavigate, useSearchParams } from "react-router-dom";
import { hasOfflineData } from "../utils/offlineCache";
import { AppFooter } from "../components/AppFooter";

type LoginStatus = {
  status?: string;
  token?: string;
  profile?: UserProfile;
  job?: { profile?: UserProfile; [key: string]: unknown };
  error?: string | null;
  [key: string]: unknown;
};

function FriendCodeGuide() {
  const [opened, { toggle }] = useDisclosure(false);

  return (
    <Stack gap={4}>
      <Anchor
        component="button"
        type="button"
        size="md"
        fw={500}
        onClick={toggle}
        style={{
          alignSelf: "flex-start",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {opened ? <IconChevronUp size={20} /> : <IconChevronDown size={20} />}
        好友代码是什么？
      </Anchor>
      <Collapse in={opened}>
        <Stack gap="xs">
          <Text size="sm">
            登录{" "}
            <Anchor
              href="https://tgk-wcaime.wahlap.com/wc_auth/oauth/authorize/maimai-dx"
              target="_blank"
              rel="noopener"
            >
              maimai NET
            </Anchor>
            ，进入「好友」页面，点击右下角「你的好友号码」即可查看。
          </Text>
          <Image
            src="/friendcode.png"
            alt="好友代码查找教程"
            radius="md"
            w="100%"
          />
        </Stack>
      </Collapse>
    </Stack>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token, setToken, offline, setOffline } = useAuth();

  const [friendCode, setFriendCode] = useState(() => {
    try {
      // 优先从 URL 参数读取
      const urlFriendCode = searchParams.get("friendCode");
      if (urlFriendCode && /^\d{1,15}$/.test(urlFriendCode)) {
        return urlFriendCode;
      }
      return localStorage.getItem("lastFriendCode") || "";
    } catch {
      return "";
    }
  });
  const [skipUpdateScore, setSkipUpdateScore] = useState(true);
  const [useIdleUpdate, setUseIdleUpdate] = useState(false);
  const [lowSuccessRate, setLowSuccessRate] = useState(false);
  const [recentStats, setRecentStats] = useState<{
    totalCount: number;
    successRate: number;
    avgDuration: number | null;
  } | null>(null);
  const [_health, setHealth] = useState("");
  const [jobId, setJobId] = useState(() => {
    try {
      return localStorage.getItem("pendingLoginJobId") || "";
    } catch {
      return "";
    }
  });
  const [_jobStatus, setJobStatus] = useState("");
  const [polling, setPolling] = useState(() => {
    try {
      return !!localStorage.getItem("pendingLoginJobId");
    } catch {
      return false;
    }
  });
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [jobStage, setJobStage] = useState("");
  const [jobStatusValue, setJobStatusValue] = useState("");
  const [friendRequestSentAt, setFriendRequestSentAt] = useState<string | null>(
    null,
  );
  const [timeLeft, setTimeLeft] = useState(0);

  const totalWaitSeconds = 5 * 60;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / totalWaitSeconds) * 100),
  );

  const canLogin = useMemo(
    () => /^\d{15}$/.test(friendCode.trim()) && !loading,
    [friendCode, loading],
  );

  const quickLoginUrl = useMemo(() => {
    if (friendCode.trim().length === 15) {
      return `${window.location.origin}/login?friendCode=${friendCode.trim()}`;
    }
    return "";
  }, [friendCode]);

  useEffect(() => {
    if (token) {
      // Exiting offline mode when logging in with a real token
      if (offline) setOffline(false);
      navigate("/app", { replace: true });
    }
  }, [token, navigate, offline, setOffline]);

  useEffect(() => {
    (async () => {
      const res = await getHealthStatus();
      setHealth(res.ok ? JSON.stringify(res.data) : `HTTP ${res.status}`);
    })();

    // Fetch recent stats on mount
    (async () => {
      try {
        const statsRes = await getRecentJobStats();
        if (statsRes) {
          setRecentStats(statsRes);
          if (statsRes.totalCount >= 5 && statsRes.successRate <= 50) {
            setLowSuccessRate(true);
          }
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!jobId || polling === false) return;

    const handle = setInterval(async () => {
      const res = await authApi.loginStatus({ query: { jobId } });

      if (res.status !== 200) {
        setJobStatus(`HTTP ${res.status}`);
        // If job not found (404), clear localStorage
        if (res.status === 404) {
          setPolling(false);
          setJobId("");
          try {
            localStorage.removeItem("pendingLoginJobId");
          } catch {}
        }
        return;
      }

      const data = res.body as LoginStatus;
      setJobStatus(JSON.stringify(data, null, 2));

      const stage = (data as any)?.job?.stage;
      if (stage) setJobStage(stage);

      const jobSt = (data as any)?.job?.status ?? data?.status;
      if (jobSt) setJobStatusValue(String(jobSt));

      const sentAt = (data as any)?.job?.friendRequestSentAt;
      if (sentAt) setFriendRequestSentAt(sentAt);

      const profileFromStatus =
        (data as LoginStatus)?.profile ??
        (data as LoginStatus)?.job?.profile ??
        null;
      if (profileFromStatus) {
        setProfile(profileFromStatus);
      }

      if (data?.token) {
        setToken(data.token);
        setPolling(false);
        try {
          localStorage.removeItem("pendingLoginJobId");
        } catch {}
        notifications.show({
          title: "登录成功",
          message: "欢迎使用 maimai Score Hub！",
          color: "green",
        });
        navigate("/app", { replace: true });
      } else if (data?.status === "failed") {
        setPolling(false);
        setJobStage("");
        setJobStatusValue("");
        setProfile(null);
        try {
          localStorage.removeItem("pendingLoginJobId");
        } catch {}
        notifications.show({
          title: "登录失败",
          message: String(data?.job?.error || "未知错误"),
          color: "red",
        });
      }
    }, 1400);

    return () => clearInterval(handle);
  }, [jobId, polling, setToken, navigate]);

  useEffect(() => {
    if (jobStage !== "wait_acceptance" || !friendRequestSentAt) {
      if (timeLeft !== 0) setTimeLeft(0);
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const sentAt = new Date(friendRequestSentAt).getTime();
      const end = sentAt + totalWaitSeconds * 1000;
      const left = Math.max(0, Math.ceil((end - now) / 1000));
      setTimeLeft(left);
    }, 500);

    return () => clearInterval(interval);
  }, [jobStage, friendRequestSentAt]);

  const startLogin = async () => {
    setLoading(true);
    setJobStatus("");
    setJobId("");
    setPolling(false);
    setProfile(null);
    setJobStage("");
    setJobStatusValue("");
    setFriendRequestSentAt(null);
    setTimeLeft(0);
    setLowSuccessRate(false);

    const trimmedCode = friendCode.trim();
    try {
      localStorage.setItem("lastFriendCode", trimmedCode);
    } catch {}

    const res = await authApi.loginRequest({
      body: {
        friendCode: trimmedCode,
        skipUpdateScore,
        useIdleUpdate: !skipUpdateScore && useIdleUpdate,
      },
    });

    if (res.status === 201 && res.body) {
      const body = res.body as any;
      // Handle skipAuth mode - direct token response
      if (body.skipAuth) {
        setToken(String(body.token ?? ""));
        notifications.show({
          title: "登录成功",
          message: "已跳过验证直接登录",
          color: "green",
        });
        navigate("/");
        setLoading(false);
        return;
      }

      // Normal flow - poll job status
      if (typeof body.jobId === "string") {
        setJobId(body.jobId);
        setPolling(true);
        try {
          localStorage.setItem("pendingLoginJobId", body.jobId);
        } catch {}
      }
    } else {
      notifications.show({
        title: "创建登录任务失败",
        message: `HTTP ${res.status}`,
        color: "red",
      });
    }

    setLoading(false);
  };

  const { colorScheme } = useMantineColorScheme();

  const headerBg =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-6)"
      : "var(--mantine-color-gray-0)";

  return (
    <AppShell header={{ height: 56 }} padding={0}>
      <AppShell.Header>
        <AppHeader showProfile={false} />
      </AppShell.Header>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        <Box
          py="lg"
          px="md"
          style={{
            backgroundColor: headerBg,
          }}
        >
          <Container size="sm" style={{ maxWidth: 600, width: "100%" }}>
            <PageHeader
              title={"欢迎！"}
              description={"使用 maimai NET 好友代码登录以继续"}
            />
          </Container>
        </Box>

        <Box p="0" mt="lg">
          <Container size="sm" style={{ maxWidth: 600, width: "100%" }}>
            <Stack gap="lg">
              {profile && <ProfileCard profile={profile} />}

              {jobStage === "wait_acceptance" ? (
                <>
                  {friendRequestSentAt ? (
                    <Alert
                      variant="outline"
                      radius="md"
                      color="blue"
                      title="好友请求已发送！"
                      icon={<IconInfoCircle size={18} />}
                    >
                      <Stack gap="sm">
                        <Text size="sm">
                          Bot 已发送好友申请，请登录 NET
                          并在核对时间一致后同意好友申请。
                        </Text>
                        <Text size="sm" c="red" fw={700}>
                          若申请时间不是{" "}
                          {formatFriendRequestSentAt(friendRequestSentAt!)}
                          ，请勿接受，可能是他人尝试登录！
                        </Text>
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
                  ) : (
                    <Group justify="center" gap="xs">
                      <Loader size="sm" />
                      <Text size="sm" c="dimmed">
                        Bot 正在发送好友请求，请稍候...
                      </Text>
                    </Group>
                  )}
                </>
              ) : (
                <>
                  <Paper shadow="xs" p="lg" radius="md" withBorder>
                    <Stack gap="md">
                      <Group align="flex-end" gap="xs">
                        <TextInput
                          label="好友代码"
                          placeholder="请输入 NET 好友代码"
                          value={friendCode}
                          onChange={(e) => {
                            const val = e.currentTarget.value;
                            if (/^\d*$/.test(val) && val.length <= 15) {
                              setFriendCode(val);
                            }
                          }}
                          disabled={polling}
                          required
                          styles={{ label: { textAlign: "left" } }}
                          error={
                            friendCode && friendCode.length !== 15
                              ? "好友代码必须是 15 位数字"
                              : null
                          }
                          style={{ flex: 1 }}
                        />
                        {quickLoginUrl && !polling && (
                          <Tooltip label="复制快速登录链接" withArrow>
                            <Button
                              variant="light"
                              onClick={() => {
                                navigator.clipboard.writeText(quickLoginUrl);
                                notifications.show({
                                  title: "链接已复制",
                                  message: "从此链接进入可自动填写好友代码",
                                  color: "teal",
                                });
                              }}
                              color="blue"
                              px="xs"
                            >
                              <IconCopy size={18} />
                            </Button>
                          </Tooltip>
                        )}
                      </Group>

                      <Checkbox
                        label="同时更新成绩"
                        checked={!skipUpdateScore}
                        onChange={(e) => {
                          setSkipUpdateScore(!e.currentTarget.checked);
                          if (e.currentTarget.checked === false) {
                            setUseIdleUpdate(false);
                          }
                        }}
                        disabled={polling}
                      />

                      {!skipUpdateScore && (
                        <Checkbox
                          label={
                            <Group gap={4}>
                              <IconClock size={14} />
                              <Text size="sm">使用夜间更新</Text>
                            </Group>
                          }
                          description="先与 Bot 成为好友，在凌晨空闲时段自动更新成绩"
                          checked={useIdleUpdate}
                          onChange={(e) =>
                            setUseIdleUpdate(e.currentTarget.checked)
                          }
                          disabled={polling}
                        />
                      )}

                      {!skipUpdateScore &&
                        recentStats &&
                        recentStats.totalCount >= 5 && (
                          <Group gap="xl">
                            <Group gap={6}>
                              <Text size="sm" c="dimmed">
                                近 1 小时更新成功率
                              </Text>
                              <Badge
                                variant="light"
                                size="lg"
                                radius="md"
                                color={
                                  recentStats.successRate >= 80
                                    ? "green"
                                    : recentStats.successRate >= 50
                                      ? "yellow"
                                      : "red"
                                }
                              >
                                {recentStats.successRate}%
                              </Badge>
                            </Group>
                            {recentStats.avgDuration != null && (
                              <Group gap={6}>
                                <Text size="sm" c="dimmed">
                                  平均耗时
                                </Text>
                                <Badge variant="light" size="lg" radius="md">
                                  {recentStats.avgDuration >= 60000
                                    ? `${Math.floor(recentStats.avgDuration / 60000)}分${Math.round((recentStats.avgDuration % 60000) / 1000)}秒`
                                    : `${Math.round(recentStats.avgDuration / 1000)}秒`}
                                </Badge>
                              </Group>
                            )}
                          </Group>
                        )}

                      {lowSuccessRate && !skipUpdateScore && !useIdleUpdate && (
                        <Alert
                          variant="light"
                          color="yellow"
                          title="推荐使用闲时更新"
                          icon={<IconInfoCircle size={16} />}
                          radius="md"
                        >
                          <Text size="sm">
                            当前立即更新成功率较低，建议勾选闲时更新以获得更好的体验。
                          </Text>
                        </Alert>
                      )}

                      <Group justify="center" gap="sm">
                        <Button
                          onClick={startLogin}
                          disabled={!canLogin || polling}
                          loading={loading}
                        >
                          登录账户
                        </Button>
                        {hasOfflineData() && (
                          <Button
                            variant="outline"
                            color="gray"
                            onClick={() => {
                              setOffline(true);
                              navigate("/app", { replace: true });
                            }}
                          >
                            离线模式
                          </Button>
                        )}
                      </Group>

                      {polling && jobStatusValue === "queued" && (
                        <Group justify="center" gap="xs">
                          <Loader size="xs" />
                          <Text size="sm" c="dimmed">
                            正在排队中，请稍候...
                          </Text>
                        </Group>
                      )}

                      {polling &&
                        jobStatusValue === "processing" &&
                        jobStage === "send_request" && (
                          <Group justify="center" gap="xs">
                            <Loader size="xs" />
                            <Text size="sm" c="dimmed">
                              正在发送好友请求，通常需要等待约 60 秒...
                            </Text>
                          </Group>
                        )}
                    </Stack>
                  </Paper>

                  <FriendCodeGuide />
                </>
              )}
            </Stack>
          </Container>
        </Box>

        <AppFooter />
      </AppShell.Main>
    </AppShell>
  );
}
