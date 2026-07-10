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
  SimpleGrid,
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
  IconId,
  IconLogin2,
  IconPassword,
  IconRobot,
  IconQrcode,
  IconSend,
  IconUser,
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
import { useAuth } from "../providers/AuthContext";
import { useNavigate, useSearchParams } from "react-router-dom";
import { hasOfflineData } from "../utils/offlineCache";
import { AppFooter } from "../components/AppFooter";
import { recordAnalyticsEvent } from "../utils/observability";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const LOGIN_WAIT_SECONDS = 5 * 60;
const PASSWORD_LOGIN_IDENTIFIER_KEY = "passwordLoginIdentifier";
const LOGIN_METHOD_KEY = "loginMethod";

type LoginJobStatus = {
  profile?: UserProfile;
  stage?: string | null;
  status?: string | null;
  friendRequestSentAt?: string | null;
  botUserFriendCode?: string | number | null;
  createdAt?: string | null;
  error?: string | null;
  [key: string]: unknown;
};

type LoginStatus = {
  status?: string;
  token?: string;
  profile?: UserProfile;
  job?: LoginJobStatus;
  error?: string | null;
  [key: string]: unknown;
};

type LoginRequestBody = {
  skipAuth?: boolean;
  token?: string | null;
  jobId?: string;
  botFriendCode?: string | number | null;
  createdAt?: string | null;
  job?: LoginJobStatus;
};

type PasswordLoginIdentifier = "friendCode" | "username";
type LoginMethod = "bot_sends_request" | "user_sends_request";

function clearPendingLoginStorage() {
  try {
    localStorage.removeItem("pendingLoginJobId");
    localStorage.removeItem("pendingLoginBotFriendCode");
    localStorage.removeItem("pendingLoginCreatedAt");
  } catch {
    // localStorage may be unavailable.
  }
}

function persistPendingLoginStorage(
  jobId: string,
  botFriendCode: string,
  createdAt: string,
) {
  try {
    localStorage.setItem("pendingLoginJobId", jobId);
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
  } catch {
    // localStorage may be unavailable.
  }
}

function persistLastLoginAccount(account?: {
  friendCode?: string | number | null;
  username?: string | null;
}) {
  try {
    const friendCode = account?.friendCode;
    const username = account?.username;
    if (friendCode) {
      localStorage.setItem("lastFriendCode", String(friendCode));
    }
    if (username) {
      localStorage.setItem("lastUsername", username);
    }
  } catch {
    // localStorage may be unavailable.
  }
}

function readPasswordLoginIdentifier(): PasswordLoginIdentifier {
  try {
    const cached = localStorage.getItem(PASSWORD_LOGIN_IDENTIFIER_KEY);
    return cached === "friendCode" || cached === "username"
      ? cached
      : "username";
  } catch {
    return "username";
  }
}

function persistPasswordLoginIdentifier(identifier: PasswordLoginIdentifier) {
  try {
    localStorage.setItem(PASSWORD_LOGIN_IDENTIFIER_KEY, identifier);
  } catch {
    // localStorage may be unavailable.
  }
}

function readLoginMethod(): LoginMethod {
  try {
    const cached = localStorage.getItem(LOGIN_METHOD_KEY);
    return cached === "bot_sends_request" || cached === "user_sends_request"
      ? cached
      : "bot_sends_request";
  } catch {
    return "bot_sends_request";
  }
}

function persistLoginMethod(method: LoginMethod) {
  try {
    localStorage.setItem(LOGIN_METHOD_KEY, method);
  } catch {
    // localStorage may be unavailable.
  }
}

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

function LoginMethodCard({
  active,
  description,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Paper
      component="button"
      type="button"
      withBorder
      p="sm"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        borderColor: active
          ? "var(--mantine-color-blue-6)"
          : "var(--mantine-color-default-border)",
        background: active
          ? "var(--mantine-color-blue-light)"
          : "var(--mantine-color-body)",
      }}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            background: active
              ? "var(--mantine-color-blue-filled)"
              : "var(--mantine-color-gray-light)",
            color: active ? "white" : "var(--mantine-color-dimmed)",
          }}
        >
          {icon}
        </Box>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={700}>
              {active ? "✓ " : ""}
              {label}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {description}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

function IdentifierCard({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Paper
      component="button"
      type="button"
      withBorder
      p="sm"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        borderColor: active
          ? "var(--mantine-color-blue-6)"
          : "var(--mantine-color-default-border)",
        background: active
          ? "var(--mantine-color-blue-light)"
          : "var(--mantine-color-body)",
      }}
    >
      <Group gap="sm" wrap="nowrap">
        <Box
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            background: active
              ? "var(--mantine-color-blue-filled)"
              : "var(--mantine-color-gray-light)",
            color: active ? "white" : "var(--mantine-color-dimmed)",
          }}
        >
          {icon}
        </Box>
        <Text size="sm" fw={700}>
          {active ? "✓ " : ""}
          {label}
        </Text>
      </Group>
    </Paper>
  );
}

export default function LoginPage() {
  useDocumentTitle("登陆");
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
  const [passwordLoginIdentifier, setPasswordLoginIdentifier] =
    useState<PasswordLoginIdentifier>(() => readPasswordLoginIdentifier());
  const [passwordLoginPassword, setPasswordLoginPassword] = useState("");
  const [passwordLoginLoading, setPasswordLoginLoading] = useState(false);
  const [loginMethod, setLoginMethod] =
    useState<LoginMethod>(() => readLoginMethod());
  const [, setHealth] = useState("");
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
  const [, setJobStatus] = useState("");
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

  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / LOGIN_WAIT_SECONDS) * 100),
  );

  const canLogin = useMemo(
    () => /^\d{15}$/.test(friendCode.trim()) && !!loginMethod && !loading,
    [friendCode, loginMethod, loading],
  );

  const canPasswordLogin = useMemo(
    () => {
      const identifier =
        passwordLoginIdentifier === "friendCode"
          ? passwordFriendCode.trim()
          : passwordUsername.trim();
      return (
        identifier.length > 0 &&
        (passwordLoginIdentifier !== "friendCode" ||
          /^\d{15}$/.test(identifier)) &&
        passwordLoginPassword.length > 0 &&
        !passwordLoginLoading &&
        !polling &&
        !qrBusy
      );
    },
    [
      passwordLoginIdentifier,
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
      if (offline) {setOffline(false);}
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
    if (!jobId || polling === false) {return;}

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
          clearPendingLoginStorage();
          return;
        }
        scheduleNext(1_000);
        return;
      }

      const data = res.body as LoginStatus;
      setJobStatus(JSON.stringify(data, null, 2));

      const stage = data.job?.stage;
      if (stage) {setJobStage(stage);}

      const jobSt = data.job?.status ?? data?.status;
      if (jobSt) {setJobStatusValue(String(jobSt));}

      const sentAt = data.job?.friendRequestSentAt;
      if (sentAt) {setFriendRequestSentAt(sentAt);}
      const botFriendCode = data.job?.botUserFriendCode;
      if (botFriendCode) {setAssignedBotFriendCode(String(botFriendCode));}
      const createdAt = data.job?.createdAt;
      if (createdAt) {setLoginCreatedAt(String(createdAt));}

      const profileFromStatus =
        (data as LoginStatus)?.profile ??
        (data as LoginStatus)?.job?.profile ??
        null;
      if (profileFromStatus) {
        setProfile(profileFromStatus);
        persistLastLoginAccount({ username: profileFromStatus.username });
      }

      if (data?.token) {
        setToken(data.token);
        recordAnalyticsEvent("login_success", { method: "friend_code" });
        setPolling(false);
        clearPendingLoginStorage();
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
        clearPendingLoginStorage();
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
      if (cancelled) {return;}
      scheduled = setTimeout(() => {
        void runOnce();
      }, ms);
    };

    void runOnce();
    return () => {
      cancelled = true;
      if (scheduled !== null) {clearTimeout(scheduled);}
    };
  }, [jobId, polling, setToken, navigate]);

  useEffect(() => {
    if (jobStage !== "wait_acceptance" || !friendRequestSentAt) {
      setTimeLeft((current) => (current === 0 ? current : 0));
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const sentAt = new Date(friendRequestSentAt).getTime();
      const end = sentAt + LOGIN_WAIT_SECONDS * 1000;
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
    } catch {
      // localStorage may be unavailable.
    }

    const res = await authApi.loginRequest({
      body: {
        friendCode: trimmedCode,
        method: loginMethod!,
      },
    });

    if (res.status === 201 && res.body) {
      const body = res.body as LoginRequestBody;
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
        if (body.job?.stage) {setJobStage(String(body.job.stage));}
        setPolling(true);
        persistPendingLoginStorage(body.jobId, botFriendCode, createdAt);
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
      if (
        passwordLoginIdentifier === "friendCode" &&
        !/^\d{15}$/.test(friendCode)
      ) {
        notifications.show({
          title: "密码登录失败",
          message: "请输入 15 位好友码",
          color: "red",
        });
        return;
      }
      if (passwordLoginIdentifier === "username" && !username) {
        notifications.show({
          title: "密码登录失败",
          message: "请输入用户名",
          color: "red",
        });
        return;
      }

      const res = await authApi.passwordLogin({
        body: {
          ...(passwordLoginIdentifier === "friendCode"
            ? { friendCode }
            : { username }),
          password: passwordLoginPassword,
        },
      });

      if (res.status === 200 && res.body?.token) {
        const user = res.body.user as
          | { friendCode?: string; username?: string | null }
          | undefined;
        persistLastLoginAccount(user);
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
    if (!jobId) {return;}
    setLoading(true);
    try {
      const res = await authApi.verifyLoginRequest({
        params: { jobId },
        body: undefined,
      });
      if (res.status === 200) {
        const job = (res.body as { job?: LoginJobStatus } | null)?.job;
        const stage = job?.stage;
        if (stage) {setJobStage(String(stage));}
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
              description={"使用 maimai NET 好友代码登录以继续，未注册将自动创建账号"}
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
                    <Paper withBorder p="sm">
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
                      <Tabs.Tab
                        value="friendCode"
                      >
                        <Group gap={4} wrap="nowrap" justify="center">
                          <IconId size={16} />
                          <span>好友码</span>
                        </Group>
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="password"
                      >
                        <Group gap={4} wrap="nowrap" justify="center">
                          <IconUser size={16} />
                          <span>账号密码</span>
                        </Group>
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="qr"
                      >
                        <Group gap={4} wrap="nowrap" justify="center">
                          <IconQrcode size={16} />
                          <span>二维码</span>
                        </Group>
                      </Tabs.Tab>
                    </Tabs.List>

                    <Tabs.Panel value="friendCode" pt="md">
                      <Paper shadow="xs" p="lg" withBorder>
                        <Stack gap="md">
                          <Group align="flex-end" gap="xs">
                            <TextInput
                              label="好友代码"
                              placeholder="请输入 NET 好友代码"
                              leftSection={<IconId size={16} />}
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
                              申请方向
                            </Text>
                            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
                              <LoginMethodCard
                                active={loginMethod === "bot_sends_request"}
                                disabled={polling || qrBusy}
                                icon={<IconRobot size={18} />}
                                label="Bot 向我发送"
                                description="按页面提示接受好友申请"
                                onClick={() => {
                                  setLoginMethod("bot_sends_request");
                                  persistLoginMethod("bot_sends_request");
                                }}
                              />
                              <LoginMethodCard
                                active={loginMethod === "user_sends_request"}
                                disabled={polling || qrBusy}
                                icon={<IconSend size={18} />}
                                label="我向 Bot 发送"
                                description="手动向分配的 Bot 好友码发送申请"
                                onClick={() => {
                                  setLoginMethod("user_sends_request");
                                  persistLoginMethod("user_sends_request");
                                }}
                              />
                            </SimpleGrid>
                          </Stack>

                          <Group justify="center" gap="sm">
                          <Button
                            onClick={startLogin}
                            disabled={!canLogin || polling}
                            loading={loading}
                            leftSection={<IconLogin2 size={16} />}
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
                      <Paper shadow="xs" p="lg" withBorder>
                        <Stack gap="md">
                          <Stack gap={6}>
                            <Text size="sm" fw={500}>
                              账号类型
                            </Text>
                            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
                              <IdentifierCard
                                active={passwordLoginIdentifier === "username"}
                                disabled={
                                  polling || qrBusy || passwordLoginLoading
                                }
                                icon={<IconUser size={18} />}
                                label="用户名"
                                onClick={() => {
                                  setPasswordLoginIdentifier("username");
                                  persistPasswordLoginIdentifier("username");
                                }}
                              />
                              <IdentifierCard
                                active={passwordLoginIdentifier === "friendCode"}
                                disabled={
                                  polling || qrBusy || passwordLoginLoading
                                }
                                icon={<IconId size={18} />}
                                label="好友代码"
                                onClick={() => {
                                  setPasswordLoginIdentifier("friendCode");
                                  persistPasswordLoginIdentifier("friendCode");
                                }}
                              />
                            </SimpleGrid>
                          </Stack>
                          {passwordLoginIdentifier === "friendCode" ? (
                            <TextInput
                              label="好友码"
                              placeholder="15 位好友码"
                              leftSection={<IconId size={16} />}
                              value={passwordFriendCode}
                              onChange={(event) => {
                                const value = event.currentTarget.value;
                                if (/^\d*$/.test(value) && value.length <= 15) {
                                  setPasswordFriendCode(value);
                                }
                              }}
                              disabled={
                                polling || qrBusy || passwordLoginLoading
                              }
                              error={
                                passwordFriendCode &&
                                passwordFriendCode.length !== 15
                                  ? "好友码必须是 15 位数字"
                                  : null
                              }
                            />
                          ) : (
                            <TextInput
                              label="用户名"
                              placeholder="自定义用户名"
                              leftSection={<IconUser size={16} />}
                              value={passwordUsername}
                              onChange={(event) =>
                                setPasswordUsername(event.currentTarget.value)
                              }
                              disabled={
                                polling || qrBusy || passwordLoginLoading
                              }
                            />
                          )}
                          <PasswordInput
                            label="密码"
                            placeholder="请输入密码"
                            leftSection={<IconPassword size={16} />}
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
                            leftSection={<IconLogin2 size={16} />}
                          >
                            密码登录
                          </Button>
                          <Text size="xs" c="dimmed">
                            密码需要先在已登录账号的设置中创建。
                          </Text>
                        </Stack>
                      </Paper>
                    </Tabs.Panel>

                    <Tabs.Panel value="qr" pt="md">
                      <Paper shadow="xs" p="lg" withBorder>
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
