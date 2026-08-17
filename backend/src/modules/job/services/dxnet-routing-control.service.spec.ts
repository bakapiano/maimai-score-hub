import { DxnetRoutingControlService } from './dxnet-routing-control.service';

describe('DxnetRoutingControlService', () => {
  it('keeps the automatic recent-event producer disabled by default', async () => {
    const model = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    };
    const service = new DxnetRoutingControlService(model as never);

    await expect(service.get()).resolves.toMatchObject({
      epoch: 0,
      enabledClaimFlows: ['manual_update', 'qr_identity'],
    });
  });

  it('patches one canary flow without clearing the other flow', async () => {
    const current = {
      key: 'singleton',
      epoch: 3,
      botAllowlist: null,
      enabledClaimFlows: ['auto_recent_event', 'manual_update'],
      claimCanaryByFlow: {
        auto_recent_event: ['auto-user'],
        manual_update: ['manual-user'],
      },
    };
    const model = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(current),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue({
        toObject: () => ({
          ...current,
          epoch: 4,
          claimCanaryByFlow: {
            ...current.claimCanaryByFlow,
            manual_update: ['next-user'],
          },
        }),
      }),
    };
    const service = new DxnetRoutingControlService(model as never);

    await expect(
      service.patch({
        expectedEpoch: 3,
        claimCanaryByFlow: { manual_update: ['next-user', 'next-user'] },
      }),
    ).resolves.toMatchObject({
      epoch: 4,
      claimCanaryByFlow: {
        auto_recent_event: ['auto-user'],
        manual_update: ['next-user'],
      },
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'singleton', epoch: 3 },
      {
        $set: { 'claimCanaryByFlow.manual_update': ['next-user'] },
        $inc: { epoch: 1 },
      },
      { new: true },
    );
  });
});
