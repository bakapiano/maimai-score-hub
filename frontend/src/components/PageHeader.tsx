import { Stack, Text, Title } from "@mantine/core";

interface PageHeaderProps {
  title: string;
  description: string;
  hideDescriptionOnMobile?: boolean;
}

export function PageHeader({
  title,
  description,
  hideDescriptionOnMobile = false,
}: PageHeaderProps) {
  if (hideDescriptionOnMobile) {
    return (
      <Stack gap={4}>
        <Title order={3} hiddenFrom="sm">
          {title}
        </Title>
        <Title order={2} visibleFrom="sm">
          {title}
        </Title>
        <Text size="sm" visibleFrom="sm">
          {description}
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={4}>
      <Title order={2}>{title}</Title>
      <Text size="sm">{description}</Text>
    </Stack>
  );
}
