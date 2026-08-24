package com.bakapiano.maiscorehub.android.update;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;

import com.bakapiano.maiscorehub.android.BuildConfig;

import org.json.JSONObject;

public final class AppUpdateInstallReceiver extends BroadcastReceiver {
    public static final String ACTION_INSTALL_STATUS =
            BuildConfig.APPLICATION_ID + ".APP_UPDATE_INSTALL_STATUS";
    public static final String ACTION_UPDATE_STATUS =
            BuildConfig.APPLICATION_ID + ".APP_UPDATE_STATUS";
    public static final String INTERNAL_STATUS_PERMISSION =
            BuildConfig.APPLICATION_ID + ".permission.INTERNAL_STATUS";
    public static final String EXTRA_REQUEST_ID = "requestId";
    public static final String EXTRA_RELEASE_ID = "releaseId";
    public static final String EXTRA_VERSION_NAME = "versionName";

    private static final String PREFERENCES = "app_update_status";
    private static final String LAST_STATUS = "last_status";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_INSTALL_STATUS.equals(intent.getAction())) {
            return;
        }
        String requestId = intent.getStringExtra(EXTRA_REQUEST_ID);
        String releaseId = intent.getStringExtra(EXTRA_RELEASE_ID);
        String versionName = intent.getStringExtra(EXTRA_VERSION_NAME);
        int status = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE
        );

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            JSONObject detail = status(
                    requestId,
                    "请在系统页面确认安装",
                    "confirm",
                    96,
                    false,
                    false,
                    null,
                    releaseId,
                    versionName
            );
            publish(context, detail);
            Intent confirmation = getConfirmationIntent(intent);
            if (confirmation != null) {
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmation);
                return;
            }
            publish(
                    context,
                    status(
                            requestId,
                            "系统安装确认页不可用",
                            "failed",
                            0,
                            true,
                            false,
                            "系统安装确认页不可用",
                            releaseId,
                            versionName
                    )
            );
            AppUpdateManager.markTerminal();
            return;
        }

        if (status == PackageInstaller.STATUS_SUCCESS) {
            JSONObject detail = status(
                    requestId,
                    "应用更新安装完成",
                    "completed",
                    100,
                    true,
                    true,
                    null,
                    releaseId,
                    versionName
            );
            publish(context, detail);
            AppUpdateManager.markTerminal();
            Intent launch = context.getPackageManager().getLaunchIntentForPackage(
                    context.getPackageName()
            );
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                context.startActivity(launch);
            }
            return;
        }

        String systemMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        String message = systemMessage == null || systemMessage.isBlank()
                ? "系统安装器返回状态 " + status
                : systemMessage;
        publish(
                context,
                status(
                        requestId,
                        "应用更新安装失败：" + message,
                        "failed",
                        0,
                        true,
                        false,
                        message,
                        releaseId,
                        versionName
                )
        );
        AppUpdateManager.markTerminal();
    }

    public static JSONObject consumeLastStatus(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(
                PREFERENCES,
                Context.MODE_PRIVATE
        );
        String raw = preferences.getString(LAST_STATUS, "");
        if (raw == null || raw.isBlank()) {
            return null;
        }
        preferences.edit().remove(LAST_STATUS).apply();
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void publish(Context context, JSONObject detail) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putString(LAST_STATUS, detail.toString())
                .apply();
        Intent status = new Intent(ACTION_UPDATE_STATUS)
                .setPackage(context.getPackageName())
                .putExtra("statusJson", detail.toString());
        context.sendBroadcast(status, INTERNAL_STATUS_PERMISSION);
    }

    private static JSONObject status(
            String requestId,
            String message,
            String stage,
            int progress,
            boolean terminal,
            boolean success,
            String error,
            String releaseId,
            String versionName
    ) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("requestId", requestId == null ? "" : requestId);
            detail.put("message", message);
            detail.put("stage", stage);
            detail.put("progress", progress);
            detail.put("terminal", terminal);
            detail.put("success", success);
            if (error != null && !error.isBlank()) {
                detail.put("error", error);
            }
            if (releaseId != null && !releaseId.isBlank()) {
                detail.put("releaseId", releaseId);
            }
            if (versionName != null && !versionName.isBlank()) {
                detail.put("versionName", versionName);
            }
        } catch (Exception ignored) {
            // Primitive values are JSON-safe.
        }
        return detail;
    }

    private static Intent getConfirmationIntent(Intent source) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return source.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
        }
        return source.getParcelableExtra(Intent.EXTRA_INTENT);
    }
}
