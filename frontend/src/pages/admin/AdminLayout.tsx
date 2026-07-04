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
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconBug,
  IconChartBar,
  IconClock,
  IconDatabase,
  IconLogs,
  IconUsers,
} from "@tabler/icons-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "../../api/appClient";
import { useApiSharedSecret } from "./adminUtils";
import { useDisclosure } from "@mantine/hooks";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";

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
    label: "历史分析",
    to: "/admin/history",
    icon: <IconChartBar size={18} />,
    color: "grape",
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
    label: "实时日志流",
    to: "/admin/live-logs",
    icon: <IconLogs size={18} />,
    color: "teal",
  },
];

export default function AdminLayout() {
  const { password, savePassword } = useApiSharedSecret();
  const [inputPassword, setInputPassword] = useState(password);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const [opened, { toggle, close }] = useDisclosure(false);
  // Resolve "auto" to actual "light"/"dark" via prefers-color-scheme;
  // useMantineColorScheme would return the literal "auto" and break
  // the `colorScheme === "dark"` style checks below.
  const colorScheme = useComputedColorScheme("light");
  const touchStartX = useRef<number | null>(null);
  const currentPage = adminPages.find((page) => page.to === location.pathname);
  useDocumentTitle(currentPage?.label ?? "管理后台");

  const verifyPassword = useCallback(async () => {
    if (!inputPassword.trim()) {
      setError("请输入 API 共享密钥");
      return;
    }
    setVerifying(true);
    setError("");

    const res = await adminApi.getStats({
      headers: { "x-api-secret": inputPassword.trim() },
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
          headers: { "x-api-secret": password },
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
              管理入口
            </Title>
            <PasswordInput
              label="API 共享密钥"
              placeholder="输入 API 共享密钥"
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
