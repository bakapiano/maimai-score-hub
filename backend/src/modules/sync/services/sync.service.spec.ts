import { SyncService } from './sync.service';

describe('SyncService.mergeRecentEvents', () => {
  it('merges uniquely matched recent FC/FS events without a since watermark', async () => {
    const previousSync = {
      id: 'previous-sync',
      friendCode: '634142510810999',
      scores: [
        {
          musicId: '220',
          cid: '220_3',
          chartIndex: 3,
          type: 'standard',
          dxScore: '1019',
          score: '100.7833%',
          fs: null,
          fc: null,
          rating: 292,
          isNew: false,
        },
      ],
    };
    const createdSyncs: any[] = [];
    const findLatestSyncQuery = {
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(previousSync),
    };
    const syncModel = {
      findOne: jest.fn().mockReturnValue(findLatestSyncQuery),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      create: jest.fn(async (input) => {
        createdSyncs.push(input);
        return { toObject: () => input };
      }),
    };
    const musicModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            id: '220',
            title: 'セガサターン起動音[H.][Remix]',
            type: 'standard',
            category: '其他游戏',
            charts: [{}, {}, {}, { cid: '220_3' }],
          },
        ]),
      }),
    };
    const service = new SyncService(
      syncModel as any,
      musicModel as any,
      {} as any,
    );

    const result = await service.mergeRecentEvents({
      friendCode: '634142510810999',
      sourceId: 'recent-event-job',
      events: [
        {
          time: '2026/07/05 12:56',
          songName: 'セガサターン起動音[H.][Remix]',
          difficulty: 'master',
          fc: null,
          fs: 'fsp',
        },
      ],
    });

    expect(result).toMatchObject({
      eventCount: 1,
      matchedCount: 1,
      updatedCount: 1,
    });
    expect(createdSyncs).toHaveLength(1);
    expect(createdSyncs[0].scores[0].fs).toBe('fsp');
  });

  it('skips recent events that match multiple current scores', async () => {
    const previousSync = {
      id: 'previous-sync',
      friendCode: '634142510810999',
      scores: [
        {
          musicId: '30',
          cid: '30_3',
          chartIndex: 3,
          type: 'standard',
          dxScore: '1000',
          score: '100.0000%',
          fs: null,
          fc: null,
          rating: 100,
          isNew: false,
        },
        {
          musicId: '10030',
          cid: '10030_3',
          chartIndex: 3,
          type: 'dx',
          dxScore: '1000',
          score: '100.0000%',
          fs: null,
          fc: null,
          rating: 100,
          isNew: true,
        },
      ],
    };
    const findLatestSyncQuery = {
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(previousSync),
    };
    const syncModel = {
      findOne: jest.fn().mockReturnValue(findLatestSyncQuery),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      create: jest.fn(async (input) => ({ toObject: () => input })),
    };
    const musicModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            id: '30',
            title: 'ネコ日和。',
            type: 'standard',
            category: '舞萌',
            charts: [{}, {}, {}, { cid: '30_3' }],
          },
          {
            id: '10030',
            title: 'ネコ日和。',
            type: 'dx',
            category: '舞萌',
            charts: [{}, {}, {}, { cid: '10030_3' }],
          },
        ]),
      }),
    };
    const service = new SyncService(
      syncModel as any,
      musicModel as any,
      {} as any,
    );

    const result = await service.mergeRecentEvents({
      friendCode: '634142510810999',
      sourceId: 'recent-event-job',
      events: [
        {
          time: '2026/07/05 11:16',
          songName: 'ネコ日和。',
          difficulty: 'master',
          fc: 'ap',
          fs: null,
        },
      ],
    });

    expect(result).toMatchObject({
      eventCount: 1,
      matchedCount: 0,
      updatedCount: 0,
      syncId: 'previous-sync',
    });
    expect(syncModel.create).not.toHaveBeenCalled();
  });
});
