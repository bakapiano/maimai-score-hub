import type { SyncScore } from '../../sync/schemas/sync.schema';
import { CabinetService } from './cabinet.service';

const FRIEND_CODE = '123456789012345';

function makeScore(index: number): SyncScore {
  return {
    musicId: String(index + 1),
    cid: `${index + 1}_3`,
    chartIndex: 3,
    type: 'dx',
    dxScore: String(1_000 + index),
    score: '100.0000%',
    fs: null,
    fc: null,
    rating: 200,
    isNew: false,
  };
}

function makeCabinetMusic(indexes: number[]) {
  return indexes.map((index) => ({
    musicId: index + 1,
    userRivalMusicDetailList: [
      {
        level: 3,
        achievement: 1_000_000,
        deluxscoreMax: 1_000 + index,
      },
    ],
  }));
}

function makeService(input: {
  scores: SyncScore[];
  matchingIndexes?: number[];
  resolvedFriendCode?: string;
}) {
  const syncQuery = {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ scores: input.scores }),
  };
  const syncModel = {
    findOne: jest.fn().mockReturnValue(syncQuery),
  };
  const scan = {
    cabinetUserId: 42,
    rivalName: 'TEST',
    music: makeCabinetMusic(input.matchingIndexes ?? []),
  };
  const sdgb = {
    scanQr: jest.fn().mockResolvedValue(scan),
  };
  const identityMatcher = {
    match: jest.fn().mockResolvedValue({
      cabinetUserId: 42,
      rivalName: 'TEST',
      rating: 15_000,
      bot: { friendCode: '999999999999999', cabinetUserId: 99 },
      friendCode: input.resolvedFriendCode ?? FRIEND_CODE,
    }),
  };
  return {
    service: new CabinetService(
      syncModel as unknown as ConstructorParameters<typeof CabinetService>[0],
      sdgb as unknown as ConstructorParameters<typeof CabinetService>[1],
      identityMatcher as unknown as ConstructorParameters<
        typeof CabinetService
      >[2],
    ),
    identityMatcher,
    scan,
  };
}

describe('CabinetService.bindByQr verification policy', () => {
  it('requires 10 matching rows when at least 10 scores are stored', async () => {
    const scores = Array.from({ length: 12 }, (_, index) => makeScore(index));
    const { service } = makeService({
      scores,
      matchingIndexes: Array.from({ length: 9 }, (_, index) => index),
    });

    await expect(service.bindByQr(FRIEND_CODE, 'QR')).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
      verification: 'scores',
      matchedRows: 9,
      requiredRows: 10,
    });
  });

  it('accepts 10 matching rows without requiring every stored score', async () => {
    const scores = Array.from({ length: 12 }, (_, index) => makeScore(index));
    const { service } = makeService({
      scores,
      matchingIndexes: Array.from({ length: 10 }, (_, index) => index),
    });

    await expect(service.bindByQr(FRIEND_CODE, 'QR')).resolves.toEqual({
      ok: true,
      cabinetUserId: 42,
    });
  });

  it('requires every stored row when 4 to 9 scores are stored', async () => {
    const scores = Array.from({ length: 4 }, (_, index) => makeScore(index));
    const { service, identityMatcher } = makeService({
      scores,
      matchingIndexes: [0, 1, 2],
    });

    await expect(service.bindByQr(FRIEND_CODE, 'QR')).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
      verification: 'scores',
      matchedRows: 3,
      requiredRows: 4,
    });
    expect(identityMatcher.match).not.toHaveBeenCalled();
  });

  it('accepts all stored rows when fewer than 10 scores are stored', async () => {
    const scores = Array.from({ length: 7 }, (_, index) => makeScore(index));
    const { service } = makeService({
      scores,
      matchingIndexes: Array.from({ length: 7 }, (_, index) => index),
    });

    await expect(service.bindByQr(FRIEND_CODE, 'QR')).resolves.toEqual({
      ok: true,
      cabinetUserId: 42,
    });
  });

  it.each([0, 1, 2, 3])(
    'uses the shared QR-login identity matcher when %i scores are stored',
    async (scoreCount) => {
      const scores = Array.from({ length: scoreCount }, (_, index) =>
        makeScore(index),
      );
      const { service, identityMatcher, scan } = makeService({ scores });

      await expect(service.bindByQr(FRIEND_CODE, 'QR')).resolves.toEqual({
        ok: true,
        cabinetUserId: 42,
      });
      expect(identityMatcher.match).toHaveBeenCalledWith(scan, {
        tagPrefix: 'cabinet-bind',
        context: `Cabinet-bind fc=${FRIEND_CODE}`,
        source: 'cabinet_binding',
      });
    },
  );

  it('rejects a low-score QR whose resolved friendCode is different', async () => {
    const { service } = makeService({
      scores: [makeScore(0), makeScore(1), makeScore(2)],
      resolvedFriendCode: '999999999999999',
    });

    await expect(service.bindByQr(FRIEND_CODE, 'QR')).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
      verification: 'profile',
      matchedRows: 0,
      requiredRows: null,
    });
  });
});
