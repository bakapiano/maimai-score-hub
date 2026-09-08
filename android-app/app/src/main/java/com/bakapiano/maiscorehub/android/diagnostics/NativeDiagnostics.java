package com.bakapiano.maiscorehub.android.diagnostics;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import com.bakapiano.maiscorehub.android.BuildConfig;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Logcat plus a bounded disk queue, independent of WebView and network availability. */
public final class NativeDiagnostics {
    private static final String TAG = "MshNative";
    private static final ThreadPoolExecutor IO = new ThreadPoolExecutor(
            1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(128),
            runnable -> new Thread(runnable, "msh-diagnostics")
    );
    private static DiagnosticLogStore store;
    private static volatile String lastContext = "";
    private static String environment = "";

    private NativeDiagnostics() { }

    public static synchronized void initialize(Context context) {
        if (store != null) return;
        store = new DiagnosticLogStore(new File(context.getFilesDir(), "diagnostics"), 128 * 1024);
        environment = "version=" + BuildConfig.VERSION_NAME + " versionCode=" + BuildConfig.VERSION_CODE
                + " channel=" + BuildConfig.APP_RELEASE_CHANNEL + " sdk=" + Build.VERSION.SDK_INT
                + " manufacturer=" + Build.MANUFACTURER + " model=" + Build.MODEL;
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                // The process is terminating: persist directly, then preserve Android's handler.
                store.saveCrash(entry("FATAL", "uncaught", "",
                        environment + "\nlastContext=" + lastContext + "\n" + DiagnosticLogStore.describe(error)));
            } catch (Throwable ignored) {
                // Diagnostic failure must preserve the original uncaught exception.
            } finally {
                if (previous != null) {
                    previous.uncaughtException(thread, error);
                } else {
                    android.os.Process.killProcess(android.os.Process.myPid());
                    System.exit(10);
                }
            }
        });
        event("process_start", "", environment);
    }

    public static void event(String stage, String requestId, String detail) {
        record("INFO", stage, requestId, detail);
    }

    public static void failure(String stage, String requestId, Throwable error) {
        record("ERROR", stage, requestId, DiagnosticLogStore.describe(error));
    }

    public static void checkPreviousCrash(Consumer<Boolean> callback) {
        submit(() -> {
            boolean found = false;
            try {
                found = store != null && store.acknowledgePreviousCrash();
            } catch (IOException | RuntimeException error) {
                persistenceWarning(error);
            }
            callback.accept(found);
        }, () -> callback.accept(false));
    }

    public static void export(Context context, Uri destination, Consumer<Boolean> callback) {
        Context app = context.getApplicationContext();
        submit(() -> {
            boolean success = false;
            try (OutputStream output = app.getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null || store == null) throw new IOException("Diagnostic export unavailable");
                output.write(store.snapshot().getBytes(StandardCharsets.UTF_8));
                success = true;
            } catch (IOException | RuntimeException error) {
                persistenceWarning(error);
            }
            callback.accept(success);
        }, () -> callback.accept(false));
    }

    private static void record(String level, String stage, String requestId, String detail) {
        lastContext = stage + " requestId=" + requestId;
        String text = entry(level, stage, requestId, detail);
        if ("ERROR".equals(level)) Log.e(TAG, text);
        else Log.i(TAG, text);
        submit(() -> {
            try {
                if (store != null) store.append(text);
            } catch (IOException | RuntimeException error) {
                persistenceWarning(error);
            }
        }, () -> Log.w(TAG, "diagnostic_queue_full"));
    }

    private static String entry(String level, String stage, String requestId, String detail) {
        return DiagnosticLogStore.sanitize(System.currentTimeMillis() + " " + level
                + " stage=" + stage + " requestId=" + requestId + " " + detail);
    }

    private static void submit(Runnable task, Runnable rejected) {
        try {
            IO.execute(task);
        } catch (RuntimeException error) {
            rejected.run();
        }
    }

    private static void persistenceWarning(Throwable error) {
        Log.w(TAG, "diagnostic_io_failed type=" + error.getClass().getSimpleName());
    }
}
