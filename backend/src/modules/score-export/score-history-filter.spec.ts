import {
  hasScoreHistoryKeyChange,
  ScoreHistoryExportQuerySchema,
  type ScoreHistoryKeyChangeInput,
} from '@maimai-score-hub/shared';

function change(
  overrides: Partial<ScoreHistoryKeyChangeInput> = {},
): ScoreHistoryKeyChangeInput {
  return {
    before: {
      score: '99.1000%',
      dxScore: '276',
      fc: null,
      fs: null,
      rating: 100,
    },
    after: {
      score: '99.4000%',
      dxScore: '278',
      fc: null,
      fs: null,
      rating: 101,
    },
    beforeDxStar: 2,
    afterDxStar: 2,
    ...overrides,
  };
}

describe('score history key-change filter', () => {
  it('ignores numeric improvements that stay within displayed tiers', () => {
    expect(hasScoreHistoryKeyChange(change())).toBe(false);
  });

  it('keeps achievement-rank and DX-star boundary changes', () => {
    expect(
      hasScoreHistoryKeyChange(
        change({
          before: { score: '99.4999%' },
          after: { score: '99.5000%' },
        }),
      ),
    ).toBe(true);
    expect(
      hasScoreHistoryKeyChange(change({ beforeDxStar: 2, afterDxStar: 3 })),
    ).toBe(true);
  });

  it('keeps FC and FS transitions, including transitions from empty', () => {
    expect(
      hasScoreHistoryKeyChange(
        change({
          before: { score: '99.1000%', fc: null },
          after: { score: '99.4000%', fc: 'fc' },
        }),
      ),
    ).toBe(true);
    expect(
      hasScoreHistoryKeyChange(
        change({
          before: { score: '99.1000%', fc: 'fc' },
          after: { score: '99.4000%', fc: 'ap' },
        }),
      ),
    ).toBe(true);
    expect(
      hasScoreHistoryKeyChange(
        change({
          before: { score: '99.1000%', fs: null },
          after: { score: '99.4000%', fs: 'fsp' },
        }),
      ),
    ).toBe(true);
  });

  it('does not treat equivalent status aliases as changes', () => {
    expect(
      hasScoreHistoryKeyChange(
        change({
          before: { score: '99.1000%', fc: 'fc+', fs: 'fsd+' },
          after: { score: '99.4000%', fc: 'fcp', fs: 'fdxp' },
        }),
      ),
    ).toBe(false);
  });

  it('parses the export filter as an optional query boolean', () => {
    const query = {
      date: '2026-07-22',
      start: 1,
      end: 2,
      timeZone: 'Asia/Shanghai',
      dayStartHour: 6,
    };
    expect(ScoreHistoryExportQuerySchema.parse(query).keyChangesOnly).toBe(
      false,
    );
    expect(
      ScoreHistoryExportQuerySchema.parse({
        ...query,
        keyChangesOnly: 'true',
      }).keyChangesOnly,
    ).toBe(true);
  });
});
