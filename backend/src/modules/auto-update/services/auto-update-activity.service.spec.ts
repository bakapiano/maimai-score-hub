/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { AutoUpdateActivityService } from './auto-update-activity.service';

describe('AutoUpdateActivityService', () => {
  it('records activity by scheduling a settled full update', async () => {
    const stateModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new AutoUpdateActivityService(
      stateModel as any,
      {
        settledFullUpdateDelayMs: 45 * 60 * 1000,
      } as any,
    );
    const at = new Date('2026-07-05T06:00:00.000Z');

    await service.recordActivitySignal({
      friendCode: '634142510810999',
      at,
    });

    expect(stateModel.updateOne).toHaveBeenCalledWith(
      { friendCode: '634142510810999', enabled: true },
      {
        $set: {
          lastAutoUpdateActivityAt: at,
          pendingFullUpdateAt: new Date('2026-07-05T06:45:00.000Z'),
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
  });
});
