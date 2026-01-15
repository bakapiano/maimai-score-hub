import type {
  ChartPayload,
  SongMetadata,
} from '../../../modules/music/music.schema';
import {
  getDivingFishMusicSourceUrl,
  mapDivingFishCategory,
  mapDivingFishType,
} from './music';

import type { ConfigService } from '@nestjs/config';

// Version name mapping from diving-fish to display names
const VERSION_MAP: Record<string, string> = {
  maimai: 'maimai',
  'maimai PLUS': 'maimai+',
  'maimai GreeN': 'green',
  'maimai GreeN PLUS': 'green+',
  'maimai ORANGE': 'orange',
  'maimai ORANGE PLUS': 'orange+',
  'maimai PiNK': 'pink',
  'maimai PiNK PLUS': 'pink+',
  'maimai MURASAKi': 'murasaki',
  'maimai MURASAKi PLUS': 'murasaki+',
  'maimai MiLK': 'milk',
  'MiLK PLUS': 'milk+',
  'maimai FiNALE': 'finale',
  'maimai でらっくす': '舞萌DX',
  'maimai でらっくす Splash': '舞萌DX 2021',
  'maimai でらっくす UNiVERSE': '舞萌DX 2022',
  'maimai でらっくす FESTiVAL': '舞萌DX 2023',
  'maimai でらっくす BUDDiES': '舞萌DX 2024',
  'maimai でらっくす PRiSM': '舞萌DX 2025',
};

function mapVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  return VERSION_MAP[version] ?? version;
}

function normalizeTitle(title: string | undefined): string | undefined {
  return title?.replace(/\u3000/g, ' ');
}

type ItemOverride = {
  title?: string;
  category?: string | null;
  artist?: string | null;
  bpm?: number | string | null;
  version?: string | null;
  isNew?: boolean | null;
  type?: string;
  charts?: ChartPayload[];
};

const ITEM_OVERRIDES: Record<string, ItemOverride> = {
  '11568': { category: '流行&动漫' }, // INTERNET OVERDOSE
  '383': { title: 'Link' },
  '364': { title: 'D✪N’T ST✪P R✪CKIN’' },
};

function getOverrideForItem(id: string | number): ItemOverride | undefined {
  return ITEM_OVERRIDES[String(id)];
}

export function buildChartsFromDivingFishItem(item: any): ChartPayload[] {
  const levels = Array.isArray(item.level) ? item.level : [];
  const detailLevels = Array.isArray(item.ds) ? item.ds : [];
  const cids = Array.isArray(item.cids) ? item.cids : [];
  const charts = Array.isArray(item.charts) ? item.charts : [];

  const maxLen = Math.max(
    levels.length,
    detailLevels.length,
    cids.length,
    charts.length,
  );
  if (!maxLen) return [];

  const normalized: ChartPayload[] = [];

  for (let i = 0; i < maxLen; i++) {
    const rawChart = charts[i];
    const hasRawChart = rawChart && typeof rawChart === 'object';

    const detailLevelRaw = detailLevels[i];
    const detailLevelParsed =
      typeof detailLevelRaw === 'number'
        ? detailLevelRaw
        : typeof detailLevelRaw === 'string'
          ? Number(detailLevelRaw)
          : undefined;

    const cid = cids[i];
    const level = levels[i];
    const detailLevel = Number.isFinite(detailLevelParsed)
      ? detailLevelParsed
      : undefined;

    if (cid === undefined || cid === null) {
      throw new Error(
        `Missing cid for chart index ${i} of song ${item.title ?? item.id ?? 'unknown'}`,
      );
    }
    if (level === undefined || level === null) {
      throw new Error(
        `Missing level for chart index ${i} of song ${item.title ?? item.id ?? 'unknown'}`,
      );
    }
    if (detailLevel === undefined) {
      throw new Error(
        `Missing detailLevel (ds) for chart index ${i} of song ${item.title ?? item.id ?? 'unknown'}`,
      );
    }

    const chart: ChartPayload = {
      cid,
      level,
      detailLevel,
      charter: hasRawChart
        ? (rawChart.charter ?? rawChart.designer)
        : undefined,
    };

    if (hasRawChart && Object.keys(rawChart).length) {
      chart.notes = rawChart;
    }

    normalized.push(chart);
  }

  return normalized;
}

export function mapSongMetadataFromDivingFish(info: any): SongMetadata | null {
  if (!info || typeof info !== 'object') {
    return null;
  }

  const rawCategory = info.genre ?? info.category;
  const mappedCategory = mapDivingFishCategory(rawCategory);
  const title = normalizeTitle(info.title);

  return {
    title: title ?? info.title,
    artist: info.artist,
    category: mappedCategory ?? undefined,
    bpm: info.bpm ?? null,
    from: info.from ?? info.version ?? null,
    isNew: info.is_new ?? undefined,
  };
}

export function getDivingFishSourceUrl(configService: ConfigService): string {
  return getDivingFishMusicSourceUrl(configService);
}

export function convertDivingFishItemToDocument(item: any, now: Date) {
  const charts = buildChartsFromDivingFishItem(item);
  const metadata = mapSongMetadataFromDivingFish(item.basic_info);
  const id = String(item.id);
  const override = getOverrideForItem(id);
  const fallbackCategory = metadata?.category ?? null;
  const category = override?.category ?? fallbackCategory;
  const mappedType = override?.type ?? mapDivingFishType(item.type, category);
  const title = normalizeTitle(item.title) ?? item.title;
  const rawVersion = metadata?.from ?? null;
  const version = mapVersion(rawVersion);

  const base = {
    id,
    title,
    type: mappedType ?? 'unknown',
    charts,
    artist: metadata?.artist ?? null,
    category,
    bpm: metadata?.bpm ?? null,
    version,
    isNew: metadata?.isNew ?? null,
    sync: {
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
  };

  return { ...base, ...(override ?? {}) };
}
