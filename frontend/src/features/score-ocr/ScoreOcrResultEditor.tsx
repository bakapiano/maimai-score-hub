import {
  Badge,
  Card,
  Checkbox,
  Group,
  Image,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import type {
  ManualScoreFc,
  ManualScoreFs,
} from "@maimai-score-hub/shared";

import type { MusicRow } from "../../types/music";
import { getCoverUrl } from "../../components/MusicScoreCard";
import { getMaxDxScoreFromNotes } from "../../utils/dxScore";
import type { ScoreOcrDraft } from "./scoreOcrModel";

type Option = { value: string; label: string };

const DIFFICULTY_OPTIONS: Option[] = [
  { value: "0", label: "Basic" },
  { value: "1", label: "Advanced" },
  { value: "2", label: "Expert" },
  { value: "3", label: "Master" },
  { value: "4", label: "Re:Master" },
  { value: "10", label: "Utage" },
];

const FC_OPTIONS: Option[] = [
  { value: "fc", label: "FC" },
  { value: "fcp", label: "FC+" },
  { value: "ap", label: "AP" },
  { value: "app", label: "AP+" },
];

const FS_OPTIONS: Option[] = [
  { value: "fs", label: "FS" },
  { value: "fsp", label: "FS+" },
  { value: "fdx", label: "FDX" },
  { value: "fdxp", label: "FDX+" },
];

type ScoreOcrResultEditorProps = {
  draft: ScoreOcrDraft;
  previewUrl?: string;
  musicOptions: Option[];
  musicMap: Map<string, MusicRow>;
  validationError?: string;
  onChange: (patch: Partial<ScoreOcrDraft>) => void;
};

function candidateSourceLabel(sources: readonly string[]) {
  if (sources.includes("cover") && sources.includes("title")) {
    return "封面 + 曲名";
  }
  return sources.includes("cover") ? "封面" : "曲名";
}

export function ScoreOcrResultEditor({
  draft,
  previewUrl,
  musicOptions,
  musicMap,
  validationError,
  onChange,
}: ScoreOcrResultEditorProps) {
  const music = musicMap.get(draft.musicId);
  const maxDxScore = getMaxDxScoreFromNotes(
    music?.charts?.[draft.chartIndex === 10 ? 0 : draft.chartIndex]?.notes,
  );

  return (
    <Card withBorder radius="md" p="md" opacity={draft.selected ? 1 : 0.65}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Group align="flex-start" wrap="nowrap">
            {music ? (
              <Image
                src={getCoverUrl(music.id)}
                alt={`${music.title} 封面`}
                w={72}
                h={72}
                fit="cover"
                radius="sm"
              />
            ) : previewUrl ? (
              <Image
                src={previewUrl}
                alt={draft.filename}
                w={96}
                h={72}
                fit="cover"
                radius="sm"
              />
            ) : null}
            <div>
              <Text fw={600} lineClamp={1}>
                {draft.filename}
              </Text>
              <Group gap={6} mt={4}>
                <Badge
                  size="sm"
                  color={draft.status === "ok" ? "green" : "orange"}
                >
                  {draft.status === "ok" ? "已识别" : "需手动填写"}
                </Badge>
                {draft.candidates.map((candidate) => (
                  <Badge key={candidate.title} size="sm" variant="light">
                    {candidate.title} · {candidateSourceLabel(candidate.sources)}
                  </Badge>
                ))}
              </Group>
              {draft.error ? (
                <Text size="xs" c="orange" mt={4}>
                  {draft.error}
                </Text>
              ) : null}
            </div>
          </Group>
          <Checkbox
            label="更新"
            checked={draft.selected}
            onChange={(event) =>
              onChange({ selected: event.currentTarget.checked })
            }
          />
        </Group>

        {music && previewUrl ? (
          <Image
            src={previewUrl}
            alt={`${draft.filename} 原图`}
            w="100%"
            mah={180}
            fit="contain"
            radius="sm"
          />
        ) : null}

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Select
            label="乐曲"
            placeholder="搜索并选择乐曲"
            data={musicOptions}
            value={draft.musicId || null}
            searchable
            clearable
            limit={50}
            onChange={(value) =>
              onChange({ musicId: value ?? "", selected: Boolean(value) })
            }
          />
          <Select
            label="难度"
            data={DIFFICULTY_OPTIONS}
            value={String(draft.chartIndex)}
            onChange={(value) =>
              onChange({ chartIndex: Number(value ?? 3) })
            }
          />
          <NumberInput
            label="达成率 (%)"
            value={draft.achievement}
            min={0}
            max={101}
            decimalScale={4}
            onChange={(value) => onChange({ achievement: value })}
          />
          <NumberInput
            label={
              maxDxScore === null
                ? "DX 分数"
                : `DX 分数（上限 ${maxDxScore}）`
            }
            value={draft.dxScore}
            min={0}
            max={maxDxScore ?? undefined}
            allowDecimal={false}
            thousandSeparator=","
            onChange={(value) => onChange({ dxScore: value })}
          />
          <Select
            label="FC"
            data={FC_OPTIONS}
            value={draft.fc}
            clearable
            onChange={(value) =>
              onChange({ fc: value as ManualScoreFc | null })
            }
          />
          <Select
            label="FS（手动填写）"
            description="当前识别结果不自动填写 FS 状态"
            data={FS_OPTIONS}
            value={draft.fs}
            clearable
            onChange={(value) =>
              onChange({ fs: value as ManualScoreFs | null })
            }
          />
        </SimpleGrid>
        {validationError ? (
          <Text c="red" size="sm">
            {validationError}
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}
