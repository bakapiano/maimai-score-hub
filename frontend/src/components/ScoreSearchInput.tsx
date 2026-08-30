import {
  ActionIcon,
  Combobox,
  Group,
  Image,
  Stack,
  Text,
  TextInput,
  useCombobox,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getCoverUrl } from "./MusicScoreCard";
import {
  type ScoreSearchEngine,
} from "../utils/scoreSearch";

const FALLBACK_COVER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='42' height='42'><rect width='100%25' height='100%25' fill='%23222931'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%238a8f98' font-size='9'>Cover</text></svg>";

export function ScoreSearchInput({
  initialValue,
  searchEngine,
  onChange,
  onSelect,
  onClear,
}: {
  initialValue: string;
  searchEngine: ScoreSearchEngine;
  onChange: (value: string) => void;
  onSelect: (musicId: string, title: string) => void;
  onClear: () => void;
}) {
  const [inputValue, setInputValue] = useState(initialValue);
  const [debouncedInputValue] = useDebouncedValue(inputValue, 200);
  const lastCommittedValue = useRef(initialValue);
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const candidates = useMemo(
    () => searchEngine.candidates(debouncedInputValue),
    [debouncedInputValue, searchEngine],
  );
  const hasQuery = inputValue.trim().length > 0;

  useEffect(() => {
    if (lastCommittedValue.current === debouncedInputValue) {
      return;
    }
    lastCommittedValue.current = debouncedInputValue;
    onChange(debouncedInputValue);
  }, [debouncedInputValue, onChange]);

  return (
    <Combobox
      store={combobox}
      withinPortal
      onOptionSubmit={(musicId) => {
        const candidate = candidates.find((item) => item.musicId === musicId);
        const nextValue = candidate?.title ?? musicId;
        lastCommittedValue.current = nextValue;
        setInputValue(nextValue);
        onSelect(musicId, nextValue);
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target>
        <TextInput
          placeholder="搜索曲名、别名或曲目 ID"
          leftSection={<IconSearch size={16} />}
          value={inputValue}
          onFocus={() => {
            if (hasQuery) {
              combobox.openDropdown();
            }
          }}
          onClick={() => {
            if (hasQuery) {
              combobox.openDropdown();
            }
          }}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            setInputValue(nextValue);
            if (nextValue.trim()) {
              combobox.openDropdown();
              combobox.updateSelectedOptionIndex();
            } else {
              combobox.closeDropdown();
            }
          }}
          rightSection={
            hasQuery ? (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="清除搜索"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  lastCommittedValue.current = "";
                  setInputValue("");
                  onClear();
                  combobox.closeDropdown();
                }}
              >
                <IconX size={14} />
              </ActionIcon>
            ) : null
          }
          rightSectionPointerEvents="all"
          size="sm"
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options mah={320} style={{ overflowY: "auto" }}>
          {candidates.length > 0 ? (
            candidates.map((candidate) => (
              <Combobox.Option
                key={candidate.musicId}
                value={candidate.musicId}
              >
                <Group gap="sm" wrap="nowrap">
                  <Image
                    src={getCoverUrl(candidate.musicId)}
                    fallbackSrc={FALLBACK_COVER}
                    w={42}
                    h={42}
                    radius="sm"
                    fit="cover"
                    flex="0 0 auto"
                  />
                  <Stack gap={1} style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500} truncate>
                      {candidate.title}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      ID {candidate.musicId}
                      {candidate.type ? ` · ${candidate.type.toUpperCase()}` : ""}
                    </Text>
                    {candidate.matchedAlias ? (
                      <Text size="xs" c="dimmed" truncate>
                        别名：{candidate.matchedAlias}
                      </Text>
                    ) : null}
                  </Stack>
                </Group>
              </Combobox.Option>
            ))
          ) : (
            <Combobox.Empty>没有匹配的曲目</Combobox.Empty>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
