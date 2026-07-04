import { Injectable, Logger } from '@nestjs/common';

import {
  buildDivingFishDocs,
  buildIdMap,
  buildLxnsDocs,
  type MusicDoc,
} from '../../../common/prober/id-map';
import {
  getLxnsSongListUrl,
  type LxnsApiResponse,
} from '../../../common/prober/lxns/transform';
import type { DivingFishItem } from '../../../common/prober/diving-fish/transform';
import { observeFetch } from '../../../common/observability/external-call-recorder';

const DIVING_FISH_MUSIC_URL =
  'https://www.diving-fish.com/api/maimaidxprober/music_data';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export type ProberExportMap = {
  toDivingFishId: Map<string, string>;
  toLxnsId: Map<string, string>;
  divingFishTitleByDbId: Map<string, string>;
};

@Injectable()
export class ProberExportMapService {
  private readonly logger = new Logger(ProberExportMapService.name);
  private cache: { value: ProberExportMap; expiresAt: number } | null = null;

  async getMap(): Promise<ProberExportMap> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    const value = await this.buildMap();
    this.cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  private async buildMap(): Promise<ProberExportMap> {
    this.logger.log('Building prober export map for diving-fish data source');

    const [dfRaw, lxnsRaw] = await Promise.all([
      observeFetch(
        {
          target: 'diving_fish',
          apiGroup: 'catalog',
          method: 'GET',
          urlGroup: 'diving_fish.music_data',
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(DIVING_FISH_MUSIC_URL),
      ).then(async (r) => {
        if (!r.ok) {
          throw new Error(`diving-fish responded ${r.status}`);
        }
        const payload: unknown = await r.json();
        if (!Array.isArray(payload)) {
          throw new Error('diving-fish returned non-array music payload');
        }
        return payload as DivingFishItem[];
      }),
      observeFetch(
        {
          target: 'lxns',
          apiGroup: 'catalog',
          method: 'GET',
          urlGroup: 'lxns.song_list',
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(getLxnsSongListUrl()),
      ).then(async (r) => {
        if (!r.ok) {
          throw new Error(`lxns responded ${r.status}`);
        }
        return r.json() as Promise<LxnsApiResponse>;
      }),
    ]);

    const dfDocs = buildDivingFishDocs(dfRaw);
    const lxDocs = buildLxnsDocs(lxnsRaw);
    const { dfToLxns } = buildIdMap(dfDocs, lxDocs);
    const dfById = this.indexById(dfDocs);

    const toDivingFishId = new Map<string, string>();
    const toLxnsId = new Map<string, string>();
    const divingFishTitleByDbId = new Map<string, string>();

    for (const [id, doc] of dfById) {
      toDivingFishId.set(id, id);
      divingFishTitleByDbId.set(id, doc.title);
    }
    for (const [dfId, lxnsId] of dfToLxns) {
      toLxnsId.set(dfId, lxnsId);
    }

    this.logger.log(
      `Prober export map ready: toDivingFish=${toDivingFishId.size}, toLxns=${toLxnsId.size}`,
    );
    return {
      toDivingFishId,
      toLxnsId,
      divingFishTitleByDbId,
    };
  }

  private indexById(docs: MusicDoc[]): Map<string, MusicDoc> {
    const map = new Map<string, MusicDoc>();
    for (const doc of docs) {
      map.set(String(doc.id), doc);
    }
    return map;
  }
}
