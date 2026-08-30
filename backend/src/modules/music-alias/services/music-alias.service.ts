import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type {
  MusicAliasEntry,
  MusicAliasListResponse,
} from '@maimai-score-hub/shared';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';

import { observeFetch } from '../../../common/observability/external-call-recorder';
import {
  buildIdMap,
  buildLxnsDocs,
  type MusicDoc,
} from '../../../common/prober/id-map';
import type { LxnsApiResponse } from '../../../common/prober/lxns/transform';
import { RedisService } from '../../../common/redis/redis.service';
import { MusicEntity } from '../../music/schemas/music.schema';
import {
  MusicAliasEntity,
  type MusicAliasSource,
} from '../schemas/music-alias.schema';

const DEFAULT_YUZUCHAN_ALIAS_URL =
  'https://www.yuzuchan.moe/api/v2/aliases/maimaidx/aliases';
const DEFAULT_LXNS_ALIAS_URL =
  'https://maimai.lxns.net/api/v0/maimai/alias/list';
const DEFAULT_LXNS_SONG_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list';
const PUBLIC_CACHE_TTL_SECONDS = 5 * 60;
const BULK_WRITE_BATCH_SIZE = 1000;

type SourceAlias = {
  sourceMusicId: string;
  musicIds: string[];
  alias: string;
  normalizedAlias: string;
};

export type MusicAliasSourceSyncSummary = {
  source: MusicAliasSource;
  fetched: number;
  stored: number;
  unmapped: number;
  removed: number;
};

export type MusicAliasSyncSummary = {
  sources: Record<
    MusicAliasSource,
    | { status: 'completed'; summary: MusicAliasSourceSyncSummary }
    | { status: 'failed'; error: string }
  >;
};

type StoredAliasRow = {
  source: MusicAliasSource;
  musicIds: string[];
  alias: string;
  normalizedAlias: string;
  syncedAt: Date | string;
};

@Injectable()
export class MusicAliasService {
  private readonly logger = new Logger(MusicAliasService.name);

  constructor(
    @InjectModel(MusicAliasEntity.name)
    private readonly aliasModel: Model<MusicAliasEntity>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async syncAll(signal?: AbortSignal): Promise<MusicAliasSyncSummary> {
    signal?.throwIfAborted();
    const musicDocs = await this.musicModel
      .find()
      .select({ _id: 0, id: 1, title: 1, type: 1, category: 1 })
      .lean<MusicDoc[]>();
    const musicIds = new Set(musicDocs.map((music) => String(music.id)));

    const [yuzuchan, lxns] = await Promise.allSettled([
      this.syncYuzuchan(musicIds, signal),
      this.syncLxns(musicDocs, musicIds, signal),
    ]);
    const summary: MusicAliasSyncSummary = {
      sources: {
        yuzuchan: this.sourceResult('yuzuchan', yuzuchan),
        lxns: this.sourceResult('lxns', lxns),
      },
    };

    if (yuzuchan.status === 'rejected' && lxns.status === 'rejected') {
      throw new Error(
        `Alias sync failed for every source: yuzuchan=${this.errorMessage(yuzuchan.reason)}; lxns=${this.errorMessage(lxns.reason)}`,
      );
    }

    await this.redis.del(this.publicCacheKey());
    return summary;
  }

  async findAll(): Promise<MusicAliasListResponse> {
    const cacheKey = this.publicCacheKey();
    const cached = await this.redis.getJson<MusicAliasListResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    const rows = await this.aliasModel
      .find({ 'musicIds.0': { $exists: true } })
      .select({
        _id: 0,
        source: 1,
        musicIds: 1,
        alias: 1,
        normalizedAlias: 1,
        syncedAt: 1,
      })
      .lean<StoredAliasRow[]>();
    const grouped = new Map<
      string,
      Map<string, { alias: string; priority: number }>
    >();
    let revisionMs = 0;

    for (const row of rows) {
      const syncedAt = new Date(row.syncedAt).getTime();
      if (Number.isFinite(syncedAt)) {
        revisionMs = Math.max(revisionMs, syncedAt);
      }
      const priority = row.source === 'yuzuchan' ? 0 : 1;
      for (const musicId of row.musicIds) {
        const aliases =
          grouped.get(musicId) ??
          new Map<string, { alias: string; priority: number }>();
        const current = aliases.get(row.normalizedAlias);
        if (!current || priority < current.priority) {
          aliases.set(row.normalizedAlias, { alias: row.alias, priority });
        }
        grouped.set(musicId, aliases);
      }
    }

    const aliases: MusicAliasEntry[] = [...grouped.entries()]
      .sort(([left], [right]) => this.compareMusicIds(left, right))
      .map(([musicId, values]) => ({
        musicId,
        aliases: [...values.values()]
          .map((value) => value.alias)
          .sort((left, right) => left.localeCompare(right)),
      }));
    const response: MusicAliasListResponse = {
      revision: revisionMs ? new Date(revisionMs).toISOString() : null,
      aliases,
    };
    await this.redis.setJson(cacheKey, response, {
      ttlSeconds: PUBLIC_CACHE_TTL_SECONDS,
    });
    return response;
  }

  private async syncYuzuchan(
    musicIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<MusicAliasSourceSyncSummary> {
    const url = this.config.get<string>(
      'YUZUCHAN_ALIAS_URL',
      DEFAULT_YUZUCHAN_ALIAS_URL,
    );
    const payload = await this.fetchJson(
      url,
      'yuzuchan',
      'yuzuchan.alias_list',
      signal,
    );
    if (!Array.isArray(payload)) {
      throw new Error('Yuzuchan alias payload must be an array');
    }

    const aliases: SourceAlias[] = [];
    let fetched = 0;
    for (const item of payload) {
      if (!this.isRecord(item)) {
        continue;
      }
      const sourceMusicId = this.sourceMusicId(item.song_id);
      if (!sourceMusicId || !Array.isArray(item.alias)) {
        continue;
      }
      for (const value of item.alias) {
        const alias = this.aliasValue(value);
        if (!alias) {
          continue;
        }
        fetched += 1;
        aliases.push({
          sourceMusicId,
          musicIds: musicIds.has(sourceMusicId) ? [sourceMusicId] : [],
          alias,
          normalizedAlias: this.normalizeAlias(alias),
        });
      }
    }
    return this.persistSource('yuzuchan', aliases, fetched, signal);
  }

  private async syncLxns(
    musicDocs: MusicDoc[],
    musicIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<MusicAliasSourceSyncSummary> {
    const headers = this.lxnsHeaders();
    const [aliasPayload, songPayload] = await Promise.all([
      this.fetchJson(
        this.config.get<string>('LXNS_ALIAS_URL', DEFAULT_LXNS_ALIAS_URL),
        'lxns',
        'lxns.alias_list',
        signal,
        headers,
      ),
      this.fetchJson(
        this.config.get<string>('LXNS_SONG_LIST_URL', DEFAULT_LXNS_SONG_URL),
        'lxns',
        'lxns.song_list',
        signal,
        headers,
      ),
    ]);
    if (!this.isRecord(aliasPayload) || !Array.isArray(aliasPayload.aliases)) {
      throw new Error('LXNS alias payload must contain an aliases array');
    }
    if (
      !this.isRecord(songPayload) ||
      !Array.isArray(songPayload.songs) ||
      !Array.isArray(songPayload.genres) ||
      !Array.isArray(songPayload.versions)
    ) {
      throw new Error('LXNS song payload has an unexpected shape');
    }

    const lxnsDocs = buildLxnsDocs(songPayload as LxnsApiResponse);
    const { dfToLxns } = buildIdMap(musicDocs, lxnsDocs);
    const lxnsToMusicIds = new Map<string, Set<string>>();
    for (const [musicId, lxnsId] of dfToLxns) {
      const resolved = lxnsToMusicIds.get(lxnsId) ?? new Set<string>();
      resolved.add(musicId);
      lxnsToMusicIds.set(lxnsId, resolved);
    }

    const aliases: SourceAlias[] = [];
    let fetched = 0;
    for (const item of aliasPayload.aliases) {
      if (!this.isRecord(item)) {
        continue;
      }
      const sourceMusicId = this.sourceMusicId(item.song_id);
      if (!sourceMusicId || !Array.isArray(item.aliases)) {
        continue;
      }
      const resolvedMusicIds = this.resolveLxnsMusicIds(
        sourceMusicId,
        lxnsToMusicIds,
        musicIds,
      );
      for (const value of item.aliases) {
        const alias = this.aliasValue(value);
        if (!alias) {
          continue;
        }
        fetched += 1;
        aliases.push({
          sourceMusicId,
          musicIds: resolvedMusicIds,
          alias,
          normalizedAlias: this.normalizeAlias(alias),
        });
      }
    }
    return this.persistSource('lxns', aliases, fetched, signal);
  }

  private resolveLxnsMusicIds(
    sourceMusicId: string,
    lxnsToMusicIds: ReadonlyMap<string, ReadonlySet<string>>,
    catalogIds: ReadonlySet<string>,
  ): string[] {
    const mapped = lxnsToMusicIds.get(sourceMusicId);
    if (mapped?.size) {
      return [...mapped].sort((left, right) =>
        this.compareMusicIds(left, right),
      );
    }

    const fallback = new Set<string>();
    if (catalogIds.has(sourceMusicId)) {
      fallback.add(sourceMusicId);
    }
    const parsed = Number(sourceMusicId);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed < 10000) {
      const dxId = String(parsed + 10000);
      if (catalogIds.has(dxId)) {
        fallback.add(dxId);
      }
    }
    return [...fallback].sort((left, right) =>
      this.compareMusicIds(left, right),
    );
  }

  private async persistSource(
    source: MusicAliasSource,
    sourceAliases: SourceAlias[],
    fetched: number,
    signal?: AbortSignal,
  ): Promise<MusicAliasSourceSyncSummary> {
    if (!sourceAliases.length) {
      throw new Error(`${source} alias payload produced an empty snapshot`);
    }
    const deduplicated = new Map<string, SourceAlias>();
    for (const item of sourceAliases) {
      deduplicated.set(
        `${item.sourceMusicId}\u0000${item.normalizedAlias}`,
        item,
      );
    }
    const values = [...deduplicated.values()];
    const runId = randomUUID();
    const syncedAt = new Date();

    for (
      let offset = 0;
      offset < values.length;
      offset += BULK_WRITE_BATCH_SIZE
    ) {
      signal?.throwIfAborted();
      const batch = values.slice(offset, offset + BULK_WRITE_BATCH_SIZE);
      await this.aliasModel.bulkWrite(
        batch.map((item) => ({
          updateOne: {
            filter: {
              source,
              sourceMusicId: item.sourceMusicId,
              normalizedAlias: item.normalizedAlias,
            },
            update: {
              $set: {
                musicIds: item.musicIds,
                alias: item.alias,
                syncRunId: runId,
                syncedAt,
              },
              $setOnInsert: {
                source,
                sourceMusicId: item.sourceMusicId,
                normalizedAlias: item.normalizedAlias,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    signal?.throwIfAborted();
    const stale = await this.aliasModel.deleteMany({
      source,
      syncRunId: { $ne: runId },
    });
    const summary = {
      source,
      fetched,
      stored: values.length,
      unmapped: values.filter((item) => item.musicIds.length === 0).length,
      removed: stale.deletedCount,
    };
    this.logger.log(
      `Alias source synced: source=${source}, fetched=${summary.fetched}, stored=${summary.stored}, unmapped=${summary.unmapped}, removed=${summary.removed}`,
    );
    return summary;
  }

  private async fetchJson(
    url: string,
    target: 'yuzuchan' | 'lxns',
    urlGroup: string,
    signal?: AbortSignal,
    headers?: HeadersInit,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const response = await observeFetch(
      {
        target,
        apiGroup: 'catalog_aliases',
        method: 'GET',
        urlGroup,
        statusCode: 0,
        durationMs: 0,
      },
      () => fetch(url, { signal, headers }),
    );
    if (!response.ok) {
      throw new Error(`${target} responded with status ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }

  private lxnsHeaders(): HeadersInit | undefined {
    const token = this.config.get<string>('LXNS_DEV_TOKEN')?.trim();
    return token ? { Authorization: token } : undefined;
  }

  private sourceResult(
    source: MusicAliasSource,
    result: PromiseSettledResult<MusicAliasSourceSyncSummary>,
  ): MusicAliasSyncSummary['sources'][MusicAliasSource] {
    if (result.status === 'fulfilled') {
      return { status: 'completed', summary: result.value };
    }
    const error = this.errorMessage(result.reason);
    this.logger.error(
      `Alias source sync failed: source=${source}, error=${error}`,
    );
    return { status: 'failed', error };
  }

  private sourceMusicId(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return null;
  }

  private aliasValue(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const alias = value.normalize('NFKC').trim();
    return alias ? alias : null;
  }

  private normalizeAlias(value: string): string {
    return value.normalize('NFKC').trim().toLowerCase();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private compareMusicIds(left: string, right: string): number {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }
    return left.localeCompare(right);
  }

  private publicCacheKey(): string {
    return this.redis.key('catalog:music-aliases:v1');
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
