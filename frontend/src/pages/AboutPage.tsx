import {
  ActionIcon,
  AppShell,
  Box,
  Button,
  Container,
  Divider,
  Group,
  Image,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconBrandBilibili,
  IconBrandGithub,
  IconBrandQq,
  IconCopy,
  IconExternalLink,
  IconLogin,
  IconUsers,
} from "@tabler/icons-react";
import { type ReactNode, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { AppCard } from "../components/AppCard";
import { AppHeader } from "../components/AppHeader";
import type { MiniProfile } from "../components/MiniProfileCard";
import { SettingsSectionHeader } from "../components/SettingsSectionHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../providers/AuthContext";
import { copyTextToClipboard } from "../utils/clipboard";
import { getCachedProfile } from "../utils/offlineCache";
import classes from "./AboutPage.module.css";

function resolveHeaderProfile(
  authProfile: ReturnType<typeof useAuth>["profile"],
  offline: boolean,
): MiniProfile | null {
  const cached = getCachedProfile();
  const cachedMini = cached
    ? { avatarUrl: cached.avatarUrl, username: cached.username }
    : null;

  if (offline) {
    return cachedMini;
  }
  if (authProfile?.profile) {
    return {
      avatarUrl: authProfile.profile.avatarUrl,
      username: authProfile.profile.username,
    };
  }
  if (authProfile) {
    return {
      avatarUrl: cachedMini?.avatarUrl ?? null,
      username: authProfile.username ?? cachedMini?.username ?? null,
    };
  }
  return cachedMini;
}

function copyQqNumber(label: string, number: string) {
  void copyTextToClipboard(number).then((copied) => {
    notifications.show(
      copied
        ? { title: `${label}已复制`, message: number, color: "teal" }
        : {
            title: "复制失败",
            message: `请手动复制：${number}`,
            color: "red",
          },
    );
  });
}

function ContactLinkTile({
  icon,
  color,
  label,
  value,
  href,
}: {
  icon: ReactNode;
  color: string;
  label: string;
  value: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={classes.contactTile}
    >
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon size={28} radius="md" color={color} variant="light">
          {icon}
        </ThemeIcon>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" lh={1.2}>
            {label}
          </Text>
          <Text size="sm" fw={500} truncate>
            {value}
          </Text>
        </Stack>
      </Group>
      <IconExternalLink
        size={14}
        color="var(--mantine-color-dimmed)"
        style={{ flexShrink: 0 }}
        aria-hidden
      />
    </a>
  );
}

function ContactCopyTile({
  icon,
  color,
  label,
  value,
}: {
  icon: ReactNode;
  color: string;
  label: string;
  value: string;
}) {
  return (
    <UnstyledButton
      type="button"
      className={classes.contactTile}
      onClick={() => copyQqNumber(label, value)}
      aria-label={`复制${label} ${value}`}
    >
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon size={28} radius="md" color={color} variant="light">
          {icon}
        </ThemeIcon>
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" lh={1.2}>
            {label}
          </Text>
          <Text size="sm" fw={500} truncate>
            {value}
          </Text>
        </Stack>
      </Group>
      <IconCopy
        size={14}
        color="var(--mantine-color-dimmed)"
        style={{ flexShrink: 0 }}
        aria-hidden
      />
    </UnstyledButton>
  );
}

function BrandOverviewCard() {
  return (
    <AppCard>
      <Stack gap="md">
        <Group justify="space-between" align="center" gap="md" wrap="wrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Box w={44} h={44} style={{ flexShrink: 0 }}>
              <Image
                src="/favicon.png"
                alt="maimai Score Hub"
                w={44}
                h={44}
                radius="md"
                fit="cover"
              />
            </Box>
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Title order={3} size="h4" lh={1.2}>
                maimai Score Hub
              </Title>
              <Text size="xs" c="dimmed">
                舞萌 DX 成绩同步与查询 · Made by Bakapiano
              </Text>
            </Stack>
          </Group>

          <Button
            component="a"
            href="https://github.com/bakapiano/maimai-score-hub"
            target="_blank"
            rel="noreferrer"
            variant="default"
            size="xs"
            leftSection={<IconBrandGithub size={15} />}
            rightSection={<IconExternalLink size={13} />}
          >
            GitHub 仓库
          </Button>
        </Group>

        <Divider />

        <Stack gap="xs">
          <Text size="xs" fw={600} c="dimmed">
            作者与联系
          </Text>
          <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="xs">
            <ContactLinkTile
              icon={<IconBrandGithub size={16} />}
              color="gray"
              label="GitHub"
              value="Bakapiano"
              href="https://github.com/Bakapiano"
            />
            <ContactLinkTile
              icon={<IconBrandBilibili size={16} />}
              color="blue"
              label="Bilibili"
              value="UID 919174"
              href="https://space.bilibili.com/919174"
            />
            <ContactCopyTile
              icon={<IconBrandQq size={16} />}
              color="cyan"
              label="作者 QQ"
              value="2514965141"
            />
          </SimpleGrid>
        </Stack>
      </Stack>
    </AppCard>
  );
}

function CommunityGroupTile({
  title,
  groupNumber,
  color,
  qrSrc,
}: {
  title: string;
  groupNumber: string;
  color: string;
  qrSrc: string;
}) {
  return (
    <Paper withBorder radius="md" p="md" className={classes.groupTile}>
      <Stack gap="md" align="center">
        <Group justify="space-between" align="center" w="100%" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon size={28} radius="md" color={color} variant="light">
              <IconBrandQq size={16} />
            </ThemeIcon>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={600} size="sm" lh={1.3}>
                {title}
              </Text>
              <Text size="xs" c="dimmed" lh={1.2}>
                QQ 群 {groupNumber}
              </Text>
            </Stack>
          </Group>

          <Tooltip label="复制群号" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`复制${title}群号 ${groupNumber}`}
              onClick={() => copyQqNumber(`${title}群号`, groupNumber)}
            >
              <IconCopy size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <a
          href={qrSrc}
          target="_blank"
          rel="noreferrer"
          aria-label={`查看${title}二维码原图`}
          className={classes.qrLink}
        >
          <Box className={classes.qrFrame}>
            <Image
              src={qrSrc}
              radius="sm"
              alt={`maimai Score Hub ${title}二维码`}
            />
          </Box>
          <Text size="xs" c="dimmed">
            点击查看原图
          </Text>
        </a>
      </Stack>
    </Paper>
  );
}

export default function AboutPage() {
  useDocumentTitle("关于网站");
  const navigate = useNavigate();
  const {
    token,
    clearToken,
    offline,
    setOffline,
    profile: authProfile,
  } = useAuth();
  const isAuthed = Boolean(token) || offline;

  const profile = useMemo(
    () => (isAuthed ? resolveHeaderProfile(authProfile, offline) : null),
    [isAuthed, authProfile, offline],
  );

  const handleLogout = () => {
    if (offline) {
      setOffline(false);
    }
    clearToken();
    navigate("/login", { replace: true });
  };

  return (
    <AppShell
      header={{ height: "var(--msh-mobile-header-height)" }}
      padding={0}
    >
      <AppShell.Header className="msh-safe-header">
        <AppHeader
          profile={profile}
          onLogout={handleLogout}
          offline={offline}
          showProfile={isAuthed}
          rightSection={
            isAuthed ? undefined : (
              <Button
                size="sm"
                variant="light"
                leftSection={<IconLogin size={16} />}
                onClick={() => navigate("/login")}
              >
                登录
              </Button>
            )
          }
        />
      </AppShell.Header>
      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100dvh",
          paddingBottom: "var(--msh-mobile-safe-area-bottom)",
        }}
      >
        <Box p="md" pt="lg">
          <Container size="sm" px={0} style={{ maxWidth: 720 }}>
            <Stack gap="md">
              <Button
                variant="subtle"
                color="gray"
                size="sm"
                px="xs"
                leftSection={<IconArrowLeft size={16} />}
                onClick={() => {
                  if (window.history.length > 1) {
                    navigate(-1);
                  } else {
                    navigate(isAuthed ? "/app" : "/login", { replace: true });
                  }
                }}
                w="fit-content"
              >
                返回
              </Button>

              <BrandOverviewCard />

              <AppCard>
                <Stack gap="md">
                  <SettingsSectionHeader
                    icon={<IconUsers size={16} />}
                    title="交流群"
                  />
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <CommunityGroupTile
                      title="用户交流群"
                      groupNumber="1098992498"
                      color="cyan"
                      qrSrc="/community/user-group-qr.jpg"
                    />
                    <CommunityGroupTile
                      title="开发交流群"
                      groupNumber="850526534"
                      color="orange"
                      qrSrc="/community/developer-group-qr.jpg"
                    />
                  </SimpleGrid>
                </Stack>
              </AppCard>
            </Stack>
          </Container>
        </Box>

      </AppShell.Main>
    </AppShell>
  );
}
