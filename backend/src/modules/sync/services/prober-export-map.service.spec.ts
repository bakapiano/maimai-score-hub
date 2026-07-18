import {
  ProberExportMapService,
  type ProberExportMap,
} from './prober-export-map.service';

type TestableMapService = {
  buildMap: () => Promise<ProberExportMap>;
};

function mapFixture(): ProberExportMap {
  return {
    toDivingFishId: new Map([['1', '1']]),
    toLxnsId: new Map([['1', '101']]),
    divingFishTitleByDbId: new Map([['1', 'test']]),
  };
}

describe('ProberExportMapService', () => {
  it('shares one cold build across concurrent callers and caches it', async () => {
    const service = new ProberExportMapService();
    const fixture = mapFixture();
    let resolveBuild: (value: ProberExportMap) => void = () => undefined;
    const pending = new Promise<ProberExportMap>((resolve) => {
      resolveBuild = resolve;
    });
    const build = jest
      .spyOn(service as unknown as TestableMapService, 'buildMap')
      .mockReturnValue(pending);

    const requests = Array.from({ length: 64 }, () => service.getMap());
    await Promise.resolve();
    expect(build).toHaveBeenCalledTimes(1);

    resolveBuild(fixture);
    const results = await Promise.all(requests);
    expect(results.every((result) => result === fixture)).toBe(true);
    await expect(service.getMap()).resolves.toBe(fixture);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('clears a failed cold build so a later request can retry', async () => {
    const service = new ProberExportMapService();
    const fixture = mapFixture();
    const build = jest
      .spyOn(service as unknown as TestableMapService, 'buildMap')
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce(fixture);

    await expect(service.getMap()).rejects.toThrow('catalog unavailable');
    await expect(service.getMap()).resolves.toBe(fixture);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
