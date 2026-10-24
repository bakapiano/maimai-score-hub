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
          生成并分享舞萌名片外链，可以展示在 Github README
          或其他网站中，随时重置或关闭。
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
            请退出离线模式后管理分享。
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
