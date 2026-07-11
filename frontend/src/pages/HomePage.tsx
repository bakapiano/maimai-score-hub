import {
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import {
  IconInfoCircle,
  IconMusic,
  IconRefresh,
  IconSettings,
} from "@tabler/icons-react";

import { useNavigate } from "react-router-dom";
import { useAuth } from "../providers/AuthContext";
import { AppCard } from "../components/AppCard";

type Banner = {
  title: string;
  description: string;
  icon: typeof IconRefresh;
  color: string;
  to: string;
};

const banners: Banner[] = [
  {
    title: "同步数据",
    description: "从 maimai DX NET 同步游戏成绩",
    icon: IconRefresh,
    color: "blue",
    to: "/app/sync",
  },
  {
    title: "乐曲成绩",
    description: "查看和分析你的游戏成绩数据",
    icon: IconMusic,
    color: "grape",
    to: "/app/scores",
  },
  {
    title: "网站设置",
    description: "主题、账号、危险操作",
    icon: IconSettings,
    color: "gray",
    to: "/app/settings",
  },
  {
    title: "关于网站",
    description: "项目说明、致谢、链接",
    icon: IconInfoCircle,
    color: "teal",
    to: "/about",
  },
];

export default function HomePage() {
  const navigate = useNavigate();
  const { offline } = useAuth();

  const handleClick = (banner: Banner) => {
    navigate(banner.to);
  };

  const isDisabled = (banner: Banner) =>
    offline && banner.to === "/app/sync";

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {banners.map((banner) => {
          const disabled = isDisabled(banner);
          return (
            <UnstyledButton
              key={banner.to}
              onClick={() => handleClick(banner)}
              disabled={disabled}
              style={{
                width: "100%",
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <AppCard>
                <Group wrap="nowrap">
                  <ThemeIcon size={48} radius="md" color={banner.color}>
                    <banner.icon size={28} />
                  </ThemeIcon>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text fw={600} size="lg">
                      {banner.title}
                    </Text>
                    <Text size="sm" c="dimmed" lineClamp={1}>
                      {disabled ? "需要登录后使用" : banner.description}
                    </Text>
                  </div>
                </Group>
              </AppCard>
            </UnstyledButton>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
