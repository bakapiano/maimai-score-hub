import {
  Alert,
  AppShell,
  Box,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  PasswordInput,
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
  IconBrandWechat,
  IconCopy,
  IconId,
  IconLogin2,
  IconKey,
  IconPassword,
  IconRobot,
  IconQrcode,
  IconSend,
  IconUser,
  IconWifiOff,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { ProfileCard, type UserProfile } from "../components/ProfileCard";
import { AppCard } from "../components/AppCard";
import { QrLoginForm } from "../components/QrLoginForm";
import {
  FriendRequestAcceptanceAlert,
  FriendRequestVerificationButton,
} from "../components/FriendRequestVerification";
import { formatFriendRequestSentAt } from "../utils/formatDate";
import { AppHeader } from "../components/AppHeader";
import { PageHeader } from "../components/PageHeader";
import { authApi, getHealthStatus } from "../api/appClient";
import { notifications } from "@mantine/notifications";
import { useAuth } from "../providers/AuthContext";
import { useNavigate, useSearchParams } from "react-router-dom";
import { hasOfflineData } from "../utils/offlineCache";
import { AppFooter } from "../components/AppFooter";
import { FriendCodeGuide } from "../components/FriendCodeGuide";
import { recordAnalyticsEvent } from "../utils/observability";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { apiUrl } from "../api/baseUrl";
import { clearPendingFriendLogin, persistPendingFriendLogin, readPendingFriendLogin } from "../utils/loginTaskCache";
import { getJobStatusDisposition, parseJobStatus } from "../utils/jobStatus";
import { HttpClientError, PollAborted, PollDead, PollTimeout, fetchForPoll, pollWithBackoff } from "../utils/poll";
import { AndroidAutoLoginPanel } from "../features/android-update/AndroidAutoLoginPanel";
import { getAndroidLoginBridge } from "../features/android-update/androidUpdateBridge";
import { useAndroidLoginAvailability } from "../features/android-update/useAndroidLoginAvailability";

const PASSWORD_LOGIN_IDENTIFIER_KEY = "passwordLoginIdentifier";
const LOGIN_METHOD_KEY = "loginMethod";
const LOGIN_TYPE_KEY = "loginType";
const LOGIN_REQUEST_TIMEOUT_MS = 15_000;

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

type LoginPollOutcome = { kind: "authenticated"; token: string } | { kind: "ended"; status: "completed" | "failed" | "canceled"; message: string };

type PasswordLoginIdentifier = "friendCode" | "username";
type LoginMethod = "bot_sends_request" | "user_sends_request";
type LoginType = "android" | "friendCode" | "password" | "qr" | "passkey";

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

function isLoginType(value: string | null): value is LoginType {
  return ["android", "friendCode", "password", "qr", "passkey"].includes(
    value ?? "",
  );
}

function readLoginType(): LoginType {
  try {
    const cached = localStorage.getItem(LOGIN_TYPE_KEY);
    if (isLoginType(cached) && (cached !== "android" || getAndroidLoginBridge())) {
      return cached;
    }
    return getAndroidLoginBridge() ? "android" : "friendCode";
  } catch {
    return getAndroidLoginBridge() ? "android" : "friendCode";
  }
}

function persistLoginType(loginType: LoginType) {
  try {
    localStorage.setItem(LOGIN_TYPE_KEY, loginType);
  } catch {
    // localStorage may be unavailable.
  }
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
  const androidLoginAvailable = useAndroidLoginAvailability();

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
  const [passkeyLoginLoading, setPasskeyLoginLoading] = useState(false);
  const [loginType, setLoginType] = useState<LoginType>(() => readLoginType());
  const [loginMethod, setLoginMethod] =
    useState<LoginMethod>(() => readLoginMethod());
  const [, setHealth] = useState("");
  const [initialPendingLogin] = useState(() => readPendingFriendLogin());
  const [jobId, setJobId] = useState(initialPendingLogin?.jobId ?? "");
  // QR-login (other tab) reports its busy state up so we can lock the
  // friend-code tab while it's running, and vice-versa via `polling`.
  const [qrBusy, setQrBusy] = useState(false);
  const [, setJobStatus] = useState("");
  const [polling, setPolling] = useState(initialPendingLogin !== null);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [jobStage, setJobStage] = useState("");
  const [jobStatusValue, setJobStatusValue] = useState("");
  const [friendRequestSentAt, setFriendRequestSentAt] = useState<string | null>(
    null,
  );
  const [assignedBotFriendCode, setAssignedBotFriendCode] = useState(
    initialPendingLogin?.botFriendCode ?? "",
  );
  const [loginCreatedAt, setLoginCreatedAt] = useState(
    initialPendingLogin?.createdAt ?? "",
  );
  const [loginExpiresAt, setLoginExpiresAt] = useState(
    initialPendingLogin?.expiresAt ?? 0,
  );
  const canLogin = useMemo(
    () =>
      /^\d{15}$/.test(friendCode.trim()) &&
      !!loginMethod &&
      !loading &&
      !passkeyLoginLoading &&
      !polling &&
      !qrBusy,
    [
      friendCode,
      loginMethod,
      loading,
      passkeyLoginLoading,
      polling,
      qrBusy,
    ],
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
        !passkeyLoginLoading &&
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
      passkeyLoginLoading,
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

    const controller = new AbortController();
    const remainingCacheMs = loginExpiresAt - Date.now();

    const resetPendingState = () => {
      setPolling(false);
      setJobId("");
      setJobStage("");
      setJobStatusValue("");
      setFriendRequestSentAt(null);
      setAssignedBotFriendCode("");
      setLoginCreatedAt("");
      setLoginExpiresAt(0);
      setProfile(null);
      clearPendingFriendLogin();
    };

    const pollLoginJob = async () => {
      if (remainingCacheMs <= 0) {
        throw new PollTimeout();
      }

      return pollWithBackoff<LoginPollOutcome>(
        async () => {
          const { body } = await fetchForPoll(
            apiUrl(`/auth/login-requests/${encodeURIComponent(jobId)}`),
            { signal: controller.signal },
          );
          const data = body as LoginStatus;
          setJobStatus(JSON.stringify(data, null, 2));

          const stage = data.job?.stage;
          setJobStage(typeof stage === "string" ? stage : "");

          const status = parseJobStatus(data.job?.status ?? data.status);
          setJobStatusValue(status ?? "");

          const sentAt = data.job?.friendRequestSentAt;
          setFriendRequestSentAt(
            typeof sentAt === "string" ? sentAt : null,
          );
          const botFriendCode = data.job?.botUserFriendCode;
          if (botFriendCode !== null && botFriendCode !== undefined) {
            setAssignedBotFriendCode(String(botFriendCode));
          }
          const createdAt = data.job?.createdAt;
          if (typeof createdAt === "string") {
            setLoginCreatedAt(createdAt);
          }

          const profileFromStatus = data.profile ?? data.job?.profile ?? null;
          if (profileFromStatus) {
            setProfile(profileFromStatus);
            persistLastLoginAccount({ username: profileFromStatus.username });
          }

          if (typeof data.token === "string" && data.token) {
            return {
              done: true,
              value: { kind: "authenticated", token: data.token },
            };
          }
          if (!status) {
            return {
              done: true,
              value: {
                kind: "ended",
                status: "failed",
                message: "登录任务返回了未知状态，请重新发起登录",
              },
            };
          }

          const disposition = getJobStatusDisposition(status);
          if (disposition === "active") {
            return { done: false };
          }
          if (disposition === "succeeded") {
            return {
              done: true,
              value: {
                kind: "ended",
                status: "completed",
                message: "登录任务已完成，但登录凭证缺失，请重新发起登录",
              },
            };
          }
          const failureStatus = status === "canceled" ? "canceled" : "failed";
          return {
            done: true,
            value: {
              kind: "ended",
              status: failureStatus,
              message:
                data.job?.error ||
                (failureStatus === "canceled"
                  ? "登录请求已取消或超时，请重新发起登录"
                  : "登录请求处理失败，请重新发起登录"),
            },
          };
        },
        {
          intervalMs: 1_000,
          maxFailures: 5,
          signal: controller.signal,
          timeoutMs: remainingCacheMs,
        },
      );
    };

    void pollLoginJob()
      .then((outcome) => {
        if (controller.signal.aborted) {return;}
        if (outcome.kind === "authenticated") {
          setToken(outcome.token);
          recordAnalyticsEvent("login_success", { method: "friend_code" });
          setPolling(false);
          setJobId("");
          setLoginExpiresAt(0);
          clearPendingFriendLogin();
          notifications.show({
            title: "登录成功",
            message: "欢迎使用 maimai Score Hub！",
            color: "green",
          });
          navigate("/app", { replace: true });
          return;
        }

        resetPendingState();
        recordAnalyticsEvent("login_failed", {
          method: "friend_code",
          status: outcome.status,
        });
        notifications.show({
          title: outcome.status === "canceled" ? "登录请求已结束" : "登录失败",
          message: outcome.message,
          color: "red",
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error instanceof PollAborted) {return;}
        resetPendingState();
        const expired = error instanceof PollTimeout;
        const unavailable = error instanceof PollDead;
        setJobStatus(
          error instanceof Error ? error.message : String(error),
        );
        notifications.show({
          title: expired ? "登录请求已过期" : "登录状态查询失败",
          message: expired
            ? "登录请求已超过 5 分钟，请重新发起登录"
            : unavailable
              ? "多次查询登录状态失败，请检查网络后重试"
              : error instanceof HttpClientError && error.status === 404
                ? "登录任务不存在或已过期，请重新发起登录"
                : error instanceof Error
                  ? error.message
                  : String(error),
          color: "red",
        });
      });

    return () => {
      controller.abort();
    };
  }, [jobId, loginExpiresAt, polling, setToken, navigate]);

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
    setLoginExpiresAt(0);
    clearPendingFriendLogin();

    const trimmedCode = friendCode.trim();
    try {
      localStorage.setItem("lastFriendCode", trimmedCode);
    } catch {
      // localStorage may be unavailable.
    }

    const requestController = new AbortController();
    const requestTimeout = window.setTimeout(
      () => requestController.abort(new Error("创建登录任务超时")), LOGIN_REQUEST_TIMEOUT_MS,
    );
    try {
      const res = await authApi.loginRequest({
        body: {
          friendCode: trimmedCode,
          method: loginMethod,
        },
        fetchOptions: { signal: requestController.signal },
      });

      if (res.status !== 201 || !res.body) {
        notifications.show({
          title: "创建登录任务失败",
          message: `HTTP ${res.status}`,
          color: "red",
        });
        return;
      }

      const body = res.body as LoginRequestBody;
      if (body.skipAuth) {
        const directToken = String(body.token ?? "");
        if (!directToken) {
          throw new Error("登录响应缺少凭证");
        }
        setToken(directToken);
        recordAnalyticsEvent("login_success", { method: "skip_auth" });
        notifications.show({
          title: "登录成功",
          message: "已跳过验证直接登录",
          color: "green",
        });
        navigate("/app", { replace: true });
        return;
      }

      if (typeof body.jobId !== "string" || !body.jobId) {
        throw new Error("创建登录任务成功，但响应中缺少任务编号");
      }

      const botFriendCode = String(body.botFriendCode ?? "");
      const createdAt = String(body.createdAt ?? body.job?.createdAt ?? "");
      const pending = persistPendingFriendLogin(
        body.jobId,
        botFriendCode,
        createdAt,
      );
      setJobId(body.jobId);
      setAssignedBotFriendCode(botFriendCode);
      setLoginCreatedAt(createdAt);
      setLoginExpiresAt(pending.expiresAt);
      setJobStage(String(body.job?.stage ?? ""));
      setJobStatusValue(String(body.job?.status ?? "queued"));
      setPolling(true);
    } catch (error) {
      clearPendingFriendLogin();
      notifications.show({
        title: "创建登录任务失败",
        message: error instanceof Error ? error.message : String(error),
        color: "red",
      });
    } finally {
      window.clearTimeout(requestTimeout);
      setLoading(false);
    }
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

  const startPasskeyLogin = async () => {
    if (!browserSupportsWebAuthn()) {
      notifications.show({
        title: "当前浏览器不支持网站密钥",
        message: "请使用最新版 Chrome、Edge、Safari 或 Firefox。",
        color: "yellow",
      });
      return;
    }

    setPasskeyLoginLoading(true);
    try {
      const optionsResult = await authApi.passkeyOptions({ body: undefined });
      if (optionsResult.status !== 200) {
        const body = optionsResult.body as {
          message?: string;
          error?: string;
        };
        throw new Error(
          body?.message || body?.error || `HTTP ${optionsResult.status}`,
        );
      }

      const response = await startAuthentication({
        optionsJSON: optionsResult.body
          .options as PublicKeyCredentialRequestOptionsJSON,
      });
      const verifyResult = await authApi.passkeyVerify({
        body: {
          ceremonyId: optionsResult.body.ceremonyId,
          response,
        },
      });
      if (verifyResult.status !== 200 || !verifyResult.body?.token) {
        const body = verifyResult.body as {
          message?: string;
          error?: string;
        };
        throw new Error(
          body?.message || body?.error || `HTTP ${verifyResult.status}`,
        );
      }

      persistLastLoginAccount(verifyResult.body.user);
      setToken(String(verifyResult.body.token));
      recordAnalyticsEvent("login_success", { method: "passkey" });
      notifications.show({
        title: "登录成功",
        message: "欢迎使用 maimai Score Hub！",
        color: "green",
      });
      navigate("/app", { replace: true });
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        return;
      }
      notifications.show({
        title: "网站密钥登录失败",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      });
    } finally {
      setPasskeyLoginLoading(false);
    }
  };

  const wakeLoginJob = async () => {
    if (!jobId) {throw new Error("登录任务不存在或已过期");}

    const res = await authApi.verifyLoginRequest({
      params: { jobId },
      body: undefined,
    });
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}`);
    }

    const job = (res.body as { job?: LoginJobStatus } | null)?.job;
    const stage = job?.stage;
    if (stage) {setJobStage(String(stage));}
    if (job?.friendRequestSentAt) {
      setFriendRequestSentAt(String(job.friendRequestSentAt));
    }
    setPolling(true);
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
        className="msh-login-main"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        <Box
          visibleFrom="sm"
          py="lg"
          px="md"
          style={{
            backgroundColor: headerBg,
          }}
        >
          <Container size="sm" style={{ maxWidth: 600, width: "100%" }}>
            <PageHeader
              title={"欢迎！"}
              description={
                androidLoginAvailable
                  ? "选择微信、好友码、账号密码、二维码或网站密钥登录"
                  : "选择好友码、账号密码、二维码或网站密钥登录"
              }
            />
          </Container>
        </Box>

        <Box p="0" mt="lg">
          <Container size="sm" style={{ maxWidth: 600, width: "100%" }}>
            <Stack gap="lg">
              {profile && <ProfileCard profile={profile} />}

              {jobStage === "wait_acceptance" ? (
                <FriendRequestAcceptanceAlert
                  key={jobId}
                  friendRequestSentAt={friendRequestSentAt}
                  onVerify={wakeLoginJob}
                  disabled={!jobId}
                />
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
                      <FriendRequestVerificationButton
                        key={jobId}
                        disabled={!jobId || jobStage === "accept_request"}
                        onVerify={wakeLoginJob}
                        idleLabel="我已发送请求"
                      />
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
                  <Tabs
                    value={loginType}
                    onChange={(value) => {
                      if (!isLoginType(value)) {return;}
                      setLoginType(value);
                      persistLoginType(value);
                    }}
                    keepMounted={false}
                    styles={{
                      list: { flexWrap: "nowrap" },
                      tab: {
                        minWidth: 0,
                        paddingInline: 4,
                        fontSize: "clamp(0.75rem, 3.2vw, 0.875rem)",
                      },
                    }}
                  >
                    <Tabs.List grow>
                      {androidLoginAvailable && (
                        <Tabs.Tab value="android">
                          <Group gap={2} wrap="nowrap" justify="center">
                            <IconBrandWechat
                              className="msh-login-tab-icon"
                              size={14}
                            />
                            <span>微信</span>
                          </Group>
                        </Tabs.Tab>
                      )}
                      <Tabs.Tab
                        value="friendCode"
                      >
                        <Group gap={2} wrap="nowrap" justify="center">
                          <IconId className="msh-login-tab-icon" size={14} />
                          <span>好友码</span>
                        </Group>
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="password"
                      >
                        <Group gap={2} wrap="nowrap" justify="center">
                          <IconUser className="msh-login-tab-icon" size={14} />
                          <span>账号密码</span>
                        </Group>
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="qr"
                      >
                        <Group gap={2} wrap="nowrap" justify="center">
                          <IconQrcode className="msh-login-tab-icon" size={14} />
                          <span>二维码</span>
                        </Group>
                      </Tabs.Tab>
                      <Tabs.Tab value="passkey">
                        <Group gap={2} wrap="nowrap" justify="center">
                          <IconKey className="msh-login-tab-icon" size={14} />
                          <span>网站密钥</span>
                        </Group>
                      </Tabs.Tab>
                    </Tabs.List>

                    {androidLoginAvailable && (
                      <Tabs.Panel value="android" pt="md">
                        <AndroidAutoLoginPanel />
                      </Tabs.Panel>
                    )}

                    <Tabs.Panel value="friendCode" pt="md">
                      <AppCard>
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
                              disabled={
                                polling || qrBusy || passkeyLoginLoading
                              }
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
                                disabled={
                                  polling || qrBusy || passkeyLoginLoading
                                }
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
                                disabled={
                                  polling || qrBusy || passkeyLoginLoading
                                }
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

                          <Group grow w="100%" gap="sm">
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
                                leftSection={<IconWifiOff size={16} />}
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
                      </AppCard>
                    </Tabs.Panel>

                    <Tabs.Panel value="password" pt="md">
                      <AppCard>
                        <Stack gap="md">
                          <Stack gap={6}>
                            <Text size="sm" fw={500}>
                              账号类型
                            </Text>
                            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
                              <IdentifierCard
                                active={passwordLoginIdentifier === "username"}
                                disabled={
                                  polling ||
                                  qrBusy ||
                                  passwordLoginLoading ||
                                  passkeyLoginLoading
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
                                  polling ||
                                  qrBusy ||
                                  passwordLoginLoading ||
                                  passkeyLoginLoading
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
                                polling ||
                                qrBusy ||
                                passwordLoginLoading ||
                                passkeyLoginLoading
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
                                polling ||
                                qrBusy ||
                                passwordLoginLoading ||
                                passkeyLoginLoading
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
                            disabled={
                              polling ||
                              qrBusy ||
                              passwordLoginLoading ||
                              passkeyLoginLoading
                            }
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
                        </Stack>
                      </AppCard>
                    </Tabs.Panel>

                    <Tabs.Panel value="qr" pt="md">
                      <AppCard>
                        <QrLoginForm
                          onSuccess={(t) => {
                            setToken(t);
                            recordAnalyticsEvent("login_success", {
                              method: "qr",
                            });
                            navigate("/");
                          }}
                          onBusyChange={setQrBusy}
                          disabled={polling || passkeyLoginLoading}
                        />
                      </AppCard>
                    </Tabs.Panel>

                    <Tabs.Panel value="passkey" pt="md">
                      <AppCard>
                        <Stack gap="md">
                          <Text size="sm" c="dimmed">
                            使用指纹、面容、设备 PIN
                            或实体安全密钥登录，无需输入用户名和密码。
                          </Text>
                          {!browserSupportsWebAuthn() && (
                            <Alert
                              color="yellow"
                              title="当前浏览器不支持网站密钥"
                            >
                              请升级浏览器，或使用其他登录方式。
                            </Alert>
                          )}
                          <Button
                            onClick={() => void startPasskeyLogin()}
                            loading={passkeyLoginLoading}
                            disabled={
                              !browserSupportsWebAuthn() ||
                              polling ||
                              qrBusy ||
                              passwordLoginLoading
                            }
                            leftSection={<IconKey size={16} />}
                          >
                            使用网站密钥登录
                          </Button>
                        </Stack>
                      </AppCard>
                    </Tabs.Panel>
                  </Tabs>

                  {loginType !== "android" && <FriendCodeGuide />}
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
