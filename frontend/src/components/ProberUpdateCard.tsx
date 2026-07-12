import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Image,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconExternalLink,
  IconKey,
  IconPassword,
  IconUser,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";

import type { AuthProfile } from "../providers/AuthContext";
import { fetchSyncPageJson } from "../pages/syncPageApi";
import { recordAnalyticsEvent } from "../utils/observability";
import { AppCard } from "./AppCard";
import styles from "./ProberUpdateCard.module.css";

type ExportTarget = "diving-fish" | "lxns";
type ExportProviderKey = "divingFish" | "lxns";
type DivingFishMode = "token" | "login";

type ProberExportProviderResult = {
  status: "success" | "failed" | "skipped";
  exported?: number;
  skipped?: number;
  scores?: number;
  message?: string;
  response?: { creates?: number; updates?: number; data?: unknown[] };
};

type ProberExportJob = {
  id: string;
  status:
    | "queued"
    | "processing"
    | "completed"
    | "partial_failed"
    | "failed"
    | "skipped";
  result?: {
    divingFish?: ProberExportProviderResult | null;
    lxns?: ProberExportProviderResult | null;
  } | null;
  error?: string | null;
};

type ProberExportCreateResponse = {
  exportJobId: string;
  status: ProberExportJob["status"];
  job: ProberExportJob;
};

type ProberProfile = Pick<
  AuthProfile,
  "hasDivingFishImportToken" | "hasLxnsImportToken"
>;

type ProberUpdateCardProps = {
  token: string | null;
  profile: ProberProfile | null;
  onProfileChanged: () => Promise<unknown>;
  header?: ReactNode;
};

type ProviderHeaderProps = {
  configured: boolean;
  href: string;
  iconSrc: string;
  title: string;
};

function ProviderHeader({
  configured,
  href,
  iconSrc,
  title,
}: ProviderHeaderProps) {
  return (
    <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
      <Anchor
        href={href}
        target="_blank"
        rel="noreferrer"
        fw={600}
        size="md"
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Image
          src={iconSrc}
          alt=""
          w={20}
          h={20}
          radius={4}
          fit="contain"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
        {title}
        <IconExternalLink size={14} aria-hidden />
      </Anchor>
      <Badge
        color={configured ? "teal" : "gray"}
        variant="light"
        radius="xl"
        size="sm"
      >
        {configured ? "已配置" : "未配置"}
      </Badge>
    </Group>
  );
}

const EXPORT_PROVIDERS: Record<
  ExportTarget,
  {
    key: ExportProviderKey;
    name: string;
    path: string;
    tokenField: "divingFishImportToken" | "lxnsImportToken";
  }
> = {
  "diving-fish": {
    key: "divingFish",
    name: "Diving-Fish",
    path: "/api/v1/me/sync/latest/exports/diving-fish",
    tokenField: "divingFishImportToken",
  },
  lxns: {
    key: "lxns",
    name: "落雪查分器",
    path: "/api/v1/me/sync/latest/exports/lxns",
    tokenField: "lxnsImportToken",
  },
};

function getExportResult(job: ProberExportJob, target: ExportTarget) {
  return job.result?.[EXPORT_PROVIDERS[target].key];
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function showCompletedExport(target: ExportTarget, job: ProberExportJob) {
  const provider = EXPORT_PROVIDERS[target];
  const result = getExportResult(job, target);
  const hasExportCount = result?.exported !== undefined;
  const message = hasExportCount
    ? `成绩已导出到 ${provider.name}（共 ${result?.scores ?? "?"} 条成绩，导出 ${result?.exported} 条）`
    : result?.message || `成绩已导出到 ${provider.name}`;

  notifications.show({
    title: result?.status === "skipped" ? "无需导出" : "导出成功",
    message,
    color: result?.status === "skipped" ? "yellow" : "green",
  });
  return result?.status ?? job.status;
}

type DivingFishPanelProps = {
  configured: boolean;
  editing: boolean;
  mode: DivingFishMode;
  importToken: string;
  username: string;
  password: string;
  fetchingToken: boolean;
  exportLoading: ExportTarget | null;
  onBeginEdit: () => void;
  onCancelTokenEdit: () => void;
  onCancelLoginEdit: () => void;
  onModeChange: (mode: DivingFishMode) => void;
  onTokenChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onExportWithToken: () => void;
  onExportWithLogin: () => void;
};

function DivingFishPanel({
  configured,
  editing,
  mode,
  importToken,
  username,
  password,
  fetchingToken,
  exportLoading,
  onBeginEdit,
  onCancelTokenEdit,
  onCancelLoginEdit,
  onModeChange,
  onTokenChange,
  onUsernameChange,
  onPasswordChange,
  onExportWithToken,
  onExportWithLogin,
}: DivingFishPanelProps) {
  const interactionDisabled = exportLoading !== null;
  const loginDisabled =
    !username || !password || fetchingToken || interactionDisabled;

  return (
    <Box className={styles.proberPanel}>
      <Stack gap="md">
        <ProviderHeader
          configured={configured}
          href="https://www.diving-fish.com/maimaidx/prober/"
          iconSrc="https://maimai.diving-fish.com/favicon.ico"
          title="水鱼查分器"
        />

        {configured && !editing ? (
          <Group grow w="100%" align="center" gap="xs">
            <Button
              onClick={onBeginEdit}
              disabled={interactionDisabled}
              variant="default"
              size="sm"
            >
              修改凭据
            </Button>
            <Button
              onClick={onExportWithToken}
              loading={exportLoading === "diving-fish"}
              disabled={interactionDisabled}
              variant="light"
              size="sm"
            >
              更新成绩
            </Button>
          </Group>
        ) : (
          <Tabs
            keepMounted={false}
            value={mode}
            onChange={(value) =>
              onModeChange((value as DivingFishMode) ?? "token")
            }
          >
            <Tabs.List>
              <Tabs.Tab value="token" disabled={interactionDisabled}>
                Token
              </Tabs.Tab>
              <Tabs.Tab value="login" disabled={interactionDisabled}>
                账号密码
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="token" pt="md">
              <Stack gap="sm">
                <PasswordInput
                  label="Import Token"
                  placeholder="输入 import token"
                  leftSection={<IconKey size={16} />}
                  value={importToken}
                  disabled={interactionDisabled}
                  onChange={(event) => onTokenChange(event.target.value)}
                />
                <Group
                  grow
                  w="100%"
                  gap="xs"
                >
                  {configured && (
                    <Button
                      onClick={onCancelTokenEdit}
                      disabled={interactionDisabled}
                      variant="default"
                      size="sm"
                    >
                      取消
                    </Button>
                  )}
                  <Button
                    onClick={onExportWithToken}
                    loading={exportLoading === "diving-fish"}
                    disabled={!importToken || interactionDisabled}
                    variant="light"
                    size="sm"
                  >
                    保存并更新
                  </Button>
                </Group>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="login" pt="md">
              <Stack gap="sm">
                <Text size="xs" c="dimmed">
                  账号密码仅用于获取 Import
                  Token，不会保存在服务器或浏览器中。
                </Text>
                <TextInput
                  label="用户名"
                  placeholder="水鱼账号用户名"
                  leftSection={<IconUser size={16} />}
                  value={username}
                  disabled={fetchingToken || interactionDisabled}
                  onChange={(event) => onUsernameChange(event.target.value)}
                />
                <PasswordInput
                  label="密码"
                  placeholder="水鱼账号密码"
                  leftSection={<IconPassword size={16} />}
                  value={password}
                  disabled={fetchingToken || interactionDisabled}
                  onChange={(event) => onPasswordChange(event.target.value)}
                />
                <Group
                  grow
                  w="100%"
                  gap="xs"
                >
                  {configured && (
                    <Button
                      onClick={onCancelLoginEdit}
                      disabled={interactionDisabled}
                      variant="default"
                      size="sm"
                    >
                      取消
                    </Button>
                  )}
                  <Button
                    onClick={onExportWithLogin}
                    loading={fetchingToken}
                    disabled={loginDisabled}
                    variant="light"
                    size="sm"
                  >
                    获取 Token 并更新
                  </Button>
                </Group>
              </Stack>
            </Tabs.Panel>
          </Tabs>
        )}
      </Stack>
    </Box>
  );
}

type LxnsPanelProps = {
  configured: boolean;
  editing: boolean;
  importToken: string;
  exportLoading: ExportTarget | null;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onTokenChange: (value: string) => void;
  onExport: () => void;
};

function LxnsPanel({
  configured,
  editing,
  importToken,
  exportLoading,
  onBeginEdit,
  onCancelEdit,
  onTokenChange,
  onExport,
}: LxnsPanelProps) {
  const interactionDisabled = exportLoading !== null;

  return (
    <Box className={styles.proberPanel}>
      <Stack gap="md">
        <ProviderHeader
          configured={configured}
          href="https://maimai.lxns.net/"
          iconSrc="https://maimai.lxns.net/favicon.webp"
          title="落雪查分器"
        />

        {configured && !editing ? (
          <Group grow w="100%" align="center" gap="xs">
            <Button
              onClick={onBeginEdit}
              disabled={interactionDisabled}
              variant="default"
              size="sm"
            >
              修改凭据
            </Button>
            <Button
              onClick={onExport}
              loading={exportLoading === "lxns"}
              disabled={interactionDisabled}
              variant="light"
              size="sm"
            >
              更新成绩
            </Button>
          </Group>
        ) : (
          <Stack gap="sm">
            <PasswordInput
              label="Personal Token"
              placeholder="输入 personal token"
              leftSection={<IconKey size={16} />}
              value={importToken}
              disabled={interactionDisabled}
              onChange={(event) => onTokenChange(event.target.value)}
            />
            <Group
              grow
              w="100%"
              gap="xs"
            >
              {configured && (
                <Button
                  onClick={onCancelEdit}
                  disabled={interactionDisabled}
                  variant="default"
                  size="sm"
                >
                  取消
                </Button>
              )}
              <Button
                onClick={onExport}
                loading={exportLoading === "lxns"}
                disabled={!importToken || interactionDisabled}
                variant="light"
                size="sm"
              >
                保存并更新
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

export function ProberUpdateCard({
  token,
  profile,
  onProfileChanged,
  header,
}: ProberUpdateCardProps) {
  const [divingFishToken, setDivingFishToken] = useState("");
  const [lxnsToken, setLxnsToken] = useState("");
  const [editingDivingFishToken, setEditingDivingFishToken] = useState(false);
  const [editingLxnsToken, setEditingLxnsToken] = useState(false);
  const [divingFishMode, setDivingFishMode] =
    useState<DivingFishMode>("token");
  const [divingFishUsername, setDivingFishUsername] = useState("");
  const [divingFishPassword, setDivingFishPassword] = useState("");
  const [fetchingDivingFishToken, setFetchingDivingFishToken] = useState(false);
  const [exportLoading, setExportLoading] = useState<ExportTarget | null>(null);

  const pollProberExportJob = async (
    exportJobId: string,
    target: ExportTarget,
  ): Promise<ProberExportJob> => {
    if (!token) {
      throw new Error("需要登录");
    }

    const terminal = new Set([
      "completed",
      "partial_failed",
      "failed",
      "skipped",
    ]);
    for (let i = 0; i < 240; i++) {
      const res = await fetchSyncPageJson<ProberExportJob>(
        `/api/v1/me/sync/prober-export-jobs/${encodeURIComponent(exportJobId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok || !res.data) {
        throw new Error(`查询导出任务失败 (HTTP ${res.status})`);
      }
      if (terminal.has(res.data.status)) {
        const result = getExportResult(res.data, target);
        if (result?.status === "failed" || res.data.status === "failed") {
          throw new Error(result?.message || res.data.error || "导出失败");
        }
        return res.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("导出仍在处理中，请稍后查看结果");
  };

  const saveToken = async (target: ExportTarget, override?: string) => {
    if (!token) {
      return false;
    }

    const currentTokens: Record<ExportTarget, string> = {
      "diving-fish": divingFishToken,
      lxns: lxnsToken,
    };
    const tokenValue = override ?? currentTokens[target];
    if (!tokenValue) {
      return true;
    }

    const body = { [EXPORT_PROVIDERS[target].tokenField]: tokenValue };
    const res = await fetchSyncPageJson<unknown>("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      await onProfileChanged();
    }
    return res.ok;
  };

  const queueExport = async (target: ExportTarget, tokenOverride?: string) => {
    if (!token) {
      return;
    }

    setExportLoading(target);
    recordAnalyticsEvent("export_started", { provider: target });
    try {
      if (!(await saveToken(target, tokenOverride))) {
        throw new Error("Token 保存失败");
      }

      const provider = EXPORT_PROVIDERS[target];
      const res = await fetchSyncPageJson<ProberExportCreateResponse>(
        provider.path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (!res.ok || !res.data?.exportJobId) {
        const data = res.data as { message?: string } | null;
        throw new Error(
          (data?.message || `HTTP ${res.status}`) + " 请检查 Token 是否正确！",
        );
      }

      notifications.show({
        title: "已加入导出队列",
        message: `正在导出到 ${provider.name}`,
        color: "blue",
      });

      const job = await pollProberExportJob(res.data.exportJobId, target);
      recordAnalyticsEvent("export_completed", {
        provider: target,
        status: showCompletedExport(target, job),
      });

      if (target === "diving-fish") {
        setDivingFishToken("");
        setEditingDivingFishToken(false);
        setDivingFishMode("token");
      } else {
        setLxnsToken("");
        setEditingLxnsToken(false);
      }
    } catch (error) {
      recordAnalyticsEvent("export_failed", {
        provider: target,
        errorClass: error instanceof Error ? error.name : "Error",
      });
      notifications.show({
        title: "导出失败",
        message: errorMessage(error, "未知错误"),
        color: "red",
      });
    } finally {
      setExportLoading(null);
    }
  };

  const exportToDivingFishWithLogin = async () => {
    if (!token || !divingFishUsername || !divingFishPassword) {
      return;
    }

    setFetchingDivingFishToken(true);
    try {
      const res = await fetchSyncPageJson<{
        importToken?: string;
        message?: string;
      }>("/api/v1/me/prober-tokens/diving-fish", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: divingFishUsername,
          password: divingFishPassword,
        }),
      });

      if (!res.ok || !res.data?.importToken) {
        notifications.show({
          title: "获取失败",
          message: res.data?.message || `HTTP ${res.status}`,
          color: "red",
        });
        return;
      }

      const fetchedToken = res.data.importToken;
      setDivingFishToken(fetchedToken);
      setDivingFishUsername("");
      setDivingFishPassword("");
      await queueExport("diving-fish", fetchedToken);
    } catch (error) {
      notifications.show({
        title: "操作失败",
        message: errorMessage(error, "网络错误，请稍后重试"),
        color: "red",
      });
    } finally {
      setFetchingDivingFishToken(false);
    }
  };

  const hasDivingFishToken = profile?.hasDivingFishImportToken ?? false;
  const hasLxnsToken = profile?.hasLxnsImportToken ?? false;

  const beginDivingFishEdit = () => {
    setEditingDivingFishToken(true);
    setDivingFishMode("token");
    setDivingFishToken("");
  };
  const cancelDivingFishTokenEdit = () => {
    setEditingDivingFishToken(false);
    setDivingFishToken("");
  };
  const cancelDivingFishLoginEdit = () => {
    setEditingDivingFishToken(false);
    setDivingFishToken("");
    setDivingFishUsername("");
    setDivingFishPassword("");
    setDivingFishMode("token");
  };
  const beginLxnsEdit = () => {
    setEditingLxnsToken(true);
    setLxnsToken("");
  };
  const cancelLxnsEdit = () => {
    setEditingLxnsToken(false);
    setLxnsToken("");
  };

  return (
    <AppCard>
      <Stack gap="md">
        {header}
        <Box className={styles.proberGrid}>
          <DivingFishPanel
            configured={hasDivingFishToken}
            editing={editingDivingFishToken}
            mode={divingFishMode}
            importToken={divingFishToken}
            username={divingFishUsername}
            password={divingFishPassword}
            fetchingToken={fetchingDivingFishToken}
            exportLoading={exportLoading}
            onBeginEdit={beginDivingFishEdit}
            onCancelTokenEdit={cancelDivingFishTokenEdit}
            onCancelLoginEdit={cancelDivingFishLoginEdit}
            onModeChange={setDivingFishMode}
            onTokenChange={setDivingFishToken}
            onUsernameChange={setDivingFishUsername}
            onPasswordChange={setDivingFishPassword}
            onExportWithToken={() => void queueExport("diving-fish")}
            onExportWithLogin={() => void exportToDivingFishWithLogin()}
          />
          <LxnsPanel
            configured={hasLxnsToken}
            editing={editingLxnsToken}
            importToken={lxnsToken}
            exportLoading={exportLoading}
            onBeginEdit={beginLxnsEdit}
            onCancelEdit={cancelLxnsEdit}
            onTokenChange={setLxnsToken}
            onExport={() => void queueExport("lxns")}
          />
        </Box>
      </Stack>
    </AppCard>
  );
}
