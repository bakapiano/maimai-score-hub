import {
  AndroidAppReleaseEnvelopeSchema,
  AndroidAppReleaseManifestSchema,
  type AndroidAppReleaseEnvelope,
  type AndroidAppReleaseManifest,
} from '@maimai-score-hub/shared';
import { createHash, createPublicKey, verify } from 'node:crypto';

export function parseSignedAndroidRelease(
  input: unknown,
  publicKeyBase64: string,
): {
  envelope: AndroidAppReleaseEnvelope;
  manifest: AndroidAppReleaseManifest;
  manifestBytes: Buffer;
} {
  const envelope = AndroidAppReleaseEnvelopeSchema.parse(input);
  const manifestBytes = decodeBase64Strict(envelope.manifestBase64);
  const signature = decodeBase64Strict(envelope.signatureBase64);
  const publicKey = createPublicKey({
    key: decodeBase64Strict(publicKeyBase64),
    format: 'der',
    type: 'spki',
  });
  if (publicKey.asymmetricKeyType !== 'rsa') {
    throw new Error('Android release manifest key must be RSA');
  }
  const verified = verify('RSA-SHA256', manifestBytes, publicKey, signature);
  if (!verified) {
    throw new Error('Android release manifest signature is invalid');
  }
  const parsed: unknown = JSON.parse(manifestBytes.toString('utf8'));
  const manifest = AndroidAppReleaseManifestSchema.parse(parsed);
  return { envelope, manifest, manifestBytes };
}

export function normalizeDownloadHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function getDownloadHost(url: string): string {
  return normalizeDownloadHost(new URL(url).hostname);
}

export function isAndroidReleaseRolloutSelected(
  releaseId: string,
  installationId: string,
  rolloutPercent: number,
  mandatory: boolean,
): boolean {
  if (mandatory || rolloutPercent >= 100) {
    return true;
  }
  if (rolloutPercent <= 0) {
    return false;
  }
  const digest = createHash('sha256')
    .update(`${releaseId}:${installationId}`)
    .digest();
  return digest.readUInt32BE(0) % 100 < rolloutPercent;
}

export function decodeBase64Strict(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Invalid canonical Base64 value');
  }
  return decoded;
}
