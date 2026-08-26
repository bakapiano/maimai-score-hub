import { HttpStatus } from '@nestjs/common';

import { AndroidAppReleaseController } from './android-app-release.controller';

describe('AndroidAppReleaseController stable APK alias', () => {
  it('redirects without caching to the newest immutable APK URL', async () => {
    const apkUrl =
      'https://api.maiscorehub.bakapiano.com/api/v1/android/app/releases/android-stable-5-example/apk';
    const releases = {
      getLatestApkUrl: jest.fn().mockResolvedValue(apkUrl),
    };
    const response = {
      setHeader: jest.fn(),
      redirect: jest.fn().mockReturnValue(undefined),
    };
    const controller = new AndroidAppReleaseController(releases as never);

    await controller.getLatestStableApk(response as never);

    expect(releases.getLatestApkUrl).toHaveBeenCalledWith('stable');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.redirect).toHaveBeenCalledWith(HttpStatus.FOUND, apkUrl);
  });
});
