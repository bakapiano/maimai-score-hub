import { Badge, Box, Group, Image, Text } from "@mantine/core";
import { type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { HeaderProfileCard, type MiniProfile } from "./MiniProfileCard";

type AppHeaderProps = {
  profile?: MiniProfile | null;
  onLogout?: () => void;
  showProfile?: boolean;
  rightSection?: ReactNode;
};

export function AppHeader({
  profile,
  onLogout,
  showProfile = true,
  rightSection,
}: AppHeaderProps) {
  const navigate = useNavigate();

  return (
    <Group
      h="100%"
      px="md"
      justify="space-between"
      wrap="nowrap"
      style={{ flexWrap: "nowrap", overflow: "hidden" }}
    >
      <Group
        gap="sm"
        wrap="nowrap"
        style={{
          minWidth: 0,
          overflow: "hidden",
          flex: 1,
          cursor: "pointer",
        }}
        onClick={() => navigate("/")}
      >
        <Box w={36} h={36}>
          <Image
            src="/favicon.png"
            alt="app icon"
            width={36}
            height={36}
            fit="cover"
            style={{
              transformOrigin: "center",
            }}
          />
        </Box>
        <Text fw={700} lineClamp={1} style={{ minWidth: 0 }}>
          maimai Score Hub
        </Text>
        <Badge size="md" variant="default">
          测试版
        </Badge>
      </Group>
      <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
        {rightSection ??
          (showProfile ? (
            <HeaderProfileCard profile={profile ?? null} onLogout={onLogout} />
          ) : null)}
      </Group>
    </Group>
  );
}
