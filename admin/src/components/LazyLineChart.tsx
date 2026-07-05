import { Suspense, lazy } from "react";
import type { ComponentType } from "react";

import { Skeleton } from "antd";

const ChartLine = lazy(async () => {
  const module = await import("@ant-design/charts");
  return {
    default: module.Line as unknown as ComponentType<Record<string, unknown>>,
  };
});

export function LazyLineChart(props: Record<string, unknown>) {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
      <ChartLine {...props} />
    </Suspense>
  );
}
