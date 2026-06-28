/**
 * 两个数据源（diving-fish / lxns）之间的乐曲 ID 映射工具。
 *
 * 以「乐曲名 + type + 分类」作为 key，将两边的 document 匹配起来，
 * 构建双向 ID 映射。
 */

import {
  convertDivingFishItemToDocument,
  type DivingFishItem,
} from './diving-fish/transform';
import {
  convertLxnsSongToDocument,
  buildGenreMap,
  buildVersionMap,
  type LxnsApiResponse,
  type LxnsSong,
} from './lxns/transform';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MusicDoc = {
  id: string;
  title: string;
  type: string;
  category: string | null;
  [key: string]: unknown;
};

export type IdMapEntry = {
  key: string;
  divingFishId: string | null;
  lxnsId: string | null;
  title: string;
  type: string;
  category: string | null;
};

export type IdMapResult = {
  /** Full entry map keyed by composite key */
  map: Map<string, IdMapEntry>;
  /** Songs only present in diving-fish */
  divingFishOnly: MusicDoc[];
  /** Songs only present in lxns */
  lxnsOnly: MusicDoc[];
  /** Keys that mapped to multiple IDs within one source */
  conflicts: { key: string; docs: MusicDoc[] }[];
  /** diving-fish id → lxns id */
  dfToLxns: Map<string, string>;
  /** lxns id → diving-fish id */
  lxnsToDf: Map<string, string>;
};

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

export function makeKey(
  title: string,
  type: string,
  category: string | null,
): string {
  return `${title}||${type}||${category ?? ''}`;
}

type SourceName = 'diving-fish' | 'lxns';

const KEY_OVERRIDES: Record<
  string,
  Partial<Pick<MusicDoc, 'title' | 'type' | 'category'>>
> = {
  'diving-fish:200': { title: 'Bad Apple!! feat.nomico' },
  'diving-fish:203': { title: 'Help me, ERINNNNNN!!（Band ver.）' },
  'diving-fish:111772': { title: '[宴]人マニア' },
};

function makeKeyForDoc(source: SourceName, doc: MusicDoc): string {
  const override = KEY_OVERRIDES[`${source}:${doc.id}`];
  return makeKey(
    override?.title ?? doc.title,
    override?.type ?? doc.type,
    override?.category ?? doc.category,
  );
}

// ---------------------------------------------------------------------------
// Convert raw API data → MusicDoc[]
// ---------------------------------------------------------------------------

export function buildDivingFishDocs(items: DivingFishItem[]): MusicDoc[] {
  const now = new Date();
  return items.map(
    (item) => convertDivingFishItemToDocument(item, now) as MusicDoc,
  );
}

export function buildLxnsDocs(lxnsData: LxnsApiResponse): MusicDoc[] {
  const genreMap = buildGenreMap(lxnsData.genres ?? []);
  const versionMap = buildVersionMap(lxnsData.versions ?? []);
  const now = new Date();

  const docs: MusicDoc[] = [];

  for (const song of lxnsData.songs) {
    const diffs = song.difficulties;
    const hasStandard = diffs.standard && diffs.standard.length > 0;
    const hasDx = diffs.dx && diffs.dx.length > 0;
    const hasUtage = diffs.utage && diffs.utage.length > 0;

    if (hasStandard && hasDx) {
      // 同时有 standard 和 dx 的情况，拆成两个 doc
      const stdSong: LxnsSong = {
        ...song,
        difficulties: { standard: diffs.standard, dx: [], utage: undefined },
      };
      const dxSong: LxnsSong = {
        ...song,
        difficulties: { standard: [], dx: diffs.dx, utage: undefined },
      };
      docs.push(
        convertLxnsSongToDocument(
          stdSong,
          genreMap,
          versionMap,
          now,
        ) as MusicDoc,
      );
      docs.push(
        convertLxnsSongToDocument(
          dxSong,
          genreMap,
          versionMap,
          now,
        ) as MusicDoc,
      );
    } else if (hasUtage) {
      docs.push(
        convertLxnsSongToDocument(song, genreMap, versionMap, now) as MusicDoc,
      );
    } else {
      docs.push(
        convertLxnsSongToDocument(song, genreMap, versionMap, now) as MusicDoc,
      );
    }
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Build full ID map (with conflict detection)
// ---------------------------------------------------------------------------

export function buildIdMap(
  divingFishDocs: MusicDoc[],
  lxnsDocs: MusicDoc[],
): IdMapResult {
  const map = new Map<string, IdMapEntry>();
  const divingFishOnly: MusicDoc[] = [];
  const lxnsOnly: MusicDoc[] = [];
  const dfKeyConflicts = new Map<string, MusicDoc[]>();
  const lxnsKeyConflicts = new Map<string, MusicDoc[]>();

  // 1) Index diving-fish docs
  for (const doc of divingFishDocs) {
    const key = makeKeyForDoc('diving-fish', doc);
    if (dfKeyConflicts.has(key)) {
      dfKeyConflicts.get(key)!.push(doc);
    } else if (map.has(key)) {
      dfKeyConflicts.set(key, [map.get(key)! as unknown as MusicDoc, doc]);
    } else {
      map.set(key, {
        key,
        divingFishId: doc.id,
        lxnsId: null,
        title: doc.title,
        type: doc.type,
        category: doc.category,
      });
    }
  }

  // 2) Match lxns docs
  for (const doc of lxnsDocs) {
    const key = makeKeyForDoc('lxns', doc);
    if (lxnsKeyConflicts.has(key)) {
      lxnsKeyConflicts.get(key)!.push(doc);
      continue;
    }

    const entry = map.get(key);
    if (entry) {
      if (entry.lxnsId !== null) {
        lxnsKeyConflicts.set(key, [doc]);
      } else {
        entry.lxnsId = doc.id;
      }
    } else {
      map.set(key, {
        key,
        divingFishId: null,
        lxnsId: doc.id,
        title: doc.title,
        type: doc.type,
        category: doc.category,
      });
    }
  }

  // 3) Collect unmatched
  for (const [, entry] of map) {
    if (entry.divingFishId === null) {
      const doc = lxnsDocs.find((d) => d.id === entry.lxnsId)!;
      lxnsOnly.push(doc);
    } else if (entry.lxnsId === null) {
      const doc = divingFishDocs.find((d) => d.id === entry.divingFishId)!;
      divingFishOnly.push(doc);
    }
  }

  // 4) Collect conflicts
  const conflicts: { key: string; docs: MusicDoc[] }[] = [];
  for (const [key, docs] of dfKeyConflicts) {
    conflicts.push({ key, docs });
  }
  for (const [key, docs] of lxnsKeyConflicts) {
    conflicts.push({ key, docs });
  }

  // 5) Build bidirectional id maps
  const dfToLxns = new Map<string, string>();
  const lxnsToDf = new Map<string, string>();
  for (const [, entry] of map) {
    if (entry.divingFishId && entry.lxnsId) {
      dfToLxns.set(entry.divingFishId, entry.lxnsId);
      lxnsToDf.set(entry.lxnsId, entry.divingFishId);
    }
  }

  return { map, divingFishOnly, lxnsOnly, conflicts, dfToLxns, lxnsToDf };
}
