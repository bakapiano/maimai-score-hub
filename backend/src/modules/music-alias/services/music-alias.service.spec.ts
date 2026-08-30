/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { MusicAliasService } from './music-alias.service';

const lxnsSongPayload = {
  songs: [
    {
      id: 30,
      title: 'ジングルベル',
      artist: 'SEGA',
      genre: 'POPS＆アニメ',
      bpm: 120,
      version: 10000,
      difficulties: {
        standard: [
          {
            type: 'standard',
            difficulty: 0,
            level: '4',
            level_value: 4,
            note_designer: '-',
            version: 10000,
          },
        ],
        dx: [
          {
            type: 'dx',
            difficulty: 0,
            level: '4',
            level_value: 4,
            note_designer: '-',
            version: 10000,
          },
        ],
      },
    },
  ],
  genres: [{ id: 1, title: '流行&动漫', genre: 'POPS＆アニメ' }],
  versions: [{ id: 1, title: 'maimai', version: 10000 }],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function createHarness() {
  const bulkWrite = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
  const aliasLean = jest.fn().mockResolvedValue([]);
  const aliasModel = {
    bulkWrite,
    deleteMany,
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: aliasLean }),
    }),
  };
  const musicDocs = [
    {
      id: '30',
      title: 'ジングルベル',
      type: 'standard',
      category: '流行&动漫',
    },
    {
      id: '10030',
      title: 'ジングルベル',
      type: 'dx',
      category: '流行&动漫',
    },
  ];
  const musicModel = {
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(musicDocs),
      }),
    }),
  };
  const config = {
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  };
  const redis = {
    key: jest.fn((key: string) => `test:${key}`),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
  };
  const service = new MusicAliasService(
    aliasModel as never,
    musicModel as never,
    config as never,
    redis as never,
  );
  return {
    service,
    aliasModel,
    aliasLean,
    bulkWrite,
    deleteMany,
    redis,
  };
}

describe('MusicAliasService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('syncs both providers and expands one LXNS song to standard and DX ids', async () => {
    const { service, bulkWrite, deleteMany, redis } = createHarness();
    jest.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes('yuzuchan')) {
        return Promise.resolve(
          response([
            {
              song_id: 10030,
              name: 'ジングルベル',
              alias: ['DX圣诞歌'],
            },
          ]),
        );
      }
      if (url.includes('/alias/list')) {
        return Promise.resolve(
          response({
            aliases: [{ song_id: 30, aliases: ['圣诞歌'] }],
          }),
        );
      }
      return Promise.resolve(response(lxnsSongPayload));
    });

    const result = await service.syncAll();

    expect(result.sources.yuzuchan.status).toBe('completed');
    expect(result.sources.lxns.status).toBe('completed');
    const operations = bulkWrite.mock.calls.flatMap(([items]) => items);
    const lxnsOperation = operations.find(
      (operation) => operation.updateOne.filter.source === 'lxns',
    );
    expect(lxnsOperation.updateOne.update.$set.musicIds).toEqual([
      '30',
      '10030',
    ]);
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'yuzuchan' }),
    );
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'lxns' }),
    );
    expect(redis.del).toHaveBeenCalledWith('test:catalog:music-aliases:v1');
  });

  it('keeps the previous snapshot for a failed provider', async () => {
    const { service, deleteMany } = createHarness();
    jest.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes('yuzuchan')) {
        return Promise.resolve(response({ error: 'temporary' }, 503));
      }
      if (url.includes('/alias/list')) {
        return Promise.resolve(
          response({
            aliases: [{ song_id: 30, aliases: ['圣诞歌'] }],
          }),
        );
      }
      return Promise.resolve(response(lxnsSongPayload));
    });

    const result = await service.syncAll();

    expect(result.sources.yuzuchan.status).toBe('failed');
    expect(result.sources.lxns.status).toBe('completed');
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'lxns' }),
    );
  });

  it('groups providers by music id and prefers the Yuzuchan display form', async () => {
    const { service, aliasLean, redis } = createHarness();
    aliasLean.mockResolvedValue([
      {
        source: 'lxns',
        musicIds: ['30', '10030'],
        alias: 'DX圣诞歌',
        normalizedAlias: 'dx圣诞歌',
        syncedAt: '2026-08-30T01:00:00.000Z',
      },
      {
        source: 'yuzuchan',
        musicIds: ['10030'],
        alias: 'dx圣诞歌',
        normalizedAlias: 'dx圣诞歌',
        syncedAt: '2026-08-30T02:00:00.000Z',
      },
      {
        source: 'lxns',
        musicIds: ['30'],
        alias: '圣诞歌',
        normalizedAlias: '圣诞歌',
        syncedAt: '2026-08-30T01:00:00.000Z',
      },
    ]);

    await expect(service.findAll()).resolves.toEqual({
      revision: '2026-08-30T02:00:00.000Z',
      aliases: [
        { musicId: '30', aliases: ['圣诞歌', 'DX圣诞歌'] },
        { musicId: '10030', aliases: ['dx圣诞歌'] },
      ],
    });
    expect(redis.setJson).toHaveBeenCalledWith(
      'test:catalog:music-aliases:v1',
      expect.any(Object),
      { ttlSeconds: 300 },
    );
  });
});
