package com.bakapiano.maiscorehub.android.web;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/** Saves bounded image blobs supplied by a trusted Score Hub WebView. */
public final class WebImageSaver {
    public interface Listener {
        void onResult(
                String requestId,
                boolean success,
                String message,
                String uri,
                String error
        );
    }

    public static final int REQUEST_CODE = 4106;
    static final int MAX_IMAGE_BYTES = 24 * 1024 * 1024;
    private static final int MAX_BASE64_CHARS = ((MAX_IMAGE_BYTES + 2) / 3) * 4;

    private final Activity activity;
    private final Executor executor;
    private final Listener listener;
    private final AtomicBoolean active = new AtomicBoolean(false);
    private PendingImage pendingLegacyImage;

    public WebImageSaver(Activity activity, Executor executor, Listener listener) {
        this.activity = activity;
        this.executor = executor;
        this.listener = listener;
    }

    public void save(
            String requestId,
            String rawFileName,
            String rawMimeType,
            String encodedImage
    ) {
        if (!active.compareAndSet(false, true)) {
            emit(
                    requestId,
                    false,
                    "已有图片正在保存",
                    null,
                    "已有图片正在保存"
            );
            return;
        }
        executor.execute(() -> {
            try {
                String mimeType = normalizeMimeType(rawMimeType);
                String fileName = sanitizeFileName(rawFileName, mimeType);
                byte[] bytes = decodeImage(mimeType, encodedImage);
                PendingImage image = new PendingImage(requestId, fileName, mimeType, bytes);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    Uri uri = saveToMediaStore(image);
                    finish(image, true, "图片已保存到相册的 MaiScoreHub 文件夹", uri, null);
                } else {
                    launchLegacySavePicker(image);
                }
            } catch (Exception error) {
                finish(
                        new PendingImage(requestId, "", "", new byte[0]),
                        false,
                        "图片保存失败",
                        null,
                        safeMessage(error)
                );
            }
        });
    }

    public boolean handleActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CODE) {
            return false;
        }
        PendingImage image;
        synchronized (this) {
            image = pendingLegacyImage;
            pendingLegacyImage = null;
        }
        if (image == null) {
            active.set(false);
            return true;
        }
        Uri uri = resultCode == Activity.RESULT_OK && data != null
                ? data.getData()
                : null;
        if (uri == null) {
            finish(image, false, "已取消保存图片", null, "已取消保存图片");
            return true;
        }
        executor.execute(() -> {
            try {
                writeUri(uri, image.bytes);
                finish(image, true, "图片已保存", uri, null);
            } catch (Exception error) {
                finish(image, false, "图片保存失败", null, safeMessage(error));
            }
        });
        return true;
    }

    public synchronized void cancel() {
        pendingLegacyImage = null;
        active.set(false);
    }

    static String normalizeMimeType(String rawMimeType) {
        String mimeType = rawMimeType == null
                ? ""
                : rawMimeType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return switch (mimeType) {
            case "image/png", "image/jpeg", "image/webp" -> mimeType;
            default -> throw new IllegalArgumentException("图片格式无效");
        };
    }

    static String sanitizeFileName(String rawFileName, String mimeType) {
        String value = rawFileName == null ? "" : rawFileName.trim();
        StringBuilder clean = new StringBuilder();
        for (int index = 0; index < value.length() && clean.length() < 100; index++) {
            char current = value.charAt(index);
            if (current < 32 || "\\/:*?\"<>|".indexOf(current) >= 0) {
                clean.append('_');
            } else {
                clean.append(current);
            }
        }
        String result = clean.toString();
        while (result.startsWith(".")) {
            result = "_" + result.substring(1);
        }
        if (result.isBlank()) {
            result = "MaiScoreHub";
        }
        String extension = switch (mimeType) {
            case "image/jpeg" -> ".jpg";
            case "image/webp" -> ".webp";
            default -> ".png";
        };
        if (!result.toLowerCase(Locale.ROOT).endsWith(extension)) {
            result += extension;
        }
        return result;
    }

    static byte[] decodeImage(String mimeType, String encodedImage) {
        if (encodedImage == null
                || encodedImage.isEmpty()
                || encodedImage.length() > MAX_BASE64_CHARS) {
            throw new IllegalArgumentException("图片大小无效");
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(encodedImage);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("图片编码无效", error);
        }
        if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("图片大小无效");
        }
        if (!hasExpectedSignature(mimeType, bytes)) {
            throw new IllegalArgumentException("图片内容与格式不匹配");
        }
        return bytes;
    }

    private Uri saveToMediaStore(PendingImage image) throws IOException {
        ContentResolver resolver = activity.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, image.fileName);
        values.put(MediaStore.Images.Media.MIME_TYPE, image.mimeType);
        values.put(
                MediaStore.Images.Media.RELATIVE_PATH,
                Environment.DIRECTORY_PICTURES + "/MaiScoreHub"
        );
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("无法创建相册文件");
        }
        try {
            writeUri(uri, image.bytes);
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (resolver.update(uri, ready, null, null) != 1) {
                throw new IOException("无法完成相册文件写入");
            }
            return uri;
        } catch (IOException | RuntimeException error) {
            resolver.delete(uri, null, null);
            throw error;
        }
    }

    private void launchLegacySavePicker(PendingImage image) {
        synchronized (this) {
            pendingLegacyImage = image;
        }
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(image.mimeType)
                        .putExtra(Intent.EXTRA_TITLE, image.fileName);
                activity.startActivityForResult(intent, REQUEST_CODE);
            } catch (Exception error) {
                synchronized (WebImageSaver.this) {
                    pendingLegacyImage = null;
                }
                finish(image, false, "图片保存失败", null, safeMessage(error));
            }
        });
    }

    private void writeUri(Uri uri, byte[] bytes) throws IOException {
        try (OutputStream output = activity.getContentResolver().openOutputStream(uri, "w")) {
            if (output == null) {
                throw new IOException("无法打开图片文件");
            }
            output.write(bytes);
            output.flush();
        }
    }

    private void finish(
            PendingImage image,
            boolean success,
            String message,
            Uri uri,
            String error
    ) {
        active.set(false);
        emit(image.requestId, success, message, uri == null ? null : uri.toString(), error);
    }

    private void emit(
            String requestId,
            boolean success,
            String message,
            String uri,
            String error
    ) {
        activity.runOnUiThread(() -> {
            if (success) {
                Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
            }
            listener.onResult(requestId, success, message, uri, error);
        });
    }

    private static boolean hasExpectedSignature(String mimeType, byte[] bytes) {
        return switch (mimeType) {
            case "image/png" -> bytes.length >= 8
                    && unsigned(bytes[0]) == 0x89
                    && bytes[1] == 'P'
                    && bytes[2] == 'N'
                    && bytes[3] == 'G'
                    && unsigned(bytes[4]) == 0x0D
                    && unsigned(bytes[5]) == 0x0A
                    && unsigned(bytes[6]) == 0x1A
                    && unsigned(bytes[7]) == 0x0A;
            case "image/jpeg" -> bytes.length >= 3
                    && unsigned(bytes[0]) == 0xFF
                    && unsigned(bytes[1]) == 0xD8
                    && unsigned(bytes[2]) == 0xFF;
            case "image/webp" -> bytes.length >= 12
                    && bytes[0] == 'R'
                    && bytes[1] == 'I'
                    && bytes[2] == 'F'
                    && bytes[3] == 'F'
                    && bytes[8] == 'W'
                    && bytes[9] == 'E'
                    && bytes[10] == 'B'
                    && bytes[11] == 'P';
            default -> false;
        };
    }

    private static int unsigned(byte value) {
        return value & 0xFF;
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
                ? error.getClass().getSimpleName()
                : message;
    }

    private record PendingImage(
            String requestId,
            String fileName,
            String mimeType,
            byte[] bytes
    ) { }
}
