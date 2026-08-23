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
    public void rejectsNonLocalLaunchTargets() {
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
    }
}
