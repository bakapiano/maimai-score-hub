import {
  Alert,
  Anchor,
  AppShell,
  Box,
  Button,
  Collapse,
  Container,
  Group,
  Image,
  Loader,
  Paper,
  PasswordInput,
  Progress,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconInfoCircle,
  IconCopy,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useMemo, useState } from "react";

import { ProfileCard, type UserProfile } from "../components/ProfileCard";
import { QrLoginForm } from "../components/QrLoginForm";
import { formatFriendRequestSentAt } from "../utils/formatDate";
import { AppHeader } from "../components/AppHeader";
import { PageHeader } from "../components/PageHeader";
import { authApi, getHealthStatus } from "../api/appClient";
import { notifications } from "@mantine/notifications";
import { useAuth } from "../providers/AuthProvider";
import { useNavigate, useSearchParams } from "react-router-dom";
import { hasOfflineData } from "../utils/offlineCache";
import { AppFooter } from "../components/AppFooter";
import { InstallAppButton } from "../components/InstallAppButton";
import { recordAnalyticsEvent } from "../utils/observability";

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
  const [passwordFriendCode, setPasswordFriendCode] = useState(() => {
    try {
      const username = localStorage.getItem("lastUsername") || "";
      if (username) return "";
      return localStorage.getItem("lastFriendCode") || "";
    } catch {
      return "";
    }
  });
  const [passwordUsername, setPasswordUsername] = useState(() => {
    try {
      return localStorage.getItem("lastUsername") || "";
    } catch {
      return "";
    }
  });
  const [passwordLoginPassword, setPasswordLoginPassword] = useState("");
  const [passwordLoginLoading, setPasswordLoginLoading] = useState(false);
  const [loginMethod, setLoginMethod] = useState<
    "bot_sends_request" | "user_sends_request" | null
  >(null);
  const [_health, setHealth] = useState("");
  const [jobId, setJobId] = useState(() => {
    try {
      return localStorage.getItem("pendingLoginJobId") || "";
    } catch {
      return "";
    }
  });
  // QR-login (other tab) reports its busy state up so we can lock the
  // friend-code tab while it's running, and vice-versa via `polling`.
  const [qrBusy, setQrBusy] = useState(false);
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
  const [assignedBotFriendCode, setAssignedBotFriendCode] = useState(() => {
    try {
      return localStorage.getItem("pendingLoginBotFriendCode") || "";
    } catch {
      return "";
    }
  });
  const [loginCreatedAt, setLoginCreatedAt] = useState(() => {
    try {
      return localStorage.getItem("pendingLoginCreatedAt") || "";
    } catch {
      return "";
    }
  });
  const [timeLeft, setTimeLeft] = useState(0);

  const totalWaitSeconds = 5 * 60;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / totalWaitSeconds) * 100),
  );

  const canLogin = useMemo(
    () => /^\d{15}$/.test(friendCode.trim()) && !!loginMethod && !loading,
    [friendCode, loginMethod, loading],
  );

  const canPasswordLogin = useMemo(
    () => {
      const hasFriendCode = passwordFriendCode.trim().length > 0;
      const hasUsername = passwordUsername.trim().length > 0;
      return (
        hasFriendCode !== hasUsername &&
        (!hasFriendCode || /^\d{15}$/.test(passwordFriendCode.trim())) &&
        passwordLoginPassword.length > 0 &&
        !passwordLoginLoading &&
        !polling &&
        !qrBusy
      );
    },
    [
      passwordFriendCode,
      passwordUsername,
      passwordLoginPassword,
      passwordLoginLoading,
      polling,
      qrBusy,
    ],
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
  }, []);

  useEffect(() => {
    if (!jobId || polling === false) return;

    let consecutiveFails = 0;
    const MAX_FAILS = 5;
    const BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000];
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const runOnce = async () => {
      let res;
      try {
        res = await authApi.loginStatus({ params: { jobId } });
      } catch (err) {
        // network failure → counted as 5xx
        consecutiveFails++;
        if (consecutiveFails >= MAX_FAILS) {
          setJobStatus(`network error: ${String(err)}`);
          return;
        }
        scheduleNext(
          BACKOFF[Math.min(consecutiveFails - 1, BACKOFF.length - 1)],
        );
        return;
      }

      if (res.status >= 500) {
        consecutiveFails++;
        if (consecutiveFails >= MAX_FAILS) {
          setJobStatus(`HTTP ${res.status} (after ${MAX_FAILS} retries)`);
          return;
        }
        scheduleNext(
          BACKOFF[Math.min(consecutiveFails - 1, BACKOFF.length - 1)],
        );
        return;
      }

      consecutiveFails = 0;

      if (res.status !== 200) {
        setJobStatus(`HTTP ${res.status}`);
        if (res.status === 404) {
          setPolling(false);
          setJobId("");
          try {
            localStorage.removeItem("pendingLoginJobId");
          } catch {}
          return;
        }
        scheduleNext(1_000);
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
      const botFriendCode = (data as any)?.job?.botUserFriendCode;
      if (botFriendCode) setAssignedBotFriendCode(String(botFriendCode));
      const createdAt = (data as any)?.job?.createdAt;
      if (createdAt) setLoginCreatedAt(String(createdAt));

      const profileFromStatus =
        (data as LoginStatus)?.profile ??
        (data as LoginStatus)?.job?.profile ??
        null;
      if (profileFromStatus) {
        setProfile(profileFromStatus);
      }

      if (data?.token) {
        setToken(data.token);
        recordAnalyticsEvent("login_success", { method: "friend_code" });
        setPolling(false);
        try {
          localStorage.removeItem("pendingLoginJobId");
          localStorage.removeItem("pendingLoginBotFriendCode");
          localStorage.removeItem("pendingLoginCreatedAt");
        } catch {}
        notifications.show({
          title: "登录成功",
          message: "欢迎使用 maimai Score Hub！",
          color: "green",
        });
        navigate("/app", { replace: true });
        return;
      }
      if (data?.status === "failed") {
        setPolling(false);
        setJobStage("");
        setJobStatusValue("");
        setProfile(null);
        try {
          localStorage.removeItem("pendingLoginJobId");
          localStorage.removeItem("pendingLoginBotFriendCode");
          localStorage.removeItem("pendingLoginCreatedAt");
        } catch {}
        notifications.show({
          title: "登录失败",
          message: String(data?.job?.error || "未知错误"),
          color: "red",
        });
        return;
      }
      scheduleNext(1_000);
    };

    const scheduleNext = (ms: number) => {
      if (cancelled) return;
      scheduled = setTimeout(() => {
        void runOnce();
      }, ms);
    };

    void runOnce();
    return () => {
      cancelled = true;
      if (scheduled !== null) clearTimeout(scheduled);
    };
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
    setAssignedBotFriendCode("");
    setLoginCreatedAt("");
    setTimeLeft(0);

    const trimmedCode = friendCode.trim();
    try {
      localStorage.setItem("lastFriendCode", trimmedCode);
    } catch {}

    const res = await authApi.loginRequest({
      body: {
        friendCode: trimmedCode,
        method: loginMethod!,
      },
    });

    if (res.status === 201 && res.body) {
      const body = res.body as any;
      // Handle skipAuth mode - direct token response
      if (body.skipAuth) {
        setToken(String(body.token ?? ""));
        recordAnalyticsEvent("login_success", { method: "skip_auth" });
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
        const botFriendCode = String(body.botFriendCode ?? "");
        const createdAt = String(body.createdAt ?? body.job?.createdAt ?? "");
        setAssignedBotFriendCode(botFriendCode);
        setLoginCreatedAt(createdAt);
        if (body.job?.stage) setJobStage(String(body.job.stage));
        setPolling(true);
        try {
          localStorage.setItem("pendingLoginJobId", body.jobId);
          if (botFriendCode) {
            localStorage.setItem("pendingLoginBotFriendCode", botFriendCode);
          } else {
            localStorage.removeItem("pendingLoginBotFriendCode");
          }
          if (createdAt) {
            localStorage.setItem("pendingLoginCreatedAt", createdAt);
          } else {
            localStorage.removeItem("pendingLoginCreatedAt");
          }
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

  const startPasswordLogin = async () => {
    setPasswordLoginLoading(true);
    try {
      const friendCode = passwordFriendCode.trim();
      const username = passwordUsername.trim();
      if (!!friendCode === !!username) {
        notifications.show({
          title: "密码登录失败",
          message: "请只填写好友码或用户名其中一项",
          color: "red",
        });
        return;
      }

      const res = await authApi.passwordLogin({
        body: {
          ...(friendCode ? { friendCode } : { username }),
          password: passwordLoginPassword,
        },
      });

      if (res.status === 200 && res.body?.token) {
        const user = res.body.user as
          | { friendCode?: string; username?: string | null }
          | undefined;
        try {
          if (user?.friendCode) {
            localStorage.setItem("lastFriendCode", user.friendCode);
          }
          if (user?.username) {
            localStorage.setItem("lastUsername", user.username);
          }
        } catch {}
        setToken(String(res.body.token));
        recordAnalyticsEvent("login_success", { method: "password" });
        setPasswordLoginPassword("");
        notifications.show({
          title: "登录成功",
          message: "欢迎使用 maimai Score Hub！",
          color: "green",
        });
        navigate("/app", { replace: true });
        return;
      }

      const body = res.body as {
        message?: string | { message?: string };
        error?: string;
      };
      const message =
        (typeof body?.message === "object" && body.message?.message) ||
        (typeof body?.message === "string" && body.message) ||
        body?.error ||
        `HTTP ${res.status}`;
      notifications.show({
        title: "密码登录失败",
        message,
        color: "red",
      });
    } catch (err) {
      notifications.show({
        title: "密码登录失败",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      });
    } finally {
      setPasswordLoginLoading(false);
    }
  };

  const wakeLoginJob = async () => {
    if (!jobId) return;
    setLoading(true);
    try {
      const res = await authApi.verifyLoginRequest({
        params: { jobId },
        body: undefined,
      });
      if (res.status === 200) {
        const job = (res.body as any)?.job;
        const stage = job?.stage;
        if (stage) setJobStage(String(stage));
        if (job?.friendRequestSentAt) {
          setFriendRequestSentAt(String(job.friendRequestSentAt));
        }
        setPolling(true);
      } else {
        notifications.show({
          title: "验证请求失败",
          message: `HTTP ${res.status}`,
          color: "red",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  // Resolve "auto" against system preference so dark-mode-via-system
  // actually picks dark header colors. useMantineColorScheme returns
  // the literal "auto" which would fall through to the light branch.
  const colorScheme = useComputedColorScheme("light");

  const headerBg =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-6)"
      : "var(--mantine-color-gray-0)";

  const isUserSendsRequestStage = [
    "wait_user_request",
    "accept_request",
  ].includes(jobStage);

  return (
    <AppShell header={{ height: 56 }} padding={0}>
      <AppShell.Header>
        <AppHeader
          showProfile={false}
          rightSection={<InstallAppButton variant="subtle" />}
        />
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
                        <Button
                          onClick={wakeLoginJob}
                          loading={loading}
                          disabled={!jobId}
                        >
                          我已接受请求
                        </Button>
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
              ) : isUserSendsRequestStage ? (
                <Alert
                  variant="outline"
                  radius="md"
                  color="blue"
                  title="请向 Bot 发送好友申请"
                  icon={<IconInfoCircle size={18} />}
                >
                  <Stack gap="sm">
                    <Text size="sm">
                      请登录 maimai NET，向下面这个 Bot 好友码发送好友申请。
                    </Text>
                    <Paper withBorder radius="md" p="sm">
                      <Group justify="space-between" align="center">
                        <Text fw={700} size="lg">
                          {assignedBotFriendCode || "等待分配 Bot..."}
                        </Text>
                        {assignedBotFriendCode && (
                          <Button
                            size="xs"
                            variant="light"
                            onClick={() =>
                              navigator.clipboard?.writeText(
                                assignedBotFriendCode,
                              )
                            }
                          >
                            复制
                          </Button>
                        )}
                      </Group>
                    </Paper>
                    {loginCreatedAt && (
                      <Text size="sm" c="dimmed">
                        登录请求创建时间：
                        {formatFriendRequestSentAt(loginCreatedAt)}
                      </Text>
                    )}
                    <Group gap="sm">
                      <Button
                        onClick={wakeLoginJob}
                        loading={loading}
                        disabled={!jobId || jobStage === "accept_request"}
                      >
                        我已发送请求
                      </Button>
                      <Group gap="xs">
                        <Loader size="xs" />
                        <Text size="sm" c="dimmed">
                          后台也会自动检查好友申请
                        </Text>
                      </Group>
                    </Group>
                  </Stack>
                </Alert>
              ) : (
                <>
                  <Tabs defaultValue="friendCode" keepMounted={false}>
                    <Tabs.List grow>
                      <Tabs.Tab value="friendCode">好友码登录</Tabs.Tab>
                      <Tabs.Tab value="password">密码登录</Tabs.Tab>
                      <Tabs.Tab value="qr">神秘二维码登录</Tabs.Tab>
                    </Tabs.List>

                    <Tabs.Panel value="friendCode" pt="md">
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
                              disabled={polling || qrBusy}
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
                                    navigator.clipboard.writeText(
                                      quickLoginUrl,
                                    );
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

                          <Stack gap={6}>
                            <Text size="sm" fw={500}>
                              好友申请方式
                            </Text>
                            <SegmentedControl
                              value={loginMethod ?? ""}
                              onChange={(value) =>
                                setLoginMethod(
                                  value as
                                    | "bot_sends_request"
                                    | "user_sends_request",
                                )
                              }
                              disabled={polling || qrBusy}
                              data={[
                                {
                                  label: "Bot 向我发送",
                                  value: "bot_sends_request",
                                },
                                {
                                  label: "我向 Bot 发送",
                                  value: "user_sends_request",
                                },
                              ]}
                            />
                          </Stack>

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
                    </Tabs.Panel>

                    <Tabs.Panel value="password" pt="md">
                      <Paper shadow="xs" p="lg" radius="md" withBorder>
                        <Stack gap="md">
                          <TextInput
                            label="好友码"
                            placeholder="15 位好友码"
                            value={passwordFriendCode}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              if (/^\d*$/.test(value) && value.length <= 15) {
                                setPasswordFriendCode(value);
                              }
                            }}
                            disabled={polling || qrBusy || passwordLoginLoading}
                          />
                          <TextInput
                            label="用户名"
                            placeholder="自定义用户名"
                            value={passwordUsername}
                            onChange={(event) =>
                              setPasswordUsername(event.currentTarget.value)
                            }
                            disabled={polling || qrBusy || passwordLoginLoading}
                          />
                          <PasswordInput
                            label="密码"
                            placeholder="请输入密码"
                            value={passwordLoginPassword}
                            onChange={(event) =>
                              setPasswordLoginPassword(event.currentTarget.value)
                            }
                            disabled={polling || qrBusy || passwordLoginLoading}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && canPasswordLogin) {
                                void startPasswordLogin();
                              }
                            }}
                          />
                          <Button
                            onClick={startPasswordLogin}
                            disabled={!canPasswordLogin}
                            loading={passwordLoginLoading}
                          >
                            密码登录
                          </Button>
                          <Text size="xs" c="dimmed">
                            好友码和用户名二选一填写。密码需要先在已登录账号的设置中创建。
                          </Text>
                        </Stack>
                      </Paper>
                    </Tabs.Panel>

                    <Tabs.Panel value="qr" pt="md">
                      <Paper shadow="xs" p="lg" radius="md" withBorder>
                        <QrLoginForm
                          onSuccess={(t) => {
                            setToken(t);
                            recordAnalyticsEvent("login_success", {
                              method: "qr",
                            });
                            navigate("/");
                          }}
                          onBusyChange={setQrBusy}
                          disabled={polling}
                        />
                      </Paper>
                    </Tabs.Panel>
                  </Tabs>

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
