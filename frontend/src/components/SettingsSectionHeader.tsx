import { Group, Text } from "@mantine/core";

export function SettingsSectionHeader({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <Group gap="xs" align="center">
      {icon}
      <Text fw={700}>{title}</Text>
    </Group>
  );
}
