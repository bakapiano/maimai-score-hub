import { BotStatusService } from './bot-status.service';
import { getDxnetWorkerQueueNames } from '@maimai-score-hub/shared';

describe('BotStatusService routing registration', () => {
  it('clears a stale worker registration when heartbeat metadata is absent', async () => {
    const botStatusModel = {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([
            {
              friendCode: '123',
              workerId: 'stale-worker',
              revision: 'stale-revision',
              consumersReady: ['one'],
              friendCount: 1,
            },
          ]),
        }),
      }),
      bulkWrite: jest.fn().mockResolvedValue({}),
    };
    const service = new BotStatusService(
      {} as never,
      botStatusModel as never,
      {} as never,
    );
    try {
      await service.report([{ friendCode: '123', available: true }]);
      const calls = botStatusModel.bulkWrite.mock.calls as unknown as Array<
        [Array<{ updateOne: { update: { $set: Record<string, unknown> } } }>]
      >;
      const operations = calls[0][0];
      expect(operations[0].updateOne.update.$set).toMatchObject({
        workerId: null,
        revision: null,
        consumersReady: [],
      });
    } finally {
      service.onModuleDestroy();
    }
  });

  it('requires the exact shared and per-Bot pinned consumer set', () => {
    const service = new BotStatusService({} as never, {} as never, {} as never);
    const friendCode = '123';
    const consumersReady = getDxnetWorkerQueueNames(friendCode);
    try {
      expect(service.hasExpectedConsumers({ friendCode, consumersReady })).toBe(
        true,
      );
      expect(
        service.hasExpectedConsumers({
          friendCode,
          consumersReady: ['1', '2', '3', '4', '5', '6'],
        }),
      ).toBe(false);
      expect(
        service.hasExpectedConsumers({
          friendCode,
          consumersReady: [...consumersReady.slice(0, 5), consumersReady[0]],
        }),
      ).toBe(false);
    } finally {
      service.onModuleDestroy();
    }
  });
});
