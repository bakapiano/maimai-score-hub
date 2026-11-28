import {
  Box,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconDeviceDesktop,
  IconDownload,
  IconDatabase,
  IconMoon,
  IconPalette,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";

import { AccountSettingsSection } from "./SettingsPanelAccountSection";
import { AppCard } from "./AppCard";
import { StatsCardSettingsSection } from "./StatsCardSettingsSection";
import { InstallAppButton } from "./InstallAppButton";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import { usePwaInstall } from "../hooks/usePwaInstall";
import { AndroidAppUpdatePanel } from "../features/android-update/AndroidAppUpdatePanel";
import { useAndroidAppUpdate } from "../features/android-update/AndroidAppUpdateContext";

function InstallAppSettingsSection() {
  const { status } = usePwaInstall();

  if (status !== "prompt" && status !== "ios") {
    return null;
  }

  return (
    <AppCard compact>
      <Stack gap="md">
        <SettingsSectionHeader
          icon={<IconDownload size={16} />}
          title="安装应用"
        />
        {status === "prompt" && (
          <InstallAppButton fullWidth variant="filled" />
        )}
        {status === "ios" && (
          <Text size="sm" c="dimmed">
            在 Safari 点击底部分享按钮，选择“添加到主屏幕”。
          </Text>
        )}
      </Stack>
    </AppCard>
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
    <AppCard compact>
      <Stack gap="md">
        <SettingsSectionHeader
          icon={<IconPalette size={16} />}
          title="外观"
        />
      <SegmentedControl
        fullWidth
        value={colorScheme}
        onChange={(value) => onChange(value as "light" | "dark" | "auto")}
        data={[
          {
            value: "light",
            label: (
              <Group gap={6} justify="center" wrap="nowrap">
                <IconSun size={16} />
                <span style={{ whiteSpace: "nowrap" }}>浅色</span>
              </Group>
            ),
          },
          {
            value: "dark",
            label: (
              <Group gap={6} justify="center" wrap="nowrap">
                <IconMoon size={16} />
                <span style={{ whiteSpace: "nowrap" }}>深色</span>
              </Group>
            ),
          },
          {
            value: "auto",
            label: (
              <Group gap={6} justify="center" wrap="nowrap">
                <IconDeviceDesktop size={16} />
                <span style={{ whiteSpace: "nowrap" }}>跟随系统</span>
              </Group>
            ),
          },
        ]}
      />
      </Stack>
    </AppCard>
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
    <AppCard compact>
      <Stack gap="md">
        <SettingsSectionHeader
          icon={<IconDatabase size={16} />}
          title="缓存"
        />
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
      </Stack>
    </AppCard>
  );
}

function preserveSessionCache() {
  const token = localStorage.getItem("netbot_token");
  const refreshToken = localStorage.getItem("netbot_refresh_token");
  const offlineMode = localStorage.getItem("offline_mode");
  const cachedProfile = localStorage.getItem("offline_cache_profile");
  const cachedSync = localStorage.getItem("offline_cache_sync_latest");

  localStorage.clear();
  if (token) {
    localStorage.setItem("netbot_token", token);
  }
  if (refreshToken) {
    localStorage.setItem("netbot_refresh_token", refreshToken);
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

export function SettingsContent({ onClose = () => {} }: { onClose?: () => void }) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [clearing, setClearing] = useState(false);
  const { available: androidAppUpdateAvailable } = useAndroidAppUpdate();

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
    <Box style={{ height: "100%" }}>
      <Stack gap="xl" mx="auto" w="100%">
        <StatsCardSettingsSection />
        <AppearanceSettingsSection
          colorScheme={colorScheme}
          onChange={setColorScheme}
        />
        {androidAppUpdateAvailable ? (
          <AndroidAppUpdatePanel />
        ) : (
          <InstallAppSettingsSection />
        )}
        <CacheSettingsSection
          clearing={clearing}
          onClearCache={handleClearCache}
        />
        <AccountSettingsSection onClose={onClose} />
      </Stack>
    </Box>
  );
}
