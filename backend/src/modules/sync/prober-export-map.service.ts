import { Injectable, Logger } from '@nestjs/common';

import { MusicService } from '../music/music.service';
import type { MusicDataSource } from '../music/music.service';
import {
  buildDivingFishDocs,
  buildIdMap,
  buildLxnsDocs,
  type MusicDoc,
} from '../../common/prober/id-map';
import {
  getLxnsSongListUrl,
  type LxnsApiResponse,
} from '../../common/prober/lxns/transform';

const DIVING_FISH_MUSIC_URL =
  'https://www.diving-fish.com/api/maimaidxprober/music_data';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type ProberExportMap = {
  dataSource: MusicDataSource;
  toDivingFishId: Map<string, string>;
  toLxnsId: Map<string, string>;
  divingFishTitleByDbId: Map<string, string>;
};

@Injectable()
export class ProberExportMapService {
  private readonly logger = new Logger(ProberExportMapService.name);
  private cache: { value: ProberExportMap; expiresAt: number } | null = null;

  constructor(private readonly musicService: MusicService) {}

  async getMap(): Promise<ProberExportMap> {
    const dataSource = await this.musicService.getDataSource();
    const now = Date.now();
    if (
      this.cache &&
      this.cache.value.dataSource === dataSource &&
      this.cache.expiresAt > now
    ) {
      return this.cache.value;
    }

    const value = await this.buildMap(dataSource);
    this.cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  private async buildMap(
    dataSource: MusicDataSource,
  ): Promise<ProberExportMap> {
    this.logger.log(`Building prober export map for ${dataSource} data source`);

    const [dfRaw, lxnsRaw] = await Promise.all([
      fetch(DIVING_FISH_MUSIC_URL).then(async (r) => {
        if (!r.ok) throw new Error(`diving-fish responded ${r.status}`);
        return r.json() as Promise<any[]>;
      }),
      fetch(getLxnsSongListUrl()).then(async (r) => {
        if (!r.ok) throw new Error(`lxns responded ${r.status}`);
        return r.json() as Promise<LxnsApiResponse>;
      }),
    ]);

    const dfDocs = buildDivingFishDocs(dfRaw);
    const lxDocs = buildLxnsDocs(lxnsRaw);
    const { dfToLxns, lxnsToDf } = buildIdMap(dfDocs, lxDocs);
    const dfById = this.indexById(dfDocs);
    const lxById = this.indexById(lxDocs);

    const toDivingFishId = new Map<string, string>();
    const toLxnsId = new Map<string, string>();
    const divingFishTitleByDbId = new Map<string, string>();

    if (dataSource === 'diving-fish') {
      for (const [id, doc] of dfById) {
        toDivingFishId.set(id, id);
        divingFishTitleByDbId.set(id, doc.title);
      }
      for (const [dfId, lxnsId] of dfToLxns) {
        toLxnsId.set(dfId, lxnsId);
      }
    } else {
      for (const [id] of lxById) {
        toLxnsId.set(id, id);
      }
      for (const [lxnsId, dfId] of lxnsToDf) {
        const dfDoc = dfById.get(dfId);
        toDivingFishId.set(lxnsId, dfId);
        if (dfDoc) {
          divingFishTitleByDbId.set(lxnsId, dfDoc.title);
        }
      }
    }

    this.logger.log(
      `Prober export map ready: toDivingFish=${toDivingFishId.size}, toLxns=${toLxnsId.size}`,
    );

    return {
      dataSource,
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
