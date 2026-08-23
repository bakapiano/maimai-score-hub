package com.bakapiano.maiscorehub.android.web;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Handles trusted WebView image inputs with the system photo picker. */
public final class WebFileChooser {
    public static final int REQUEST_CODE = 4104;

    private static final int MAX_IMAGES = 20;
    private final Activity activity;
    private ValueCallback<Uri[]> pendingCallback;

    public WebFileChooser(Activity activity) {
        this.activity = activity;
    }

    public boolean show(
            ValueCallback<Uri[]> callback,
            WebChromeClient.FileChooserParams params
    ) {
        cancel();
        pendingCallback = callback;

        try {
            activity.startActivityForResult(createAlbumPickerIntent(params), REQUEST_CODE);
        } catch (RuntimeException error) {
            cancel();
        }
        return true;
    }

    public boolean handleActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CODE) {
            return false;
        }

        Uri[] selected = null;
        if (resultCode == Activity.RESULT_OK) {
            List<Uri> returnedUris = collectReturnedUris(data);
            selected = validateImages(returnedUris);
        }

        ValueCallback<Uri[]> callback = pendingCallback;
        pendingCallback = null;
        if (callback != null) {
            callback.onReceiveValue(selected == null || selected.length == 0 ? null : selected);
        }
        return true;
    }

    public void cancel() {
        ValueCallback<Uri[]> callback = pendingCallback;
        pendingCallback = null;
        if (callback != null) {
            callback.onReceiveValue(null);
        }
    }

    static String[] normalizeImageAcceptTypes(String[] rawTypes) {
        Map<String, String> normalized = new LinkedHashMap<>();
        if (rawTypes != null) {
            for (String rawType : rawTypes) {
                if (rawType == null) {
                    continue;
                }
                for (String part : rawType.split(",")) {
                    String value = normalizeImageType(part.trim().toLowerCase(Locale.ROOT));
                    if (value != null) {
                        normalized.put(value, value);
                    }
                }
            }
        }
        if (normalized.isEmpty()) {
            return new String[]{"image/*"};
        }
        return normalized.values().toArray(new String[0]);
    }

    private Intent createAlbumPickerIntent(WebChromeClient.FileChooserParams params) {
        boolean multiple = params.getMode()
                == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        String[] acceptedTypes = normalizeImageAcceptTypes(params.getAcceptTypes());
        String pickerType = acceptedTypes.length == 1 ? acceptedTypes[0] : "image/*";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType(pickerType);
            if (multiple) {
                picker.putExtra(
                        MediaStore.EXTRA_PICK_IMAGES_MAX,
                        Math.min(MAX_IMAGES, MediaStore.getPickImagesMaxLimit())
                );
            }
            if (picker.resolveActivity(activity.getPackageManager()) != null) {
                return picker;
            }
        }
        return new Intent(
                Intent.ACTION_PICK,
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        )
                .setType(pickerType)
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
    }

    private List<Uri> collectReturnedUris(Intent data) {
        List<Uri> uris = new ArrayList<>();
        if (data == null) {
            return uris;
        }
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount() && uris.size() < MAX_IMAGES; index++) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) {
                    uris.add(uri);
                }
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        return uris;
    }

    private Uri[] validateImages(List<Uri> candidates) {
        ContentResolver resolver = activity.getContentResolver();
        Map<String, Uri> accepted = new LinkedHashMap<>();
        for (Uri uri : candidates) {
            if (accepted.size() >= MAX_IMAGES || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
                continue;
            }
            String mimeType = resolver.getType(uri);
            if (mimeType != null
                    && !mimeType.toLowerCase(Locale.ROOT).startsWith("image/")) {
                continue;
            }
            accepted.put(uri.toString(), uri);
        }
        return accepted.values().toArray(new Uri[0]);
    }

    private static String normalizeImageType(String value) {
        return switch (value) {
            case "image/*", "image/jpeg", "image/png", "image/webp", "image/gif" -> value;
            case ".jpg", ".jpeg" -> "image/jpeg";
            case ".png" -> "image/png";
            case ".webp" -> "image/webp";
            case ".gif" -> "image/gif";
            default -> value.startsWith("image/") ? value : null;
        };
    }

}
