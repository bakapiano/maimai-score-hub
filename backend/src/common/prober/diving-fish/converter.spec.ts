import type { SyncScore } from '../../../modules/sync/schemas/sync.schema';
import { convertSyncScoresToDivingFishRecords } from './converter';

function score(musicId: string, chartIndex: number): SyncScore {
  return {
    musicId,
    cid: `${musicId}_${chartIndex}`,
    chartIndex,
    type: 'standard',
    dxScore: '1000',
    score: '100.0000%',
    fc: null,
    fs: null,
    rating: 0,
    isNew: false,
  };
}

describe('Diving-Fish score converter', () => {
  it('uses the Diving-Fish import alias only for music 383', () => {
    const titles = new Map([
      ['131', 'Link'],
      ['383', 'Link'],
    ]);

    const records = convertSyncScoresToDivingFishRecords(
      [score('131', 4), score('383', 3)],
      titles,
    );

    expect(records.map((record) => record.title)).toEqual([
      'Link',
      'Link(CoF)',
    ]);
  });
});
