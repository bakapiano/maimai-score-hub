import {
  Alert,
  Badge,
  Button,
  CopyButton,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconCheck,
  IconCopy,
  IconLink,
  IconRefresh,
  IconShieldLock,
  IconWorldOff,
  IconShare,
  IconSun,
  IconMoon,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@mantine/hooks";
import type {
  StatsCardState,
  StatsCardTheme,
  StatsCardDisplay,
  StatsCardDisplayPatch,
} from "@maimai-score-hub/shared";
import {
  changeStatsCard,
  getStatsCardPreview,
  getStatsCardState,
  statsCardLink,
  updateStatsCardDisplay,
} from "../api/statsCard";
import type { StatsCardAction } from "../api/statsCard";
import classes from "./StatsCardShareModal.module.css";

type Props = { opened: boolean; onClose: () => void; token: string };
type Busy = StatsCardAction | "display" | null;
const DISPLAY_FIELDS: Array<{ key: keyof StatsCardDisplay; label: string }> = [
  { key: "rating", label: "Rating" },
  { key: "awakeningCount", label: "觉醒数" },
  { key: "classRank", label: "友人对战段位" },
  { key: "courseRank", label: "课题段位" },
  { key: "title", label: "称号" },
];

export function StatsCardShareModal({ opened, onClose, token }: Props) {
  const fullScreen = useMediaQuery("(max-width: 48em)");
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      fullScreen={fullScreen}
      centered={!fullScreen}
      closeButtonProps={{ "aria-label": "关闭名片弹窗" }}
      classNames={{
        inner: "msh-safe-modal-inner",
        content: "msh-safe-modal-content",
        header: classes.header,
        body: classes.body,
      }}
      title={
        <Group gap="xs" wrap="nowrap">
          <IconShare size={20} aria-hidden />
          <Text fw={600}>舞萌名片外链</Text>
        </Group>
      }
    >
      {opened && <ShareSettings key={token} token={token} />}
    </Modal>
  );
}

function ShareSettings({ token }: { token: string }) {
  const [state, setState] = useState<StatsCardState | null>(null);
  const [theme, setTheme] = useState<StatsCardTheme>("light");
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [stateRevision, setStateRevision] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [stateLoading, setStateLoading] = useState(true);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const displayVersion = state
    ? state.updatedAt + JSON.stringify(state.display)
    : null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStateLoading(true);
    void getStatsCardState(token, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setState(value);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(message(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setStateLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [token, stateRevision]);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreview(null);
    setPreviewError(null);
    if (displayVersion !== null) {
      void getStatsCardPreview(token, theme, controller.signal)
        .then((blob) => {
          if (!controller.signal.aborted) {
            objectUrl = URL.createObjectURL(blob);
            setPreview(objectUrl);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setPreviewError(message(reason));
          }
        });
    }
    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [token, theme, revision, displayVersion]);

  async function mutate(
    action: Exclude<Busy, null>,
    patch?: StatsCardDisplayPatch,
  ) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(action);
    setError(null);
    try {
      const next =
        action === "display"
          ? await updateStatsCardDisplay(token, patch ?? {})
          : await changeStatsCard(token, action);
      if (alive.current) {
        setState(next);
      }
    } catch (reason) {
      if (alive.current) {
        setError(message(reason));
        // Recover the true settings if a successful write's response was lost.
        setStateRevision((value) => value + 1);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setBusy(null);
      }
    }
  }

  function reload() {
    setError(null);
    setStateRevision((value) => value + 1);
    setRevision((value) => value + 1);
  }
  const url =
    state?.enabled && state.code
      ? statsCardLink(window.location.origin, state.code, theme)
      : "";
  const locked = Boolean(busy) || stateLoading;
  return (
    <Stack gap="md">
      <Group justify="space-between" gap="xs" aria-label="名片预览操作">
        <Text size="sm" fw={600}>
          名片预览
        </Text>
        <Group gap={6}>
          <SegmentedControl
            aria-label="名片主题"
            size="xs"
            value={theme}
            onChange={(value) => setTheme(value as StatsCardTheme)}
            data={[
              {
                value: "light",
                label: (
                  <Group gap={4} justify="center" wrap="nowrap">
                    <IconSun size={14} aria-hidden />
                    <span>浅色</span>
                  </Group>
                ),
              },
              {
                value: "dark",
                label: (
                  <Group gap={4} justify="center" wrap="nowrap">
                    <IconMoon size={14} aria-hidden />
                    <span>深色</span>
                  </Group>
                ),
              },
            ]}
          />
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={locked}
            leftSection={<IconRefresh size={14} />}
            onClick={reload}
          >
            刷新预览
          </Button>
        </Group>
      </Group>
      <CardPreview
        preview={preview}
        error={previewError}
        theme={theme}
        onRetry={() => setRevision((value) => value + 1)}
      />
      <Alert icon={<IconShieldLock size={18} />} color="orange" variant="light">
        任何拿到链接的人都能查看和转发，请注意隐私保护
      </Alert>
      {error && (
        <Alert color="red" title="操作未完成">
          {error}
          <Button size="compact-xs" variant="subtle" onClick={reload}>
            重新加载
          </Button>
        </Alert>
      )}
      {stateLoading && !state && (
        <Group justify="center">
          <Loader size="sm" />
        </Group>
      )}
      {state && (
        <DisplaySettings
          display={state.display}
          disabled={locked}
          onChange={(patch) => void mutate("display", patch)}
        />
      )}
      {state && (
        <ShareActions
          enabled={state.enabled}
          url={url}
          busy={busy}
          disabled={locked}
          onAction={(action) => void mutate(action)}
        />
      )}
    </Stack>
  );
}

function DisplaySettings({
  display,
  disabled,
  onChange,
}: {
  display: StatsCardDisplay;
  disabled: boolean;
  onChange: (patch: StatsCardDisplayPatch) => void;
}) {
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="md">
        <Text size="sm" fw={600}>
          展示内容
        </Text>
        <div className={classes.displayOptions}>
          {DISPLAY_FIELDS.map(({ key, label }) => (
            <Switch
              key={key}
              label={label}
              checked={display[key]}
              disabled={disabled}
              onChange={(event) =>
                onChange({ [key]: event.currentTarget.checked })
              }
            />
          ))}
        </div>
      </Stack>
    </Paper>
  );
}

function LinkField({ url }: { url: string }) {
  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="nowrap">
        <TextInput
          aria-label="SVG 图片外链"
          value={url}
          readOnly
          className={classes.linkInput}
          classNames={{ input: classes.linkValue }}
          leftSection={<IconLink size={14} />}
        />
        <CopyButton value={url}>
          {({ copied, copy }) => (
            <Button
              variant="filled"
              size="sm"
              color={copied ? "teal" : undefined}
              onClick={copy}
              leftSection={
                copied ? <IconCheck size={14} /> : <IconCopy size={14} />
              }
            >
              {copied ? "已复制" : "复制链接"}
            </Button>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
}

function ShareActions({
  enabled,
  url,
  busy,
  disabled,
  onAction,
}: {
  enabled: boolean;
  url: string;
  busy: Busy;
  disabled: boolean;
  onAction: (action: StatsCardAction) => void;
}) {
  const [confirm, setConfirm] = useState<"rotate" | "disable" | null>(null);
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      component="section"
      aria-label="分享管理"
      className={classes.shareManagement}
    >
      <Stack gap="md">
        <Group justify="space-between" gap="xs">
          <Group gap="xs" wrap="nowrap">
            <IconShare
              size={16}
              aria-hidden
              className={classes.managementIcon}
            />
            <Text size="sm" fw={600}>
              名片外链
            </Text>
            <Badge color={enabled ? "teal" : "gray"} variant="light">
              {enabled ? "分享已开启" : "尚未公开"}
            </Badge>
          </Group>
        </Group>
        {url && <LinkField url={url} />}
        {enabled ? (
          <Group gap="xs" grow className={classes.managementFooter}>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              disabled={disabled}
              leftSection={<IconRefresh size={14} />}
              onClick={() => setConfirm("rotate")}
            >
              重置链接
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              disabled={disabled}
              leftSection={<IconWorldOff size={14} />}
              onClick={() => setConfirm("disable")}
            >
              关闭分享
            </Button>
          </Group>
        ) : (
          <Button
            leftSection={<IconLink size={16} />}
            loading={busy === "enable"}
            disabled={disabled}
            onClick={() => onAction("enable")}
          >
            生成外链
          </Button>
        )}
        {confirm && (
          <Alert color={confirm === "disable" ? "red" : "orange"}>
            <Text size="sm">
              {confirm === "rotate"
                ? "重置后旧链接失效，需要替换已粘贴的引用。确认重置？"
                : "关闭后源站不再提供这张名片。第三方已保存的图片无法收回。确认关闭？"}
            </Text>
            <Group mt="sm" justify="flex-end">
              <Button
                size="xs"
                variant="default"
                disabled={disabled}
                onClick={() => setConfirm(null)}
              >
                取消
              </Button>
              <Button
                size="xs"
                color={confirm === "disable" ? "red" : "orange"}
                loading={busy === confirm}
                disabled={disabled}
                onClick={() => {
                  onAction(confirm);
                  setConfirm(null);
                }}
              >
                {confirm === "rotate" ? "确认重置" : "确认关闭"}
              </Button>
            </Group>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

function CardPreview({
  preview,
  error,
  theme,
  onRetry,
}: {
  preview: string | null;
  error: string | null;
  theme: StatsCardTheme;
  onRetry: () => void;
}) {
  return (
    <Paper
      className={classes.preview}
      data-theme={theme}
      withBorder
      p="sm"
      radius="md"
      aria-label="名片预览区域"
      aria-busy={!preview && !error}
    >
      <div className={classes.previewViewport}>
        {preview && (
          <img
            src={preview}
            alt="个人名片 SVG 预览"
            className={classes.previewImage}
          />
        )}
        {!preview && !error && (
          <Group justify="center" className={classes.previewOverlay}>
            <Loader size="sm" aria-label="正在生成预览" />
          </Group>
        )}
        {error && (
          <Stack
            align="center"
            justify="center"
            gap="xs"
            className={classes.previewOverlay}
          >
            <Text size="sm" c="red">
              {error}
            </Text>
            <Button size="xs" variant="light" onClick={onRetry}>
              重试预览
            </Button>
          </Stack>
        )}
      </div>
    </Paper>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}
