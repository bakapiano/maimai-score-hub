/**
 * Decode a QR code from an image buffer (PNG/JPG/WebP/...) using jsQR
 * + sharp. Returns the embedded string, or null when no QR was found.
 *
 * Pulled out of CabinetService so AuthModule (QR login) and UsersModule
 * (cabinet binding) can both reuse it without depending on each other.
 */
import jsQR from 'jsqr';
import sharp from 'sharp';

export async function decodeQrImage(buf: Buffer): Promise<string | null> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = jsQR(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
  );
  return result?.data ?? null;
}
