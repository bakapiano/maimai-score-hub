import { AndroidAppReleaseService } from './android-app-release.service';

describe('AndroidAppReleaseService latest APK URL', () => {
  function createService(input?: {
    policy?: { packageName: string } | null;
    release?: { apkUrl: string } | null;
  }) {
    const policy =
      input?.policy === undefined
        ? { packageName: 'com.bakapiano.maiscorehub.android' }
        : input.policy;
    const release =
      input?.release === undefined
        ? {
            apkUrl:
              'https://api.maiscorehub.bakapiano.com/api/v1/android/app/releases/android-stable-5-example/apk',
          }
        : input.release;
    const policyExec = jest.fn().mockResolvedValue(policy);
    const releaseExec = jest.fn().mockResolvedValue(release);
    const releaseSort = jest.fn(() => ({
      lean: () => ({ exec: releaseExec }),
    }));
    const releaseModel = {
      findOne: jest.fn(() => ({ sort: releaseSort })),
    };
    const policyModel = {
      findOne: jest.fn(() => ({
        lean: () => ({ exec: policyExec }),
      })),
    };
    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    return {
      service: new AndroidAppReleaseService(
        releaseModel as never,
        policyModel as never,
        config as never,
      ),
      policyModel,
      releaseModel,
      releaseSort,
    };
  }

  it('resolves the newest enabled stable release URL', async () => {
    const { service, policyModel, releaseModel, releaseSort } = createService();

    await expect(service.getLatestApkUrl('stable')).resolves.toBe(
      'https://api.maiscorehub.bakapiano.com/api/v1/android/app/releases/android-stable-5-example/apk',
    );
    expect(policyModel.findOne).toHaveBeenCalledWith({
      channel: 'stable',
      enabled: true,
    });
    expect(releaseModel.findOne).toHaveBeenCalledWith({
      channel: 'stable',
      packageName: 'com.bakapiano.maiscorehub.android',
      revoked: false,
    });
    expect(releaseSort).toHaveBeenCalledWith({
      versionCode: -1,
      publishedAt: -1,
    });
  });

  it('fails when the stable channel has no published release', async () => {
    const { service } = createService({ release: null });

    await expect(service.getLatestApkUrl('stable')).rejects.toThrow(
      'Android release not found',
    );
  });
});
