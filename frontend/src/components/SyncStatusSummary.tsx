import { Badge, Box, Group, Loader, Stack, Text } from "@mantine/core";
import { IconCheck, IconRefresh, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";

export type SyncStatusVisualState = "idle" | "loading" | "completed" | "failed";

export function SyncStatusSummary({
  color,
  label,
  text,
  badge,
  state,
  action,
}: {
  color: string;
  label: string;
  text: string;
  badge?: string | null;
  state: SyncStatusVisualState;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="center" wrap="wrap">
      <Group
        gap="sm"
        align="center"
        wrap="nowrap"
        style={{ flex: "1 1 240px", minWidth: 0 }}
      >
        <Box
          style={{
            width: 42,
            height: 42,
            flex: "0 0 auto",
            borderRadius: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: `var(--mantine-color-${color}-7)`,
            background: `var(--mantine-color-${color}-light)`,
          }}
        >
          {state === "loading" ? (
            <Loader size="sm" color={color} />
          ) : state === "failed" ? (
            <IconX size={22} />
          ) : state === "completed" ? (
            <IconCheck size={22} />
          ) : (
            <IconRefresh size={22} />
          )}
        </Box>
        <Stack gap={1} style={{ minWidth: 0 }}>
          <Group gap="xs">
            <Text fw={700} size="md">
              {label}
            </Text>
            {badge && (
              <Badge variant="light" color={color} radius="xl" size="sm">
                {badge}
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {text}
          </Text>
        </Stack>
      </Group>
      {action}
    </Group>
  );
}
