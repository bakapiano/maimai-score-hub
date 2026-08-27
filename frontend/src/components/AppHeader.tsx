import {
  Badge,
  Box,
  Group,
  Image,
  Text,
  useComputedColorScheme,
} from "@mantine/core";
import { type ReactNode, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { syncAndroidStatusBar } from "../features/android-update/androidSystemBar";
import { HeaderProfileCard, type MiniProfile } from "./MiniProfileCard";

type AppHeaderProps = {
  profile?: MiniProfile | null;
  onLogout?: () => void;
  showProfile?: boolean;
  rightSection?: ReactNode;
  profileMenuItems?: ReactNode;
  offline?: boolean;
};

export function AppHeader({
  profile,
  onLogout,
  showProfile = true,
  rightSection,
  profileMenuItems,
  offline,
}: AppHeaderProps) {
  const navigate = useNavigate();
  const colorScheme = useComputedColorScheme("light");
  const headerAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const header = headerAnchorRef.current?.closest<HTMLElement>(
        ".msh-safe-header",
      );
      if (header) {
        syncAndroidStatusBar(header, colorScheme === "light");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [colorScheme]);

  return (
    <>
      <Group
        ref={headerAnchorRef}
        h="100%"
        px="md"
        justify="space-between"
        wrap="nowrap"
        visibleFrom="sm"
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
              <HeaderProfileCard
                profile={profile ?? null}
                onLogout={onLogout}
                offline={offline}
              />
            ) : null)}
        </Group>
      </Group>

      <Group
        h="100%"
        px="md"
        justify="flex-start"
        wrap="nowrap"
        hiddenFrom="sm"
        style={{ overflow: "hidden" }}
      >
        {rightSection ??
          (showProfile ? (
            <HeaderProfileCard
              profile={profile ?? null}
              onLogout={onLogout}
              offline={offline}
              menuItems={profileMenuItems}
              menuPosition="bottom-start"
              showUsernameOnMobile
            />
          ) : (
            <Group
              gap="sm"
              wrap="nowrap"
              style={{ minWidth: 0, cursor: "pointer" }}
              onClick={() => navigate("/")}
            >
              <Box w={32} h={32} style={{ flexShrink: 0 }}>
                <Image
                  src="/favicon.png"
                  alt=""
                  width={32}
                  height={32}
                  fit="cover"
                />
              </Box>
              <Text fw={700} lineClamp={1} style={{ minWidth: 0 }}>
                maimai Score Hub
              </Text>
            </Group>
          ))}
      </Group>
    </>
  );
}
