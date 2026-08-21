import { ManualScoreUpdateBodySchema } from '@maimai-score-hub/shared';

import { MeSyncController } from './me-sync.controller';

describe('MeSyncController.updateScores', () => {
  function makeSubject(changedChartCount = 1) {
    const response = {
      sourceId: '0264d7c8-95d6-4c3b-b953-707434ea3154',
      syncId: 'sync-1',
      outcome:
        changedChartCount > 0 ? ('updated' as const) : ('no_change' as const),
      submittedChartCount: 2,
      changedChartCount,
      scoreCount: 20,
      scoreVersion: changedChartCount > 0 ? 4 : 3,
    };
    const syncs = {
      createFromManualScores: jest.fn().mockResolvedValue(response),
    };
    const proberExports = {
      ensureAutoExportWake: jest.fn().mockResolvedValue(undefined),
    };
    const users = {
      getById: jest.fn().mockResolvedValue({
        friendCode: '123456789012345',
      }),
    };
    const controller = new MeSyncController(
      syncs as never,
      users as never,
      proberExports as never,
    );
    return { controller, syncs, users, proberExports, response };
  }

  const body = {
    scores: [
      { musicId: '17', chartIndex: 3, achievement: 100.5 },
      { musicId: '18', chartIndex: 4, dxScore: 1234, fc: 'ap' as const },
    ],
  };

  it('uses the JWT owner and wakes automatic exports after an improvement', async () => {
    const subject = makeSubject();

    await expect(
      subject.controller.updateScores(
        {
          user: {
            sub: '68a7e801e9abbd760017a62e',
            friendCode: '123456789012345',
          },
        } as never,
        body,
      ),
    ).resolves.toEqual(subject.response);
    expect(subject.syncs.createFromManualScores).toHaveBeenCalledWith({
      friendCode: '123456789012345',
      ownerUserId: '68a7e801e9abbd760017a62e',
      scores: body.scores,
    });
    expect(subject.proberExports.ensureAutoExportWake).toHaveBeenCalledWith(
      '123456789012345',
    );
  });

  it('keeps the export cursor settled for a no_change result', async () => {
    const subject = makeSubject(0);

    await subject.controller.updateScores(
      {
        user: {
          sub: '68a7e801e9abbd760017a62e',
          friendCode: '123456789012345',
        },
      } as never,
      body,
    );

    expect(subject.proberExports.ensureAutoExportWake).not.toHaveBeenCalled();
  });

  it('rejects a token whose subject and friend code resolve to different users', async () => {
    const subject = makeSubject();
    subject.users.getById.mockResolvedValue({
      friendCode: '999999999999999',
    });

    await expect(
      subject.controller.updateScores(
        {
          user: {
            sub: '68a7e801e9abbd760017a62e',
            friendCode: '123456789012345',
          },
        } as never,
        body,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(subject.syncs.createFromManualScores).not.toHaveBeenCalled();
  });

  it('validates batch size, fields and score ranges in the shared schema', () => {
    expect(() => ManualScoreUpdateBodySchema.parse({ scores: [] })).toThrow();
    expect(() =>
      ManualScoreUpdateBodySchema.parse({
        scores: [{ musicId: '17', chartIndex: 3 }],
      }),
    ).toThrow('at least one score field is required');
    expect(() =>
      ManualScoreUpdateBodySchema.parse({
        scores: [{ musicId: '17', chartIndex: 3, achievement: 101.1 }],
      }),
    ).toThrow();
  });
});
