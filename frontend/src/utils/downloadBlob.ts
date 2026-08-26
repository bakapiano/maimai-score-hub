import {
  getAndroidHostBridge,
  getAndroidImageSaveBridge,
  saveAndroidImage,
} from "../features/android-update/androidUpdateBridge";

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (blob.type.startsWith("image/") && getAndroidHostBridge()) {
    if (!getAndroidImageSaveBridge()) {
      throw new Error("请更新 MaiScoreHub 后再导出图片");
    }
    await saveAndroidImage(blob, filename);
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 60_000);
}
