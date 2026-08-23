package com.bakapiano.maiscorehub.android.wechat;

import android.content.Intent;

import java.net.URI;

/**
 * Opens a URL in WeChat's own WebView through the exported LauncherUI handoff.
 *
 * <p>WeChat 8.0.68 reads a serialized {@code start_ui_params} value from the
 * {@code intent_params_b} extra. Keep this narrowly scoped to the local OAuth
 * launcher so the app cannot turn the handoff into a general internal-activity
 * launcher.</p>
 */
public final class WechatWebViewLauncher {
    private static final String WECHAT_PACKAGE = "com.tencent.mm";
    private static final String WECHAT_LAUNCHER = "com.tencent.mm.ui.LauncherUI";
    private static final String WECHAT_WEBVIEW =
            "com.tencent.mm.plugin.webview.ui.tools.WebViewUI";
    private static final String START_UI_PARAMS_EXTRA = "intent_params_b";
    private static final String LOCAL_PROXY_HOST = "10.77.0.2";

    private WechatWebViewLauncher() {
    }

    public static Intent createIntent(String launchUrl) {
        requireLocalLaunchUrl(launchUrl);
        return new Intent()
                .setClassName(WECHAT_PACKAGE, WECHAT_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(START_UI_PARAMS_EXTRA, buildStartUiParams(launchUrl));
    }

    static String buildStartUiParams(String launchUrl) {
        requireLocalLaunchUrl(launchUrl);
        return "<start_ui_params>"
                + "<activity>" + WECHAT_WEBVIEW + "</activity>"
                + "<extra_key>rawUrl</extra_key>"
                + "<extra>" + escapeXml(launchUrl) + "</extra>"
                + "</start_ui_params>";
    }

    static void requireLocalLaunchUrl(String launchUrl) {
        try {
            URI uri = URI.create(launchUrl);
            if (!"http".equals(uri.getScheme())
                    || !LOCAL_PROXY_HOST.equals(uri.getHost())
                    || uri.getPort() <= 0
                    || !"/launch".equals(uri.getPath())) {
                throw new IllegalArgumentException("Unexpected WeChat launch URL");
            }
        } catch (RuntimeException error) {
            if (error instanceof IllegalArgumentException
                    && "Unexpected WeChat launch URL".equals(error.getMessage())) {
                throw error;
            }
            throw new IllegalArgumentException("Invalid WeChat launch URL", error);
        }
    }

    private static String escapeXml(String value) {
        return value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&apos;");
    }
}
