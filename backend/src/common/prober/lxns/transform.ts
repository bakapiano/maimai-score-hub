import type { ChartPayload } from '../../../modules/music/music.schema';

const LXNS_SONG_LIST_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list';

// LXNS genre mapping: genre (Japanese) -> title (Chinese display)
// This map will be populated from the API response
type GenreMapItem = { id: number; title: string; genre: string };
type VersionMapItem = { id: number; title: string; version: number };

function normalizeTitle(title: string | undefined): string | undefined {
  return title?.replace(/\u3000/g, ' ');
}

type LxnsDifficulty = {
  type: string; // 'standard' | 'dx' | 'utage'
  difficulty: number;
  level: string;
  level_value: number;
  note_designer: string;
  version: number;
  // utage-specific fields
  kanji?: string;
  description?: string;
  is_buddy?: boolean;
  notes?: {
    total?: number;
    tap?: number;
    hold?: number;
    slide?: number;
    touch?: number;
    break?: number;
  };
};

type LxnsDifficulties = {
  standard: LxnsDifficulty[];
  dx: LxnsDifficulty[];
  utage?: LxnsDifficulty[];
};

type LxnsSong = {
  id: number;
  title: string;
  artist: string;
  genre: string; // Japanese genre name
  bpm: number;
  version: number;
  difficulties: LxnsDifficulties;
};

type LxnsApiResponse = {
  songs: LxnsSong[];
  genres: GenreMapItem[];
  versions: VersionMapItem[];
};

function mapLxnsType(
  difficulties: LxnsDifficulties,
): 'standard' | 'dx' | 'utage' | 'unknown' {
  // Check which difficulties have charts
  const hasStandard = difficulties.standard && difficulties.standard.length > 0;
  const hasDx = difficulties.dx && difficulties.dx.length > 0;
  const hasUtage = difficulties.utage && difficulties.utage.length > 0;

  if (hasUtage && !hasStandard && !hasDx) return 'utage';
  if (hasDx) return 'dx';
  if (hasStandard) return 'standard';
  return 'unknown';
}

function buildChartsFromLxnsSong(song: LxnsSong): ChartPayload[] {
  const charts: ChartPayload[] = [];
  const musicId = String(song.id);
  const difficulties = song.difficulties;

  // Process standard charts
  if (difficulties.standard && difficulties.standard.length > 0) {
    for (const diff of difficulties.standard) {
      const chart: ChartPayload = {
        cid: `${musicId}_${diff.difficulty}`,
        level: diff.level,
        detailLevel: diff.level_value,
        charter: diff.note_designer || undefined,
      };
      if (diff.notes) {
        chart.notes = diff.notes;
      }
      charts.push(chart);
    }
  }

  // Process DX charts
  if (difficulties.dx && difficulties.dx.length > 0) {
    for (const diff of difficulties.dx) {
      const chart: ChartPayload = {
        cid: `${musicId}_${diff.difficulty}`,
        level: diff.level,
        detailLevel: diff.level_value,
        charter: diff.note_designer || undefined,
      };
      if (diff.notes) {
        chart.notes = diff.notes;
      }
      charts.push(chart);
    }
  }

  // Process Utage charts
  if (difficulties.utage && difficulties.utage.length > 0) {
    for (const diff of difficulties.utage) {
      const chart: ChartPayload = {
        cid: `${musicId}_${diff.difficulty}`,
        level: diff.level,
        detailLevel: diff.level_value || 0,
        charter: diff.note_designer || undefined,
      };
      if (diff.notes) {
        chart.notes = diff.notes;
      }
      charts.push(chart);
    }
  }

  return charts;
}

export function convertLxnsSongToDocument(
  song: LxnsSong,
  genreMap: Map<string, string>,
  versionMap: Map<number, string>,
  now: Date,
) {
  const charts = buildChartsFromLxnsSong(song);
  const id = String(song.id);
  const title = normalizeTitle(song.title) ?? song.title;

  // Map genre from Japanese to Chinese display name
  const category = genreMap.get(song.genre) ?? song.genre;

  // Determine type based on which difficulties have charts
  const type = mapLxnsType(song.difficulties);

  // Map version number to display name using the version map from API
  const version = versionMap.get(song.version) ?? null;

  return {
    id,
    title,
    type,
    charts,
    artist: song.artist ?? null,
    category,
    bpm: song.bpm ?? null,
    version,
    isNew: null, // LXNS doesn't provide is_new field
    sync: {
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
  };
}

export function buildGenreMap(genres: GenreMapItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of genres) {
    // Map Japanese genre name to Chinese title
    map.set(g.genre, g.title);
  }
  return map;
}

export function buildVersionMap(
  versions: VersionMapItem[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const v of versions) {
    // Map version number to Chinese title
    map.set(v.version, v.title);
  }
  return map;
}

export function getLxnsSongListUrl(): string {
  return LXNS_SONG_LIST_URL;
}

export type { LxnsApiResponse, LxnsSong, GenreMapItem, VersionMapItem };
