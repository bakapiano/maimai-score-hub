import {
  Box,
  Button,
  Drawer,
  Group,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconCopy,
  IconDeviceDesktop,
  IconLogin,
  IconLogout,
  IconMoon,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { notifications } from "@mantine/notifications";
import { useAuth } from "../providers/AuthProvider";
import { InstallAppButton } from "./InstallAppButton";
import { usePwaInstall } from "../hooks/usePwaInstall";
import { useNavigate } from "react-router-dom";
import { usersApi } from "../api/appClient";

type Props = {
  opened: boolean;
  onClose: () => void;
};

function InstallAppSettingsSection() {
  const { status } = usePwaInstall();

  if (status === "installed" || status === "unavailable") return null;

  return (
    <div>
      <Text size="sm" fw={500} mb="xs">
        应用
      </Text>
      <InstallAppButton fullWidth />
      {status === "ios" && (
        <Text size="xs" c="dimmed" mt={4}>
          iOS 请使用浏览器分享菜单添加到主屏幕
        </Text>
      )}
    </div>
  );
}

export function SettingsPanel({ opened, onClose }: Props) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { token, clearToken, offline, setOffline } = useAuth();
  const navigate = useNavigate();
  const touchStartX = useRef<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [accountUsername, setAccountUsername] = useState("");
  const [initialUsername, setInitialUsername] = useState("");
  const [accountHasPassword, setAccountHasPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!opened || !token || offline) return;

    let cancelled = false;
    void (async () => {
      const res = await usersApi.profile({
        headers: { authorization: `Bearer ${token}` },
      });
      if (cancelled || res.status !== 200) return;
      const body = res.body as {
        username?: string | null;
        hasPassword?: boolean;
      };
      const username = body.username ?? "";
      setAccountUsername(username);
      setInitialUsername(username);
      setAccountHasPassword(!!body.hasPassword);
    })();

    return () => {
      cancelled = true;
    };
  }, [opened, token, offline]);

  const handleDeleteAccount = async () => {
    if (!token) return;
    const confirmed = window.confirm(
      "确定要永久删除你的账号和所有相关数据吗？\n\n此操作不可撤销。",
    );
    if (!confirmed) return;
    const sure = window.confirm(
      "再次确认：删除后你的成绩同步记录、所有更新任务都会一并消失。\n\n继续？",
    );
    if (!sure) return;

    setDeletingAccount(true);
    try {
      const res = await fetch("/api/v1/me", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) {
        notifications.show({
          color: "red",
          title: "删除失败",
          message: json?.message ?? json?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const d = json?.deleted ?? {};
      notifications.show({
        color: "green",
        title: "账号已删除",
        message: `已清除 ${d.user ?? 0} 用户、${d.syncs ?? 0} 同步记录、${d.jobs ?? 0} 任务。`,
      });
      // Tear down local session and bounce to login.
      try {
        localStorage.removeItem("netbot_token");
        localStorage.removeItem("lastFriendCode");
        localStorage.removeItem("lastUsername");
        localStorage.removeItem("pendingLoginJobId");
      } catch {
        // ignore
      }
      clearToken();
      onClose();
      navigate("/login", { replace: true });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "删除失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingAccount(false);
    }
  };

  const handleLogout = () => {
    if (offline) {
      setOffline(false);
    }
    clearToken();
    onClose();
    navigate("/login", { replace: true });
  };

  const handleSavePassword = async () => {
    if (!token) return;

    const trimmedUsername = accountUsername.trim();
    const normalizedUsername = trimmedUsername.toLowerCase();
    const usernameChanged = normalizedUsername !== initialUsername;
    const passwordChanged = newPassword.length > 0;

    if (!usernameChanged && !passwordChanged) {
      notifications.show({
        color: "yellow",
        message: "没有需要保存的更改",
      });
      return;
    }
    if (usernameChanged && !trimmedUsername) {
      notifications.show({
        color: "red",
        title: "用户名不能为空",
        message: "如需修改用户名，请输入 3-32 位英文字母、数字或下划线。",
      });
      return;
    }
    if (!accountHasPassword && !passwordChanged) {
      notifications.show({
        color: "red",
        title: "请先设置密码",
        message: "首次设置用户名时也需要同时设置密码。",
      });
      return;
    }
    if (accountHasPassword && !currentPassword) {
      notifications.show({
        color: "red",
        title: "请输入当前密码",
        message: "修改用户名或密码需要验证当前密码。",
      });
      return;
    }

    setSavingPassword(true);
    try {
      const body: {
        username?: string;
        currentPassword?: string;
        newPassword?: string;
      } = {};
      if (usernameChanged && normalizedUsername) body.username = normalizedUsername;
      if (currentPassword) body.currentPassword = currentPassword;
      if (passwordChanged) body.newPassword = newPassword;

      const res = await usersApi.setPassword({
        headers: { authorization: `Bearer ${token}` },
        body,
      });

      if (res.status !== 200) {
        const responseBody = res.body as {
          message?: string | { message?: string };
          error?: string;
        };
        const message =
          (typeof responseBody?.message === "object" &&
            responseBody.message?.message) ||
          (typeof responseBody?.message === "string" && responseBody.message) ||
          responseBody?.error ||
          `HTTP ${res.status}`;
        notifications.show({
          color: "red",
          title: "保存失败",
          message,
        });
        return;
      }

      const responseBody = res.body as {
        username?: string | null;
        hasPassword?: boolean;
      };
      const savedUsername = responseBody.username ?? "";
      setAccountUsername(savedUsername);
      setInitialUsername(savedUsername);
      setAccountHasPassword(!!responseBody.hasPassword);
      try {
        if (savedUsername) localStorage.setItem("lastUsername", savedUsername);
      } catch {
        // ignore
      }
      setCurrentPassword("");
      setNewPassword("");
      notifications.show({
        color: "green",
        message: "账号登录设置已保存",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "保存失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingPassword(false);
    }
  };

  const handleClearCache = () => {
    setClearing(true);
    try {
      const token = localStorage.getItem("netbot_token");
      const offlineMode = localStorage.getItem("offline_mode");
      const cachedProfile = localStorage.getItem("offline_cache_profile");
      const cachedSync = localStorage.getItem("offline_cache_sync_latest");
      localStorage.clear();
      if (token) localStorage.setItem("netbot_token", token);
      if (offlineMode) localStorage.setItem("offline_mode", offlineMode);
      if (cachedProfile)
        localStorage.setItem("offline_cache_profile", cachedProfile);
      if (cachedSync)
        localStorage.setItem("offline_cache_sync_latest", cachedSync);
      window.location.reload();
    } catch (err) {
      console.error("Failed to clear cache", err);
      setClearing(false);
    }
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="网站设置"
      position="right"
      size="sm"
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const startX = touchStartX.current;
        touchStartX.current = null;
        if (startX === null) return;
        const endX = event.changedTouches[0]?.clientX ?? startX;
        if (endX - startX > 50) {
          onClose();
        }
      }}
    >
      <Box style={{ height: "100%" }}>
        <Stack gap="lg">
          <div>
            <Text size="sm" fw={500} mb="xs">
              外观
            </Text>
            <SegmentedControl
              fullWidth
              value={colorScheme}
              onChange={(value) =>
                setColorScheme(value as "light" | "dark" | "auto")
              }
              data={[
                {
                  value: "light",
                  label: (
                    <Group gap={6} justify="center">
                      <IconSun size={16} />
                      <span>浅色</span>
                    </Group>
                  ),
                },
                {
                  value: "dark",
                  label: (
                    <Group gap={6} justify="center">
                      <IconMoon size={16} />
                      <span>深色</span>
                    </Group>
                  ),
                },
                {
                  value: "auto",
                  label: (
                    <Group gap={6} justify="center">
                      <IconDeviceDesktop size={16} />
                      <span>跟随系统</span>
                    </Group>
                  ),
                },
              ]}
            />
          </div>

          <InstallAppSettingsSection />

          <div>
            <Text size="sm" fw={500} mb="xs">
              缓存
            </Text>
            <Button
              variant="light"
              color="red"
              fullWidth
              leftSection={<IconTrash size={16} />}
              onClick={handleClearCache}
              loading={clearing}
            >
              清除本地缓存
            </Button>
            <Text size="xs" c="dimmed" mt={4}>
              清除所有本地缓存数据
            </Text>
          </div>

          {(token || offline) && (
            <div>
              <Text size="sm" fw={500} mb="xs">
                账号
              </Text>
              <Stack gap="xs">
                {offline ? (
                  <>
                    <Text size="xs" c="dimmed">
                      当前处于离线模式
                    </Text>
                    <Button
                      variant="light"
                      color="blue"
                      fullWidth
                      leftSection={<IconLogin size={16} />}
                      onClick={() => {
                        setOffline(false);
                        onClose();
                        navigate("/login", { replace: true });
                      }}
                    >
                      前往登录
                    </Button>
                  </>
                ) : (
                  <>
                    <Stack gap="xs">
                      <TextInput
                        label="自定义用户名"
                        placeholder="可选，用于密码登录"
                        value={accountUsername}
                        onChange={(event) =>
                          setAccountUsername(event.currentTarget.value)
                        }
                      />
                      {accountHasPassword && (
                        <PasswordInput
                          label="当前密码"
                          value={currentPassword}
                          onChange={(event) =>
                            setCurrentPassword(event.currentTarget.value)
                          }
                          placeholder="修改用户名或密码时必填"
                        />
                      )}
                      <PasswordInput
                        label={accountHasPassword ? "新密码" : "设置密码"}
                        value={newPassword}
                        onChange={(event) =>
                          setNewPassword(event.currentTarget.value)
                        }
                        placeholder={
                          accountHasPassword ? "不修改密码可留空" : "至少 8 位"
                        }
                      />
                      <Button
                        variant="light"
                        color="teal"
                        fullWidth
                        loading={savingPassword}
                        onClick={handleSavePassword}
                      >
                        保存登录设置
                      </Button>
                      <Text size="xs" c="dimmed">
                        保存后可使用好友码或自定义用户名 + 密码登录。用户名可修改，但需要当前密码。
                      </Text>
                    </Stack>
                    <Button
                      variant="light"
                      color="blue"
                      fullWidth
                      leftSection={<IconCopy size={16} />}
                      onClick={() => {
                        const friendCode =
                          localStorage.getItem("lastFriendCode");
                        if (friendCode) {
                          const url = `${window.location.origin}/login?friendCode=${friendCode}`;
                          navigator.clipboard.writeText(url);
                          notifications.show({
                            title: "链接已复制",
                            message: "从此链接进入可自动填写好友代码",
                            color: "teal",
                          });
                        } else {
                          notifications.show({
                            title: "无法生成链接",
                            message: "未找到好友代码信息",
                            color: "red",
                          });
                        }
                      }}
                    >
                      快速登录链接
                    </Button>
                    <Button
                      variant="light"
                      color="gray"
                      fullWidth
                      leftSection={<IconLogout size={16} />}
                      onClick={handleLogout}
                    >
                      退出登录
                    </Button>
                  </>
                )}
              </Stack>
            </div>
          )}

          {token && !offline && (
            <Box>
              <Text fw={600} size="sm" c="red" mb="xs">
                删除账号数据
              </Text>
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  彻底删除你的账号在网站的所有相关数据，此操作不可撤销。
                </Text>
                <Button
                  variant="filled"
                  color="red"
                  fullWidth
                  leftSection={<IconTrash size={16} />}
                  loading={deletingAccount}
                  onClick={handleDeleteAccount}
                >
                  删除我的账号
                </Button>
              </Stack>
            </Box>
          )}
        </Stack>
      </Box>
    </Drawer>
  );
}
