package com.bakapiano.maiscorehub.android.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ProxyInfo;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.util.Log;
import android.util.Base64;

import com.bakapiano.maiscorehub.android.BuildConfig;
import com.bakapiano.maiscorehub.android.MainActivity;
import com.bakapiano.maiscorehub.android.R;
import com.bakapiano.maiscorehub.android.diagnostics.DiagnosticLogStore;
import com.bakapiano.maiscorehub.android.diagnostics.NativeDiagnostics;
import com.bakapiano.maiscorehub.android.net.DxnetTransport;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class ProxyUpdateVpnService extends VpnService {
    public static final String EXTRA_REQUEST_ID = "requestId";
    public static final String EXTRA_AUTH_URL = "authUrl";
    public static final String EXTRA_MANUAL_AUTH_URL = "manualAuthUrl";
    public static final String EXTRA_MESSAGE = "message";
    public static final String EXTRA_TERMINAL = "terminal";
    public static final String EXTRA_SUCCESS = "success";
    public static final String EXTRA_ERROR = "error";
    public static final String EXTRA_DIAGNOSTIC_STAGE = "diagnosticStage";
    public static final String ACTION_OAUTH_STATUS =
            BuildConfig.APPLICATION_ID + ".OAUTH_STATUS";
    public static final String INTERNAL_STATUS_PERMISSION =
            BuildConfig.APPLICATION_ID + ".permission.INTERNAL_STATUS";

    private static final String CHANNEL_ID = "oauth_proxy";
    private static final int NOTIFICATION_ID = 22081;
    private static final String TAG = "MshOAuthVpn";
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicReference<String> callbackUrl = new AtomicReference<>();
    private CountDownLatch callbackLatch;
    private ParcelFileDescriptor vpnInterface;
    private HttpProxyServer proxyServer;
    private String activeRequestId = "";
    private volatile String currentStage = "service_created";
    private volatile boolean foregroundStarted;
    private final AtomicBoolean ownsRunning = new AtomicBoolean(false);

    public static boolean isRunning() {
        return RUNNING.get();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NativeDiagnostics.event("service_created", "", "");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String requestId = intent == null ? "" : intent.getStringExtra(EXTRA_REQUEST_ID);
        if (!isValidRequestId(requestId)) {
            NativeDiagnostics.event("service_invalid_request", "", "");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!RUNNING.compareAndSet(false, true)) {
            if (requestId.equals(activeRequestId)) {
                NativeDiagnostics.event("service_duplicate_start", requestId, "");
                return START_NOT_STICKY;
            }
            broadcast(
                    requestId,
                    "已有微信授权正在进行",
                    true,
                    false,
                    "已有微信授权正在进行",
                    null
            );
            return START_NOT_STICKY;
        }
        ownsRunning.set(true);
        activeRequestId = requestId;
        OAuthStartupGuard.start(
                () -> {
                    stage("foreground_start");
                    createNotificationChannel();
                    startForeground(NOTIFICATION_ID, notification("正在准备微信授权…"));
                    foregroundStarted = true;
                    stage("foreground_started");
                },
                () -> executor.execute(this::runOAuth),
                (failedStage, error) -> {
                    reportFailure(failedStage, error);
                    finishOAuth();
                }
        );
        return START_NOT_STICKY;
    }

    private void runOAuth() {
        try {
            stage("preflight");
            requireProxyApi();
            callbackUrl.set(null);
            callbackLatch = new CountDownLatch(1);
            DxnetTransport transport = DxnetTransport.shared();
            transport.resetSession();
            stage("resolve_authorization");
            String directAuthUrl = transport.resolveAuthorizationUrl();
            stage("proxy_start");
            proxyServer = new HttpProxyServer(
                    this::protect,
                    url -> {
                        if (callbackUrl.compareAndSet(null, url)) {
                            callbackLatch.countDown();
                        }
                    },
                    transport::resolveAuthorizationUrl,
                    host -> NativeDiagnostics.event("proxy_connect", activeRequestId, "host=" + host),
                    createSuccessIconDataUri()
            );
            int proxyPort = proxyServer.start();
            String manualAuthUrl = "http://10.77.0.2:" + proxyPort
                    + "/launch?nonce=" + System.currentTimeMillis();
            boolean manualLinkCopied = copyManualAuthUrl(manualAuthUrl);
            stage("vpn_establish");
            establishVpn(proxyPort);
            stage("vpn_established");
            Log.i(TAG, "Prepared direct HTTPS OAuth with local HTTP fallback");
            broadcast(
                    activeRequestId,
                    manualLinkCopied
                            ? "临时 VPN 已启动，备用链接已复制，正在微信打开授权页…"
                            : "临时 VPN 已启动，正在微信打开授权页…",
                    false,
                    false,
                    null,
                    directAuthUrl,
                    manualAuthUrl
            );
            stage("wait_callback");
            if (!callbackLatch.await(5, TimeUnit.MINUTES)) {
                throw new IOException("等待微信授权超时");
            }
            closeVpnTransport();
            broadcast(
                    activeRequestId,
                    "授权完成，正在建立 DXNET 会话…",
                    false,
                    false,
                    null,
                    null
            );
            stage("exchange_callback");
            transport.exchangeCallback(callbackUrl.get());
            stage("oauth_completed");
            broadcast(
                    activeRequestId,
                    "微信授权完成，DXNET 会话已建立",
                    true,
                    true,
                    null,
                    null
            );
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            NativeDiagnostics.event("oauth_cancelled", activeRequestId, "stage=" + currentStage);
            broadcast(
                    activeRequestId,
                    "微信授权已取消",
                    true,
                    false,
                    "微信授权已取消",
                    null
            );
        } catch (Exception | LinkageError error) {
            reportFailure(currentStage, error);
        } finally {
            finishOAuth();
        }
    }

    private void stage(String stage) {
        currentStage = stage;
        NativeDiagnostics.event(stage, activeRequestId, "");
    }

    private void reportFailure(String stage, Throwable error) {
        NativeDiagnostics.failure(stage, activeRequestId, error);
        String message = "微信授权失败：" + safeMessage(error);
        broadcast(activeRequestId, message, true, false, message, null, null, stage);
    }

    private void finishOAuth() {
        closeVpnTransport();
        if (ownsRunning.compareAndSet(true, false)) {
            RUNNING.set(false);
        }
        OAuthStartupGuard.run("foreground_stop", () -> {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregroundStarted = false;
        }, (stage, error) -> NativeDiagnostics.failure(stage, activeRequestId, error));
        OAuthStartupGuard.run("service_stop", this::stopSelf,
                (stage, error) -> NativeDiagnostics.failure(stage, activeRequestId, error));
    }

    private String createSuccessIconDataUri() throws IOException {
        Bitmap source = BitmapFactory.decodeResource(
                getResources(),
                R.drawable.maiscorehub_icon
        );
        if (source == null) {
            throw new IOException("无法读取 MaiScoreHub 图标");
        }
        Bitmap scaled = Bitmap.createScaledBitmap(source, 96, 96, true);
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                throw new IOException("无法生成 MaiScoreHub 图标");
            }
            return "data:image/png;base64,"
                    + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        } finally {
            if (scaled != source) {
                scaled.recycle();
            }
            source.recycle();
        }
    }

    private void establishVpn(int proxyPort) throws Exception {
        if (Build.VERSION.SDK_INT < 29) {
            throw new IOException("手机系统版本需要 Android 10 或更高版本");
        }
        Builder builder = new Builder()
                .setSession("MaiScoreHub OAuth")
                .setMtu(1500)
                .addAddress("10.77.0.2", 32)
                .setBlocking(true)
                .setConfigureIntent(PendingIntent.getActivity(
                        this,
                        0,
                        new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                ));
        Set<String> callbackAddresses = new LinkedHashSet<>();
        callbackAddresses.add("43.137.87.70");
        callbackAddresses.add("43.145.17.212");
        for (InetAddress address : InetAddress.getAllByName("tgk-wcaime.wahlap.com")) {
            if (address instanceof Inet4Address) {
                callbackAddresses.add(address.getHostAddress());
            }
        }
        for (String address : callbackAddresses) {
            builder.addRoute(address, 32);
        }
        builder.addAllowedApplication("com.tencent.mm");
        builder.setHttpProxy(ProxyInfo.buildDirectProxy("10.77.0.2", proxyPort));
        if (Build.VERSION.SDK_INT >= 29) {
            builder.setMetered(false);
        }
        ParcelFileDescriptor replacement = builder.establish();
        if (replacement == null) {
            throw new IOException("临时 VPN 建立失败");
        }
        ParcelFileDescriptor previous = vpnInterface;
        vpnInterface = replacement;
        if (previous != null) {
            previous.close();
        }
    }

    private void requireProxyApi() throws IOException {
        if (Build.VERSION.SDK_INT < 29) {
            throw new IOException("手机系统版本需要 Android 10 或更高版本");
        }
        try {
            getPackageManager().getPackageInfo("com.tencent.mm", 0);
        } catch (PackageManager.NameNotFoundException error) {
            throw new IOException("手机上未找到微信", error);
        }
    }

    private boolean copyManualAuthUrl(String authUrl) {
        // A ROM clipboard restriction should still allow the direct OAuth path.
        return OAuthStartupGuard.run("clipboard_copy", () -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (clipboard == null) throw new IllegalStateException("Clipboard service unavailable");
            clipboard.setPrimaryClip(ClipData.newPlainText("maimai DXNET 授权", authUrl));
        }, (stage, error) -> NativeDiagnostics.failure(stage, activeRequestId, error));
    }

    private void broadcast(
            String requestId,
            String message,
            boolean terminal,
            boolean success,
            String error,
            String authUrl
    ) {
        broadcast(requestId, message, terminal, success, error, authUrl, null);
    }

    private void broadcast(
            String requestId,
            String message,
            boolean terminal,
            boolean success,
            String error,
            String authUrl,
            String manualAuthUrl
    ) {
        broadcast(requestId, message, terminal, success, error, authUrl, manualAuthUrl, null);
    }

    private void broadcast(
            String requestId,
            String message,
            boolean terminal,
            boolean success,
            String error,
            String authUrl,
            String manualAuthUrl,
            String diagnosticStage
    ) {
        Log.i(
                TAG,
                "oauth requestId=" + requestId + " terminal=" + terminal
                        + " success=" + success + " message=" + DiagnosticLogStore.sanitize(message)
        );
        Intent status = new Intent(ACTION_OAUTH_STATUS)
                .setPackage(getPackageName())
                .putExtra(EXTRA_REQUEST_ID, requestId)
                .putExtra(EXTRA_MESSAGE, message)
                .putExtra(EXTRA_TERMINAL, terminal)
                .putExtra(EXTRA_SUCCESS, success);
        if (error != null && !error.isBlank()) {
            status.putExtra(EXTRA_ERROR, error);
        }
        if (authUrl != null && !authUrl.isBlank()) {
            status.putExtra(EXTRA_AUTH_URL, authUrl);
        }
        if (manualAuthUrl != null && !manualAuthUrl.isBlank()) {
            status.putExtra(EXTRA_MANUAL_AUTH_URL, manualAuthUrl);
        }
        if (diagnosticStage != null) status.putExtra(EXTRA_DIAGNOSTIC_STAGE, diagnosticStage);
        // Deliver the terminal result independently of optional notification updates.
        OAuthStartupGuard.run("status_broadcast",
                () -> sendBroadcast(status, INTERNAL_STATUS_PERMISSION),
                (stage, failure) -> NativeDiagnostics.failure(stage, requestId, failure));
        if (foregroundStarted) {
            OAuthStartupGuard.run("notification_update", () -> {
                NotificationManager manager = getSystemService(NotificationManager.class);
                manager.notify(NOTIFICATION_ID, notification(message));
            }, (stage, failure) -> NativeDiagnostics.failure(stage, requestId, failure));
        }
    }

    private Notification notification(String message) {
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("MaiScoreHub")
                .setContentText(message)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setContentIntent(contentIntent)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "微信授权",
                    NotificationManager.IMPORTANCE_LOW
            );
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private synchronized void closeVpnTransport() {
        if (proxyServer != null) {
            HttpProxyServer previous = proxyServer;
            proxyServer = null;
            OAuthStartupGuard.run("proxy_close", previous::close,
                    (stage, error) -> NativeDiagnostics.failure(stage, activeRequestId, error));
        }
        if (vpnInterface != null) {
            ParcelFileDescriptor previous = vpnInterface;
            vpnInterface = null;
            try {
                previous.close();
            } catch (IOException | RuntimeException error) {
                NativeDiagnostics.failure("vpn_close", activeRequestId, error);
            }
        }
    }

    @Override
    public void onRevoke() {
        NativeDiagnostics.event("vpn_revoked", activeRequestId, "stage=" + currentStage);
        broadcast(
                activeRequestId,
                "临时 VPN 权限已撤销",
                true,
                false,
                "临时 VPN 权限已撤销",
                null
        );
        closeVpnTransport();
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        NativeDiagnostics.event("service_destroyed", activeRequestId, "stage=" + currentStage);
        closeVpnTransport();
        executor.shutdownNow();
        if (ownsRunning.compareAndSet(true, false)) {
            RUNNING.set(false);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent);
    }

    private static boolean isValidRequestId(String value) {
        return value != null && value.matches("^[A-Za-z0-9-]{8,80}$");
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
                ? error.getClass().getSimpleName()
                : DiagnosticLogStore.sanitize(message);
    }
}
