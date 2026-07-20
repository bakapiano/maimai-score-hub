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

  it('uses one fallback time for legacy scores without observations', () => {
    const fallback = new Date('2026-07-20T05:00:00.000Z');
    const result = convertSyncScoresToLxnsPayload(
      [score(), score({ musicId: '10018', cid: '10018_3' })],
      undefined,
      fallback,
    );

    expect(result.scores.map((entry) => entry.play_time)).toEqual([
      fallback.toISOString(),
      fallback.toISOString(),
    ]);
  });

  it('falls back when a stored observation is invalid', () => {
    const fallback = new Date('2026-07-20T06:00:00.000Z');
    const result = convertSyncScoresToLxnsPayload(
      [score({ observedAt: new Date('invalid') })],
      undefined,
      fallback,
    );

    expect(result.scores[0].play_time).toBe(fallback.toISOString());
  });
});
