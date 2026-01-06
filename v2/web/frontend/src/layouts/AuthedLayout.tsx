import { AppShell, Button, Group, NavLink, Text } from "@mantine/core";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

import { ColorSchemeToggle } from "../components/ColorSchemeToggle";
import { useAuth } from "../providers/AuthProvider";

const links = [
  { label: "Home", to: "/app" },
  { label: "Debug (旧版)", to: "/app/debug" },
];

export default function AuthedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { clearToken } = useAuth();

  const handleLogout = () => {
    clearToken();
    navigate("/login", { replace: true });
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 200, breakpoint: "sm" }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>NetBot 控制台</Text>
          <Group>
            <ColorSchemeToggle />
            <Button variant="light" onClick={handleLogout} size="xs">
              退出登录
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        <Group justify="space-between" align="center" mb="sm">
          <Text fw={600} size="sm">
            导航
          </Text>
        </Group>
        {links.map((link) => (
          <NavLink
            key={link.to}
            component={Link}
            to={link.to}
            label={link.label}
            active={location.pathname === link.to}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
