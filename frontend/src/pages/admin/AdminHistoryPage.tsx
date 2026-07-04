import {
  Button,
  Card,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import {
  type AdminEnvironment,
  getDefaultAdminEnvironment,
  useAdminContext,
} from "./adminUtils";

type HistorySection = "api" | "rum" | "analytics" | "workers";
type HistoryWindow = "24h" | "7d" | "30d";

const SECTION_LABELS: Record<HistorySection, string> = {
  api: "Backend API",
  rum: "Frontend RUM",
  analytics: "Product Analytics",
  workers: "Workers / External API",
};

export default function AdminHistoryPage() {
  const { password } = useAdminContext();
  const [env, setEnv] = useState<AdminEnvironment>(() =>
    getDefaultAdminEnvironment(),
  );
  const [windowValue, setWindowValue] = useState<HistoryWindow>("24h");
  const [section, setSection] = useState<HistorySection>("api");
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ env, window: windowValue });
      const res = await fetch(
        `/api/v1/admin/history/${section}?${params.toString()}`,
        { headers: { "x-api-secret": password } },
      );
      if (res.ok) {
        setRows((await res.json()) as Array<Record<string, unknown>>);
      }
    } finally {
      setLoading(false);
    }
  }, [env, password, section, windowValue]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <Stack gap={0}>
          <Title order={2}>History</Title>
          <Text size="sm" c="dimmed">
            ClickHouse 历史分析；本地和 devtunnel 默认 dev，生产默认 prod
          </Text>
        </Stack>
        <Button
          leftSection={<IconRefresh size={16} />}
          onClick={() => void load()}
          loading={loading}
          variant="light"
        >
          刷新
        </Button>
      </Group>

      <Card withBorder>
        <Group>
          <Select
            label="数据环境"
            value={env}
            onChange={(value) => setEnv(value === "dev" ? "dev" : "prod")}
            data={[
              { value: "prod", label: "prod" },
              { value: "dev", label: "dev" },
            ]}
          />
          <Select
            label="Window"
            value={windowValue}
            onChange={(value) =>
              setWindowValue(
                value === "7d" || value === "30d" ? value : "24h",
              )
            }
            data={[
              { value: "24h", label: "24h" },
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
          />
        </Group>
      </Card>

      <SegmentedControl
        value={section}
        onChange={(value) => setSection(value as HistorySection)}
        data={(Object.keys(SECTION_LABELS) as HistorySection[]).map((key) => ({
          value: key,
          label: SECTION_LABELS[key],
        }))}
      />

      <RowsTable title={SECTION_LABELS[section]} rows={rows} />
    </Stack>
  );
}

function RowsTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
}) {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        {title}
      </Title>
      {!rows.length ? (
        <Text size="sm" c="dimmed">
          暂无数据
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={700}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                {keys.map((key) => (
                  <Table.Th key={key}>{key}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row, index) => (
                <Table.Tr key={index}>
                  {keys.map((key) => (
                    <Table.Td key={key}>{String(row[key] ?? "")}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}
