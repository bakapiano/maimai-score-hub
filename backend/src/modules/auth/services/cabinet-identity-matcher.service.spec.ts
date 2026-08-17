import { CabinetIdentityMatcherService } from './cabinet-identity-matcher.service';

describe('CabinetIdentityMatcherService claim snapshot fencing', () => {
  function serviceWithSnapshot(updatedAt: Date) {
    return new CabinetIdentityMatcherService(
      {} as never,
      {} as never,
      {
        get: jest.fn().mockResolvedValue({
          updatedAt,
          friends: [
            {
              friendCode: '123456789012345',
              userName: 'TARGET',
              rating: 15_000,
            },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  const attempt = {
    id: 'attempt',
    status: 'waiting_snapshot',
    purpose: 'login',
    cabinetUserId: 1,
    rivalName: 'TARGET',
    computedRating: 15_000,
    botUserFriendCode: '999999999999999',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    updatedAt: new Date('2026-08-09T00:00:00.000Z'),
  } as const;

  it('ignores the capacity-refresh snapshot taken before addRival', async () => {
    const service = serviceWithSnapshot(new Date('2026-08-09T00:00:01.000Z'));
    await expect(
      service.resolveAttemptSnapshot(
        attempt as never,
        new Date('2026-08-09T00:00:02.000Z'),
      ),
    ).resolves.toEqual({ kind: 'waiting' });
  });

  it('matches only after the post-addRival refresh timestamp', async () => {
    const refreshedAt = new Date('2026-08-09T00:00:02.000Z');
    const service = serviceWithSnapshot(refreshedAt);
    await expect(
      service.resolveAttemptSnapshot(attempt as never, refreshedAt),
    ).resolves.toEqual({
      kind: 'found',
      friendCode: '123456789012345',
      botFriendCode: '999999999999999',
    });
  });
});
