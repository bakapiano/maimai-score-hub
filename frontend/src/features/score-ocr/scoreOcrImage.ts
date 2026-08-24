export const OCR_UPLOAD_MAX_EDGE = 2560;
export const OCR_UPLOAD_JPEG_QUALITY = 0.85;

export function fitImageWithinEdge(
  width: number,
  height: number,
  maxEdge = OCR_UPLOAD_MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function compressScoreOcrImage(file: File): Promise<File> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const size = fitImageWithinEdge(bitmap.width, bitmap.height);
    const resized = size.width !== bitmap.width || size.height !== bitmap.height;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return file;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvasToBlob(
      canvas,
      "image/jpeg",
      OCR_UPLOAD_JPEG_QUALITY,
    );
    if (!blob || (!resized && blob.size >= file.size)) {
      return file;
    }
    return new File([blob], file.name, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
