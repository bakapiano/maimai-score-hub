import { Button, Card, Segmented, Space } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";

import { DynamicTable } from "../components/DynamicTable";
import { PageHeader } from "../components/PageHeader";
import { adminFetch } from "../api/client";
import { useAdminContext } from "../utils/admin";

type HistorySection = "api" | "rum" | "analytics" | "workers";

const SECTION_LABELS: Record<HistorySection, string> = {
  api: "Backend API",
  rum: "Frontend RUM",
  analytics: "Product Analytics",
  workers: "Workers / External API",
};

export default function HistoryPage() {
  const { password, environment, historyWindow } = useAdminContext();
  const [section, setSection] = useState<HistorySection>("api");
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const body = await adminFetch<Array<Record<string, unknown>>>(
        environment,
        `/admin/history/${section}`,
        password,
        { env: environment, window: historyWindow },
      );
      setRows(body);
    } finally {
      setLoading(false);
    }
  }, [environment, historyWindow, password, section]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page-stack">
      <PageHeader
        title="历史分析"
        description="ClickHouse 历史指标；本地和 devtunnel 默认 dev，生产默认 prod。"
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={loading}
          >
            刷新
          </Button>
        }
      />

      <Card className="admin-card filter-card">
        <Space wrap>
          <Segmented
            value={section}
            onChange={(value) => setSection(value as HistorySection)}
            options={(Object.keys(SECTION_LABELS) as HistorySection[]).map(
              (key) => ({
                value: key,
                label: SECTION_LABELS[key],
              }),
            )}
          />
        </Space>
      </Card>

      <Card
        className="admin-card wide-table-card"
        title={SECTION_LABELS[section]}
        loading={loading}
      >
        <DynamicTable rows={rows} />
      </Card>
    </div>
  );
}
