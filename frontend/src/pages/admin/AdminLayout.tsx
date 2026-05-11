import {
  AppShell,
  Box,
  Burger,
  Button,
  Card,
  Container,
  NavLink,
  PasswordInput,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconBug,
  IconClock,
  IconClockBolt,
  IconDatabase,
  IconLogs,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "../../api/appClient";
import { useAdminPassword } from "./adminUtils";
import { useDisclosure } from "@mantine/hooks";

type AdminPageMeta = {
  label: string;
  to: string;
  icon: React.ReactNode;
  color: string;
};

const adminPages: AdminPageMeta[] = [
  {
    label: "实时监控",
    to: "/admin",
    icon: <IconClock size={18} />,
    color: "orange",
  },
  {
    label: "自动更新监控",
    to: "/admin/auto-update",
    icon: <IconClockBolt size={18} />,
    color: "indigo",
  },
  {
    label: "数据同步",
    to: "/admin/sync",
    icon: <IconDatabase size={18} />,
    color: "blue",
  },
  {
    label: "任务调试",
    to: "/admin/job-debug",
    icon: <IconBug size={18} />,
    color: "yellow",
  },
  {
    label: "用户列表",
    to: "/admin/users",
    icon: <IconUsers size={18} />,
    color: "cyan",
  },
  {
    label: "sdgb worker",
    to: "/admin/sdgb-worker",
    icon: <IconRobot size={18} />,
    color: "grape",
  },
  {
    label: "Worker 日志",
    to: "/admin/worker-logs",
    icon: <IconLogs size={18} />,
    color: "teal",
  },
];

export default function AdminLayout() {
  const { password, savePassword } = useAdminPassword();
  const [inputPassword, setInputPassword] = useState(password);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const [opened, { toggle, close }] = useDisclosure(false);
  const { colorScheme } = useMantineColorScheme();
  const touchStartX = useRef<number | null>(null);

  const verifyPassword = useCallback(async () => {
    if (!inputPassword.trim()) {
      setError("请输入管理员密码");
      return;
    }
    setVerifying(true);
    setError("");

    const res = await adminApi.getStats({
      headers: { "x-admin-password": inputPassword.trim() },
    });
    setVerifying(false);

    if (res.status === 200) {
      savePassword(inputPassword.trim());
      setVerified(true);
    } else {
      setError(`验证失败 (HTTP ${res.status})`);
    }
  }, [inputPassword, savePassword]);

  // Auto verify if password is stored
  useEffect(() => {
    if (password && !verified) {
      setInputPassword(password);
      (async () => {
        setVerifying(true);
        const res = await adminApi.getStats({
          headers: { "x-admin-password": password },
        });
        setVerifying(false);
        if (res.status === 200) {
          setVerified(true);
        }
      })();
    }
  }, [password, verified]);

  if (!verified) {
    return (
      <Container size="xs" py="xl">
        <Card withBorder shadow="sm" padding="xl" radius="md">
          <Stack gap="md">
            <Title order={3} ta="center">
              管理员登录
            </Title>
            <PasswordInput
              label="管理员密码"
              placeholder="输入密码"
              value={inputPassword}
              onChange={(e) => setInputPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void verifyPassword();
                }
              }}
            />
            {error && (
              <Text size="sm" c="red">
                {error}
              </Text>
            )}
            <Button onClick={verifyPassword} loading={verifying} fullWidth>
              登录
            </Button>
          </Stack>
        </Card>
      </Container>
    );
  }

  return (
    <AppShell
      navbar={{
        width: 200,
        breakpoint: "sm",
        collapsed: { mobile: !opened },
      }}
      padding="md"
    >
      <AppShell.Navbar
        p="sm"
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
        <Stack gap={4} style={{ flex: 1 }}>
          <Text size="sm" fw={700} c="dimmed" mb="xs" px="sm">
            管理后台
          </Text>
          {adminPages.map((page) => (
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
        </Stack>

        <Box mt="auto" pt="md">
          <Button
            variant="subtle"
            size="xs"
            fullWidth
            onClick={() => {
              savePassword("");
              setVerified(false);
              setInputPassword("");
              navigate("/admin");
            }}
          >
            退出登录
          </Button>
        </Box>
      </AppShell.Navbar>

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
        <Outlet context={{ password }} />
      </AppShell.Main>
    </AppShell>
  );
}
