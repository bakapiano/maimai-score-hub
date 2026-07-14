import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconKey, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import type { PasskeySummary } from "@maimai-score-hub/shared";
import { useEffect, useState } from "react";

import { usersApi } from "../api/appClient";

type PasskeyManagementSectionProps = {
  token: string;
  hasPassword: boolean;
};

function responseMessage(body: unknown, status: number): string {
  const value = body as {
    message?: string | { message?: string };
    error?: string;
  } | null;
  return (
    (typeof value?.message === "object" && value.message?.message) ||
    (typeof value?.message === "string" && value.message) ||
    value?.error ||
    `HTTP ${status}`
  );
}

function formatDate(value: string | null): string {
  if (!value) {
    return "尚未使用";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {return value;}

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 1000),
  );
  let relativeTime = "刚刚";
  if (elapsedSeconds >= 365 * 24 * 60 * 60) {
    relativeTime = `${Math.floor(elapsedSeconds / (365 * 24 * 60 * 60))}年前`;
  } else if (elapsedSeconds >= 30 * 24 * 60 * 60) {
    relativeTime = `${Math.floor(elapsedSeconds / (30 * 24 * 60 * 60))}个月前`;
  } else if (elapsedSeconds >= 24 * 60 * 60) {
    relativeTime = `${Math.floor(elapsedSeconds / (24 * 60 * 60))}天前`;
  } else if (elapsedSeconds >= 60 * 60) {
    relativeTime = `${Math.floor(elapsedSeconds / (60 * 60))}小时前`;
  } else if (elapsedSeconds >= 60) {
    relativeTime = `${Math.floor(elapsedSeconds / 60)}分钟前`;
  }

  return `${date.toLocaleString("zh-CN", { hour12: false })} · ${relativeTime}`;
}

function isUserCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

type UserAgentData = {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ model?: string; platform?: string }>;
};

function detectBrowserName(userAgentData: UserAgentData | undefined) {
  const brands = userAgentData?.brands ?? [];
  if (brands.some(({ brand }) => brand.includes("Microsoft Edge"))) {
    return "Edge";
  }
  if (brands.some(({ brand }) => brand.includes("Google Chrome"))) {
    return "Chrome";
  }

  const userAgent = navigator.userAgent;
  if (/Edg\//.test(userAgent)) {return "Edge";}
  if (/Firefox\/|FxiOS\//.test(userAgent)) {return "Firefox";}
  if (/Chrome\/|CriOS\//.test(userAgent)) {return "Chrome";}
  if (/Safari\//.test(userAgent)) {return "Safari";}
  return "浏览器";
}

function detectDeviceName(
  model: string,
  platform: string,
  userAgentData: UserAgentData | undefined,
) {
  if (model) {return model;}

  const userAgent = navigator.userAgent;
  if (/iPhone/.test(userAgent)) {return "iPhone";}
  if (/iPad/.test(userAgent)) {return "iPad";}
  if (/Android/.test(userAgent)) {
    const modelMatch = userAgent.match(
      /Android [^;]+;\s*([^;)]+?)(?:\s+Build\/|\))/,
    );
    if (modelMatch?.[1]) {return modelMatch[1].trim();}
    return userAgentData?.mobile ? "Android 手机" : "Android 设备";
  }
  if (/Windows/i.test(platform) || /Windows/.test(userAgent)) {
    return "Windows";
  }
  if (/macOS|Mac/i.test(platform) || /Macintosh/.test(userAgent)) {
    return "Mac";
  }
  if (/Chrome OS/i.test(platform) || /CrOS/.test(userAgent)) {
    return "Chromebook";
  }
  if (/Linux/i.test(platform) || /Linux/.test(userAgent)) {return "Linux";}
  return userAgentData?.mobile ? "移动设备" : "当前设备";
}

async function getSuggestedPasskeyName(passkeys: PasskeySummary[]) {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: UserAgentData;
  };
  const userAgentData = navigatorWithUserAgentData.userAgentData;
  let model = "";
  let platform = userAgentData?.platform ?? navigator.platform;

  try {
    const values = await userAgentData?.getHighEntropyValues?.([
      "model",
      "platform",
    ]);
    model = values?.model?.trim() ?? "";
    platform = values?.platform?.trim() || platform;
  } catch {
    model = "";
  }

  const deviceName = detectDeviceName(model, platform, userAgentData);
  const browserName = detectBrowserName(userAgentData);
  const baseName = `${deviceName} · ${browserName}`.slice(0, 50);
  const existingNames = new Set(passkeys.map((passkey) => passkey.name));
  if (!existingNames.has(baseName)) {return baseName;}

  let suffix = 2;
  while (existingNames.has(`${baseName} ${suffix}`)) {
    suffix += 1;
  }
  return `${baseName.slice(0, 47)} ${suffix}`;
}

function PasskeyList({
  passkeys,
  onRename,
  onDelete,
}: {
  passkeys: PasskeySummary[];
  onRename: (passkey: PasskeySummary) => void;
  onDelete: (passkey: PasskeySummary) => void;
}) {
  return (
    <Stack gap="xs">
      {passkeys.map((passkey) => (
        <Paper key={passkey.id} withBorder p="xs" radius="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Box style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Text size="sm" fw={600} truncate>
                  {passkey.name}
                </Text>
                <Badge size="xs" variant="light">
                  {passkey.deviceType === "multiDevice"
                    ? passkey.backedUp
                      ? "已同步"
                      : "可同步"
                    : "单设备"}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                创建日期：{formatDate(passkey.createdAt)}
              </Text>
              <Text size="xs" c="dimmed">
                最近使用：{formatDate(passkey.lastUsedAt)}
              </Text>
            </Box>
            <Group gap={4} wrap="nowrap">
              <Tooltip label="重命名">
                <ActionIcon variant="subtle" onClick={() => onRename(passkey)}>
                  <IconPencil size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="删除">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => onDelete(passkey)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

function PasskeyWarnings({
  hasPassword,
  supported,
  count,
}: {
  hasPassword: boolean;
  supported: boolean;
  count: number;
}) {
  return (
    <>
      {!hasPassword && (
        <Alert color="yellow" mb="xs">
          请先保存账号密码，再创建网站密钥。
        </Alert>
      )}
      {!supported && (
        <Alert color="yellow" mb="xs">
          当前浏览器不支持 WebAuthn，请升级浏览器后重试。
        </Alert>
      )}
      {count >= 10 && (
        <Alert color="yellow" mb="xs">
          已达到每个账号 10 个网站密钥的上限。
        </Alert>
      )}
    </>
  );
}

function PasskeyContent({
  loading,
  passkeys,
  onRename,
  onDelete,
}: {
  loading: boolean;
  passkeys: PasskeySummary[];
  onRename: (passkey: PasskeySummary) => void;
  onDelete: (passkey: PasskeySummary) => void;
}) {
  if (loading) {
    return (
      <Group justify="center" py="sm">
        <Loader size="sm" />
      </Group>
    );
  }
  if (passkeys.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        尚未创建网站密钥。创建后可使用指纹、面容、设备 PIN 或安全密钥登录。
      </Text>
    );
  }
  return (
    <PasskeyList passkeys={passkeys} onRename={onRename} onDelete={onDelete} />
  );
}

export function PasskeyManagementSection({
  token,
  hasPassword,
}: PasskeyManagementSectionProps) {
  const supported = browserSupportsWebAuthn();
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpened, setCreateOpened] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [renameTarget, setRenameTarget] = useState<PasskeySummary | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PasskeySummary | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void usersApi
      .listPasskeys({
        headers: { authorization: `Bearer ${token}` },
      })
      .then((res: { status: number; body: unknown }) => {
        if (cancelled) {
          return;
        }
        if (res.status === 200) {
          setPasskeys(res.body as PasskeySummary[]);
          return;
        }
        notifications.show({
          color: "red",
          title: "读取网站密钥失败",
          message: responseMessage(res.body, res.status),
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          notifications.show({
            color: "red",
            title: "读取网站密钥失败",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const closeCreate = () => {
    if (creating) {
      return;
    }
    setCreateOpened(false);
    setCreateName("");
    setCreatePassword("");
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name || !createPassword) {
      notifications.show({
        color: "yellow",
        message: "请输入网站密钥名称和当前密码",
      });
      return;
    }

    setCreating(true);
    try {
      const optionsResult = await usersApi.createPasskeyOptions({
        headers: { authorization: `Bearer ${token}` },
        body: { password: createPassword },
      });
      if (optionsResult.status !== 200) {
        throw new Error(
          responseMessage(optionsResult.body, optionsResult.status),
        );
      }

      const response = await startRegistration({
        optionsJSON: optionsResult.body
          .options as PublicKeyCredentialCreationOptionsJSON,
      });
      const verifyResult = await usersApi.verifyPasskeyRegistration({
        headers: { authorization: `Bearer ${token}` },
        body: {
          ceremonyId: optionsResult.body.ceremonyId,
          name,
          response,
        },
      });
      if (verifyResult.status !== 201) {
        throw new Error(
          responseMessage(verifyResult.body, verifyResult.status),
        );
      }

      setPasskeys((current) => [
        verifyResult.body as PasskeySummary,
        ...current,
      ]);
      setCreateOpened(false);
      setCreateName("");
      setCreatePassword("");
      notifications.show({ color: "green", message: "网站密钥已创建" });
    } catch (error) {
      if (!isUserCancellation(error)) {
        notifications.show({
          color: "red",
          title: "创建网站密钥失败",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setCreating(false);
      setCreatePassword("");
    }
  };

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim()) {
      return;
    }
    setRenaming(true);
    try {
      const result = await usersApi.renamePasskey({
        params: { id: renameTarget.id },
        headers: { authorization: `Bearer ${token}` },
        body: { name: renameName.trim() },
      });
      if (result.status !== 200) {
        throw new Error(responseMessage(result.body, result.status));
      }
      const updated = result.body as PasskeySummary;
      setPasskeys((current) =>
        current.map((passkey) =>
          passkey.id === updated.id ? updated : passkey,
        ),
      );
      setRenameTarget(null);
      setRenameName("");
      notifications.show({ color: "green", message: "名称已更新" });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "重命名失败",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || !deletePassword) {
      return;
    }
    setDeleting(true);
    try {
      const result = await usersApi.deletePasskey({
        params: { id: deleteTarget.id },
        headers: { authorization: `Bearer ${token}` },
        body: { password: deletePassword },
      });
      if (result.status !== 200) {
        throw new Error(responseMessage(result.body, result.status));
      }
      setPasskeys((current) =>
        current.filter((passkey) => passkey.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
      setDeletePassword("");
      notifications.show({ color: "green", message: "网站密钥已删除" });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "删除网站密钥失败",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
      setDeletePassword("");
    }
  };

  return (
    <Box>
      <Divider mb="md" />
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconKey size={17} />
          <Text fw={600} size="sm">
            网站密钥
          </Text>
        </Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={!hasPassword || !supported || passkeys.length >= 10}
          onClick={() => {
            void getSuggestedPasskeyName(passkeys).then((name) => {
              setCreateName(name);
              setCreateOpened(true);
            });
          }}
        >
          创建
        </Button>
      </Group>

      <PasskeyWarnings
        hasPassword={hasPassword}
        supported={supported}
        count={passkeys.length}
      />

      <PasskeyContent
        loading={loading}
        passkeys={passkeys}
        onRename={(passkey) => {
          setRenameTarget(passkey);
          setRenameName(passkey.name);
        }}
        onDelete={setDeleteTarget}
      />

      <Modal
        opened={createOpened}
        onClose={closeCreate}
        title="创建网站密钥"
        centered
      >
        <Stack>
          <TextInput
            label="名称"
            description="已根据当前设备和浏览器自动填写，可自行修改"
            maxLength={50}
            value={createName}
            onChange={(event) => setCreateName(event.currentTarget.value)}
          />
          <PasswordInput
            label="当前密码"
            value={createPassword}
            onChange={(event) => setCreatePassword(event.currentTarget.value)}
          />
          <Button loading={creating} onClick={() => void handleCreate()}>
            继续创建
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={!!renameTarget}
        onClose={() => !renaming && setRenameTarget(null)}
        title="重命名网站密钥"
        centered
      >
        <Stack>
          <TextInput
            label="名称"
            maxLength={50}
            value={renameName}
            onChange={(event) => setRenameName(event.currentTarget.value)}
          />
          <Button loading={renaming} onClick={() => void handleRename()}>
            保存
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={!!deleteTarget}
        onClose={() => {
          if (!deleting) {
            setDeleteTarget(null);
            setDeletePassword("");
          }
        }}
        title="删除网站密钥"
        centered
      >
        <Stack>
          <Text size="sm">
            删除“{deleteTarget?.name}”后，该网站密钥将无法再用于登录。
          </Text>
          <PasswordInput
            label="当前密码"
            value={deletePassword}
            onChange={(event) => setDeletePassword(event.currentTarget.value)}
          />
          <Button
            color="red"
            loading={deleting}
            onClick={() => void handleDelete()}
          >
            确认删除
          </Button>
        </Stack>
      </Modal>
    </Box>
  );
}
