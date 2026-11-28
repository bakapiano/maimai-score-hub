import { Group, Radio, SimpleGrid, Text } from "@mantine/core";

import classes from "./RadioCardGroup.module.css";

export interface RadioCardOption {
  name: string;
  description: string;
  value: string;
}

export function RadioCardGroup({
  data,
  value,
  disabled = false,
  showDescription = true,
  onChange,
}: {
  data: RadioCardOption[];
  value?: string;
  disabled?: boolean;
  showDescription?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <Radio.Group value={value} onChange={onChange}>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        {data.map((item) => (
          <Radio.Card
            className={classes.root}
            radius="md"
            value={item.value}
            key={item.value}
            disabled={disabled}
          >
            <Group
              wrap="nowrap"
              align={showDescription ? "flex-start" : "center"}
              gap="xs"
            >
              <Radio.Indicator />
              <div style={{ minWidth: 0 }}>
                <Text className={classes.label}>{item.name}</Text>
                {showDescription && item.description ? (
                  <Text className={classes.description} lh="xs">
                    {item.description}
                  </Text>
                ) : null}
              </div>
            </Group>
          </Radio.Card>
        ))}
      </SimpleGrid>
    </Radio.Group>
  );
}
