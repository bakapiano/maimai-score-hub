import {
  AppShell,
  Box,
  Button,
  Card,
  Container,
  NavLink,
  PasswordInput,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconBug,
  IconClock,
  IconDatabase,
  IconUsers,
} from "@tabler/icons-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";

import { adminFetch, useAdminPassword, type AdminStats } from "./adminUtils";

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
];

export default function AdminLayout() {
  const { password, savePassword } = useAdminPassword();
  const [inputPassword, setInputPassword] = useState(password);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();

  const verifyPassword = useCallback(async () => {
    if (!inputPassword.trim()) {
      setError("请输入管理员密码");
      return;
    }
    setVerifying(true);
    setError("");

    const res = await adminFetch<AdminStats>(
      "/api/admin/stats",
      inputPassword.trim(),
    );
    setVerifying(false);

    if (res.ok) {
      savePassword(inputPassword.trim());
      setVerified(true);
    } else {
      setError(res.error || "验证失败");
    }
  }, [inputPassword, savePassword]);

  // Auto verify if password is stored
  useEffect(() => {
    if (password && !verified) {
      setInputPassword(password);
      (async () => {
        setVerifying(true);
        const res = await adminFetch<AdminStats>("/api/admin/stats", password);
        setVerifying(false);
        if (res.ok) {
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
      }}
      padding="md"
    >
      <AppShell.Navbar p="sm" withBorder>
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
        <Outlet context={{ password }} />
      </AppShell.Main>
    </AppShell>
  );
}
