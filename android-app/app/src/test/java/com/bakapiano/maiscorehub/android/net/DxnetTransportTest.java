package com.bakapiano.maiscorehub.android.net;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.IOException;

public class DxnetTransportTest {
    @Test
    public void normalizesTheWechatCallbackToHttpForVpnCapture() throws Exception {
        String source = "https://open.weixin.qq.com/connect/oauth2/authorize"
                + "?redirect_uri=https%3A%2F%2Ftgk-wcaime.wahlap.com%2Fwc_auth%2Foauth%2Fcallback%2Fmaimai-dx";

        String normalized = DxnetTransport.normalizeAuthorizationUrl(source);

        assertTrue(normalized.contains("redirect_uri=http%3A"));
        assertTrue(normalized.endsWith("#wechat_redirect"));
    }

    @Test
    public void acceptsOnlyRelativeDxnetPaths() throws Exception {
        assertEquals("/record/", DxnetTransport.requireRelativePath("/record/"));
        assertThrows(
                IOException.class,
                () -> DxnetTransport.requireRelativePath("https://example.com/")
        );
        assertThrows(
                IOException.class,
                () -> DxnetTransport.requireRelativePath("/record/../friend/")
        );
    }
}
