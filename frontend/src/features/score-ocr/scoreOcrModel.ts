import type {
  ManualScoreFc,
  ManualScoreFs,
  ManualScoreUpdateItem,
  OcrCandidate,
  OcrDifficulty,
  OcrRecognitionItem,
} from "@maimai-score-hub/shared";

import type { MusicRow } from "../../types/music";
import { getMaxDxScoreFromNotes } from "../../utils/dxScore.ts";

export type ScoreOcrDraft = {
  id: string;
  selected: boolean;
  filename: string;
  status: OcrRecognitionItem["status"];
  error: string | null;
  candidates: OcrCandidate[];
  musicId: string;
  chartIndex: number;
  achievement: number | string;
  dxScore: number | string;
  fc: ManualScoreFc | null;
  fs: ManualScoreFs | null;
};

export type ScoreOcrDraftError = {
  id: string;
  message: string;
};

const DIFFICULTY_INDEX: Record<OcrDifficulty, number> = {
  basic: 0,
  advanced: 1,
  expert: 2,
  master: 3,
  remaster: 4,
  utage: 10,
};

function normalizeMusicTitle(title: string): string {
  return title.normalize("NFKC").trim().toLocaleLowerCase();
}

export function getOcrCandidateMusics(
  candidates: readonly OcrCandidate[],
  musics: readonly MusicRow[],
): MusicRow[] {
  const musicsByTitle = new Map<string, MusicRow[]>();
  for (const music of musics) {
    const key = normalizeMusicTitle(music.title);
    const rows = musicsByTitle.get(key) ?? [];
    rows.push(music);
    musicsByTitle.set(key, rows);
  }

  const seen = new Set<string>();
  const matches: MusicRow[] = [];
  for (const candidate of candidates) {
    for (const music of musicsByTitle.get(normalizeMusicTitle(candidate.title)) ?? []) {
      if (!seen.has(music.id)) {
        seen.add(music.id);
        matches.push(music);
      }
    }
  }
  return matches;
}

function matchingMusic(
  result: OcrRecognitionItem,
  musics: readonly MusicRow[],
): MusicRow | undefined {
  for (const candidate of result.candidates) {
    const candidateTitle = normalizeMusicTitle(candidate.title);
    const normalizedMatches = musics.filter(
      (music) => normalizeMusicTitle(music.title) === candidateTitle,
    );
    if (!normalizedMatches.length) {
      continue;
    }
    if (result.isDx !== null && result.isDx !== undefined) {
      const desiredType = result.isDx ? "dx" : "standard";
      const typed = normalizedMatches.find(
        (music) => music.type === desiredType,
      );
      if (typed) {
        return typed;
      }
    }
    return normalizedMatches[0];
  }
  return undefined;
}

export function difficultyChartIndex(
  difficulty: OcrDifficulty | null | undefined,
): number {
  return difficulty ? DIFFICULTY_INDEX[difficulty] : 3;
}

export function buildScoreOcrDrafts(
  results: readonly OcrRecognitionItem[],
  musics: readonly MusicRow[],
): ScoreOcrDraft[] {
  return results.map((result) => {
    const music = matchingMusic(result, musics);
    const hasScore =
      result.achievement !== null && result.achievement !== undefined
        ? true
        : result.dxScore !== null && result.dxScore !== undefined
          ? true
          : Boolean(result.fc || result.fs);
    return {
      id: `${result.index}:${result.filename}`,
      selected: result.status === "ok" && Boolean(music) && hasScore,
      filename: result.filename,
      status: result.status,
      error: result.error ?? null,
      candidates: result.candidates,
      musicId: music?.id ?? "",
      chartIndex: difficultyChartIndex(result.difficulty),
      achievement: result.achievement ?? "",
      dxScore: result.dxScore ?? "",
      fc: result.fc ?? null,
      fs: result.fs ?? null,
    };
  });
}

function finiteNumber(value: number | string): number | null {
  if (value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function valueError(input: {
  achievement: number | null;
  dxScore: number | null;
  maxDxScore: number | null;
}): string | null {
  if (
    input.achievement !== null &&
    (input.achievement < 0 || input.achievement > 101)
  ) {
    return "达成率范围应为 0–101";
  }
  if (
    input.dxScore !== null &&
    (!Number.isInteger(input.dxScore) || input.dxScore < 0)
  ) {
    return "DX 分数应为非负整数";
  }
  if (
    input.dxScore !== null &&
    input.maxDxScore !== null &&
    input.dxScore > input.maxDxScore
  ) {
    return `DX 分数超过谱面上限 ${input.maxDxScore}`;
  }
  return null;
}

function scoreFromDraft(
  draft: ScoreOcrDraft,
  music: MusicRow,
): { score?: ManualScoreUpdateItem; error?: string } {
  const chartIndexMatchesType =
    music.type === "utage"
      ? draft.chartIndex === 10
      : draft.chartIndex !== 10;
  const chart = chartIndexMatchesType
    ? music.charts?.[draft.chartIndex === 10 ? 0 : draft.chartIndex]
    : undefined;
  if (!chart) {
    return { error: "该乐曲没有所选难度谱面" };
  }
  const achievement = finiteNumber(draft.achievement);
  const dxScore = finiteNumber(draft.dxScore);
  const error = valueError({
    achievement,
    dxScore,
    maxDxScore: getMaxDxScoreFromNotes(chart?.notes),
  });
  if (error) {
    return { error };
  }
  if (
    achievement === null &&
    dxScore === null &&
    draft.fc === null &&
    draft.fs === null
  ) {
    return { error: "至少填写一项成绩" };
  }
  return {
    score: {
      musicId: draft.musicId,
      chartIndex: draft.chartIndex,
      ...(achievement === null ? {} : { achievement }),
      ...(dxScore === null ? {} : { dxScore }),
      ...(draft.fc === null ? {} : { fc: draft.fc }),
      ...(draft.fs === null ? {} : { fs: draft.fs }),
    },
  };
}

export function buildManualScoreUpdates(
  drafts: readonly ScoreOcrDraft[],
  musics: readonly MusicRow[],
): { scores: ManualScoreUpdateItem[]; errors: ScoreOcrDraftError[] } {
  const scores: ManualScoreUpdateItem[] = [];
  const errors: ScoreOcrDraftError[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    if (!draft.selected) {
      continue;
    }
    const music = musics.find((item) => item.id === draft.musicId);
    if (!music) {
      errors.push({ id: draft.id, message: "请选择乐曲" });
      continue;
    }
    const key = `${draft.musicId}:${draft.chartIndex}`;
    if (seen.has(key)) {
      errors.push({ id: draft.id, message: "同一谱面在本批次中重复" });
      continue;
    }
    seen.add(key);

    const built = scoreFromDraft(draft, music);
    if (built.error) {
      errors.push({ id: draft.id, message: built.error });
      continue;
    }
    scores.push(built.score!);
  }
  if (!scores.length && !errors.length) {
    errors.push({ id: "batch", message: "请选择至少一条识别结果" });
  }
  return { scores, errors };
}
