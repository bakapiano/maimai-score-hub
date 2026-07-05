import type { ReactNode } from "react";

import { Card, Statistic, Tag, Typography } from "antd";

const { Text } = Typography;

export function MetricCard({
  title,
  value,
  status,
  color,
  prefix,
}: {
  title: string;
  value: ReactNode;
  status?: string;
  color?: string;
  prefix?: ReactNode;
}) {
  return (
    <Card className="metric-card" variant="borderless">
      <div className="metric-card-title">
        <Text type="secondary">{title}</Text>
        {status ? <Tag color={color}>{status}</Tag> : null}
      </div>
      <Statistic value={String(value)} prefix={prefix} />
    </Card>
  );
}
