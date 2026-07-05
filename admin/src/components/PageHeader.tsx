import type { ReactNode } from "react";

import { Space, Typography } from "antd";

const { Text, Title } = Typography;

export function PageHeader({
  title,
  description,
  extra,
}: {
  title: string;
  description?: string;
  extra?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header-copy">
        <Title level={2}>{title}</Title>
        {description ? <Text type="secondary">{description}</Text> : null}
      </div>
      {extra ? (
        <Space wrap className="page-header-extra">
          {extra}
        </Space>
      ) : null}
    </div>
  );
}
