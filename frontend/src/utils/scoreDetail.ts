import type { DetailedMusicScoreCardProps } from "../components/MusicScoreCard";
import type { MusicChartPayload, MusicRow } from "../types/music";
import type { SyncScore } from "../types/syncScore";
import {
  getRatingFloorByIsNew,
  type RatingFloors,
} from "./ratingFloors";

export type ScoreDetailEntry = {
  music: MusicRow;
  chart: MusicChartPayload;
  chartIndex: number;
  score?: SyncScore;
};

export function buildScoreDetailFromEntry(
  entry: ScoreDetailEntry,
  ratingFloors: RatingFloors,
): DetailedMusicScoreCardProps {
  const isNew = entry.score?.isNew ?? entry.music.isNew ?? null;

  return {
    musicId: entry.music.id,
    chartIndex: entry.chartIndex,
    type: entry.music.type,
    rating: entry.score?.rating ?? null,
    score: entry.score?.score || null,
    fs: entry.score?.fs ?? null,
    fc: entry.score?.fc ?? null,
    dxScore: entry.score?.dxScore || null,
    chartPayload: entry.chart || null,
    songMetadata: {
      title: entry.music.title,
      artist: entry.music.artist,
      category: entry.music.category,
      isNew: entry.music.isNew,
      bpm: entry.music.bpm,
      version: entry.music.version,
    },
    bpm:
      typeof entry.music.bpm === "number"
        ? entry.music.bpm
        : parseInt(entry.music.bpm as string) || null,
    noteDesigner: entry.chart?.charter || null,
    isNew,
    ratingFloor: getRatingFloorByIsNew(isNew, ratingFloors),
  };
}
