import type { ReactNode } from "react";

import { Card, Empty, Grid, Table } from "antd";
import type { TableProps } from "antd";

const { useBreakpoint } = Grid;

type ResponsiveTableProps<T extends object> = TableProps<T> & {
  renderMobileItem?: (item: T, index: number) => ReactNode;
};

export function ResponsiveTable<T extends object>({
  renderMobileItem,
  scroll,
  className,
  ...props
}: ResponsiveTableProps<T>) {
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  if (isMobile && renderMobileItem) {
    const data = props.dataSource ? Array.from(props.dataSource) : [];
    if (!data.length) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />;
    }

    return (
      <div className="mobile-record-list">
        {data.map((item, index) => (
          <Card key={getMobileKey(props.rowKey, item, index)} size="small">
            {renderMobileItem(item, index)}
          </Card>
        ))}
      </div>
    );
  }

  return (
    <Table
      {...props}
      className={["responsive-table", className].filter(Boolean).join(" ")}
      tableLayout="fixed"
      scroll={scroll?.y ? { y: scroll.y } : undefined}
    />
  );
}

function getMobileKey<T extends object>(
  rowKey: TableProps<T>["rowKey"],
  item: T,
  index: number,
) {
  if (typeof rowKey === "function") {
    return String(rowKey(item, index));
  }
  if (typeof rowKey === "string" && rowKey in item) {
    return String(item[rowKey as keyof T]);
  }
  return String(index);
}
