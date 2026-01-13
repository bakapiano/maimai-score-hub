import {
  Alert,
  AppShell,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Progress,
  Checkbox,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

import { ProfileCard, type UserProfile } from "../components/ProfileCard";
import { ColorSchemeToggle } from "../components/ColorSchemeToggle";
import { notifications } from "@mantine/notifications";
import { useAuth } from "../providers/AuthProvider";
import { useNavigate } from "react-router-dom";

type LoginRequest = { jobId: string; userId: string };

type LoginStatus = {
  status?: string;
  token?: string;
  profile?: UserProfile;
  job?: { profile?: UserProfile; [key: string]: unknown };
  error?: string | null;
  [key: string]: unknown;
};

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}

export default function LoginPage() {
  const navigate = useNavigate();
  const { token, setToken } = useAuth();

  const [friendCode, setFriendCode] = useState(() => {
    try {
      return localStorage.getItem("lastFriendCode") || "";
    } catch {
      return "";
    }
  });
  const [skipUpdateScore, setSkipUpdateScore] = useState(true);
  const [_health, setHealth] = useState("");
  const [jobId, setJobId] = useState("");
  const [_jobStatus, setJobStatus] = useState("");
  const [polling, setPolling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [jobStage, setJobStage] = useState("");
  const [friendRequestSentAt, setFriendRequestSentAt] = useState("");
  const [jobCreatedAd, setJobCreatedAt] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);

  const totalWaitSeconds = 60;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / totalWaitSeconds) * 100)
  );

  const canLogin = useMemo(
    () => /^\d{15}$/.test(friendCode.trim()) && !loading,
    [friendCode, loading]
  );

  useEffect(() => {
    if (token) {
      navigate("/app", { replace: true });
    }
  }, [token, navigate]);

  useEffect(() => {
    (async () => {
      const res = await fetchJson<{ status?: string }>("/api/health");
      setHealth(res.ok ? JSON.stringify(res.data) : `HTTP ${res.status}`);
    })();
  }, []);

  useEffect(() => {
    if (!jobId || polling === false) return;

    const handle = setInterval(async () => {
      const res = await fetchJson<LoginStatus>(
        `/api/auth/login-status?jobId=${jobId}`
      );

      if (!res.ok) {
        setJobStatus(`HTTP ${res.status}`);
        return;
      }

      setJobStatus(JSON.stringify(res.data, null, 2));

      const stage = (res.data as any)?.job?.stage;
      if (stage) setJobStage(stage);

      const sentAt = (res.data as any)?.job?.friendRequestSentAt;
      if (sentAt) setFriendRequestSentAt(sentAt);

      const createdAt = (res.data as any)?.job?.createdAt;
      if (createdAt) setJobCreatedAt(createdAt);

      const profileFromStatus =
        (res.data as LoginStatus)?.profile ??
        (res.data as LoginStatus)?.job?.profile ??
        null;
      if (profileFromStatus) {
        setProfile(profileFromStatus);
      }

      if (res.data?.status === "completed" && res.data?.token) {
        setToken(res.data.token);
        setPolling(false);
        notifications.show({
          title: "登录成功",
          message: "欢迎使用 maimai DX Copilot！",
          color: "green",
        });
        navigate("/app", { replace: true });
      } else if (res.data?.status === "failed") {
        setPolling(false);
        setJobStage("");
        setProfile(null);
        notifications.show({
          title: "登录失败",
          message: String(res.data?.job?.error || "未知错误"),
          color: "red",
        });
      }
    }, 1400);

    return () => clearInterval(handle);
  }, [jobId, polling, setToken, navigate]);

  useEffect(() => {
    if (jobStage !== "wait_acceptance" || !jobCreatedAd) {
      if (timeLeft !== 0) setTimeLeft(0);
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const created = new Date(jobCreatedAd).getTime();
      const end = created + 60 * 1000;
      const left = Math.max(0, Math.ceil((end - now) / 1000));
      setTimeLeft(left);
    }, 500);

    return () => clearInterval(interval);
  }, [jobStage, jobCreatedAd]);

  const startLogin = async () => {
    setLoading(true);
    setJobStatus("");
    setJobId("");
    setPolling(false);
    setProfile(null);
    setJobStage("");
    setFriendRequestSentAt("");
    setJobCreatedAt(null);
    setTimeLeft(0);

    const trimmedCode = friendCode.trim();
    try {
      localStorage.setItem("lastFriendCode", trimmedCode);
    } catch {}

    const res = await fetchJson<LoginRequest>("/api/auth/login-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        friendCode: trimmedCode,
        skipUpdateScore,
      }),
    });

    if (res.ok && res.data) {
      setJobId(res.data.jobId);
      setPolling(true);
      // notifications.show({
      //   title: "登录请求已创建",
      //   message: `好友代码：${trimmedCode}，正在轮询登录状态...`,
      // });
    } else {
      setJobStatus(`Login request failed (HTTP ${res.status})`);
    }

    setLoading(false);
  };

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>maimai DX Copilot</Text>
          <ColorSchemeToggle />
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Center h="100%">
          <Container size="sm" py="xl" style={{ maxWidth: 480, width: "100%" }}>
            <Stack gap="lg">
              <div>
                {jobStage === "wait_acceptance" ? (
                  <Title order={2}>欢迎回来！</Title>
                ) : (
                  <>
                    <Title order={2}>登录</Title>
                    {/* <Text c="dimmed" size="sm">
                      输入 friendCode，创建登录任务并轮询状态，拿到 token
                      后会自动保存并跳转。
                    </Text> */}
                  </>
                )}
              </div>

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
                      mt="sm"
                    >
                      <Stack gap="sm">
                        <Text size="sm">
                          Bot 已发送好友申请，请登录 NET
                          并在核对时间一致后同意好友申请。
                        </Text>
                        <Text size="sm" c="red" fw={700}>
                          若申请时间不是 {friendRequestSentAt}
                          ，请勿接受，可能是他人尝试登录！
                        </Text>
                        <Progress.Root size="xl" mt={4}>
                          <Progress.Section
                            animated
                            value={remainingPercent}
                            title={`${timeLeft} 秒后过期`}
                            // radius=""
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
                <Paper shadow="xs" p="lg" radius="md" withBorder>
                  <Stack gap="md">
                    <TextInput
                      label="好友代码"
                      placeholder="请输入 NET 好友代码，例如 634142510810999"
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
                    />

                    <Checkbox
                      label="更新成绩数据"
                      checked={!skipUpdateScore}
                      onChange={(e) =>
                        setSkipUpdateScore(!e.currentTarget.checked)
                      }
                      disabled={polling}
                    />

                    <Group justify="center" gap="sm">
                      <Button
                        onClick={startLogin}
                        disabled={!canLogin}
                        loading={loading || polling}
                      >
                        下一步
                      </Button>
                    </Group>
                  </Stack>
                </Paper>
              )}
            </Stack>
          </Container>
        </Center>
      </AppShell.Main>
    </AppShell>
  );
}
