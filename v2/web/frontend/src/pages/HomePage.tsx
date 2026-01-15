import {
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { IconMusic, IconRefresh } from "@tabler/icons-react";

import { useNavigate } from "react-router-dom";

const banners = [
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
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {banners.map((banner) => (
          <UnstyledButton
            key={banner.to}
            onClick={() => navigate(banner.to)}
            style={{ width: "100%" }}
          >
            <Card withBorder shadow="sm" padding="lg" radius="md">
              <Group wrap="nowrap">
                <ThemeIcon size={48} radius="md" color={banner.color}>
                  <banner.icon size={28} />
                </ThemeIcon>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text fw={600} size="lg">
                    {banner.title}
                  </Text>
                  <Text size="sm" c="dimmed" lineClamp={1}>
                    {banner.description}
                  </Text>
                </div>
              </Group>
            </Card>
          </UnstyledButton>
        ))}
      </SimpleGrid>

      {/* <Text c="dimmed" size="sm">
        更多功能开发中...
      </Text> */}
    </Stack>
  );
}
