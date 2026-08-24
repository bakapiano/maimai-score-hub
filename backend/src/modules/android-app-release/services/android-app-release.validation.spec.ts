import { generateKeyPairSync, sign } from 'node:crypto';

import {
  isAndroidReleaseRolloutSelected,
  parseSignedAndroidRelease,
} from './android-app-release.validation';

describe('Android app release validation', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyBase64 = keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');

  function envelope(overrides: Record<string, unknown> = {}) {
    const manifest = {
      releaseId: 'android-beta-4-deadbeef',
      channel: 'beta',
      packageName: 'com.bakapiano.maiscorehub.android.beta',
      versionCode: 4,
      versionName: '0.2.2-beta',
      requiredBridgeApiVersion: 2,
      minSdk: 26,
      apkUrl:
        'https://api.maiscorehub.bakapiano.com/api/v1/android/app/releases/android-beta-4-deadbeef/apk',
      apkSha256: 'a'.repeat(64),
      apkSize: 1024,
      certificateSha256: 'b'.repeat(64),
      downloadHosts: ['api.maiscorehub.bakapiano.com'],
      mandatory: false,
      rolloutPercent: 100,
      notes: 'test',
      publishedAt: '2026-08-24T00:00:00.000Z',
      ...overrides,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    return {
      manifestBase64: bytes.toString('base64'),
      signatureBase64: sign('RSA-SHA256', bytes, keys.privateKey).toString(
        'base64',
      ),
      signatureAlgorithm: 'SHA256withRSA' as const,
    };
  }

  it('verifies and parses the exact signed manifest bytes', () => {
    const result = parseSignedAndroidRelease(envelope(), publicKeyBase64);
    expect(result.manifest.versionCode).toBe(4);
    expect(result.manifest.channel).toBe('beta');
  });

  it('rejects a manifest signed by another key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const input = envelope();
    const bytes = Buffer.from(input.manifestBase64, 'base64');
    input.signatureBase64 = sign(
      'RSA-SHA256',
      bytes,
      other.privateKey,
    ).toString('base64');
    expect(() => parseSignedAndroidRelease(input, publicKeyBase64)).toThrow(
      'signature is invalid',
    );
  });

  it('selects deterministic rollout cohorts and always selects mandatory', () => {
    const first = isAndroidReleaseRolloutSelected(
      'android-beta-4-deadbeef',
      'installation-1',
      30,
      false,
    );
    expect(
      isAndroidReleaseRolloutSelected(
        'android-beta-4-deadbeef',
        'installation-1',
        30,
        false,
      ),
    ).toBe(first);
    expect(
      isAndroidReleaseRolloutSelected(
        'android-beta-4-deadbeef',
        'installation-1',
        0,
        true,
      ),
    ).toBe(true);
  });
});
