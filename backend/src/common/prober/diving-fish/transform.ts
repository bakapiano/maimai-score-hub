import type {
  ChartPayload,
  SongMetadata,
} from '../../../modules/music/schemas/music.schema';
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
  'maimai でらっくす PRiSM PLUS': '舞萌DX 2026',
};

function mapVersion(version: string | null | undefined): string | null {
  if (!version) {
    return null;
  }
  return VERSION_MAP[version] ?? version;
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

type DivingFishBasicInfo = {
  title?: unknown;
  artist?: unknown;
  genre?: unknown;
  category?: unknown;
  bpm?: unknown;
  from?: unknown;
  version?: unknown;
  is_new?: unknown;
};

export type DivingFishItem = {
  id?: unknown;
  title?: unknown;
  type?: unknown;
  level?: unknown;
  ds?: unknown;
  charts?: unknown;
  basic_info?: unknown;
};

const ITEM_OVERRIDES: Record<string, ItemOverride> = {
  '11568': { category: '流行&动漫' }, // INTERNET OVERDOSE
  '383': { title: 'Link' },
};

function getOverrideForItem(id: string | number): ItemOverride | undefined {
  return ITEM_OVERRIDES[String(id)];
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return 'unknown';
}

export function buildChartsFromDivingFishItem(
  item: DivingFishItem,
): ChartPayload[] {
  const levels: unknown[] = Array.isArray(item.level) ? item.level : [];
  const detailLevels: unknown[] = Array.isArray(item.ds) ? item.ds : [];
  const charts: unknown[] = Array.isArray(item.charts) ? item.charts : [];

  const maxLen = Math.max(levels.length, detailLevels.length, charts.length);
  if (!maxLen) {
    return [];
  }

  const normalized: ChartPayload[] = [];

  const musicId = String(item.id);

  for (let i = 0; i < maxLen; i++) {
    normalized.push(
      buildChartPayload(item, musicId, i, levels, detailLevels, charts),
    );
  }

  return normalized;
}

function buildChartPayload(
  item: DivingFishItem,
  musicId: string,
  index: number,
  levels: unknown[],
  detailLevels: unknown[],
  charts: unknown[],
): ChartPayload {
  const levelRaw = levels[index];
  const detailLevel = parseDetailLevel(detailLevels[index]);
  if (levelRaw === undefined || levelRaw === null) {
    throw new Error(
      `Missing level for chart index ${index} of song ${formatUnknown(
        item.title ?? item.id,
      )}`,
    );
  }
  if (detailLevel === undefined) {
    throw new Error(
      `Missing detailLevel (ds) for chart index ${index} of song ${formatUnknown(
        item.title ?? item.id,
      )}`,
    );
  }

  const rawChartRecord = toChartRecord(charts[index]);
  const chart: ChartPayload = {
    cid: `${musicId}_${index}`,
    level:
      typeof levelRaw === 'string' || typeof levelRaw === 'number'
        ? String(levelRaw)
        : formatUnknown(levelRaw),
    detailLevel,
    charter: getChartDesigner(rawChartRecord),
  };

  if (rawChartRecord && Object.keys(rawChartRecord).length) {
    chart.notes = charts[index];
  }
  return chart;
}

function parseDetailLevel(raw: unknown): number | undefined {
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toChartRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>)
    : null;
}

function getChartDesigner(
  record: Record<string, unknown> | null,
): string | undefined {
  if (typeof record?.charter === 'string') {
    return record.charter;
  }
  return typeof record?.designer === 'string' ? record.designer : undefined;
}

export function mapSongMetadataFromDivingFish(
  info: unknown,
): SongMetadata | null {
  if (!info || typeof info !== 'object') {
    return null;
  }
  const record = info as DivingFishBasicInfo;

  const rawCategory = record.genre ?? record.category;
  const mappedCategory = mapDivingFishCategory(rawCategory);
  const title = typeof record.title === 'string' ? record.title : undefined;

  return {
    title,
    artist: typeof record.artist === 'string' ? record.artist : undefined,
    category: mappedCategory ?? undefined,
    bpm:
      typeof record.bpm === 'string' || typeof record.bpm === 'number'
        ? record.bpm
        : null,
    from:
      typeof record.from === 'string'
        ? record.from
        : typeof record.version === 'string'
          ? record.version
          : null,
    isNew: typeof record.is_new === 'boolean' ? record.is_new : undefined,
  };
}

export function getDivingFishSourceUrl(configService: ConfigService): string {
  return getDivingFishMusicSourceUrl(configService);
}

export function convertDivingFishItemToDocument(
  item: DivingFishItem,
  now: Date,
) {
  const charts = buildChartsFromDivingFishItem(item);
  const metadata = mapSongMetadataFromDivingFish(item.basic_info);
  const id = String(item.id);
  const override = getOverrideForItem(id);
  const fallbackCategory = metadata?.category ?? null;
  const category = override?.category ?? fallbackCategory;
  const rawType = typeof item.type === 'string' ? item.type : undefined;
  const mappedType = override?.type ?? mapDivingFishType(rawType, category);
  const title = typeof item.title === 'string' ? item.title : id;
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
