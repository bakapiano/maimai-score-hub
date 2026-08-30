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
  fetchCoverSourceBuffer: (
    dbId: string,
    toDivingFishId: (dbId: string) => string | null,
    toLxnsId: (dbId: string) => string | null,
    signal?: AbortSignal,
  ) => Promise<Buffer | null>;
};

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

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

  it('falls back from utage 111597 to the regular DX song cover', async () => {
    const service = new CoverService({} as never);
    const testable = service as unknown as TestableCoverService;
    const source = Uint8Array.from([1, 2, 3]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input) => {
        const url = fetchInputUrl(input);
        if (url.includes('/11597.png')) {
          return Promise.resolve(new Response(source, { status: 200 }));
        }
        if (url.includes('/111597.png')) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return Promise.resolve(
          new Response(source, {
            status: 200,
            headers: { 'cache-control': 'no-cache' },
          }),
        );
      });
    const toDivingFishId = jest.fn((id: string) => id);
    const toLxnsId = jest.fn((id: string) =>
      id === '111597' ? '111597' : id === '11597' ? '1597' : null,
    );

    await expect(
      testable.fetchCoverSourceBuffer('111597', toDivingFishId, toLxnsId),
    ).resolves.toEqual(Buffer.from(source));
    expect(toDivingFishId).toHaveBeenCalledWith('11597');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.diving-fish.com/covers/11597.png',
      { signal: undefined },
    );
  });

  it('uses the raw LXNS suffix when an utage base song is absent from the catalog', async () => {
    const service = new CoverService({} as never);
    const testable = service as unknown as TestableCoverService;
    const source = Uint8Array.from([8, 5, 1]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input) => {
        const url = fetchInputUrl(input);
        if (url.includes('/851.png!webp')) {
          return Promise.resolve(new Response(source, { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      });
    const toDivingFishId = jest.fn((id: string) => id);
    const toLxnsId = jest.fn((id: string) =>
      id === '100851' ? '100851' : null,
    );

    await expect(
      testable.fetchCoverSourceBuffer('100851', toDivingFishId, toLxnsId),
    ).resolves.toEqual(Buffer.from(source));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://assets.lxns.net/maimai/jacket/851.png!webp',
      { signal: undefined },
    );
  });
});
