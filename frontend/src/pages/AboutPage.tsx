import {
  Anchor,
  Box,
  Button,
  Container,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconBrandBilibili,
  IconBrandGithub,
  IconBrandQq,
  IconHeart,
  IconLink,
  IconUsers,
} from "@tabler/icons-react";

import { AppFooter } from "../components/AppFooter";
import { AppHeader } from "../components/AppHeader";
import { AppShell } from "@mantine/core";
import { useNavigate } from "react-router-dom";

export default function AboutPage() {
  const navigate = useNavigate();

  return (
    <AppShell header={{ height: 56 }} padding={0}>
      <AppShell.Header>
        <AppHeader
          profile={null}
          onLogout={() => navigate("/login")}
          offline={false}
        />
      </AppShell.Header>
      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        <Box p="md" pt="xl">
          <Container size="sm">
            <Stack gap="xl">
              <Button
                // variant="subtle"
                leftSection={<IconArrowLeft size={18} />}
                onClick={() => navigate(-1)}
                w="fit-content"
              >
                返回
              </Button>
              <Paper withBorder shadow="sm" p="xl" radius="md">
                <Stack gap="md">
                  <Group gap="sm">
                    <ThemeIcon
                      size={40}
                      radius="md"
                      color="red"
                      variant="light"
                    >
                      <IconHeart size={24} />
                    </ThemeIcon>
                    <Title order={3}>作者</Title>
                  </Group>

                  <Divider />

                  <Group gap="sm">
                    <Text size="md">
                      Made with ❤️ by{" "}
                      <Text span fw={600}>
                        Bakapiano
                      </Text>
                    </Text>
                  </Group>

                  <Stack gap="xs">
                    <Group gap="sm">
                      <ThemeIcon
                        size={28}
                        radius="md"
                        color="dark"
                        variant="light"
                      >
                        <IconBrandGithub size={18} />
                      </ThemeIcon>
                      <Anchor
                        href="https://github.com/Bakapiano"
                        target="_blank"
                        size="sm"
                      >
                        github.com/Bakapiano
                      </Anchor>
                    </Group>

                    <Group gap="sm">
                      <ThemeIcon
                        size={28}
                        radius="md"
                        color="blue"
                        variant="light"
                      >
                        <IconBrandBilibili size={18} />
                      </ThemeIcon>
                      <Anchor
                        href="https://space.bilibili.com/919174"
                        target="_blank"
                        size="sm"
                      >
                        space.bilibili.com/919174
                      </Anchor>
                    </Group>

                    <Group gap="sm">
                      <ThemeIcon
                        size={28}
                        radius="md"
                        color="cyan"
                        variant="light"
                      >
                        <IconBrandQq size={18} />
                      </ThemeIcon>
                      <Text size="sm">QQ：2514965141</Text>
                    </Group>
                  </Stack>
                </Stack>
              </Paper>

              <Paper withBorder shadow="sm" p="xl" radius="md">
                <Stack gap="md">
                  <Group gap="sm">
                    <ThemeIcon
                      size={40}
                      radius="md"
                      color="teal"
                      variant="light"
                    >
                      <IconLink size={24} />
                    </ThemeIcon>
                    <Title order={3}>项目地址</Title>
                  </Group>

                  <Divider />

                  <Group gap="sm">
                    <ThemeIcon
                      size={28}
                      radius="md"
                      color="dark"
                      variant="light"
                    >
                      <IconBrandGithub size={18} />
                    </ThemeIcon>
                    <Anchor
                      href="https://github.com/bakapiano/maimai-score-hub"
                      target="_blank"
                      size="sm"
                    >
                      github.com/bakapiano/maimai-score-hub
                    </Anchor>
                  </Group>
                </Stack>
              </Paper>

              <Paper withBorder shadow="sm" p="xl" radius="md">
                <Stack gap="md">
                  <Group gap="sm">
                    <ThemeIcon
                      size={40}
                      radius="md"
                      color="violet"
                      variant="light"
                    >
                      <IconUsers size={24} />
                    </ThemeIcon>
                    <Title order={3}>交流群</Title>
                  </Group>

                  <Divider />

                  <Group gap="sm">
                    <ThemeIcon
                      size={28}
                      radius="md"
                      color="cyan"
                      variant="light"
                    >
                      <IconBrandQq size={18} />
                    </ThemeIcon>
                    <Text size="sm">QQ 4群：1078979790</Text>
                  </Group>
                  <Group gap="sm">
                    <ThemeIcon
                      size={28}
                      radius="md"
                      color="cyan"
                      variant="light"
                    >
                      <IconBrandQq size={18} />
                    </ThemeIcon>
                    <Text size="sm">QQ 5群：1098992498</Text>
                  </Group>
                </Stack>
              </Paper>
            </Stack>
          </Container>
        </Box>

        <AppFooter />
      </AppShell.Main>
    </AppShell>
  );
}
