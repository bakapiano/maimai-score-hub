import { Box, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function SyncMetric({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Group gap="xs" align="center" wrap="nowrap" style={{ minHeight: 48 }}>
      <Box
        style={{
          width: 20,
          height: 20,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--mantine-color-gray-6)",
        }}
      >
        {icon}
      </Box>
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        {children}
      </Stack>
    </Group>
  );
}
