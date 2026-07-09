import {
  Alert,
  Anchor,
  AppShell,
  Box,
  Burger,
  Drawer,
  Group,
  NavLink,
  Stack,
  Text,
  ThemeIcon,
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconBug,
  IconDownload,
  IconHome,
  IconInfoCircle,
  IconMusic,
  IconRefresh,
  IconSettings,
} from "@tabler/icons-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useMemo, useRef } from "react";

import { type MiniProfile } from "../components/MiniProfileCard";
import { AppHeader } from "../components/AppHeader";
import { PageHeader } from "../components/PageHeader";
import { SettingsPanel } from "../components/SettingsPanel";
import { AppFooter } from "../components/AppFooter";
import { InstallAppButton } from "../components/InstallAppButton";
import { useAuth } from "../providers/AuthContext";
import { usePwaInstall } from "../hooks/usePwaInstall";
import { useDisclosure } from "@mantine/hooks";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { getCachedProfile } from "../utils/offlineCache";

type PageMeta = {
  label: string;
  to: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  color?: string;
  hidden?: boolean;
};

const pages: PageMeta[] = [
  {
    label: "网站首页",
    to: "/app",
    title: "网站首页",
    description: "开始使用 maimai Score Hub",
    icon: <IconHome size={18} />,
    color: "teal",
  },
  {
    label: "同步数据",
    to: "/app/sync",
    title: "同步数据",
    description: "从 maimai DX NET 同步游戏成绩",
    icon: <IconRefresh size={18} />,
    color: "blue",
  },
  {
    label: "乐曲成绩",
    to: "/app/scores",
    title: "乐曲成绩",
    description: "查看和分析你的游戏成绩数据",
    icon: <IconMusic size={18} />,
    color: "grape",
  },
  {
    label: "Debug",
    to: "/app/debug",
    title: "调试工具",
    description: "用于开发和调试的内部工具页面",
    icon: <IconBug size={18} />,
    color: "orange",
    hidden: true,
  },
];

function readLastFriendCode() {
  try {
    return localStorage.getItem("lastFriendCode");
  } catch {
    return null;
  }
}

function readCachedMiniProfile(friendCode?: string | null): MiniProfile | null {
  const cached = getCachedProfile();
  if (!cached) {return null;}

  const knownFriendCode = friendCode ?? readLastFriendCode();
  if (
    cached.friendCode &&
    knownFriendCode &&
    cached.friendCode !== knownFriendCode
  ) {
    return null;
  }

  return { avatarUrl: cached.avatarUrl, username: cached.username };
}

function InstallAppGuideModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { status } = usePwaInstall();
  const touchStartX = useRef<number | null>(null);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="安装应用"
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
          <div>
            <Text size="sm" fw={500} mb="xs">
              应用
            </Text>
            {status === "prompt" && (
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  将 maimai Score Hub 安装为应用后，可以从桌面或主屏幕直接打开。
                </Text>
                <InstallAppButton fullWidth variant="filled" />
              </Stack>
            )}
            {status === "ios" && (
              <Stack gap="xs">
                <Text size="sm">
                  iOS 需要通过 Safari 的分享菜单添加到主屏幕。
                </Text>
                <Text size="sm" c="dimmed">
                  点击底部分享按钮，然后选择“添加到主屏幕”。
                </Text>
              </Stack>
            )}
            {status === "installed" && (
              <Text size="sm" c="dimmed">
                应用已经安装，或当前正在以应用模式运行。
              </Text>
            )}
            {status === "unavailable" && (
              <Text size="sm" c="dimmed">
                当前浏览器暂未提供安装入口。可以尝试使用 Chrome、Edge 或移动端浏览器的菜单添加到主屏幕。
              </Text>
            )}
          </div>
        </Stack>
      </Box>
    </Drawer>
  );
}

export default function AuthedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { clearToken, offline, setOffline, profile: authProfile } = useAuth();
  const [opened, { toggle, close: closeNav }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] =
    useDisclosure(false);
  const [
    installGuideOpened,
    { open: openInstallGuide, close: closeInstallGuide },
  ] = useDisclosure(false);
  // useMantineColorScheme returns the raw setting ("light" | "dark" |
  // "auto"). For visual conditionals like the header background we need
  // the RESOLVED scheme — useComputedColorScheme resolves "auto" against
  // prefers-color-scheme so dark-mode-via-system works correctly.
  const colorScheme = useComputedColorScheme("light");
  const cachedProfile = useMemo(
    () => readCachedMiniProfile(authProfile?.friendCode),
    [authProfile?.friendCode],
  );
  const touchStartX = useRef<number | null>(null);

  const currentPage = pages.find((p) => p.to === location.pathname);
  useDocumentTitle(currentPage?.title ?? null);

  const handleLogout = () => {
    if (offline) {
      setOffline(false);
    }
    clearToken();
    navigate("/login", { replace: true });
  };

  const profile: MiniProfile | null = offline
    ? cachedProfile
    : authProfile?.profile
      ? {
          avatarUrl: authProfile.profile.avatarUrl,
          username: authProfile.profile.username,
        }
      : authProfile
        ? {
            avatarUrl: cachedProfile?.avatarUrl ?? null,
            username: authProfile.username ?? cachedProfile?.username ?? null,
          }
        : cachedProfile;

  const headerBg =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-6)"
      : "var(--mantine-color-gray-0)";

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !opened },
      }}
      padding={0}
    >
      <AppShell.Header>
        <AppHeader profile={profile} onLogout={handleLogout} offline={offline} />
      </AppShell.Header>

      <AppShell.Navbar
        p="md"
        withBorder
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const startX = touchStartX.current;
          touchStartX.current = null;
          if (startX === null) {return;}
          const endX = event.changedTouches[0]?.clientX ?? startX;
          if (startX - endX > 50) {
            closeNav();
          }
        }}
      >
        <Stack h="100%">
          {/* Top: Navigation links */}
          <Group gap={4}>
            {pages
              .filter((page) => !page.hidden)
              .map((page) => {
                const isDisabled = offline && page.to === "/app/sync";
                return (
                <NavLink
                  key={page.to}
                  component={Link}
                  to={page.to}
                  label={page.label}
                  leftSection={
                    <ThemeIcon size={28} radius="md" color={page.color}>
                      {page.icon}
                    </ThemeIcon>
                  }
                  active={location.pathname === page.to}
                  onClick={closeNav}
                  style={isDisabled ? { opacity: 0.5 } : undefined}
                />
                );
              })}

            <NavLink
              label="网站设置"
              leftSection={
                <ThemeIcon size={28} radius="md" color="gray">
                  <IconSettings size={18} />
                </ThemeIcon>
              }
              onClick={() => {
                closeNav();
                openSettings();
              }}
            />

            <NavLink
              label="安装应用"
              leftSection={
                <ThemeIcon size={28} radius="md" color="cyan">
                  <IconDownload size={18} />
                </ThemeIcon>
              }
              onClick={() => {
                closeNav();
                openInstallGuide();
              }}
            />

            <NavLink
              component={Link}
              to="/about"
              label="关于网站"
              leftSection={
                <ThemeIcon size={28} radius="md" color="blue">
                  <IconInfoCircle size={18} />
                </ThemeIcon>
              }
              onClick={closeNav}
            />
          </Group>
        </Stack>
      </AppShell.Navbar>

      <SettingsPanel opened={settingsOpened} onClose={closeSettings} />
      <InstallAppGuideModal
        opened={installGuideOpened}
        onClose={closeInstallGuide}
      />

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        <Box
          hiddenFrom="sm"
          style={{
            position: "fixed",
            left: 16,
            bottom: 16,
            zIndex: 2000,
          }}
        >
          <Box
            w={48}
            h={48}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor:
                colorScheme === "dark"
                  ? "var(--mantine-color-dark-4)"
                  : "var(--mantine-color-gray-2)",
              borderRadius: 999,
              boxShadow: "var(--mantine-shadow-sm)",
            }}
          >
            <Burger opened={opened} onClick={toggle} size="sm" />
          </Box>
        </Box>
        {currentPage && (
          <Box
            py={{ base: "xs", sm: "lg" }}
            px="md"
            style={{
              backgroundColor: headerBg,
            }}
          >
            <div style={{ maxWidth: 838, margin: "0 auto" }}>
              <PageHeader
                title={currentPage.title}
                description={currentPage.description}
                hideDescriptionOnMobile
              />
            </div>
          </Box>
        )}
        {offline && (
          <Box px="md" pt="md">
            <div style={{ maxWidth: 838, margin: "0 auto" }}>
              <Alert
                variant="light"
                color="yellow"
                icon={<IconInfoCircle size={18} />}
                radius="md"
              >
                当前处于离线模式，仅可查看缓存的成绩数据：
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  onClick={() => {
                    setOffline(false);
                    clearToken();
                    navigate("/login", { replace: true });
                  }}
                >
                  登录来使用完整功能
                </Anchor>
              </Alert>
            </div>
          </Box>
        )}
        <Box p="md">
          <div
            style={{
              maxWidth: 838,
              margin: "0 auto",
              width: "100%",
            }}
          >
            <Outlet context={{ openSettings }} />
          </div>
        </Box>

        <AppFooter />
      </AppShell.Main>
    </AppShell>
  );
}
