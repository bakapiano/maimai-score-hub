import {
  Box,
  Button,
  Drawer,
  Group,
  SegmentedControl,
  Stack,
  Text,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconCopy,
  IconDeviceDesktop,
  IconLogout,
  IconMoon,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useRef, useState } from "react";

import { notifications } from "@mantine/notifications";
import { useAuth } from "../providers/AuthProvider";

type Props = {
  opened: boolean;
  onClose: () => void;
};

export function SettingsPanel({ opened, onClose }: Props) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { token, clearToken } = useAuth();
  const touchStartX = useRef<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const handleLogout = () => {
    clearToken();
    onClose();
    window.location.reload();
  };

  const handleClearCache = () => {
    setClearing(true);
    try {
      const token = localStorage.getItem("netbot_token");
      localStorage.clear();
      if (token) {
        localStorage.setItem("netbot_token", token);
      }
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

          {token && (
            <div>
              <Text size="sm" fw={500} mb="xs">
                账号
              </Text>
              <Stack gap="xs">
                <Button
                  variant="light"
                  color="blue"
                  fullWidth
                  leftSection={<IconCopy size={16} />}
                  onClick={() => {
                    const friendCode = localStorage.getItem("lastFriendCode");
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
              </Stack>
            </div>
          )}
        </Stack>
      </Box>
    </Drawer>
  );
}
