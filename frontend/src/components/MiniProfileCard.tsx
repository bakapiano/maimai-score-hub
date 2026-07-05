import { Avatar, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { IconCopy, IconLogin, IconLogout } from "@tabler/icons-react";
import type { SyntheticEvent } from "react";

import { normalizeMaimaiImgUrl } from "../utils/maimaiImages";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";

export type MiniProfile = {
  avatarUrl: string | null;
  username: string | null;
};

type Props = {
  profile: MiniProfile | null;
};

type HeaderProps = Props & {
  onLogout?: () => void;
  offline?: boolean;
};

const AVATAR_PLACEHOLDER_SRC = "/avatar-placeholder.svg";

function getAvatarSrc(profile: MiniProfile | null) {
  return profile?.avatarUrl
    ? normalizeMaimaiImgUrl(profile.avatarUrl)
    : AVATAR_PLACEHOLDER_SRC;
}

function handleAvatarImageError(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  const placeholderUrl = new URL(AVATAR_PLACEHOLDER_SRC, window.location.origin)
    .href;
  if (img.src !== placeholderUrl) {
    img.src = AVATAR_PLACEHOLDER_SRC;
  }
}

// Compact version for header with dropdown menu
export function HeaderProfileCard({ profile, onLogout, offline }: HeaderProps) {
  const navigate = useNavigate();

  // In offline mode, show menu with login option
  if (offline) {
    return (
      <Menu shadow="md" width={160} position="bottom-end">
        <Menu.Target>
          <UnstyledButton>
            <Group gap="xs" wrap="nowrap">
              <Text
                size="sm"
                fw={500}
                lineClamp={1}
                style={{ maxWidth: 120 }}
                visibleFrom="sm"
              >
                {profile?.username ?? "离线模式"}
              </Text>
              <Avatar
                src={getAvatarSrc(profile)}
                alt={profile?.username ?? "avatar"}
                size={36}
                radius="0"
                imageProps={{
                  referrerPolicy: "no-referrer",
                  onError: handleAvatarImageError,
                  style: { transformOrigin: "center" },
                }}
              />
            </Group>
          </UnstyledButton>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconLogin size={16} />}
            onClick={() => {
              onLogout?.();
              navigate("/login", { replace: true });
            }}
          >
            前往登录
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  }

  // No profile yet (e.g. brand-new user that hasn't run a sync) — still
  // render the menu so the user has a way to log out / get to settings.
  // The label falls back to "我的账号"; avatar falls back to the same
  // placeholder ProfileCard uses.
  return (
    <Menu shadow="md" width={160} position="bottom-end">
      <Menu.Target>
        <UnstyledButton>
          <Group gap="xs" wrap="nowrap">
            <Text
              size="sm"
              fw={500}
              lineClamp={1}
              style={{ maxWidth: 120 }}
              visibleFrom="sm"
            >
              {profile?.username ?? "我的账号"}
            </Text>
            <Avatar
              src={getAvatarSrc(profile)}
              alt={profile?.username ?? "avatar"}
              size={36}
              radius="0"
              imageProps={{
                referrerPolicy: "no-referrer",
                onError: handleAvatarImageError,
                style: { transformOrigin: "center" },
              }}
            />
          </Group>
        </UnstyledButton>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconCopy size={16} />}
          onClick={() => {
            const friendCode = localStorage.getItem("lastFriendCode");
            if (friendCode) {
              const url = `${window.location.origin}/login?friendCode=${friendCode}`;
              navigator.clipboard.writeText(url);
              notifications.show({
                title: "链接已复制",
                message: "从此链接进入可自动填写好友代码",
                color: "teal",
              });
            } else {
              notifications.show({
                title: "无法生成链接",
                message: "未找到好友代码信息",
                color: "red",
              });
            }
          }}
        >
          快速登录链接
        </Menu.Item>
        <Menu.Item
          color="red"
          leftSection={<IconLogout size={16} />}
          onClick={onLogout}
        >
          退出登录
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
