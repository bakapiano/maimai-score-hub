package com.bakapiano.maiscorehub.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.widget.Toast;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import androidx.core.content.ContextCompat;

import com.bakapiano.maiscorehub.android.net.DxnetTransport;
import com.bakapiano.maiscorehub.android.diagnostics.DiagnosticLogStore;
import com.bakapiano.maiscorehub.android.diagnostics.NativeDiagnostics;
import com.bakapiano.maiscorehub.android.update.AppUpdateInstallReceiver;
import com.bakapiano.maiscorehub.android.update.AppUpdateManager;
import com.bakapiano.maiscorehub.android.vpn.ProxyUpdateVpnService;
import com.bakapiano.maiscorehub.android.vpn.OAuthStartupGuard;
import com.bakapiano.maiscorehub.android.web.InsetWebViewContainer;
import com.bakapiano.maiscorehub.android.web.WebFileChooser;
import com.bakapiano.maiscorehub.android.web.WebImageSaver;
import com.bakapiano.maiscorehub.android.wechat.WechatWebViewLauncher;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int VPN_PERMISSION_REQUEST = 4101;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4102;
    private static final int WECHAT_SHARE_REQUEST = 4103;
    private static final int APP_UPDATE_PERMISSION_REQUEST = 4104;
    private static final int DIAGNOSTICS_EXPORT_REQUEST = 4110;
    private static final int MAX_REQUEST_JSON_CHARS = 64 * 1024;
    private static final String TAG_WEBVIEW = "MshWebView";
    private static final String WEB_CACHE_PREFERENCES = "web_cache";
    private static final String WEB_CACHE_VERSION_CODE = "version_code";

    private final ExecutorService requestExecutor = Executors.newFixedThreadPool(4);
    private InsetWebViewContainer webViewContainer;
    private WebView webView;
    private WebFileChooser webFileChooser;
    private WebImageSaver webImageSaver;
    private AppUpdateManager appUpdateManager;
    private String pendingOAuthRequestId = "";
    private String pendingAppUpdateRequestId = "";
    private String pendingAppUpdateReleaseId = "";
    private boolean awaitingAppUpdatePermission;
    private JSONObject lastOAuthStatus;
    private JSONObject lastAppUpdateStatus;
    private boolean receiverRegistered;
    private boolean appUpdateReceiverRegistered;
    private boolean e2eDispatched;
    private boolean activityResumed;
    private boolean oauthServiceStartPending;
    private boolean awaitingOAuthPermission;
    private String pendingDiagnosticOffer;
    private String visibleDiagnosticOffer;
    private AlertDialog diagnosticDialog;

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
            String manualAuthUrl = intent.getStringExtra(
                    ProxyUpdateVpnService.EXTRA_MANUAL_AUTH_URL
            );
            if (isValidRequestId(requestId) && message != null) {
                emitOAuthStatus(requestId, message, terminal, success, error);
                if (terminal && success) {
                    OAuthStartupGuard.run("webview_foreground", MainActivity.this::bringWebViewToFront,
                            (stage, failure) -> NativeDiagnostics.failure(stage, requestId, failure));
                }
                if (terminal && !success
                        && intent.hasExtra(ProxyUpdateVpnService.EXTRA_DIAGNOSTIC_STAGE)) {
                    showDiagnosticOffer("授权失败，诊断日志已记录。\n请求编号：" + requestId);
                }
            }
            if (authUrl != null && !authUrl.isBlank()) {
                launchWechatWebView(authUrl, manualAuthUrl, requestId);
            }
        }
    };

    private final BroadcastReceiver appUpdateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!AppUpdateInstallReceiver.ACTION_UPDATE_STATUS.equals(intent.getAction())) {
                return;
            }
            String raw = intent.getStringExtra("statusJson");
            if (raw == null || raw.isBlank()) {
                return;
            }
            try {
                JSONObject status = new JSONObject(raw);
                emitAppUpdateStatus(status);
                if (status.optBoolean("terminal", false)) {
                    AppUpdateManager.markTerminal();
                }
            } catch (JSONException ignored) {
                // Status is produced by the app-local installer receiver.
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webViewContainer = new InsetWebViewContainer(this);
        webView = webViewContainer.getWebView();
        webFileChooser = new WebFileChooser(this);
        webImageSaver = new WebImageSaver(
                this,
                requestExecutor,
                this::emitImageSaveStatus
        );
        appUpdateManager = new AppUpdateManager(
                this,
                requestExecutor,
                this::emitAppUpdateStatus
        );
        if (savedInstanceState != null) {
            pendingOAuthRequestId = savedInstanceState.getString("pending_oauth_request_id", "");
            oauthServiceStartPending = savedInstanceState.getBoolean("oauth_service_start_pending", false);
            awaitingOAuthPermission = savedInstanceState.getBoolean("awaiting_oauth_permission", false);
            pendingDiagnosticOffer = savedInstanceState.getString("pending_diagnostic_offer");
            pendingAppUpdateRequestId = savedInstanceState.getString(
                    "pending_app_update_request_id",
                    ""
            );
            pendingAppUpdateReleaseId = savedInstanceState.getString(
                    "pending_app_update_release_id",
                    ""
            );
            awaitingAppUpdatePermission = savedInstanceState.getBoolean(
                    "awaiting_app_update_permission",
                    false
            );
            e2eDispatched = savedInstanceState.getBoolean("e2e_dispatched", false);
        }
        lastAppUpdateStatus = AppUpdateInstallReceiver.consumeLastStatus(this);
        setContentView(webViewContainer);
        configureWebView(savedInstanceState);
        registerOAuthReceiver();
        registerAppUpdateReceiver();
        requestNotificationPermission();
        NativeDiagnostics.checkPreviousCrash(found -> {
            if (found) runOnUiThread(() -> showDiagnosticOffer("检测到上次运行的异常退出记录，可导出诊断日志用于排查。"));
        });
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
                if (lastAppUpdateStatus != null) {
                    dispatchEvent("msh-android-app-update-status", lastAppUpdateStatus);
                }
                dispatchE2EStart();
            }
        });
        boolean webCacheRefreshed = refreshWebCacheAfterAppUpgrade();
        if (savedInstanceState == null || webCacheRefreshed) {
            webView.loadUrl(BuildConfig.WEB_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private boolean refreshWebCacheAfterAppUpgrade() {
        int cachedVersionCode = getSharedPreferences(
                WEB_CACHE_PREFERENCES,
                MODE_PRIVATE
        ).getInt(WEB_CACHE_VERSION_CODE, 0);
        if (!WebCachePolicy.shouldRefresh(cachedVersionCode, BuildConfig.VERSION_CODE)) {
            return false;
        }
        webView.clearCache(true);
        getSharedPreferences(WEB_CACHE_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putInt(WEB_CACHE_VERSION_CODE, BuildConfig.VERSION_CODE)
                .apply();
        Log.i(TAG_WEBVIEW, "Cleared WebView cache for app version " + BuildConfig.VERSION_CODE);
        return true;
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
        if ("app_update".equals(mode)) {
            String releaseId = getIntent().getStringExtra("e2e_release_id");
            if (!isValidReleaseId(releaseId)) {
                return;
            }
            e2eDispatched = true;
            String script = "(function waitForAppUpdateE2E(remaining){"
                    + "if(typeof window.__mshStartAndroidAppUpdateE2E==='function'){"
                    + "window.__mshStartAndroidAppUpdateE2E("
                    + JSONObject.quote(releaseId) + ");return;}"
                    + "if(remaining>0){setTimeout(function(){waitForAppUpdateE2E(remaining-1)},500)}})(60)";
            webView.evaluateJavascript(script, null);
            return;
        }
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
        if (Build.VERSION.SDK_INT < 29) {
            emitOAuthStatus(requestId, "微信授权需要 Android 10 或更高版本", true, false,
                    "微信授权需要 Android 10 或更高版本");
            return;
        }
        emitOAuthStatus(requestId, "正在申请临时 VPN…", false, false, null);
        NativeDiagnostics.event("vpn_permission_prepare", requestId, "resumed=" + activityResumed);
        OAuthStartupGuard.run("vpn_permission_prepare", () -> {
            Intent permissionIntent = VpnService.prepare(this);
            if (permissionIntent != null) {
                awaitingOAuthPermission = true;
                NativeDiagnostics.event("vpn_permission_prompt", requestId, "");
                startActivityForResult(permissionIntent, VPN_PERMISSION_REQUEST);
            } else {
                startOAuthService();
            }
        }, this::handleOAuthStartupFailure);
    }

    private void startOAuthService() {
        if (!isValidRequestId(pendingOAuthRequestId) || isFinishing() || isDestroyed()) return;
        oauthServiceStartPending = true;
        if (!activityResumed) {
            NativeDiagnostics.event("service_waiting_for_resume", pendingOAuthRequestId, "");
            return;
        }
        oauthServiceStartPending = false;
        Intent service = new Intent(this, ProxyUpdateVpnService.class)
                .putExtra(ProxyUpdateVpnService.EXTRA_REQUEST_ID, pendingOAuthRequestId);
        NativeDiagnostics.event("service_start", pendingOAuthRequestId, "resumed=" + activityResumed);
        if (OAuthStartupGuard.run("service_start", () -> startForegroundService(service),
                this::handleOAuthStartupFailure)) {
            emitOAuthStatus(pendingOAuthRequestId, "正在启动微信授权…", false, false, null);
        }
    }

    private void handleOAuthStartupFailure(String stage, Throwable error) {
        oauthServiceStartPending = false;
        awaitingOAuthPermission = false;
        NativeDiagnostics.failure(stage, pendingOAuthRequestId, error);
        String message = "系统未能启动微信授权（" + error.getClass().getSimpleName()
                + "），请返回应用前台后重试。";
        emitOAuthStatus(pendingOAuthRequestId, message, true, false, message);
        showDiagnosticOffer("授权启动失败，诊断日志已记录。\n请求编号：" + pendingOAuthRequestId);
    }

    private void beginAppUpdate(String requestId, String releaseId) {
        if (!isValidRequestId(requestId)) {
            return;
        }
        if (!isValidReleaseId(releaseId)) {
            emitAppUpdateFailure(requestId, "应用更新版本编号无效");
            return;
        }
        if (!isTrustedWebPage()) {
            emitAppUpdateFailure(requestId, "当前网页来源无法启动应用更新");
            return;
        }
        if (AppUpdateManager.isRunning()) {
            emitAppUpdateFailure(requestId, "已有应用更新正在进行");
            return;
        }
        pendingAppUpdateRequestId = requestId;
        pendingAppUpdateReleaseId = releaseId;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            awaitingAppUpdatePermission = true;
            emitAppUpdateStatus(
                    requestId,
                    "请允许 MaiScoreHub 安装应用更新",
                    "permission",
                    1,
                    false,
                    false,
                    null
            );
            Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
            );
            startActivityForResult(settings, APP_UPDATE_PERMISSION_REQUEST);
            return;
        }
        startAppUpdateManager();
    }

    private void startAppUpdateManager() {
        awaitingAppUpdatePermission = false;
        appUpdateManager.start(
                pendingAppUpdateRequestId,
                pendingAppUpdateReleaseId
        );
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == DIAGNOSTICS_EXPORT_REQUEST) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                NativeDiagnostics.export(this, data.getData(), success -> runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        Toast.makeText(this, success ? "诊断日志已导出" : "导出失败，请重试",
                                Toast.LENGTH_LONG).show();
                    }
                }));
            }
            return;
        }
        if (webFileChooser.handleActivityResult(requestCode, resultCode, data)) {
            return;
        }
        if (webImageSaver.handleActivityResult(requestCode, resultCode, data)) {
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
        if (requestCode == APP_UPDATE_PERMISSION_REQUEST) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || getPackageManager().canRequestPackageInstalls()) {
                resumePendingAppUpdateIfAuthorized();
            } else {
                awaitingAppUpdatePermission = false;
                emitAppUpdateFailure(
                        pendingAppUpdateRequestId,
                        "应用更新安装权限未开启"
                );
            }
            return;
        }
        if (requestCode != VPN_PERMISSION_REQUEST) {
            return;
        }
        awaitingOAuthPermission = false;
        NativeDiagnostics.event("vpn_permission_result", pendingOAuthRequestId,
                "granted=" + (resultCode == RESULT_OK) + " resumed=" + activityResumed);
        if (resultCode == RESULT_OK) {
            startOAuthService();
        } else {
            oauthServiceStartPending = false;
            emitOAuthStatus(
                    pendingOAuthRequestId,
                    "临时 VPN 授权已取消",
                    true,
                    false,
                    "临时 VPN 授权已取消"
            );
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumePendingAppUpdateIfAuthorized();
    }

    @Override
    protected void onPostResume() {
        super.onPostResume();
        activityResumed = true;
        if (oauthServiceStartPending && !awaitingOAuthPermission) startOAuthService();
        if (pendingDiagnosticOffer != null) showDiagnosticOffer(pendingDiagnosticOffer);
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        super.onPause();
    }

    private void showDiagnosticOffer(String message) {
        if (isFinishing() || isDestroyed()) return;
        pendingDiagnosticOffer = message;
        if (!activityResumed || (diagnosticDialog != null && diagnosticDialog.isShowing())) return;
        pendingDiagnosticOffer = null;
        visibleDiagnosticOffer = message;
        OAuthStartupGuard.run("diagnostic_dialog", () -> {
            diagnosticDialog = new AlertDialog.Builder(this)
                    .setTitle("授权诊断")
                    .setMessage(message + "\n日志包含脱敏异常、运行阶段和应用/系统版本。")
                    .setPositiveButton("导出诊断日志", (dialog, which) -> exportDiagnostics())
                    .setNegativeButton("关闭", null)
                    .create();
            diagnosticDialog.show();
        }, (stage, error) -> NativeDiagnostics.failure(stage, pendingOAuthRequestId, error));
    }

    private void exportDiagnostics() {
        OAuthStartupGuard.run("diagnostic_export_picker", () -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_TITLE, "MaiScoreHub-diagnostics-" + System.currentTimeMillis() + ".txt");
            startActivityForResult(intent, DIAGNOSTICS_EXPORT_REQUEST);
        }, (stage, error) -> {
            NativeDiagnostics.failure(stage, pendingOAuthRequestId, error);
            Toast.makeText(this, "无法打开保存位置，请重试", Toast.LENGTH_LONG).show();
        });
    }

    private void resumePendingAppUpdateIfAuthorized() {
        if (!awaitingAppUpdatePermission
                || !isValidRequestId(pendingAppUpdateRequestId)
                || !isValidReleaseId(pendingAppUpdateReleaseId)
                || AppUpdateManager.isRunning()) {
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getPackageManager().canRequestPackageInstalls()) {
            startAppUpdateManager();
        } else {
            awaitingAppUpdatePermission = false;
            emitAppUpdateFailure(
                    pendingAppUpdateRequestId,
                    "应用更新安装权限未开启"
            );
        }
    }

    private void launchWechatWebView(
            String directAuthUrl,
            String manualAuthUrl,
            String requestId
    ) {
        boolean exerciseManualFallback = BuildConfig.E2E_ENABLED
                && "manual".equals(getIntent().getStringExtra("e2e_oauth_path"));
        String launchTarget = exerciseManualFallback ? manualAuthUrl : directAuthUrl;
        try {
            NativeDiagnostics.event("wechat_launch", requestId, "manual=" + exerciseManualFallback);
            startActivity(WechatWebViewLauncher.createIntent(launchTarget));
            emitOAuthStatus(
                    requestId,
                    exerciseManualFallback
                            ? "已在微信打开手动授权链接，正在等待登录…"
                            : "已在微信直接打开授权页，正在等待登录…",
                    false,
                    false,
                    null
            );
        } catch (Exception directLaunchError) {
            NativeDiagnostics.failure("wechat_direct_launch", requestId, directLaunchError);
            if (manualAuthUrl == null || manualAuthUrl.isBlank()) {
                emitOAuthStatus(
                        requestId,
                        "微信授权页启动失败",
                        true,
                        false,
                        safeMessage(directLaunchError)
                );
                return;
            }
            Intent share = new Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .setPackage("com.tencent.mm")
                    .putExtra(Intent.EXTRA_TEXT, manualAuthUrl);
            try {
                startActivityForResult(share, WECHAT_SHARE_REQUEST);
            } catch (Exception error) {
                NativeDiagnostics.failure("wechat_fallback_launch", requestId, error);
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

    private void beginImageSave(
            String requestId,
            String fileName,
            String mimeType,
            String encodedImage
    ) {
        if (!isValidRequestId(requestId)) {
            return;
        }
        if (!isTrustedWebPage()) {
            emitImageSaveStatus(
                    requestId,
                    false,
                    "当前网页来源无法保存图片",
                    null,
                    "当前网页来源无法保存图片"
            );
            return;
        }
        webImageSaver.save(requestId, fileName, mimeType, encodedImage);
    }

    private void emitImageSaveStatus(
            String requestId,
            boolean success,
            String message,
            String uri,
            String error
    ) {
        try {
            JSONObject detail = new JSONObject()
                    .put("requestId", requestId)
                    .put("message", message)
                    .put("terminal", true)
                    .put("success", success);
            if (uri != null && !uri.isBlank()) {
                detail.put("uri", uri);
            }
            if (error != null && !error.isBlank()) {
                detail.put("error", error);
            }
            dispatchEvent("msh-android-image-save-status", detail);
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
        if (terminal && pendingOAuthRequestId.equals(requestId)) {
            oauthServiceStartPending = false;
            awaitingOAuthPermission = false;
        }
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

    private void emitAppUpdateStatus(JSONObject detail) {
        lastAppUpdateStatus = detail;
        dispatchEvent("msh-android-app-update-status", detail);
    }

    private void emitAppUpdateStatus(
            String requestId,
            String message,
            String stage,
            int progress,
            boolean terminal,
            boolean success,
            String error
    ) {
        try {
            JSONObject detail = new JSONObject()
                    .put("requestId", requestId)
                    .put("message", message)
                    .put("stage", stage)
                    .put("progress", progress)
                    .put("terminal", terminal)
                    .put("success", success);
            if (error != null && !error.isBlank()) {
                detail.put("error", error);
            }
            emitAppUpdateStatus(detail);
        } catch (JSONException ignored) {
            // Primitive values are JSON-safe.
        }
    }

    private void emitAppUpdateFailure(String requestId, String message) {
        emitAppUpdateStatus(
                requestId,
                message,
                "failed",
                0,
                true,
                false,
                message
        );
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
        ContextCompat.registerReceiver(this, oauthReceiver, filter,
                ProxyUpdateVpnService.INTERNAL_STATUS_PERMISSION, null, ContextCompat.RECEIVER_NOT_EXPORTED);
        receiverRegistered = true;
    }

    private void registerAppUpdateReceiver() {
        IntentFilter filter = new IntentFilter(
                AppUpdateInstallReceiver.ACTION_UPDATE_STATUS
        );
        ContextCompat.registerReceiver(this, appUpdateReceiver, filter,
                AppUpdateInstallReceiver.INTERNAL_STATUS_PERMISSION, null, ContextCompat.RECEIVER_NOT_EXPORTED);
        appUpdateReceiverRegistered = true;
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
        outState.putString("pending_oauth_request_id", pendingOAuthRequestId);
        outState.putBoolean("oauth_service_start_pending", oauthServiceStartPending);
        outState.putBoolean("awaiting_oauth_permission", awaitingOAuthPermission);
        outState.putString("pending_diagnostic_offer",
                diagnosticDialog != null && diagnosticDialog.isShowing()
                        ? visibleDiagnosticOffer : pendingDiagnosticOffer);
        outState.putString(
                "pending_app_update_request_id",
                pendingAppUpdateRequestId
        );
        outState.putString(
                "pending_app_update_release_id",
                pendingAppUpdateReleaseId
        );
        outState.putBoolean(
                "awaiting_app_update_permission",
                awaitingAppUpdatePermission
        );
        outState.putBoolean("e2e_dispatched", e2eDispatched);
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
        activityResumed = false;
        if (diagnosticDialog != null) {
            diagnosticDialog.dismiss();
            diagnosticDialog = null;
        }
        if (receiverRegistered) {
            unregisterReceiver(oauthReceiver);
            receiverRegistered = false;
        }
        if (appUpdateReceiverRegistered) {
            unregisterReceiver(appUpdateReceiver);
            appUpdateReceiverRegistered = false;
        }
        webImageSaver.cancel();
        requestExecutor.shutdownNow();
        webFileChooser.cancel();
        webView.removeJavascriptInterface("MaiScoreHubAndroid");
        webView.destroy();
        webView = null;
        webViewContainer.removeAllViews();
        webViewContainer = null;
        super.onDestroy();
    }

    private static boolean isValidRequestId(String value) {
        return value != null && value.matches("^[A-Za-z0-9-]{8,80}$");
    }

    private static boolean isValidReleaseId(String value) {
        return value != null && value.matches("^[a-z0-9][a-z0-9._-]{7,79}$");
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
            return NativeBridgeContract.API_VERSION;
        }

        @JavascriptInterface
        public int getVersionCode() {
            return BuildConfig.VERSION_CODE;
        }

        @JavascriptInterface
        public String getPackageName() {
            return MainActivity.this.getPackageName();
        }

        @JavascriptInterface
        public String getReleaseChannel() {
            return BuildConfig.APP_RELEASE_CHANNEL;
        }

        @JavascriptInterface
        public boolean isAppUpdateRunning() {
            return AppUpdateManager.isRunning();
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

        @JavascriptInterface
        public void startAppUpdate(String requestId, String releaseId) {
            runOnUiThread(() -> beginAppUpdate(requestId, releaseId));
        }

        @JavascriptInterface
        public void setStatusBarStyle(String backgroundColor, boolean darkIcons) {
            runOnUiThread(() -> {
                if (isTrustedWebPage()) {
                    webViewContainer.setStatusBarStyle(backgroundColor, darkIcons);
                }
            });
        }

        @JavascriptInterface
        public void saveImage(
                String requestId,
                String fileName,
                String mimeType,
                String encodedImage
        ) {
            runOnUiThread(() -> beginImageSave(
                    requestId,
                    fileName,
                    mimeType,
                    encodedImage
            ));
        }
    }
}
