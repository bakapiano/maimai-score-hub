package com.bakapiano.maiscorehub.android.vpn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class HttpProxyServerTest {
    private static final String TEST_ICON_DATA_URI =
            "data:image/png;base64,iVBORw0KGgo=";

    @Test
    public void capturesExactOAuthCallbackAndReturnsInlineSuccessPage() throws Exception {
        AtomicReference<String> captured = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        try (HttpProxyServer proxy = new HttpProxyServer(
                socket -> true,
                url -> {
                    captured.set(url);
                    latch.countDown();
                },
                () -> "https://open.weixin.qq.com/connect/oauth2/authorize?example=1",
                ignored -> { },
                TEST_ICON_DATA_URI
        )) {
            int port = proxy.start();
            try (Socket client = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
                String url = "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback/maimai-dx"
                        + "?r=nonce&t=timestamp&code=example&state=state";
                client.getOutputStream().write((
                        "GET " + url + " HTTP/1.1\r\n"
                                + "Host: tgk-wcaime.wahlap.com\r\nConnection: close\r\n\r\n"
                ).getBytes(StandardCharsets.ISO_8859_1));
                String response = readAll(client.getInputStream());
                assertTrue(response.startsWith("HTTP/1.1 200 OK"));
                assertTrue(response.contains("登陆成功！请手动返回 APP 内继续"));
                assertTrue(response.contains("class=\"appIcon\""));
                assertTrue(response.contains("class=\"successMark\""));
                assertTrue(response.contains(TEST_ICON_DATA_URI));
                assertTrue(response.contains("id=\"closePage\""));
                assertTrue(response.contains("WeixinJSBridge.call('closeWindow')"));
                Matcher nonce = Pattern.compile("<script nonce=\"([^\"]+)\">")
                        .matcher(response);
                assertTrue(nonce.find());
                assertTrue(response.contains("script-src 'nonce-" + nonce.group(1) + "'"));
                assertFalse(response.contains("script-src 'unsafe-inline'"));
                assertFalse(response.contains("class=\"phoneIcon\""));
                assertFalse(response.contains("@keyframes"));
                assertFalse(response.contains("class=\"progress\""));
                assertFalse(response.contains("class=\"notice\""));
                assertTrue(response.contains("Content-Security-Policy:"));
                assertTrue(latch.await(2, TimeUnit.SECONDS));
                assertEquals(url, captured.get());
            }
        }
    }

    @Test
    public void tunnelsConnectTrafficBidirectionally() throws Exception {
        AtomicBoolean protectorReceivedBoundSocket = new AtomicBoolean(false);
        try (ServerSocket upstream = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            Thread echo = new Thread(() -> {
                try (Socket socket = upstream.accept()) {
                    byte[] input = socket.getInputStream().readNBytes(4);
                    socket.getOutputStream().write(input);
                    socket.getOutputStream().flush();
                } catch (Exception error) {
                    throw new RuntimeException(error);
                }
            });
            echo.start();
            try (HttpProxyServer proxy = new HttpProxyServer(
                    socket -> {
                        protectorReceivedBoundSocket.set(socket.isBound());
                        return true;
                    },
                    ignored -> { },
                    () -> "https://open.weixin.qq.com/connect/oauth2/authorize?example=1",
                    ignored -> { },
                    TEST_ICON_DATA_URI
            )) {
                int port = proxy.start();
                try (Socket client = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
                    client.setSoTimeout(3_000);
                    client.getOutputStream().write((
                            "CONNECT 127.0.0.1:" + upstream.getLocalPort() + " HTTP/1.1\r\n"
                                    + "Host: 127.0.0.1\r\n\r\n"
                    ).getBytes(StandardCharsets.ISO_8859_1));
                    String header = readHeader(client.getInputStream());
                    assertTrue(header.startsWith("HTTP/1.1 200 Connection Established"));
                    client.getOutputStream().write("ping".getBytes(StandardCharsets.UTF_8));
                    client.getOutputStream().flush();
                    assertEquals("ping", new String(
                            client.getInputStream().readNBytes(4),
                            StandardCharsets.UTF_8
                    ));
                    assertTrue(protectorReceivedBoundSocket.get());
                }
            }
            echo.join(2_000);
        }
    }

    @Test
    public void resolvesLocalLaunchInsideTheAndroidProxy() throws Exception {
        AtomicBoolean resolved = new AtomicBoolean(false);
        String target = "https://open.weixin.qq.com/connect/oauth2/authorize"
                + "?appid=example#wechat_redirect";
        try (HttpProxyServer proxy = new HttpProxyServer(
                socket -> true,
                ignored -> { },
                () -> {
                    resolved.set(true);
                    return target;
                },
                ignored -> { },
                TEST_ICON_DATA_URI
        )) {
            int port = proxy.start();
            try (Socket client = new Socket(InetAddress.getByName("127.0.0.1"), port)) {
                client.getOutputStream().write((
                        "GET http://10.77.0.2:" + port + "/launch?nonce=123 HTTP/1.1\r\n"
                                + "Host: 10.77.0.2:" + port + "\r\nConnection: close\r\n\r\n"
                ).getBytes(StandardCharsets.ISO_8859_1));
                String response = readAll(client.getInputStream());
                assertTrue(response.startsWith("HTTP/1.1 302 Found"));
                assertTrue(response.contains("Location: " + target));
                assertTrue(resolved.get());
            }
        }
    }

    private static String readHeader(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int value = input.read();
            if (value < 0) break;
            output.write(value);
            if (
                    (matched == 0 && value == '\r') ||
                    (matched == 1 && value == '\n') ||
                    (matched == 2 && value == '\r') ||
                    (matched == 3 && value == '\n')
            ) {
                matched++;
            } else {
                matched = value == '\r' ? 1 : 0;
            }
        }
        return output.toString(StandardCharsets.ISO_8859_1);
    }

    private static String readAll(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int count;
        while ((count = input.read(buffer)) >= 0) {
            output.write(buffer, 0, count);
        }
        return output.toString(StandardCharsets.UTF_8);
    }
}
