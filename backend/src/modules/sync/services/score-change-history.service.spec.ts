/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { ScoreChangeHistoryService } from './score-change-history.service';

describe('ScoreChangeHistoryService.changedScoreChartsByFriendBetween', () => {
  it('groups score/dxScore changes into chart-specific cids', async () => {
    const aggregate = jest.fn().mockResolvedValue([
      {
        _id: {
          friendCode: 'friend-a',
          musicId: '17',
          chartIndex: 3,
        },
      },
      {
        _id: {
          friendCode: 'friend-a',
          musicId: '100018',
          chartIndex: 10,
        },
      },
      {
        _id: {
          friendCode: 'friend-b',
          musicId: '18',
          chartIndex: 4,
        },
      },
    ]);
    const service = new ScoreChangeHistoryService({ aggregate } as any);
    const start = new Date('2026-08-18T02:00:00.000Z');
    const end = new Date('2026-08-18T02:30:00.000Z');

    await expect(
      service.changedScoreChartsByFriendBetween(start, end),
    ).resolves.toEqual([
      { friendCode: 'friend-a', musicIds: ['17_3', '100018_0'] },
      { friendCode: 'friend-b', musicIds: ['18_4'] },
    ]);
    expect(aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          $match: {
            observedAt: { $gte: start, $lt: end },
            changedFields: { $in: ['score', 'dxScore'] },
          },
        },
      ]),
    );
  });
});
