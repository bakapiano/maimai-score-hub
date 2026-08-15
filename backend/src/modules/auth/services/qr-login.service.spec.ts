/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { QrLoginService } from './qr-login.service';

describe('QrLoginService claim reconciliation', () => {
  it('finishes a completed login attempt without a frontend poll', async () => {
    const now = new Date();
    const attempt = {
      id: 'attempt-1',
      status: 'waiting_snapshot',
      purpose: 'login',
      ownerUserId: null,
      expectedFriendCode: null,
      cabinetUserId: 42,
      rivalName: 'TARGET',
      computedRating: 15_000,
      botUserFriendCode: 'bot-1',
      dxnetJobId: 'job-1',
      resolvedFriendCode: null,
      token: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const attemptModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(attempt),
      }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([attempt]),
      }),
    };
    const users = {
      findByFriendCode: jest.fn().mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        friendCode: '123456789012345',
        cabinetUserId: 42,
        profile: { username: 'TARGET' },
      }),
      updateLastActiveAt: jest.fn().mockResolvedValue(undefined),
    };
    const service = new QrLoginService(
      {} as never,
      users as never,
      {
        resolveAttemptSnapshot: jest.fn().mockResolvedValue({
          kind: 'found',
          friendCode: '123456789012345',
          botFriendCode: 'bot-1',
        }),
      } as never,
      {
        issueTokenForUser: jest.fn().mockResolvedValue({
          token: 'token-1',
          user: { id: '507f1f77bcf86cd799439011' },
        }),
      } as never,
      attemptModel as never,
      {
        getWorker: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'completed',
          botUserFriendCode: 'bot-1',
          cabinetFriendshipStatus: 'ready',
          result: { friendsUpdatedAt: now.toISOString() },
          updatedAt: now.toISOString(),
        }),
      } as never,
      {
        run: jest.fn().mockImplementation((_options, task) =>
          task({
            signal: new AbortController().signal,
            assertActive: jest.fn(),
          }).then((value: unknown) => ({ acquired: true, value })),
        ),
      } as never,
    );

    await (
      service as unknown as { runClaimAttemptReconcile(): Promise<void> }
    ).runClaimAttemptReconcile();

    expect(attemptModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'attempt-1' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'matched',
          token: 'token-1',
        }),
      }),
    );
  });
});

describe('QrLoginService cabinet binding fencing', () => {
  it('does not let an old binding attempt overwrite a newer binding', async () => {
    const attemptModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new QrLoginService(
      {} as never,
      {
        bindCabinetUserIdIfUnbound: jest.fn().mockResolvedValue(false),
      } as never,
      {} as never,
      {} as never,
      attemptModel as never,
      {} as never,
      {} as never,
    );

    await (
      service as unknown as {
        completeCabinetBindingClaim(
          attempt: Record<string, unknown>,
          friendCode: string,
        ): Promise<void>;
      }
    ).completeCabinetBindingClaim(
      {
        id: 'attempt-2',
        status: 'waiting_snapshot',
        purpose: 'cabinet_binding',
        ownerUserId: '507f1f77bcf86cd799439011',
        expectedFriendCode: '123456789012345',
        cabinetUserId: 42,
      },
      '123456789012345',
    );

    expect(attemptModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'attempt-2' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('未覆盖'),
        }),
      }),
    );
  });
});
