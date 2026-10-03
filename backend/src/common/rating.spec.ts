import { buildB50RatingSummary } from './rating';

describe('buildB50RatingSummary', () => {
  it('sums the best 15 new charts and best 35 old charts', () => {
    const newScores = Array.from({ length: 16 }, (_, index) => ({
      musicId: `new-${index}`,
      rating: 100 + index,
      isNew: true,
      type: 'dx',
    }));
    const oldScores = Array.from({ length: 36 }, (_, index) => ({
      musicId: `old-${index}`,
      rating: 200 + index,
      isNew: false,
      type: 'standard',
    }));

    const scores = [
      ...newScores,
      ...oldScores,
      { musicId: 'utage', rating: 999, isNew: true, type: 'utage' },
      { musicId: 'unknown', rating: 999, isNew: null, type: 'dx' },
      { musicId: 'unrated', rating: null, isNew: true, type: 'dx' },
      { musicId: 'invalid', rating: NaN, isNew: true, type: 'dx' },
    ];
    const summary = buildB50RatingSummary(
      scores,
      new Set(scores.map((score) => score.musicId)),
    );

    expect(summary.newTop).toHaveLength(15);
    expect(summary.oldTop).toHaveLength(35);
    expect(summary.newSum).toBe(1_620);
    expect(summary.oldSum).toBe(7_630);
    expect(summary.totalSum).toBe(9_250);
  });

  it('fills both buckets from active songs while preserving historical scores', () => {
    const active = [
      ...Array.from({ length: 16 }, (_, index) => ({
        musicId: `new-${index}`,
        rating: 200 + index,
        isNew: true,
      })),
      ...Array.from({ length: 36 }, (_, index) => ({
        musicId: `old-${index}`,
        rating: 100 + index,
        isNew: false,
      })),
    ];
    const deleted = [
      { musicId: 'deleted-new', rating: 999, isNew: true },
      { musicId: 'deleted-old', rating: 999, isNew: false },
    ];
    const scores = Object.freeze(
      [...deleted, ...active].map((score) => Object.freeze(score)),
    );
    const before = JSON.stringify(scores);
    const catalog = new Map(active.map((score) => [score.musicId, {}]));
    const summary = buildB50RatingSummary(scores, catalog);

    expect(summary.newTop).toHaveLength(15);
    expect(summary.oldTop).toHaveLength(35);
    expect(summary.newTop.at(-1)?.musicId).toBe('new-1');
    expect(summary.oldTop.at(-1)?.musicId).toBe('old-1');
    expect(summary.newSum).toBe(3120);
    expect(summary.oldSum).toBe(4130);
    expect(summary.totalSum).toBe(7250);
    expect(JSON.stringify(scores)).toBe(before);
  });

  it('returns empty buckets for an empty catalog or only deleted scores', () => {
    const scores = [{ musicId: 'deleted', rating: 999, isNew: false }];
    for (const catalog of [new Set<string>(), new Set(['active'])]) {
      expect(buildB50RatingSummary(scores, catalog)).toEqual({
        newTop: [],
        oldTop: [],
        newSum: 0,
        oldSum: 0,
        totalSum: 0,
      });
    }
  });

  it('re-evaluates the same scores against a changed catalog', () => {
    const scores = [
      { musicId: '1', rating: 300, isNew: true },
      { musicId: '10001', rating: 200, isNew: false },
    ];
    expect(
      buildB50RatingSummary(scores, new Set(['1', '10001'])).totalSum,
    ).toBe(500);
    expect(buildB50RatingSummary(scores, new Set(['10001'])).totalSum).toBe(
      200,
    );
  });
});
