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
    public static final String EXTRA_MESSAGE = "message";
    public static final String EXTRA_TERMINAL = "terminal";
    public static final String EXTRA_SUCCESS = "success";
    public static final String EXTRA_ERROR = "error";
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

    public static boolean isRunning() {
        return RUNNING.get();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String requestId = intent == null ? "" : intent.getStringExtra(EXTRA_REQUEST_ID);
        if (!isValidRequestId(requestId)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!RUNNING.compareAndSet(false, true)) {
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
        activeRequestId = requestId;
        startForeground(NOTIFICATION_ID, notification("正在准备微信授权…"));
        executor.execute(this::runOAuth);
        return START_NOT_STICKY;
    }

    private void runOAuth() {
        try {
            requireProxyApi();
            callbackUrl.set(null);
            callbackLatch = new CountDownLatch(1);
            DxnetTransport transport = DxnetTransport.shared();
            transport.resetSession();
            proxyServer = new HttpProxyServer(
                    this::protect,
                    url -> {
                        if (callbackUrl.compareAndSet(null, url)) {
                            callbackLatch.countDown();
                        }
                    },
                    transport::resolveAuthorizationUrl,
                    host -> Log.i(TAG, "Proxy CONNECT " + host),
                    createSuccessIconDataUri()
            );
            int proxyPort = proxyServer.start();
            String launchUrl = "http://10.77.0.2:" + proxyPort
                    + "/launch?nonce=" + System.currentTimeMillis();
            copyAuthUrl(launchUrl);
            establishVpn(proxyPort);
            broadcast(
                    activeRequestId,
                    "临时 VPN 已启动，正在微信打开授权页…",
                    false,
                    false,
                    null,
                    launchUrl
            );

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
            transport.exchangeCallback(callbackUrl.get());
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
            broadcast(
                    activeRequestId,
                    "微信授权已取消",
                    true,
                    false,
                    "微信授权已取消",
                    null
            );
        } catch (Exception error) {
            String message = safeMessage(error);
            broadcast(
                    activeRequestId,
                    "微信授权失败：" + message,
                    true,
                    false,
                    message,
                    null
            );
        } finally {
            closeVpnTransport();
            RUNNING.set(false);
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
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

    private void copyAuthUrl(String authUrl) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("maimai DXNET 授权", authUrl));
    }

    private void broadcast(
            String requestId,
            String message,
            boolean terminal,
            boolean success,
            String error,
            String authUrl
    ) {
        Log.i(
                TAG,
                "oauth requestId=" + requestId + " terminal=" + terminal
                        + " success=" + success + " message=" + message
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, notification(message));
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
        sendBroadcast(status, INTERNAL_STATUS_PERMISSION);
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
            proxyServer.close();
            proxyServer = null;
        }
        if (vpnInterface != null) {
            try {
                vpnInterface.close();
            } catch (IOException ignored) {
                // Best-effort cleanup.
            }
            vpnInterface = null;
        }
    }

    @Override
    public void onRevoke() {
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
        closeVpnTransport();
        executor.shutdownNow();
        RUNNING.set(false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent);
    }

    private static boolean isValidRequestId(String value) {
        return value != null && value.matches("^[A-Za-z0-9-]{8,80}$");
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank()
                ? error.getClass().getSimpleName()
                : message;
    }
}
