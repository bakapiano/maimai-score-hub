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
  IconDeviceDesktop,
  IconMoon,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useRef, useState } from "react";

import { AccountSettingsSection } from "./SettingsPanelAccountSection";
import { InstallAppButton } from "./InstallAppButton";
import { usePwaInstall } from "../hooks/usePwaInstall";

type Props = {
  opened: boolean;
  onClose: () => void;
};

function InstallAppSettingsSection() {
  const { status } = usePwaInstall();

  if (status === "installed" || status === "unavailable") {
    return null;
  }

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

function AppearanceSettingsSection({
  colorScheme,
  onChange,
}: {
  colorScheme: string;
  onChange: (value: "light" | "dark" | "auto") => void;
}) {
  return (
    <div>
      <Text size="sm" fw={500} mb="xs">
        外观
      </Text>
      <SegmentedControl
        fullWidth
        value={colorScheme}
        onChange={(value) => onChange(value as "light" | "dark" | "auto")}
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
  );
}

function CacheSettingsSection({
  clearing,
  onClearCache,
}: {
  clearing: boolean;
  onClearCache: () => void;
}) {
  return (
    <div>
      <Text size="sm" fw={500} mb="xs">
        缓存
      </Text>
      <Button
        variant="light"
        color="red"
        fullWidth
        leftSection={<IconTrash size={16} />}
        onClick={onClearCache}
        loading={clearing}
      >
        清除本地缓存
      </Button>
      <Text size="xs" c="dimmed" mt={4}>
        清除所有本地缓存数据
      </Text>
    </div>
  );
}

function preserveSessionCache() {
  const token = localStorage.getItem("netbot_token");
  const offlineMode = localStorage.getItem("offline_mode");
  const cachedProfile = localStorage.getItem("offline_cache_profile");
  const cachedSync = localStorage.getItem("offline_cache_sync_latest");

  localStorage.clear();
  if (token) {
    localStorage.setItem("netbot_token", token);
  }
  if (offlineMode) {
    localStorage.setItem("offline_mode", offlineMode);
  }
  if (cachedProfile) {
    localStorage.setItem("offline_cache_profile", cachedProfile);
  }
  if (cachedSync) {
    localStorage.setItem("offline_cache_sync_latest", cachedSync);
  }
}

export function SettingsPanel({ opened, onClose }: Props) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const touchStartX = useRef<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const handleClearCache = () => {
    setClearing(true);
    try {
      preserveSessionCache();
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
      lockScroll={false}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const startX = touchStartX.current;
        touchStartX.current = null;
        if (startX === null) {
          return;
        }
        const endX = event.changedTouches[0]?.clientX ?? startX;
        if (endX - startX > 50) {
          onClose();
        }
      }}
    >
      <Box style={{ height: "100%" }}>
        <Stack gap="lg">
          <AppearanceSettingsSection
            colorScheme={colorScheme}
            onChange={setColorScheme}
          />
          <InstallAppSettingsSection />
          <CacheSettingsSection
            clearing={clearing}
            onClearCache={handleClearCache}
          />
          <AccountSettingsSection onClose={onClose} />
        </Stack>
      </Box>
    </Drawer>
  );
}
