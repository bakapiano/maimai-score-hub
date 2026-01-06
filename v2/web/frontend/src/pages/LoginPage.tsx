import {
  Alert,
  AppShell,
  Box,
  Button,
  Center,
  Checkbox,
  Code,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
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
  const [health, setHealth] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobStatus, setJobStatus] = useState("");
  const [polling, setPolling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);

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
          message: "Token 已保存到本地，正在跳转...",
          color: "green",
        });
        navigate("/app", { replace: true });
      } else if (res.data?.status === "failed") {
        setPolling(false);
        notifications.show({
          title: "登录失败",
          message: String(res.data?.job?.error || "未知错误"),
          color: "red",
        });
      }
    }, 1400);

    return () => clearInterval(handle);
  }, [jobId, polling, setToken, navigate]);

  const startLogin = async () => {
    setLoading(true);
    setJobStatus("");
    setJobId("");
    setPolling(false);
    setProfile(null);

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
          <Text fw={700}>NetBot 控制台</Text>
          <ColorSchemeToggle />
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Center h="100%">
          <Container size="sm" py="xl">
            <Stack gap="lg">
              <div>
                <Title order={2}>NetBot 登录</Title>
                <Text c="dimmed" size="sm">
                  输入 friendCode，创建登录任务并轮询状态，拿到 token
                  后会自动保存并跳转。
                </Text>
              </div>

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

                  {/* <Checkbox
                  label="Skip Update Score"
                  checked={skipUpdateScore}
                  onChange={(e) => setSkipUpdateScore(e.currentTarget.checked)}
                /> */}

                  <Group justify="center" gap="sm">
                    <Button
                      onClick={startLogin}
                      disabled={!canLogin}
                      loading={loading || polling}
                    >
                      下一步
                    </Button>
                  </Group>

                  {profile && <ProfileCard profile={profile} />}
                </Stack>
              </Paper>
            </Stack>
          </Container>
        </Center>
      </AppShell.Main>
    </AppShell>
  );
}
