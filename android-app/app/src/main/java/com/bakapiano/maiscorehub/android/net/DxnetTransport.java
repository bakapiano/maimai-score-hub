package com.bakapiano.maiscorehub.android.net;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.ConnectionSpec;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.FormBody;
import okhttp3.HttpUrl;
import okhttp3.Interceptor;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.TlsVersion;

public final class DxnetTransport {
    private static final String TAG = "MshDxnetTransport";
    private static final String BASE_URL = "https://maimai.wahlap.com/maimai-mobile";
    private static final String AUTHORIZE_URL =
            "https://tgk-wcaime.wahlap.com/wc_auth/oauth/authorize/maimai-dx";
    private static final String WECHAT_USER_AGENT =
            "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 "
                    + "NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) "
                    + "WindowsWechat(0x6307001e)";
    private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    private static final DxnetTransport SHARED = new DxnetTransport();

    private final OkHttpClient client;
    private final MemoryCookieJar cookies;

    private DxnetTransport() {
        cookies = new MemoryCookieJar();
        Interceptor headers = chain -> {
            Request.Builder request = chain.request().newBuilder()
                    .header("User-Agent", WECHAT_USER_AGENT)
                    .header("Accept-Language", "zh-CN,zh;q=0.9,en-US;q=0.8")
                    .header("Cache-Control", "no-cache");
            if ("tgk-wcaime.wahlap.com".equals(chain.request().url().host())) {
                request
                        .header("Upgrade-Insecure-Requests", "1")
                        .header(
                                "Accept",
                                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                                        + "image/webp,image/apng,*/*;q=0.8"
                        )
                        .header("Sec-Fetch-Site", "none")
                        .header("Sec-Fetch-Mode", "navigate")
                        .header("Sec-Fetch-User", "?1")
                        .header("Sec-Fetch-Dest", "document")
                        .header("Accept-Encoding", "gzip, deflate, br");
            }
            return chain.proceed(request.build());
        };
        ConnectionSpec tls = new ConnectionSpec.Builder(ConnectionSpec.COMPATIBLE_TLS)
                .tlsVersions(TlsVersion.TLS_1_2, TlsVersion.TLS_1_1, TlsVersion.TLS_1_0)
                .allEnabledCipherSuites()
                .build();
        client = new OkHttpClient.Builder()
                .proxy(Proxy.NO_PROXY)
                .cookieJar(cookies)
                .addInterceptor(headers)
                .followRedirects(true)
                .followSslRedirects(true)
                .connectionSpecs(Arrays.asList(tls, ConnectionSpec.CLEARTEXT))
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(90, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build();
    }

    public static DxnetTransport shared() {
        return SHARED;
    }

    public synchronized void resetSession() {
        cookies.clear();
        client.connectionPool().evictAll();
    }

    public String resolveAuthorizationUrl() throws IOException {
        try (Response response = client.newCall(
                new Request.Builder().url(AUTHORIZE_URL).get().build()
        ).execute()) {
            String finalUrl = response.request().url().toString();
            if (!response.isSuccessful()
                    || !"open.weixin.qq.com".equals(response.request().url().host())) {
                String body = readBody(response);
                throwIfMaintenance(body);
                throw new IOException("DXNET 授权入口响应异常，HTTP " + response.code());
            }
            return normalizeAuthorizationUrl(finalUrl);
        }
    }

    public void exchangeCallback(String capturedUrl) throws IOException {
        String secureUrl = requireCallbackUrl(capturedUrl);
        OkHttpClient noRedirectClient = client.newBuilder()
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
        String location;
        HttpUrl callbackUrl;
        try (Response response = noRedirectClient.newCall(
                new Request.Builder()
                        .url(secureUrl)
                        .header("Host", "tgk-wcaime.wahlap.com")
                        .get()
                        .build()
        ).execute()) {
            Log.i(TAG, "OAuth callback HTTP " + response.code());
            if (response.code() < 200 || response.code() >= 400) {
                throw new IOException("微信授权交换失败，HTTP " + response.code());
            }
            location = response.header("Location");
            callbackUrl = response.request().url();
        }
        if (location == null || location.isBlank()) {
            throw new IOException("微信授权交换缺少跳转地址");
        }
        HttpUrl redirect = callbackUrl.resolve(location);
        if (redirect == null || !"maimai.wahlap.com".equals(redirect.host())) {
            throw new IOException("微信授权交换跳转地址无效");
        }
        try (Response response = client.newCall(
                new Request.Builder().url(redirect).get().build()
        ).execute()) {
            String body = readBody(response);
            throwIfMaintenance(body);
            if (!response.isSuccessful()) {
                throw new IOException("DXNET 会话建立失败，HTTP " + response.code());
            }
        }
    }

    public JSONObject execute(String requestJson) throws IOException {
        try {
            JSONObject input = new JSONObject(requestJson);
            String method = input.optString("method", "").toUpperCase();
            String path = requireRelativePath(input.optString("path", ""));
            Request.Builder request = new Request.Builder().url(BASE_URL + path);
            if ("GET".equals(method)) {
                request.get();
            } else if ("POST".equals(method)) {
                request.post(buildForm(input));
            } else {
                throw new IOException("DXNET Bridge 仅接受 GET/POST");
            }
            try (Response response = client.newCall(request.build()).execute()) {
                String body = readBody(response);
                return new JSONObject()
                        .put("status", response.code())
                        .put("url", response.request().url().toString())
                        .put("body", body);
            }
        } catch (JSONException error) {
            throw new IOException("DXNET Bridge 请求 JSON 无效", error);
        }
    }

    private RequestBody buildForm(JSONObject input) throws IOException, JSONException {
        JSONObject values = input.optJSONObject("form");
        FormBody.Builder form = new FormBody.Builder(StandardCharsets.UTF_8);
        boolean hasToken = false;
        if (values != null) {
            if (values.length() > 64) {
                throw new IOException("DXNET Bridge 表单字段过多");
            }
            Iterator<String> keys = values.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object raw = values.get(key);
                if (!(raw instanceof String) || key.isBlank() || key.length() > 100) {
                    throw new IOException("DXNET Bridge 表单字段无效");
                }
                form.add(key, (String) raw);
                if ("token".equals(key)) {
                    hasToken = true;
                }
            }
        }
        if (input.optBoolean("attachCsrfToken", false) && !hasToken) {
            String token = cookies.getCookieValue("maimai.wahlap.com", "_t");
            if (token == null || token.isBlank()) {
                throw new IOException("DXNET 会话缺少表单令牌");
            }
            form.add("token", token);
        }
        return form.build();
    }

    static String normalizeAuthorizationUrl(String source) throws IOException {
        String location = source
                .replace("redirect_uri=https%3A", "redirect_uri=http%3A")
                .replace("redirect_uri=https%3a", "redirect_uri=http%3a")
                .replace("redirect_uri=https:", "redirect_uri=http:");
        HttpUrl parsed = HttpUrl.parse(location);
        String callback = parsed == null ? null : parsed.queryParameter("redirect_uri");
        if (callback == null || !callback.startsWith(
                "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback/"
        )) {
            throw new IOException("DXNET 授权回调地址结构异常");
        }
        return location.contains("#wechat_redirect")
                ? location
                : location + "#wechat_redirect";
    }

    static String requireRelativePath(String path) throws IOException {
        if (path == null
                || !path.startsWith("/")
                || path.startsWith("//")
                || path.contains("\\")
                || path.contains("..")
                || path.length() > 2048) {
            throw new IOException("DXNET Bridge 路径无效");
        }
        return path;
    }

    private static String requireCallbackUrl(String source) throws IOException {
        if (source == null || !source.startsWith(
                "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback/"
        )) {
            throw new IOException("微信授权回调地址无效");
        }
        return source.replaceFirst("^http://", "https://");
    }

    private static String readBody(Response response) throws IOException {
        String body = response.body() == null ? "" : response.body().string();
        if (body.getBytes(StandardCharsets.UTF_8).length > MAX_RESPONSE_BYTES) {
            throw new IOException("DXNET 响应超过 4MB 限制");
        }
        return body;
    }

    private static void throwIfMaintenance(String body) throws IOException {
        if (body.contains("系统正在维护中") || body.contains("正在维护中")) {
            throw new IOException("DXNET 每日维护中（04:00–07:00）");
        }
    }

    private static final class MemoryCookieJar implements CookieJar {
        private final Map<String, Cookie> values = new LinkedHashMap<>();

        @Override
        public synchronized void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            for (Cookie cookie : cookies) {
                values.put(cookie.name() + "|" + cookie.domain() + "|" + cookie.path(), cookie);
            }
            Log.i(TAG, "Stored cookies count=" + values.size());
        }

        @Override
        public synchronized List<Cookie> loadForRequest(HttpUrl url) {
            long now = System.currentTimeMillis();
            values.values().removeIf(cookie -> cookie.expiresAt() < now);
            List<Cookie> result = new ArrayList<>();
            for (Cookie cookie : values.values()) {
                if (cookie.matches(url)) {
                    result.add(cookie);
                }
            }
            return result;
        }

        synchronized String getCookieValue(String host, String name) {
            HttpUrl url = HttpUrl.parse("https://" + host + "/");
            if (url == null) {
                return null;
            }
            for (Cookie cookie : loadForRequest(url)) {
                if (name.equals(cookie.name())) {
                    return cookie.value();
                }
            }
            return null;
        }

        synchronized void clear() {
            values.clear();
        }
    }
}
