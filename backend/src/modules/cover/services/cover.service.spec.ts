import { CoverService } from './cover.service';

type TestableCoverService = {
  ensureDir: () => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
  buildCrossIdMap: () => Promise<unknown>;
  ensureCoverVariants: (
    dbId: string,
    force: boolean,
    toDivingFishId: (dbId: string) => string | null,
    toLxnsId: (dbId: string) => string | null,
    signal?: AbortSignal,
  ) => Promise<'saved' | 'skipped' | 'failed'>;
};

describe('CoverService incremental sync', () => {
  it('skips downloading when both local variants already exist', async () => {
    const service = new CoverService({} as never);
    const testable = service as unknown as TestableCoverService;
    jest.spyOn(testable, 'pathExists').mockResolvedValue(true);

    await expect(
      testable.ensureCoverVariants(
        '8',
        false,
        (id) => id,
        () => null,
      ),
    ).resolves.toBe('skipped');
  });

  it('does not fetch remote mappings when every cover already exists', async () => {
    const lean = jest.fn().mockResolvedValue([{ id: '8' }]);
    const model = {
      find: jest.fn(() => ({
        select: jest.fn(() => ({ lean })),
      })),
    };
    const service = new CoverService(model as never);
    const testable = service as unknown as TestableCoverService;
    jest.spyOn(testable, 'ensureDir').mockResolvedValue();
    jest.spyOn(testable, 'pathExists').mockResolvedValue(true);
    const mapping = jest.spyOn(testable, 'buildCrossIdMap');

    await expect(service.syncAll()).resolves.toEqual({
      total: 1,
      saved: 0,
      skipped: 1,
      failed: 0,
    });
    expect(mapping).not.toHaveBeenCalled();
  });
});
