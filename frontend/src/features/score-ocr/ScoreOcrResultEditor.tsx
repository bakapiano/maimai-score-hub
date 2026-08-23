import {
  Badge,
  Box,
  Card,
  Checkbox,
  Group,
  Image,
  NumberInput,
  Select,
  SimpleGrid,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type { ManualScoreFc, ManualScoreFs } from "@maimai-score-hub/shared";
import { memo, useCallback, useDeferredValue, useMemo } from "react";

import type { MusicRow } from "../../types/music";
import {
  getIconUrl,
  type DetailedMusicScoreCardProps,
} from "../../components/MusicScoreCard";
import { ScoreSummary } from "../../components/ScoreDetailSummary";
import { getMaxDxScoreFromNotes } from "../../utils/dxScore";
import {
  getOcrCandidateMusics,
  type ScoreOcrDraft,
} from "./scoreOcrModel";
import classes from "./ScoreOcrResultEditor.module.css";

type Option = { value: string; label: string };

const DIFFICULTY_OPTIONS: Option[] = [
  { value: "0", label: "Basic" },
  { value: "1", label: "Advanced" },
  { value: "2", label: "Expert" },
  { value: "3", label: "Master" },
  { value: "4", label: "Re:Master" },
  { value: "10", label: "Utage" },
];

const FC_OPTIONS: Array<{ value: ManualScoreFc; label: string }> = [
  { value: "fc", label: "FC" },
  { value: "fcp", label: "FC+" },
  { value: "ap", label: "AP" },
  { value: "app", label: "AP+" },
];

const FS_OPTIONS: Array<{ value: ManualScoreFs; label: string }> = [
  { value: "fs", label: "FS" },
  { value: "fsp", label: "FS+" },
  { value: "fdx", label: "FDX" },
  { value: "fdxp", label: "FDX+" },
];

type ScoreOcrResultEditorProps = {
  draft: ScoreOcrDraft;
  previewIndex: number;
  previewUrl?: string;
  musicMap: Map<string, MusicRow>;
  validationError?: string;
  onChange: (id: string, patch: Partial<ScoreOcrDraft>) => void;
  onPreview?: (index: number) => void;
};

const MemoizedScoreSummary = memo(ScoreSummary);

function scoreValue(value: number | string) {
  return value === "" ? null : String(value);
}

function buildScoreSummaryData(
  draft: ScoreOcrDraft,
  music: MusicRow,
  maxDxScore: number | null,
): DetailedMusicScoreCardProps {
  const chart = music.charts?.[draft.chartIndex === 10 ? 0 : draft.chartIndex];
  return {
    musicId: music.id,
    chartIndex: draft.chartIndex,
    type: music.type,
    rating: null,
    score: scoreValue(draft.achievement),
    dxScore: scoreValue(draft.dxScore),
    fc: draft.fc,
    fs: draft.fs,
    chartPayload: chart ?? null,
    songMetadata: {
      title: music.title,
      artist: music.artist,
      category: music.category,
      bpm: music.bpm,
      version: music.version,
      isNew: music.isNew,
    },
    bpm: null,
    noteDesigner: chart?.charter,
    maxDxScore,
    isNew: music.isNew,
  };
}

function RecognitionMeta({
  draft,
  previewUrl,
  onChange,
  onPreview,
}: {
  draft: ScoreOcrDraft;
  previewUrl?: string;
  onChange: (patch: Partial<ScoreOcrDraft>) => void;
  onPreview?: () => void;
}) {
  return (
    <Box className={classes.recognitionMeta}>
      <Group align="center" gap="sm" wrap="nowrap">
        <Badge size="sm" color={draft.status === "ok" ? "green" : "orange"}>
          {draft.status === "ok" ? "已识别" : "需手动填写"}
        </Badge>
        <Text className={classes.filename} size="xs" c="dimmed" lineClamp={1}>
          {draft.filename}
        </Text>
        {previewUrl ? (
          <UnstyledButton
            className={classes.previewButton}
            onClick={onPreview}
            aria-label={`查看 ${draft.filename} 完整图片`}
          >
            <Image
              src={previewUrl}
              alt={`${draft.filename} 原图`}
              className={classes.previewImage}
              radius="sm"
            />
          </UnstyledButton>
        ) : null}
        <Checkbox
          label="更新"
          checked={draft.selected}
          onChange={(event) =>
            onChange({ selected: event.currentTarget.checked })
          }
        />
      </Group>
      {draft.error ? (
        <Text size="xs" c="orange" mt="xs">
          {draft.error}
        </Text>
      ) : null}
    </Box>
  );
}

function UnmatchedSummary({ draft }: { draft: ScoreOcrDraft }) {
  return (
    <Box className={classes.unmatchedSummary}>
      <Text fw={700}>{draft.candidates[0]?.title ?? "未匹配乐曲"}</Text>
      <Text size="sm" c="dimmed">
        请在下方选择曲目后确认成绩。
      </Text>
    </Box>
  );
}

function StatusIconSelector<T extends string>({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  const choices: ReadonlyArray<{ value: T | null; label: string }> = [
    { value: null, label: "无" },
    ...options,
  ];

  return (
    <fieldset className={classes.statusSelector}>
      <legend className={classes.statusSelectorLabel}>{label}</legend>
      <Box className={classes.statusOptions}>
        {choices.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value ?? "none"}
              className={`${classes.statusOption} ${selected ? classes.statusOptionSelected : ""}`}
              title={option.label}
            >
              <input
                className={classes.statusInput}
                type="radio"
                name={name}
                value={option.value ?? "none"}
                checked={selected}
                aria-label={`${label}：${option.label}`}
                onChange={() => onChange(option.value)}
              />
              {option.value === null ? (
                <Text className={classes.statusNone}>无</Text>
              ) : (
                <Image
                  src={getIconUrl(option.value)}
                  alt=""
                  className={classes.statusIcon}
                />
              )}
            </label>
          );
        })}
      </Box>
    </fieldset>
  );
}

function ResultFields({
  draft,
  candidateMusicOptions,
  maxDxScore,
  validationError,
  onChange,
}: {
  draft: ScoreOcrDraft;
  candidateMusicOptions: Option[];
  maxDxScore: number | null;
  validationError?: string;
  onChange: (patch: Partial<ScoreOcrDraft>) => void;
}) {
  return (
    <Box className={classes.editSection}>
      <Text fw={700} mb="sm">
        确认识别结果
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <Select
          label="乐曲"
          placeholder="选择 OCR 候选曲目"
          data={candidateMusicOptions}
          value={draft.musicId || null}
          clearable
          nothingFoundMessage="没有可用的 OCR 候选曲目"
          onChange={(value) =>
            onChange({ musicId: value ?? "", selected: Boolean(value) })
          }
        />
        <Select
          label="难度"
          data={DIFFICULTY_OPTIONS}
          value={String(draft.chartIndex)}
          onChange={(value) => onChange({ chartIndex: Number(value ?? 3) })}
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
            maxDxScore === null ? "DX 分数" : `DX 分数（上限 ${maxDxScore}）`
          }
          value={draft.dxScore}
          min={0}
          max={maxDxScore ?? undefined}
          allowDecimal={false}
          thousandSeparator=","
          onChange={(value) => onChange({ dxScore: value })}
        />
        <StatusIconSelector
          label="FC"
          name={`${draft.id}-fc`}
          options={FC_OPTIONS}
          value={draft.fc}
          onChange={(value) => onChange({ fc: value })}
        />
        <StatusIconSelector
          label="FS（目前需要手动填写）"
          name={`${draft.id}-fs`}
          options={FS_OPTIONS}
          value={draft.fs}
          onChange={(value) => onChange({ fs: value })}
        />
      </SimpleGrid>
      {validationError ? (
        <Text c="red" size="sm" mt="sm">
          {validationError}
        </Text>
      ) : null}
    </Box>
  );
}

export const ScoreOcrResultEditor = memo(function ScoreOcrResultEditor({
  draft,
  previewIndex,
  previewUrl,
  musicMap,
  validationError,
  onChange,
  onPreview,
}: ScoreOcrResultEditorProps) {
  const deferredDraft = useDeferredValue(draft);
  const music = musicMap.get(draft.musicId);
  const chart = music?.charts?.[draft.chartIndex === 10 ? 0 : draft.chartIndex];
  const maxDxScore = getMaxDxScoreFromNotes(chart?.notes);
  const candidateMusicOptions = useMemo(
    () =>
      getOcrCandidateMusics(draft.candidates, [...musicMap.values()]).map(
        (candidateMusic) => ({
          value: candidateMusic.id,
          label: `${candidateMusic.title} · ${candidateMusic.type === "dx" ? "DX" : candidateMusic.type === "utage" ? "宴" : "SD"} · ${candidateMusic.id}`,
        }),
      ),
    [draft.candidates, musicMap],
  );
  const summaryMusic = musicMap.get(deferredDraft.musicId);
  const summaryChart =
    summaryMusic?.charts?.[
      deferredDraft.chartIndex === 10 ? 0 : deferredDraft.chartIndex
    ];
  const summaryMaxDxScore = getMaxDxScoreFromNotes(summaryChart?.notes);
  const scoreData = useMemo(
    () =>
      summaryMusic
        ? buildScoreSummaryData(deferredDraft, summaryMusic, summaryMaxDxScore)
        : null,
    [deferredDraft, summaryMaxDxScore, summaryMusic],
  );
  const changeDraft = useCallback(
    (patch: Partial<ScoreOcrDraft>) => onChange(draft.id, patch),
    [draft.id, onChange],
  );
  const previewImage = useCallback(
    () => onPreview?.(previewIndex),
    [onPreview, previewIndex],
  );

  return (
    <Card
      withBorder
      radius="md"
      p={0}
      opacity={draft.selected ? 1 : 0.65}
      className={classes.resultCard}
    >
      <RecognitionMeta
        draft={draft}
        previewUrl={previewUrl}
        onChange={changeDraft}
        onPreview={previewImage}
      />
      {scoreData ? (
        <MemoizedScoreSummary
          scoreData={scoreData}
          maxDxScore={summaryMaxDxScore}
        />
      ) : (
        <UnmatchedSummary draft={draft} />
      )}

      <ResultFields
        draft={draft}
        candidateMusicOptions={candidateMusicOptions}
        maxDxScore={maxDxScore}
        validationError={validationError}
        onChange={changeDraft}
      />
    </Card>
  );
});
