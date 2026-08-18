/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { MusicService } from './music.service';

describe('MusicService.resolveScoreFetchTargets', () => {
  it('resolves chart-specific cids into genre and level page metadata', async () => {
    const lean = jest.fn().mockResolvedValue([
      {
        id: '100',
        title: 'Tell Your World',
        type: 'standard',
        category: 'niconico＆VOCALOID™',
        charts: [
          { cid: '100_0', level: '1' },
          {},
          {},
          { cid: '100_3', level: '13' },
        ],
      },
      {
        id: '100018',
        title: '[協]Love You',
        type: 'utage',
        category: '宴会場',
        charts: [{ cid: '100018_0', level: '12?' }],
      },
    ]);
    const model = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean }),
      }),
    };
    const service = new MusicService(model as any, {} as any, {} as any);

    await expect(
      service.resolveScoreFetchTargets(['100_3', '100018_0', 'missing_0']),
    ).resolves.toEqual({
      targets: [
        {
          musicId: '100_3',
          title: 'Tell Your World',
          type: 'standard',
          category: 'niconico＆VOCALOID™',
          diff: 3,
          genre: 102,
          level: 19,
        },
        {
          musicId: '100018_0',
          title: '[協]Love You',
          type: 'utage',
          category: '宴会場',
          diff: 10,
          genre: 99,
          level: null,
        },
      ],
      missing: ['missing_0'],
    });
  });
});
