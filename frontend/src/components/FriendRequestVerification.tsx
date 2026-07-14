import {
  Alert,
  Button,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { formatFriendRequestSentAt } from "../utils/formatDate";

const FRIEND_REQUEST_WAIT_SECONDS = 5 * 60;
const VERIFY_COOLDOWN_SECONDS = 5;

type FriendRequestVerificationButtonProps = {
  disabled?: boolean;
  idleLabel: string;
  onVerify: () => Promise<void>;
};

export function FriendRequestVerificationButton({
  disabled = false,
  idleLabel,
  onVerify,
}: FriendRequestVerificationButtonProps) {
  const [loading, setLoading] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (cooldownSeconds <= 0) {return;}

    const timeout = setTimeout(() => {
      setCooldownSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1_000);

    return () => clearTimeout(timeout);
  }, [cooldownSeconds]);

  const handleVerify = async () => {
    if (disabled || inFlightRef.current || cooldownSeconds > 0) {return;}

    inFlightRef.current = true;
    setLoading(true);
    setCooldownSeconds(VERIFY_COOLDOWN_SECONDS);
    try {
      await onVerify();
      notifications.show({
        title: "已触发检查",
        message: "后台正在确认好友状态，请稍候",
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: "触发检查失败",
        message: error instanceof Error ? error.message : "未知错误",
        color: "red",
      });
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      onClick={handleVerify}
      loading={loading}
      disabled={disabled || loading || cooldownSeconds > 0}
    >
      {cooldownSeconds > 0
        ? `正在检查（${cooldownSeconds}s）`
        : idleLabel}
    </Button>
  );
}

type FriendRequestAcceptanceAlertProps = {
  disabled?: boolean;
  friendRequestSentAt?: string | null;
  onVerify: () => Promise<void>;
};

function getRemainingSeconds(friendRequestSentAt: string): number {
  const sentAt = new Date(friendRequestSentAt).getTime();
  if (!Number.isFinite(sentAt)) {return 0;}

  return Math.max(
    0,
    Math.ceil(
      (sentAt + FRIEND_REQUEST_WAIT_SECONDS * 1_000 - Date.now()) / 1_000,
    ),
  );
}

export function FriendRequestAcceptanceAlert({
  disabled = false,
  friendRequestSentAt,
  onVerify,
}: FriendRequestAcceptanceAlertProps) {
  const [timeLeft, setTimeLeft] = useState(() =>
    friendRequestSentAt ? getRemainingSeconds(friendRequestSentAt) : 0,
  );

  useEffect(() => {
    if (!friendRequestSentAt) {
      return;
    }

    const updateTimeLeft = () => {
      setTimeLeft(getRemainingSeconds(friendRequestSentAt));
    };
    const interval = setInterval(updateTimeLeft, 500);

    return () => clearInterval(interval);
  }, [friendRequestSentAt]);

  if (!friendRequestSentAt) {
    return (
      <Group justify="center" gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Bot 正在发送好友请求，请稍候...
        </Text>
      </Group>
    );
  }

  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / FRIEND_REQUEST_WAIT_SECONDS) * 100),
  );

  return (
    <Alert
      variant="outline"
      radius="md"
      color="blue"
      title="好友请求已发送！"
      icon={<IconInfoCircle size={18} />}
    >
      <Stack gap="sm">
        <Text size="sm">
          Bot 已发送好友申请，请登录 NET 并在核对时间一致后同意好友申请。
        </Text>
        <Text size="sm" c="red" fw={700}>
          若申请时间不是 {formatFriendRequestSentAt(friendRequestSentAt)}
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
        <FriendRequestVerificationButton
          onVerify={onVerify}
          disabled={disabled}
          idleLabel="我已接受请求"
        />
      </Stack>
    </Alert>
  );
}
