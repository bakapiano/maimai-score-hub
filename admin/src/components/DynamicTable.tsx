import { Card, Empty, Grid, Space, Table, Typography } from "antd";

import { formatCell } from "../utils/admin";

const { Text } = Typography;
const { useBreakpoint } = Grid;

export function DynamicTable({
  rows,
  maxHeight,
  size = "small",
}: {
  rows: Array<Record<string, unknown>>;
  maxHeight?: number;
  size?: "small" | "middle";
}) {
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const columns = keys.map((key) => ({
    title: key,
    dataIndex: key,
    key,
    render: (value: unknown) => (
      <Text className="cell-monospace" title={formatCell(value)}>
        {formatCell(value)}
      </Text>
    ),
  }));

  if (!rows.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />;
  }

  if (isMobile) {
    return (
      <div className="mobile-record-list">
        {rows.map((row, index) => (
          <Card key={index} size="small">
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              {keys.map((key) => (
                <div className="mobile-field" key={key}>
                  <Text type="secondary">{key}</Text>
                  <Text className="cell-monospace">{formatCell(row[key])}</Text>
                </div>
              ))}
            </Space>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <Table
      className="responsive-table"
      size={size}
      rowKey={(_, index) => String(index)}
      columns={columns}
      dataSource={rows}
      pagination={false}
      tableLayout="fixed"
      scroll={maxHeight ? { y: maxHeight } : undefined}
    />
  );
}
