import {
  Box,
  Group,
  Image,
  Text,
  UnstyledButton,
  useComputedColorScheme,
} from "@mantine/core";
import { IconHelpCircle } from "@tabler/icons-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { syncAndroidStatusBar } from "../features/android-update/androidSystemBar";
import { HeaderProfileCard, type MiniProfile } from "./MiniProfileCard";
import classes from "./AppHeader.module.css";

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
  const { pathname } = useLocation();
  const isAboutPage = pathname === "/about";
  const colorScheme = useComputedColorScheme("light");
  const headerAnchorRef = useRef<HTMLDivElement>(null);

  const helpButton = !isAboutPage ? (
    <UnstyledButton
      type="button"
      className={classes.helpButton}
      aria-label="获得帮助"
      onClick={() => navigate("/about")}
    >
      <IconHelpCircle size={15} stroke={2} />
      <span>帮助</span>
    </UnstyledButton>
  ) : null;

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
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          {rightSection ??
            (showProfile ? (
              <HeaderProfileCard
                profile={profile ?? null}
                onLogout={onLogout}
                offline={offline}
              />
            ) : (
              helpButton
            ))}
        </Group>
      </Group>

      <Group
        h="100%"
        px="md"
        gap="xs"
        justify="space-between"
        wrap="nowrap"
        hiddenFrom="sm"
        style={{ overflow: "hidden" }}
      >
        <Box style={{ minWidth: 0, overflow: "hidden" }}>
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
        </Box>
        {!rightSection ? helpButton : null}
      </Group>
    </>
  );
}
