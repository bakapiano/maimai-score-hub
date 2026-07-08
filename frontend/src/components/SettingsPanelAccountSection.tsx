import { Box, Button, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import {
  IconCopy,
  IconLogin,
  IconLogout,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { notifications } from "@mantine/notifications";
import { useAuth } from "../providers/AuthContext";
import { useNavigate } from "react-router-dom";
import { usersApi } from "../api/appClient";

type AccountSettingsSectionProps = {
  onClose: () => void;
};

type SaveValidationInput = {
  accountHasPassword: boolean;
  currentPassword: string;
  normalizedUsername: string;
  passwordChanged: boolean;
  trimmedUsername: string;
  usernameChanged: boolean;
};

type PasswordUpdateBody = {
  username?: string;
  currentPassword?: string;
  newPassword?: string;
};

function getSaveValidationError(input: SaveValidationInput) {
  if (!input.usernameChanged && !input.passwordChanged) {
    return { color: "yellow", message: "没有需要保存的更改" };
  }
  if (input.usernameChanged && !input.trimmedUsername) {
    return {
      color: "red",
      title: "用户名不能为空",
      message: "如需修改用户名，请输入 3-32 位英文字母、数字或下划线。",
    };
  }
  if (!input.accountHasPassword && !input.passwordChanged) {
    return {
      color: "red",
      title: "请先设置密码",
      message: "首次设置用户名时也需要同时设置密码。",
    };
  }
  if (input.accountHasPassword && !input.currentPassword) {
    return {
      color: "red",
      title: "请输入当前密码",
      message: "修改用户名或密码需要验证当前密码。",
    };
  }
  return null;
}

function buildPasswordUpdateBody(input: {
  currentPassword: string;
  newPassword: string;
  normalizedUsername: string;
  passwordChanged: boolean;
  usernameChanged: boolean;
}) {
  const body: PasswordUpdateBody = {};
  if (input.usernameChanged && input.normalizedUsername) {
    body.username = input.normalizedUsername;
  }
  if (input.currentPassword) {
    body.currentPassword = input.currentPassword;
  }
  if (input.passwordChanged) {
    body.newPassword = input.newPassword;
  }
  return body;
}

function getResponseMessage(
  responseBody: { message?: string | { message?: string }; error?: string },
  status: number,
) {
  return (
    (typeof responseBody?.message === "object" &&
      responseBody.message?.message) ||
    (typeof responseBody?.message === "string" && responseBody.message) ||
    responseBody?.error ||
    `HTTP ${status}`
  );
}

function clearDeletedAccountStorage() {
  try {
    localStorage.removeItem("netbot_token");
    localStorage.removeItem("lastFriendCode");
    localStorage.removeItem("lastUsername");
    localStorage.removeItem("pendingLoginJobId");
  } catch {
    // localStorage may be unavailable.
  }
}

function persistLastUsername(username: string) {
  try {
    if (username) {
      localStorage.setItem("lastUsername", username);
    }
  } catch {
    // localStorage may be unavailable.
  }
}

function copyQuickLoginLink() {
  const friendCode = localStorage.getItem("lastFriendCode");
  if (!friendCode) {
    notifications.show({
      title: "无法生成链接",
      message: "未找到好友代码信息",
      color: "red",
    });
    return;
  }

  const url = `${window.location.origin}/login?friendCode=${friendCode}`;
  void navigator.clipboard.writeText(url);
  notifications.show({
    title: "链接已复制",
    message: "从此链接进入可自动填写好友代码",
    color: "teal",
  });
}

function OfflineAccountActions({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: () => void;
}) {
  return (
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
          onLogin();
          onClose();
        }}
      >
        前往登录
      </Button>
    </>
  );
}

function PasswordSettingsForm({
  accountHasPassword,
  accountUsername,
  currentPassword,
  newPassword,
  savingPassword,
  onAccountUsernameChange,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onSavePassword,
}: {
  accountHasPassword: boolean;
  accountUsername: string;
  currentPassword: string;
  newPassword: string;
  savingPassword: boolean;
  onAccountUsernameChange: (value: string) => void;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onSavePassword: () => void;
}) {
  return (
    <Stack gap="xs">
      <TextInput
        label="自定义用户名"
        placeholder="可选，用于密码登录"
        value={accountUsername}
        onChange={(event) => onAccountUsernameChange(event.currentTarget.value)}
      />
      {accountHasPassword && (
        <PasswordInput
          label="当前密码"
          value={currentPassword}
          onChange={(event) => onCurrentPasswordChange(event.currentTarget.value)}
          placeholder="修改用户名或密码时必填"
        />
      )}
      <PasswordInput
        label={accountHasPassword ? "新密码" : "设置密码"}
        value={newPassword}
        onChange={(event) => onNewPasswordChange(event.currentTarget.value)}
        placeholder={accountHasPassword ? "不修改密码可留空" : "至少 8 位"}
      />
      <Button
        variant="light"
        color="teal"
        fullWidth
        loading={savingPassword}
        onClick={onSavePassword}
      >
        保存登录设置
      </Button>
      <Text size="xs" c="dimmed">
        保存后可使用好友码或自定义用户名 + 密码登录。用户名可修改，但需要当前密码。
      </Text>
    </Stack>
  );
}

function DeleteAccountBox({
  deletingAccount,
  onDeleteAccount,
}: {
  deletingAccount: boolean;
  onDeleteAccount: () => void;
}) {
  return (
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
          onClick={onDeleteAccount}
        >
          删除我的账号
        </Button>
      </Stack>
    </Box>
  );
}

export function AccountSettingsSection({ onClose }: AccountSettingsSectionProps) {
  const { token, clearToken, offline, setOffline } = useAuth();
  const navigate = useNavigate();
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [accountUsername, setAccountUsername] = useState("");
  const [initialUsername, setInitialUsername] = useState("");
  const [accountHasPassword, setAccountHasPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!token || offline) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const res = await usersApi.profile({
        headers: { authorization: `Bearer ${token}` },
      });
      if (cancelled || res.status !== 200) {
        return;
      }
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
  }, [token, offline]);

  if (!token && !offline) {
    return null;
  }

  const handleDeleteAccount = async () => {
    if (!token) {
      return;
    }
    const confirmed = window.confirm(
      "确定要永久删除你的账号和所有相关数据吗？\n\n此操作不可撤销。",
    );
    if (!confirmed) {
      return;
    }
    const sure = window.confirm(
      "再次确认：删除后你的成绩同步记录、所有更新任务都会一并消失。\n\n继续？",
    );
    if (!sure) {
      return;
    }

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
      clearDeletedAccountStorage();
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
    if (!token) {
      return;
    }

    const trimmedUsername = accountUsername.trim();
    const normalizedUsername = trimmedUsername.toLowerCase();
    const usernameChanged = normalizedUsername !== initialUsername;
    const passwordChanged = newPassword.length > 0;
    const validationError = getSaveValidationError({
      accountHasPassword,
      currentPassword,
      normalizedUsername,
      passwordChanged,
      trimmedUsername,
      usernameChanged,
    });

    if (validationError) {
      notifications.show(validationError);
      return;
    }

    setSavingPassword(true);
    try {
      const res = await usersApi.setPassword({
        headers: { authorization: `Bearer ${token}` },
        body: buildPasswordUpdateBody({
          currentPassword,
          newPassword,
          normalizedUsername,
          passwordChanged,
          usernameChanged,
        }),
      });

      if (res.status !== 200) {
        const responseBody = res.body as {
          message?: string | { message?: string };
          error?: string;
        };
        notifications.show({
          color: "red",
          title: "保存失败",
          message: getResponseMessage(responseBody, res.status),
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
      persistLastUsername(savedUsername);
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

  const goToLogin = () => {
    setOffline(false);
    navigate("/login", { replace: true });
  };

  return (
    <>
      <div>
        <Text size="sm" fw={500} mb="xs">
          账号
        </Text>
        <Stack gap="xs">
          {offline ? (
            <OfflineAccountActions onClose={onClose} onLogin={goToLogin} />
          ) : (
            <>
              <PasswordSettingsForm
                accountHasPassword={accountHasPassword}
                accountUsername={accountUsername}
                currentPassword={currentPassword}
                newPassword={newPassword}
                savingPassword={savingPassword}
                onAccountUsernameChange={setAccountUsername}
                onCurrentPasswordChange={setCurrentPassword}
                onNewPasswordChange={setNewPassword}
                onSavePassword={handleSavePassword}
              />
              <Button
                variant="light"
                color="blue"
                fullWidth
                leftSection={<IconCopy size={16} />}
                onClick={copyQuickLoginLink}
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
      {token && !offline && (
        <DeleteAccountBox
          deletingAccount={deletingAccount}
          onDeleteAccount={handleDeleteAccount}
        />
      )}
    </>
  );
}
