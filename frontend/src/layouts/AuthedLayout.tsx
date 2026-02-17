import {
  AppShell,
  Box,
  Burger,
  Group,
  NavLink,
  Stack,
  ThemeIcon,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconBug,
  IconHome,
  IconMusic,
  IconRefresh,
  IconSettings,
} from "@tabler/icons-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";

import { type MiniProfile } from "../components/MiniProfileCard";
import { AppHeader } from "../components/AppHeader";
import { PageHeader } from "../components/PageHeader";
import { SettingsPanel } from "../components/SettingsPanel";
import { usersApi } from "../api/appClient";
import { useAuth } from "../providers/AuthProvider";
import { useDisclosure } from "@mantine/hooks";

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

export default function AuthedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { token, clearToken } = useAuth();
  const [opened, { toggle, close }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] =
    useDisclosure(false);
  const { colorScheme } = useMantineColorScheme();
  const [profile, setProfile] = useState<MiniProfile | null>(null);
  const touchStartX = useRef<number | null>(null);

  const currentPage = pages.find((p) => p.to === location.pathname);

  const handleLogout = () => {
    clearToken();
    navigate("/login", { replace: true });
  };

  // Load profile for mini card
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    (async () => {
      const res = await usersApi.profile({
        headers: { authorization: `Bearer ${token}` },
      });

      if (cancelled) return;

      if (res.status === 200 && res.body?.profile) {
        setProfile({
          avatarUrl: (res.body.profile as MiniProfile).avatarUrl,
          username: (res.body.profile as MiniProfile).username,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

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
        <AppHeader profile={profile} onLogout={handleLogout} />
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
          if (startX === null) return;
          const endX = event.changedTouches[0]?.clientX ?? startX;
          if (startX - endX > 50) {
            close();
          }
        }}
      >
        <Stack h="100%">
          {/* Top: Navigation links */}
          <Group gap={4}>
            {pages
              .filter((page) => !page.hidden)
              .map((page) => (
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
                  onClick={close}
                />
              ))}

            <NavLink
              label="网站设置"
              leftSection={
                <ThemeIcon size={28} radius="md" color="gray">
                  <IconSettings size={18} />
                </ThemeIcon>
              }
              onClick={() => {
                close();
                openSettings();
              }}
            />
          </Group>
        </Stack>
      </AppShell.Navbar>

      <SettingsPanel opened={settingsOpened} onClose={closeSettings} />

      <AppShell.Main>
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
            py={"lg"}
            px="md"
            style={{
              backgroundColor: headerBg,
            }}
          >
            <div style={{ maxWidth: 838, margin: "0 auto" }}>
              <PageHeader
                title={currentPage.title}
                description={currentPage.description}
              />
            </div>
          </Box>
        )}
        <Box p="md">
          <div
            style={{
              maxWidth: 838,
              margin: "0 auto",
              width: "100%",
              overflowX: "hidden",
            }}
          >
            <Outlet />
          </div>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
