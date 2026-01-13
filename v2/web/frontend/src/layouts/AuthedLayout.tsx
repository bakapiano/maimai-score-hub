import { AppShell, Burger, Button, Group, NavLink, Text } from "@mantine/core";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

import { ColorSchemeToggle } from "../components/ColorSchemeToggle";
import { useAuth } from "../providers/AuthProvider";
import { useDisclosure } from "@mantine/hooks";

const links = [
  { label: "Home", to: "/app" },
  { label: "成绩", to: "/app/scores" },
  { label: "Debug (旧版)", to: "/app/debug" },
];

export default function AuthedLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { clearToken } = useAuth();
  const [opened, { toggle }] = useDisclosure(false);

  const handleLogout = () => {
    clearToken();
    navigate("/login", { replace: true });
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !opened },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
            />
            <Text fw={700}>maimai DX Copilot</Text>
          </Group>
          <Group>
            <ColorSchemeToggle />
            <Button variant="light" onClick={handleLogout} size="xs">
              退出登录
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" withBorder>
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
        <div
          style={{
            maxWidth: 1225,
            margin: "0 auto",
            width: "100%",
            overflowX: "hidden",
          }}
        >
          <Outlet />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
