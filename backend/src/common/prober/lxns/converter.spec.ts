import type { SyncScore } from '../../../modules/sync/schemas/sync.schema';
import { convertSyncScoresToLxnsPayload } from './converter';

function score(input: Partial<SyncScore> = {}): SyncScore {
  return {
    musicId: '10017',
    cid: '10017_3',
    chartIndex: 3,
    type: 'dx',
    dxScore: '1234',
    score: '100.5000%',
    fs: 'fdxp',
    fc: 'app',
    rating: 300,
    isNew: false,
    ...input,
  };
}

describe('convertSyncScoresToLxnsPayload', () => {
  it('exports the persisted observation as LXNS play_time', () => {
    const observedAt = new Date('2026-07-20T04:38:00.000Z');
    const result = convertSyncScoresToLxnsPayload([score({ observedAt })]);

    expect(result.scores[0]).toMatchObject({
      id: 17,
      type: 'dx',
      play_time: observedAt.toISOString(),
    });
  });

  it('omits play_time for legacy scores without observations', () => {
    const result = convertSyncScoresToLxnsPayload([
      score(),
      score({ musicId: '10018', cid: '10018_3' }),
    ]);

    expect(result.scores[0]).not.toHaveProperty('play_time');
    expect(result.scores[1]).not.toHaveProperty('play_time');
  });

  it('omits play_time when a stored observation is invalid', () => {
    const result = convertSyncScoresToLxnsPayload([
      score({ observedAt: new Date('invalid') }),
    ]);

    expect(result.scores[0]).not.toHaveProperty('play_time');
  });
});
