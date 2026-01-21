import { Avatar, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { IconCopy, IconLogout } from "@tabler/icons-react";

import { normalizeMaimaiImgUrl } from "../utils/maimaiImages";
import { notifications } from "@mantine/notifications";

export type MiniProfile = {
  avatarUrl: string | null;
  username: string | null;
};

type Props = {
  profile: MiniProfile | null;
};

type HeaderProps = Props & {
  onLogout?: () => void;
};

// Compact version for header with dropdown menu
export function HeaderProfileCard({ profile, onLogout }: HeaderProps) {
  if (!profile) {
    return null;
  }

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
              {profile.username ?? "未知用户"}
            </Text>
            <Avatar
              src={
                profile.avatarUrl
                  ? normalizeMaimaiImgUrl(profile.avatarUrl)
                  : null
              }
              alt={profile.username ?? "avatar"}
              size={36}
              radius="0"
              imageProps={{
                referrerPolicy: "no-referrer",
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
