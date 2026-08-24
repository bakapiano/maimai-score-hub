package com.bakapiano.maiscorehub.android.wechat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class WechatWebViewLauncherTest {
    @Test
    public void buildsRestrictedStartUiParams() {
        assertEquals(
                "<start_ui_params>"
                        + "<activity>com.tencent.mm.plugin.webview.ui.tools.WebViewUI</activity>"
                        + "<extra_key>rawUrl</extra_key>"
                        + "<extra>http://10.77.0.2:12345/launch?nonce=1&amp;mode=recent</extra>"
                        + "</start_ui_params>",
                WechatWebViewLauncher.buildStartUiParams(
                        "http://10.77.0.2:12345/launch?nonce=1&mode=recent"
                )
        );
    }

    @Test
    public void buildsRestrictedSecureOAuthStartUiParams() {
        String url = "https://open.weixin.qq.com/connect/oauth2/authorize"
                + "?appid=wx-example"
                + "&redirect_uri=http%3A%2F%2Ftgk-wcaime.wahlap.com%2Fwc_auth%2Foauth%2Fcallback%2Fmaimai-dx"
                + "&response_type=code&scope=snsapi_base&state=fresh-state"
                + "#wechat_redirect";

        assertEquals(
                "<start_ui_params>"
                        + "<activity>com.tencent.mm.plugin.webview.ui.tools.WebViewUI</activity>"
                        + "<extra_key>rawUrl</extra_key>"
                        + "<extra>" + url.replace("&", "&amp;") + "</extra>"
                        + "</start_ui_params>",
                WechatWebViewLauncher.buildStartUiParams(url)
        );
    }

    @Test
    public void rejectsUntrustedLaunchTargets() {
        assertThrows(
                IllegalArgumentException.class,
                () -> WechatWebViewLauncher.buildStartUiParams("https://example.com/")
        );
        assertThrows(
                IllegalArgumentException.class,
                () -> WechatWebViewLauncher.buildStartUiParams(
                        "http://10.77.0.2:12345/not-launch"
                )
        );
        assertThrows(
                IllegalArgumentException.class,
                () -> WechatWebViewLauncher.buildStartUiParams(
                        "https://open.weixin.qq.com/connect/oauth2/authorize"
                                + "?appid=wx-example"
                                + "&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback"
                                + "&response_type=code&state=state"
                )
        );
    }
}
