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

  it('records recent event fingerprint changes as activity', async () => {
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

    const changed = await service.recordRecentEventFingerprint({
      friendCode: '634142510810999',
      fingerprint: 'abc123',
      at,
    });

    expect(changed).toBe(true);
    expect(stateModel.updateOne).toHaveBeenCalledWith(
      {
        friendCode: '634142510810999',
        enabled: true,
        $or: [
          { lastRecentEventFingerprint: { $exists: false } },
          { lastRecentEventFingerprint: null },
          { lastRecentEventFingerprint: { $ne: 'abc123' } },
        ],
      },
      {
        $set: {
          lastRecentEventFingerprint: 'abc123',
          lastAutoUpdateActivityAt: at,
          pendingFullUpdateAt: new Date('2026-07-05T06:45:00.000Z'),
          schedulerVersion: 'rival-first-v1',
        },
      },
    );
  });
});
