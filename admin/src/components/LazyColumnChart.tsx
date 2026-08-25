import { Suspense, lazy } from "react";
import type { ComponentType } from "react";

import { Skeleton } from "antd";

const ChartColumn = lazy(async () => {
  const module = await import("@ant-design/charts");
  return {
    default: module.Column as unknown as ComponentType<Record<string, unknown>>,
  };
});

export function LazyColumnChart(props: Record<string, unknown>) {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
      <ChartColumn {...props} />
    </Suspense>
  );
}
