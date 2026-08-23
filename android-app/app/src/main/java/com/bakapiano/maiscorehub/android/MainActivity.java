package com.bakapiano.maiscorehub.android;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.bakapiano.maiscorehub.android.net.DxnetTransport;
import com.bakapiano.maiscorehub.android.vpn.ProxyUpdateVpnService;
import com.bakapiano.maiscorehub.android.web.WebFileChooser;
import com.bakapiano.maiscorehub.android.wechat.WechatWebViewLauncher;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int VPN_PERMISSION_REQUEST = 4101;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4102;
    private static final int WECHAT_SHARE_REQUEST = 4103;
    private static final int BRIDGE_API_VERSION = 1;
    private static final int MAX_REQUEST_JSON_CHARS = 64 * 1024;
    private static final String TAG_WEBVIEW = "MshWebView";

    private final ExecutorService requestExecutor = Executors.newFixedThreadPool(4);
    private WebView webView;
    private WebFileChooser webFileChooser;
    private String pendingOAuthRequestId = "";
    private JSONObject lastOAuthStatus;
    private boolean receiverRegistered;
    private boolean e2eDispatched;

    private final BroadcastReceiver oauthReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!ProxyUpdateVpnService.ACTION_OAUTH_STATUS.equals(intent.getAction())) {
                return;
            }
            String requestId = intent.getStringExtra(ProxyUpdateVpnService.EXTRA_REQUEST_ID);
            String message = intent.getStringExtra(ProxyUpdateVpnService.EXTRA_MESSAGE);
            boolean terminal = intent.getBooleanExtra(
                    ProxyUpdateVpnService.EXTRA_TERMINAL,
                    false
            );
            boolean success = intent.getBooleanExtra(
                    ProxyUpdateVpnService.EXTRA_SUCCESS,
                    false
            );
            String error = intent.getStringExtra(ProxyUpdateVpnService.EXTRA_ERROR);
            String authUrl = intent.getStringExtra(ProxyUpdateVpnService.EXTRA_AUTH_URL);
            if (isValidRequestId(requestId) && message != null) {
                emitOAuthStatus(requestId, message, terminal, success, error);
                if (terminal && success) {
                    bringWebViewToFront();
                }
            }
            if (authUrl != null && !authUrl.isBlank()) {
                launchWechatWebView(authUrl, requestId);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webFileChooser = new WebFileChooser(this);
        setContentView(webView);
        configureWebView(savedInstanceState);
        registerOAuthReceiver();
        requestNotificationPermission();
    }

    private void bringWebViewToFront() {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
    }

    private void configureWebView(Bundle savedInstanceState) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setUserAgentString(
                settings.getUserAgentString() + " MaiScoreHubAndroid/" + BuildConfig.VERSION_NAME
        );
        if (BuildConfig.DEBUG) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        configureWebAuthentication(settings);
        webView.addJavascriptInterface(new NativeBridge(), "MaiScoreHubAndroid");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.i(TAG_WEBVIEW, consoleMessage.message());
                return true;
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                return isTrustedWebPage()
                        && webFileChooser.show(filePathCallback, fileChooserParams);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isTrustedWebHost(uri.getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // External navigation is best-effort.
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                dispatchEvent("msh-android-ready", null);
                if (lastOAuthStatus != null) {
                    dispatchEvent("msh-android-oauth-status", lastOAuthStatus);
                }
                dispatchE2EStart();
            }
        });
        if (savedInstanceState == null) {
            webView.loadUrl(BuildConfig.WEB_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void configureWebAuthentication(WebSettings settings) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            Log.w(TAG_WEBVIEW, "WebView WebAuthn feature unavailable");
            return;
        }
        WebSettingsCompat.setWebAuthenticationSupport(
                settings,
                WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
        );
        Log.i(
                TAG_WEBVIEW,
                "WebView WebAuthn mode="
                        + WebSettingsCompat.getWebAuthenticationSupport(settings)
        );
    }

    private void dispatchE2EStart() {
        if (!BuildConfig.E2E_ENABLED || e2eDispatched) {
            return;
        }
        String mode = getIntent().getStringExtra("e2e_mode");
        if (!"recent".equals(mode) && !"full".equals(mode) && !"login".equals(mode)) {
            return;
        }
        e2eDispatched = true;
        String script = "(function waitForE2E(remaining){"
                + "if(typeof window.__mshStartAndroidE2E==='function'){"
                + "window.__mshStartAndroidE2E(" + JSONObject.quote(mode) + ");return;}"
                + "if(remaining>0){setTimeout(function(){waitForE2E(remaining-1)},500)}})(60)";
        webView.evaluateJavascript(script, null);
    }

    private void beginOAuth(String requestId) {
        if (!isValidRequestId(requestId)) {
            return;
        }
        if (!isTrustedWebPage()) {
            emitOAuthStatus(
                    requestId,
                    "当前网页来源无法启动微信授权",
                    true,
                    false,
                    "当前网页来源无法启动微信授权"
            );
            return;
        }
        if (ProxyUpdateVpnService.isRunning()) {
            emitOAuthStatus(
                    requestId,
                    "已有微信授权正在进行",
                    true,
                    false,
                    "已有微信授权正在进行"
            );
            return;
        }
        pendingOAuthRequestId = requestId;
        emitOAuthStatus(requestId, "正在申请临时 VPN…", false, false, null);
        Intent permissionIntent = VpnService.prepare(this);
        if (permissionIntent != null) {
            startActivityForResult(permissionIntent, VPN_PERMISSION_REQUEST);
            return;
        }
        startOAuthService();
    }

    private void startOAuthService() {
        Intent service = new Intent(this, ProxyUpdateVpnService.class)
                .putExtra(ProxyUpdateVpnService.EXTRA_REQUEST_ID, pendingOAuthRequestId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
        emitOAuthStatus(
                pendingOAuthRequestId,
                "正在启动微信授权…",
                false,
                false,
                null
        );
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (webFileChooser.handleActivityResult(requestCode, resultCode, data)) {
            return;
        }
        if (requestCode == WECHAT_SHARE_REQUEST) {
            emitOAuthStatus(
                    pendingOAuthRequestId,
                    "临时 VPN 已启动，请在微信点击刚发送的链接…",
                    false,
                    false,
                    null
            );
            return;
        }
        if (requestCode != VPN_PERMISSION_REQUEST) {
            return;
        }
        if (resultCode == RESULT_OK) {
            startOAuthService();
        } else {
            emitOAuthStatus(
                    pendingOAuthRequestId,
                    "临时 VPN 授权已取消",
                    true,
                    false,
                    "临时 VPN 授权已取消"
            );
        }
    }

    private void launchWechatWebView(String authUrl, String requestId) {
        try {
            startActivity(WechatWebViewLauncher.createIntent(authUrl));
            emitOAuthStatus(
                    requestId,
                    "已在微信打开授权页，正在等待登录…",
                    false,
                    false,
                    null
            );
        } catch (Exception directLaunchError) {
            Intent share = new Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .setPackage("com.tencent.mm")
                    .putExtra(Intent.EXTRA_TEXT, authUrl);
            try {
                startActivityForResult(share, WECHAT_SHARE_REQUEST);
            } catch (Exception error) {
                emitOAuthStatus(
                        requestId,
                        "微信授权页启动失败",
                        true,
                        false,
                        safeMessage(directLaunchError)
                );
            }
        }
    }

    private void handleDxnetRequest(String requestId, String requestJson) {
        if (!isValidRequestId(requestId)) {
            return;
        }
        if (!isTrustedWebPage()) {
            emitHttpFailure(requestId, "当前网页来源无法使用 DXNET Bridge");
            return;
        }
        if (requestJson == null || requestJson.length() > MAX_REQUEST_JSON_CHARS) {
            emitHttpFailure(requestId, "DXNET Bridge 请求大小无效");
            return;
        }
        requestExecutor.execute(() -> {
            try {
                JSONObject response = DxnetTransport.shared().execute(requestJson);
                JSONObject detail = new JSONObject()
                        .put("requestId", requestId)
                        .put("success", true)
                        .put("status", response.getInt("status"))
                        .put("url", response.getString("url"))
                        .put("body", response.getString("body"));
                dispatchEvent("msh-android-http-result", detail);
            } catch (Exception error) {
                emitHttpFailure(requestId, safeMessage(error));
            }
        });
    }

    private void emitHttpFailure(String requestId, String error) {
        try {
            dispatchEvent(
                    "msh-android-http-result",
                    new JSONObject()
                            .put("requestId", requestId)
                            .put("success", false)
                            .put("error", error)
            );
        } catch (JSONException ignored) {
            // Primitive values are JSON-safe.
        }
    }

    private void emitOAuthStatus(
            String requestId,
            String message,
            boolean terminal,
            boolean success,
            String error
    ) {
        try {
            JSONObject detail = new JSONObject()
                    .put("requestId", requestId)
                    .put("message", message)
                    .put("terminal", terminal)
                    .put("success", success);
            if (error != null && !error.isBlank()) {
                detail.put("error", error);
            }
            lastOAuthStatus = detail;
            dispatchEvent("msh-android-oauth-status", detail);
        } catch (JSONException ignored) {
            // Primitive values are JSON-safe.
        }
    }

    private void dispatchEvent(String eventName, JSONObject detail) {
        if (webView == null) {
            return;
        }
        String script = detail == null
                ? "window.dispatchEvent(new Event(" + JSONObject.quote(eventName) + "))"
                : "window.dispatchEvent(new CustomEvent(" + JSONObject.quote(eventName)
                + ",{detail:" + detail + "}))";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private boolean isTrustedWebPage() {
        String currentUrl = webView == null ? null : webView.getUrl();
        String host = currentUrl == null ? null : Uri.parse(currentUrl).getHost();
        return isTrustedWebHost(host);
    }

    private boolean isTrustedWebHost(String host) {
        return "127.0.0.1".equals(host)
                || "localhost".equals(host)
                || "maiscorehub.bakapiano.com".equals(host)
                || "maimai.bakapiano.com".equals(host);
    }

    private void registerOAuthReceiver() {
        IntentFilter filter = new IntentFilter(ProxyUpdateVpnService.ACTION_OAUTH_STATUS);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(
                    oauthReceiver,
                    filter,
                    ProxyUpdateVpnService.INTERNAL_STATUS_PERMISSION,
                    null,
                    Context.RECEIVER_NOT_EXPORTED
            );
        } else {
            registerReceiver(
                    oauthReceiver,
                    filter,
                    ProxyUpdateVpnService.INTERNAL_STATUS_PERMISSION,
                    null
            );
        }
        receiverRegistered = true;
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_PERMISSION_REQUEST
            );
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (receiverRegistered) {
            unregisterReceiver(oauthReceiver);
            receiverRegistered = false;
        }
        requestExecutor.shutdownNow();
        webFileChooser.cancel();
        webView.removeJavascriptInterface("MaiScoreHubAndroid");
        webView.destroy();
        webView = null;
        super.onDestroy();
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

    private final class NativeBridge {
        @JavascriptInterface
        public boolean isAvailable() {
            return true;
        }

        @JavascriptInterface
        public String getVersion() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public int getBridgeApiVersion() {
            return BRIDGE_API_VERSION;
        }

        @JavascriptInterface
        public boolean isOAuthRunning() {
            return ProxyUpdateVpnService.isRunning();
        }

        @JavascriptInterface
        public void startOAuth(String requestId) {
            runOnUiThread(() -> beginOAuth(requestId));
        }

        @JavascriptInterface
        public void dxnetRequest(String requestId, String requestJson) {
            runOnUiThread(() -> handleDxnetRequest(requestId, requestJson));
        }
    }
}
