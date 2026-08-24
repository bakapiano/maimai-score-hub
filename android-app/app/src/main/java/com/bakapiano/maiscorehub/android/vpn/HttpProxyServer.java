package com.bakapiano.maiscorehub.android.vpn;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class HttpProxyServer implements Closeable {
    private static final String TAG = "MshHttpProxy";
    interface SocketProtector {
        boolean protect(Socket socket);
    }

    interface CallbackListener {
        void onCallback(String callbackUrl);
    }

    interface LaunchTargetProvider {
        String resolve() throws IOException;
    }

    interface ConnectListener {
        void onConnect(String host);
    }

    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final SecureRandom NONCE_RANDOM = new SecureRandom();
    private final SocketProtector protector;
    private final CallbackListener callbackListener;
    private final LaunchTargetProvider launchTargetProvider;
    private final ConnectListener connectListener;
    private final String successIconDataUri;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private ServerSocket serverSocket;

    HttpProxyServer(
            SocketProtector protector,
            CallbackListener callbackListener,
            LaunchTargetProvider launchTargetProvider,
            ConnectListener connectListener,
            String successIconDataUri
    ) {
        this.protector = protector;
        this.callbackListener = callbackListener;
        this.launchTargetProvider = launchTargetProvider;
        this.connectListener = connectListener;
        if (successIconDataUri == null
                || !successIconDataUri.startsWith("data:image/png;base64,")) {
            throw new IllegalArgumentException("OAuth success icon must be an inline PNG");
        }
        this.successIconDataUri = successIconDataUri;
    }

    int start() throws IOException {
        serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new InetSocketAddress(0));
        executor.execute(this::acceptLoop);
        return serverSocket.getLocalPort();
    }

    int getPort() throws IOException {
        if (serverSocket == null || serverSocket.isClosed()) {
            throw new IOException("Proxy server is closed");
        }
        return serverSocket.getLocalPort();
    }

    private void acceptLoop() {
        while (!closed.get()) {
            try {
                Socket client = serverSocket.accept();
                if (!isAllowedClient(client)) {
                    safeLog("Rejected proxy client " + client.getInetAddress());
                    closeQuietly(client);
                    continue;
                }
                client.setSoTimeout(300_000);
                executor.execute(() -> handleClient(client));
            } catch (IOException error) {
                if (!closed.get()) {
                    close();
                }
                return;
            }
        }
    }

    private boolean isAllowedClient(Socket client) {
        InetAddress address = client.getInetAddress();
        return address.isLoopbackAddress()
                || "10.77.0.2".equals(address.getHostAddress());
    }

    private void handleClient(Socket client) {
        boolean handedOff = false;
        try {
            byte[] headerBytes = readHeader(client.getInputStream());
            if (headerBytes.length == 0) {
                return;
            }
            String header = new String(headerBytes, StandardCharsets.ISO_8859_1);
            String[] lines = header.split("\\r?\\n");
            if (lines.length == 0) {
                return;
            }
            String[] requestParts = lines[0].split(" ", 3);
            if (requestParts.length < 3) {
                return;
            }
            if ("CONNECT".equalsIgnoreCase(requestParts[0])) {
                HostPort target = HostPort.parse(requestParts[1], 443);
                safeLog("CONNECT " + target.host + ":" + target.port);
                Socket remote = connect(target.host, target.port);
                connectListener.onConnect(target.host);
                client.getOutputStream().write(
                        "HTTP/1.1 200 Connection Established\r\nProxy-Agent: MSH-Android\r\n\r\n"
                                .getBytes(StandardCharsets.ISO_8859_1)
                );
                relay(client, remote);
                handedOff = true;
                return;
            }

            String hostHeader = findHeader(lines, "host");
            URI uri = toUri(requestParts[1], hostHeader);
            safeLog(requestParts[0] + " " + uri.getHost() + uri.getPath());
            if (isLocalLaunch(uri)) {
                sendRedirect(client.getOutputStream(), launchTargetProvider.resolve());
                return;
            }
            if (isOAuthCallback(uri)) {
                safeLog("OAuth callback captured");
                sendCapturedResponse(client.getOutputStream());
                callbackListener.onCallback(uri.toString());
                return;
            }

            int port = uri.getPort() > 0 ? uri.getPort() : 80;
            Socket remote = connect(uri.getHost(), port);
            String path = uri.getRawPath();
            if (path == null || path.isEmpty()) {
                path = "/";
            }
            if (uri.getRawQuery() != null) {
                path += "?" + uri.getRawQuery();
            }
            String rewritten = requestParts[0] + " " + path + " " + requestParts[2]
                    + header.substring(lines[0].length());
            remote.getOutputStream().write(rewritten.getBytes(StandardCharsets.ISO_8859_1));
            relay(client, remote);
            handedOff = true;
        } catch (Exception error) {
            safeLog("Proxy error: " + error.getClass().getSimpleName()
                    + ": " + error.getMessage());
            sendBadGateway(client);
        } finally {
            if (!handedOff) {
                closeQuietly(client);
            }
        }
    }

    private Socket connect(String host, int port) throws IOException {
        if (host == null || host.isBlank()) {
            throw new IOException("Proxy target host is empty");
        }
        Socket remote = new Socket();
        remote.bind(new InetSocketAddress(0));
        if (!protector.protect(remote)) {
            closeQuietly(remote);
            throw new IOException("Unable to protect proxy socket");
        }
        remote.connect(new InetSocketAddress(host, port), 20_000);
        remote.setSoTimeout(300_000);
        return remote;
    }

    private void relay(Socket left, Socket right) {
        AtomicBoolean finished = new AtomicBoolean(false);
        Runnable closeBoth = () -> {
            if (finished.compareAndSet(false, true)) {
                closeQuietly(left);
                closeQuietly(right);
            }
        };
        executor.execute(() -> copy(left, right, closeBoth));
        executor.execute(() -> copy(right, left, closeBoth));
    }

    private void copy(Socket source, Socket destination, Runnable onDone) {
        try {
            InputStream input = source.getInputStream();
            OutputStream output = destination.getOutputStream();
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                output.write(buffer, 0, count);
                output.flush();
            }
        } catch (IOException ignored) {
            // Closing either side is the normal way a proxied request finishes.
        } finally {
            onDone.run();
        }
    }

    private byte[] readHeader(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int matched = 0;
        while (buffer.size() < MAX_HEADER_BYTES) {
            int value = input.read();
            if (value < 0) {
                break;
            }
            buffer.write(value);
            if (
                    (matched == 0 && value == '\r') ||
                    (matched == 1 && value == '\n') ||
                    (matched == 2 && value == '\r') ||
                    (matched == 3 && value == '\n')
            ) {
                matched++;
                if (matched == 4) {
                    return buffer.toByteArray();
                }
            } else {
                matched = value == '\r' ? 1 : 0;
            }
        }
        if (buffer.size() >= MAX_HEADER_BYTES) {
            throw new IOException("Proxy request header is too large");
        }
        return buffer.toByteArray();
    }

    private String findHeader(String[] lines, String name) {
        String prefix = name.toLowerCase(Locale.ROOT) + ":";
        for (String line : lines) {
            if (line.toLowerCase(Locale.ROOT).startsWith(prefix)) {
                return line.substring(line.indexOf(':') + 1).trim();
            }
        }
        return "";
    }

    private URI toUri(String requestTarget, String hostHeader) throws Exception {
        if (requestTarget.startsWith("http://")) {
            return URI.create(requestTarget);
        }
        return URI.create("http://" + hostHeader + (requestTarget.startsWith("/") ? "" : "/") + requestTarget);
    }

    private boolean isOAuthCallback(URI uri) {
        String query = uri.getRawQuery() == null ? "" : uri.getRawQuery();
        return "http".equalsIgnoreCase(uri.getScheme())
                && "tgk-wcaime.wahlap.com".equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 80)
                && uri.getPath() != null
                && uri.getPath().startsWith("/wc_auth/oauth/callback")
                && hasQueryKey(query, "r")
                && hasQueryKey(query, "t")
                && hasQueryKey(query, "code")
                && hasQueryKey(query, "state");
    }

    private boolean isLocalLaunch(URI uri) {
        String host = uri.getHost();
        return "http".equalsIgnoreCase(uri.getScheme())
                && ("10.77.0.2".equals(host) || "127.0.0.1".equals(host))
                && "/launch".equals(uri.getPath())
                && hasQueryKey(uri.getRawQuery() == null ? "" : uri.getRawQuery(), "nonce");
    }

    private boolean hasQueryKey(String query, String key) {
        return query.startsWith(key + "=") || query.contains("&" + key + "=");
    }

    private void sendCapturedResponse(OutputStream output) throws IOException {
        byte[] nonceBytes = new byte[18];
        NONCE_RANDOM.nextBytes(nonceBytes);
        String scriptNonce = Base64.getEncoder()
                .withoutPadding()
                .encodeToString(nonceBytes);
        String html = "<!doctype html><html lang=\"zh-CN\"><head>"
                + "<meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover\">"
                + "<meta name=\"theme-color\" content=\"#f8f9fa\">"
                + "<title>MaiScoreHub</title>"
                + "<style>"
                + ":root{color:#212529;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif;color-scheme:light}"
                + "*{box-sizing:border-box}"
                + "body{min-height:100vh;min-height:100dvh;margin:0;padding:max(10vh,env(safe-area-inset-top,0px)) max(20px,env(safe-area-inset-right,0px)) max(32px,env(safe-area-inset-bottom,0px)) max(20px,env(safe-area-inset-left,0px));background:#f8f9fa}"
                + "main{width:min(420px,100%);margin:0 auto;text-align:center}"
                + ".iconWrap{width:72px;height:72px;margin:0 auto 16px}"
                + ".appIcon{display:block;width:72px;height:72px;border-radius:12px}"
                + "h1{margin:0;color:#212529;font-size:26px;font-weight:700;line-height:1.35}"
                + ".resultCard{margin-top:28px;overflow:hidden;background:#fff;border:1px solid #dee2e6;border-radius:10px;box-shadow:0 6px 18px rgba(33,37,41,.08)}"
                + ".resultBody{padding:28px 24px 24px}"
                + ".statusIcon{display:flex;width:42px;height:42px;margin:0 auto 16px;align-items:center;justify-content:center;color:#0ca678;background:#e6fcf5;border-radius:50%}"
                + ".statusIcon svg{width:22px;height:22px;stroke:currentColor;stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}"
                + "p{margin:0;color:#343a40;font-size:16px;font-weight:500;line-height:1.65}"
                + ".actions{padding:16px;border-top:1px solid #e9ecef}"
                + ".closeButton{width:100%;padding:11px 18px;color:#fff;font:inherit;font-size:15px;font-weight:600;background:#228be6;border:1px solid #228be6;border-radius:8px;box-shadow:none}"
                + ".closeButton:active{transform:scale(.98)}.closeButton:disabled{opacity:.62}"
                + "@media(max-width:360px){body{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}.resultBody{padding:24px 18px 22px}}"
                + "</style></head><body><main>"
                + "<div class=\"iconWrap\"><img class=\"appIcon\" src=\""
                + successIconDataUri
                + "\" alt=\"MaiScoreHub\"></div>"
                + "<h1>MaiScoreHub</h1>"
                + "<section class=\"resultCard\">"
                + "<div class=\"resultBody\"><div class=\"statusIcon\" aria-hidden=\"true\">"
                + "<svg viewBox=\"0 0 24 24\"><path d=\"M5 12.5l4.2 4.2L19 7\"></path></svg></div>"
                + "<p>登陆成功！请手动返回 APP 内继续</p></div>"
                + "<div class=\"actions\"><button class=\"closeButton\" id=\"closePage\" type=\"button\">关闭页面</button></div>"
                + "</section>"
                + "</main><script nonce=\"" + scriptNonce + "\">"
                + "document.getElementById('closePage').addEventListener('click',function(){"
                + "var button=this;button.disabled=true;"
                + "if(window.WeixinJSBridge&&typeof window.WeixinJSBridge.call==='function'){window.WeixinJSBridge.call('closeWindow');return;}"
                + "document.addEventListener('WeixinJSBridgeReady',function(){window.WeixinJSBridge.call('closeWindow');},{once:true});"
                + "window.close();setTimeout(function(){button.disabled=false;},800);"
                + "});</script></body></html>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: text/html; charset=utf-8\r\n"
                + "Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-"
                + scriptNonce
                + "'; base-uri 'none'; form-action 'none'\r\n"
                + "Cache-Control: no-store\r\n"
                + "Content-Length: " + body.length
                + "\r\nConnection: close\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.ISO_8859_1));
        output.write(body);
        output.flush();
    }

    private void sendRedirect(OutputStream output, String location) throws IOException {
        if (location == null
                || !location.startsWith("https://open.weixin.qq.com/")
                || location.contains("\r")
                || location.contains("\n")) {
            throw new IOException("本地 OAuth 跳转地址无效");
        }
        String response = "HTTP/1.1 302 Found\r\n"
                + "Location: " + location + "\r\n"
                + "Cache-Control: no-store, no-cache, must-revalidate\r\n"
                + "Content-Length: 0\r\nConnection: close\r\n\r\n";
        output.write(response.getBytes(StandardCharsets.ISO_8859_1));
        output.flush();
    }

    private void sendBadGateway(Socket client) {
        try {
            client.getOutputStream().write(
                    "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .getBytes(StandardCharsets.ISO_8859_1)
            );
        } catch (IOException ignored) {
            // The client may already have closed the socket.
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        closeQuietly(serverSocket);
        executor.shutdownNow();
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // Best-effort cleanup.
        }
    }

    private static void safeLog(String message) {
        try {
            Log.i(TAG, message);
        } catch (RuntimeException ignored) {
            // android.util.Log is unavailable in local JVM unit tests.
        }
    }

    private static final class HostPort {
        final String host;
        final int port;

        private HostPort(String host, int port) {
            this.host = host;
            this.port = port;
        }

        static HostPort parse(String value, int defaultPort) {
            if (value.startsWith("[")) {
                int end = value.indexOf(']');
                String host = value.substring(1, end);
                int port = value.length() > end + 2
                        ? Integer.parseInt(value.substring(end + 2))
                        : defaultPort;
                return new HostPort(host, port);
            }
            int separator = value.lastIndexOf(':');
            if (separator > 0 && value.indexOf(':') == separator) {
                return new HostPort(
                        value.substring(0, separator),
                        Integer.parseInt(value.substring(separator + 1))
                );
            }
            return new HostPort(value, defaultPort);
        }
    }
}
