import { DxnetCabinetPreparationService } from './dxnet-cabinet-preparation.service';

describe('DxnetCabinetPreparationService idempotency', () => {
  it('keys add-rival by delivery epoch and Bot rather than BullMQ attempt', async () => {
    const sdgb = {
      enqueueAddRival: jest.fn().mockResolvedValue({ id: 'sdgb-1' }),
    };
    const service = new DxnetCabinetPreparationService(
      {} as never,
      {} as never,
      {} as never,
      sdgb as never,
      {} as never,
    );
    const subject = service as unknown as {
      enqueueOrReuseAddRival(
        job: Record<string, unknown>,
        execution: { deliveryEpoch: number; attemptsStarted: number },
        botFriendCode: string,
        botCabinetUserId: number,
        targetCabinetUserId: number,
      ): Promise<string>;
    };

    await expect(
      subject.enqueueOrReuseAddRival(
        {
          id: 'job-1',
          priority: 2,
          cabinetFriendship: { sdgbJobId: null },
        },
        { deliveryEpoch: 4, attemptsStarted: 7 },
        'bot-a',
        100,
        200,
      ),
    ).resolves.toBe('sdgb-1');
    expect(sdgb.enqueueAddRival).toHaveBeenCalledWith(
      { botCabinetUserId: 100, targetCabinetUserId: 200 },
      expect.objectContaining({
        idempotencyKey: 'dxnet:job-1:delivery:4:bot:bot-a:add-rival',
      }),
    );
  });
});
