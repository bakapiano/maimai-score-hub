import { Table, type TableProps } from "@mantine/core";

/**
 * Admin tables that need to stay readable on mobile. Wraps the standard
 * Mantine Table in a horizontally-scrollable container so wide admin
 * tables (8+ columns) don't get squished on phone widths.
 *
 * Drop-in replacement for `<Table>` — props are forwarded directly.
 */
export function ScrollableTable(props: TableProps) {
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table {...props} />
    </Table.ScrollContainer>
  );
}
