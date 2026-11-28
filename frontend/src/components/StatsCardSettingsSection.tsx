import { Button, Stack, Text } from "@mantine/core";
import { IconShare } from "@tabler/icons-react";
import { useState } from "react";
import { useAuth } from "../providers/AuthContext";
import { AppCard } from "./AppCard";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import { StatsCardShareModal } from "./StatsCardShareModal";

export function StatsCardSettingsSection() {
  const { token, offline } = useAuth();
  const [opened, setOpened] = useState(false);
  return (
    <AppCard compact>
      <Stack gap="md">
        <SettingsSectionHeader
          icon={<IconShare size={16} />}
          title="舞萌名片外链"
        />
        <Text size="sm" c="dimmed">
          生成可嵌入 GitHub README 或个人主页的动态名片链接，随时可重置或关闭。
        </Text>
        <Button
          variant="light"
          fullWidth
          leftSection={<IconShare size={16} />}
          disabled={!token || offline}
          onClick={() => setOpened(true)}
          aria-label="舞萌名片外链"
        >
          分享
        </Button>
        {offline && (
          <Text size="xs" c="dimmed">
            离线模式下无法管理分享，请先登录。
          </Text>
        )}
      </Stack>
      {token && !offline && (
        <StatsCardShareModal
          opened={opened}
          onClose={() => setOpened(false)}
          token={token}
        />
      )}
    </AppCard>
  );
}
