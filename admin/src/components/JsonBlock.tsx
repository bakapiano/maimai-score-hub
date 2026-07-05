import { Typography } from "antd";

const { Paragraph } = Typography;

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <Paragraph className="json-block">
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </Paragraph>
  );
}
