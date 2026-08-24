import assert from "node:assert/strict";
import test from "node:test";

import {
  OCR_UPLOAD_JPEG_QUALITY,
  OCR_UPLOAD_MAX_EDGE,
  compressScoreOcrImage,
  fitImageWithinEdge,
} from "../src/features/score-ocr/scoreOcrImage.ts";

test("large landscape images fit within the OCR upload edge", () => {
  assert.deepEqual(fitImageWithinEdge(4000, 3000), {
    width: 2560,
    height: 1920,
  });
});

test("large portrait images preserve their aspect ratio", () => {
  assert.deepEqual(fitImageWithinEdge(3000, 4000), {
    width: 1920,
    height: 2560,
  });
});

test("smaller images keep their original dimensions", () => {
  assert.deepEqual(fitImageWithinEdge(1920, 1080), {
    width: 1920,
    height: 1080,
  });
  assert.equal(OCR_UPLOAD_MAX_EDGE, 2560);
});

test("OCR uploads use the resized JPEG file", async () => {
  let bitmapClosed = false;
  let encodedQuality: number | undefined;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage: () => {},
    }),
    toBlob: (
      callback: BlobCallback,
      type?: string,
      quality?: number,
    ) => {
      encodedQuality = quality;
      callback(new Blob([new Uint8Array(1_000)], { type }));
    },
  };
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({
      width: 4_000,
      height: 3_000,
      close: () => {
        bitmapClosed = true;
      },
    }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });

  try {
    const source = new File([new Uint8Array(5_000)], "score.png", {
      type: "image/png",
      lastModified: 123,
    });
    const compressed = await compressScoreOcrImage(source);
    assert.equal(canvas.width, 2_560);
    assert.equal(canvas.height, 1_920);
    assert.equal(encodedQuality, OCR_UPLOAD_JPEG_QUALITY);
    assert.equal(compressed.name, source.name);
    assert.equal(compressed.type, "image/jpeg");
    assert.equal(compressed.size, 1_000);
    assert.equal(compressed.lastModified, source.lastModified);
    assert.equal(bitmapClosed, true);
  } finally {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
});
