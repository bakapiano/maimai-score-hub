import sharp from 'sharp';

type Region = { left: number; top: number; width: number; height: number };

function countRgbPixels(
  pixels: Uint8Array,
  channels: number,
  color: readonly [number, number, number],
) {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += channels) {
    if (
      pixels[offset] === color[0] &&
      pixels[offset + 1] === color[1] &&
      pixels[offset + 2] === color[2]
    ) {
      count += 1;
    }
  }
  return count;
}

export async function countRgbPixelsInRegion(
  png: Buffer,
  region: Region,
  color: readonly [number, number, number],
) {
  const { data, info } = await sharp(png)
    .extract(region)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return countRgbPixels(data, info.channels, color);
}
