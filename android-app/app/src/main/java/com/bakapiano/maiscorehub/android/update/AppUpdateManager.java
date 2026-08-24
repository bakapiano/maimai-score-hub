package com.bakapiano.maiscorehub.android.update;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import com.bakapiano.maiscorehub.android.BuildConfig;
import com.bakapiano.maiscorehub.android.NativeBridgeContract;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

public final class AppUpdateManager {
    public interface StatusListener {
        void onStatus(JSONObject status);
    }

    private static final Pattern RELEASE_ID = Pattern.compile(
            "^[a-z0-9][a-z0-9._-]{7,79}$"
    );
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static final int MAX_MANIFEST_BYTES = 128 * 1024;

    private final Context context;
    private final ExecutorService executor;
    private final StatusListener listener;
    private final OkHttpClient client;

    public AppUpdateManager(
            Context context,
            ExecutorService executor,
            StatusListener listener
    ) {
        this.context = context.getApplicationContext();
        this.executor = executor;
        this.listener = listener;
        this.client = new OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(2, TimeUnit.MINUTES)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build();
    }

    public static boolean isRunning() {
        return RUNNING.get();
    }

    public static void markTerminal() {
        RUNNING.set(false);
    }

    public void start(String requestId, String releaseId) {
        if (!RELEASE_ID.matcher(releaseId == null ? "" : releaseId).matches()) {
            emit(requestId, "版本编号无效", "failed", 0, true, false, "版本编号无效");
            return;
        }
        if (!RUNNING.compareAndSet(false, true)) {
            emit(
                    requestId,
                    "已有应用更新正在进行",
                    "busy",
                    0,
                    true,
                    false,
                    "已有应用更新正在进行"
            );
            return;
        }
        executor.execute(() -> runUpdate(requestId, releaseId));
    }

    private void runUpdate(String requestId, String releaseId) {
        try {
            emit(requestId, "正在获取签名更新清单…", "manifest", 3, false, false, null);
            X509Certificate currentCertificate = getCurrentCertificate();
            String envelope = fetchManifest(releaseId);
            AppReleaseManifest manifest = AppReleaseVerifier.verifyEnvelope(
                    envelope,
                    currentCertificate.getPublicKey()
            );
            verifyManifestCompatibility(releaseId, manifest, currentCertificate);

            emit(requestId, "清单校验通过，正在下载安装包…", "download", 8, false, false, null);
            File apk = downloadApk(requestId, manifest);
            emit(requestId, "下载完成，正在校验安装包…", "verify", 74, false, false, null);
            verifyArchive(apk, manifest);

            emit(requestId, "安装包校验通过，正在提交系统安装器…", "install", 88, false, false, null);
            commitInstall(requestId, manifest, apk);
            emit(requestId, "请在系统页面确认安装", "confirm", 94, false, false, null);
        } catch (Exception error) {
            RUNNING.set(false);
            String message = safeMessage(error);
            emit(requestId, "应用更新失败：" + message, "failed", 0, true, false, message);
        }
    }

    private String fetchManifest(String releaseId) throws Exception {
        String encoded = URLEncoder.encode(releaseId, StandardCharsets.UTF_8);
        String url = BuildConfig.APP_RELEASE_API_BASE_URL
                + "/android/app/releases/" + encoded + "/manifest";
        try (Response response = client.newCall(new Request.Builder().url(url).get().build()).execute()) {
            if (!response.isSuccessful()) {
                throw new IllegalStateException("更新清单 HTTP " + response.code());
            }
            return readBoundedUtf8(response.body(), MAX_MANIFEST_BYTES);
        }
    }

    private File downloadApk(String requestId, AppReleaseManifest manifest) throws Exception {
        manifest.requireDownloadUrlAllowed(BuildConfig.ALLOW_INSECURE_APP_UPDATES);
        File directory = new File(context.getCacheDir(), "app-updates");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("无法创建应用更新缓存");
        }
        File partial = new File(directory, manifest.releaseId + ".apk.part");
        File target = new File(directory, manifest.releaseId + ".apk");
        deleteQuietly(partial);
        deleteQuietly(target);

        Request request = new Request.Builder()
                .url(manifest.apkUrl)
                .header("Accept", "application/vnd.android.package-archive")
                .get()
                .build();
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IllegalStateException("安装包下载 HTTP " + response.code());
            }
            ResponseBody body = response.body();
            if (body == null) {
                throw new IllegalStateException("安装包下载响应为空");
            }
            long declaredLength = body.contentLength();
            if (declaredLength > 0 && declaredLength != manifest.apkSize) {
                throw new IllegalStateException("安装包下载长度与清单不一致");
            }
            long copied = 0;
            int lastProgress = -1;
            try (
                    InputStream input = body.byteStream();
                    OutputStream output = new FileOutputStream(partial)
            ) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    copied += count;
                    if (copied > manifest.apkSize || copied > AppReleaseVerifier.MAX_APK_BYTES) {
                        throw new IllegalStateException("安装包下载超过清单大小");
                    }
                    output.write(buffer, 0, count);
                    int progress = 8 + (int) Math.min(64, copied * 64 / manifest.apkSize);
                    if (progress != lastProgress) {
                        lastProgress = progress;
                        emit(
                                requestId,
                                "正在下载安装包 " + copied * 100 / manifest.apkSize + "%…",
                                "download",
                                progress,
                                false,
                                false,
                                null
                        );
                    }
                }
                output.flush();
            } catch (Exception error) {
                deleteQuietly(partial);
                throw error;
            }
            if (copied != manifest.apkSize) {
                deleteQuietly(partial);
                throw new IllegalStateException("安装包下载不完整");
            }
        }
        if (!partial.renameTo(target)) {
            deleteQuietly(partial);
            throw new IllegalStateException("无法保存应用更新安装包");
        }
        if (!AppReleaseVerifier.sha256(target).equals(manifest.apkSha256)) {
            deleteQuietly(target);
            throw new IllegalStateException("安装包 SHA-256 校验失败");
        }
        return target;
    }

    private void verifyManifestCompatibility(
            String requestedReleaseId,
            AppReleaseManifest manifest,
            X509Certificate currentCertificate
    ) throws Exception {
        if (!requestedReleaseId.equals(manifest.releaseId)) {
            throw new IllegalArgumentException("更新清单版本编号不匹配");
        }
        if (!BuildConfig.APP_RELEASE_CHANNEL.equals(manifest.channel)) {
            throw new IllegalArgumentException("更新清单频道不匹配");
        }
        if (!context.getPackageName().equals(manifest.packageName)) {
            throw new IllegalArgumentException("更新清单包名不匹配");
        }
        if (manifest.versionCode <= BuildConfig.VERSION_CODE) {
            throw new IllegalArgumentException("目标版本需要高于当前版本");
        }
        if (manifest.requiredBridgeApiVersion > NativeBridgeContract.API_VERSION) {
            throw new IllegalArgumentException("当前安装器版本无法处理该更新");
        }
        if (Build.VERSION.SDK_INT < manifest.minSdk) {
            throw new IllegalArgumentException("当前 Android 版本低于更新要求");
        }
        String currentDigest = AppReleaseVerifier.certificateSha256(
                currentCertificate.getEncoded()
        );
        if (!currentDigest.equals(manifest.certificateSha256)) {
            throw new IllegalArgumentException("更新清单签名证书不匹配");
        }
        manifest.requireDownloadUrlAllowed(BuildConfig.ALLOW_INSECURE_APP_UPDATES);
    }

    private void verifyArchive(File apk, AppReleaseManifest manifest) throws Exception {
        PackageInfo archive = getArchivePackageInfo(apk);
        if (archive == null || !manifest.packageName.equals(archive.packageName)) {
            throw new IllegalArgumentException("安装包包名校验失败");
        }
        long archiveVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? archive.getLongVersionCode()
                : archive.versionCode;
        if (archiveVersion != manifest.versionCode) {
            throw new IllegalArgumentException("安装包版本号校验失败");
        }
        Signature signer = getSingleSigner(archive);
        String digest = AppReleaseVerifier.certificateSha256(signer.toByteArray());
        if (!manifest.certificateSha256.equals(digest)) {
            throw new IllegalArgumentException("安装包签名证书校验失败");
        }
    }

    private void commitInstall(
            String requestId,
            AppReleaseManifest manifest,
            File apk
    ) throws Exception {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL
        );
        params.setAppPackageName(context.getPackageName());
        params.setSize(manifest.apkSize);
        params.setInstallReason(PackageManager.INSTALL_REASON_USER);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        }
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (
                    InputStream input = new FileInputStream(apk);
                    OutputStream output = session.openWrite("base.apk", 0, manifest.apkSize)
            ) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, count);
                }
                session.fsync(output);
            }
            Intent status = new Intent(context, AppUpdateInstallReceiver.class)
                    .setAction(AppUpdateInstallReceiver.ACTION_INSTALL_STATUS)
                    .putExtra(AppUpdateInstallReceiver.EXTRA_REQUEST_ID, requestId)
                    .putExtra(AppUpdateInstallReceiver.EXTRA_RELEASE_ID, manifest.releaseId)
                    .putExtra(AppUpdateInstallReceiver.EXTRA_VERSION_NAME, manifest.versionName);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                flags |= PendingIntent.FLAG_MUTABLE;
            }
            PendingIntent pending = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    status,
                    flags
            );
            session.commit(pending.getIntentSender());
        } catch (Exception error) {
            installer.abandonSession(sessionId);
            throw error;
        }
    }

    private X509Certificate getCurrentCertificate() throws Exception {
        PackageInfo current = getInstalledPackageInfo();
        Signature signer = getSingleSigner(current);
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        try (InputStream input = new java.io.ByteArrayInputStream(signer.toByteArray())) {
            return (X509Certificate) factory.generateCertificate(input);
        }
    }

    private PackageInfo getInstalledPackageInfo() throws Exception {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        return context.getPackageManager().getPackageInfo(context.getPackageName(), flags);
    }

    private PackageInfo getArchivePackageInfo(File apk) {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        return context.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
    }

    private static Signature getSingleSigner(PackageInfo info) {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            if (info.signingInfo == null || info.signingInfo.hasMultipleSigners()) {
                throw new IllegalArgumentException("应用签名数量无效");
            }
            signatures = info.signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length != 1) {
            throw new IllegalArgumentException("应用签名数量无效");
        }
        return signatures[0];
    }

    private static String readBoundedUtf8(ResponseBody body, int maxBytes) throws Exception {
        if (body == null) {
            throw new IllegalStateException("更新清单响应为空");
        }
        try (InputStream input = body.byteStream()) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (output.size() + count > maxBytes) {
                    throw new IllegalStateException("更新清单响应过大");
                }
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8);
        }
    }

    private void emit(
            String requestId,
            String message,
            String stage,
            int progress,
            boolean terminal,
            boolean success,
            String error
    ) {
        try {
            JSONObject status = new JSONObject()
                    .put("requestId", requestId)
                    .put("message", message)
                    .put("stage", stage)
                    .put("progress", progress)
                    .put("terminal", terminal)
                    .put("success", success);
            if (error != null && !error.isBlank()) {
                status.put("error", error);
            }
            listener.onStatus(status);
        } catch (Exception ignored) {
            // Primitive values are JSON-safe.
        }
    }

    private static void deleteQuietly(File file) {
        if (file.exists() && !file.delete()) {
            file.deleteOnExit();
        }
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
                ? error.getClass().getSimpleName()
                : message;
    }
}
