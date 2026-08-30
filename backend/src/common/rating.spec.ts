import { buildB50RatingSummary } from './rating';

describe('buildB50RatingSummary', () => {
  it('sums the best 15 new charts and best 35 old charts', () => {
    const newScores = Array.from({ length: 16 }, (_, index) => ({
      rating: 100 + index,
      isNew: true,
      type: 'dx',
    }));
    const oldScores = Array.from({ length: 36 }, (_, index) => ({
      rating: 200 + index,
      isNew: false,
      type: 'standard',
    }));

    const summary = buildB50RatingSummary([
      ...newScores,
      ...oldScores,
      { rating: 999, isNew: true, type: 'utage' },
      { rating: 999, isNew: null, type: 'dx' },
      { rating: null, isNew: true, type: 'dx' },
    ]);

    expect(summary.newTop).toHaveLength(15);
    expect(summary.oldTop).toHaveLength(35);
    expect(summary.newSum).toBe(1_620);
    expect(summary.oldSum).toBe(7_630);
    expect(summary.totalSum).toBe(9_250);
  });
});
