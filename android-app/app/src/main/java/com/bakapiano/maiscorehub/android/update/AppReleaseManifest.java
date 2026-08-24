package com.bakapiano.maiscorehub.android.update;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

final class AppReleaseManifest {
    private static final Pattern RELEASE_ID = Pattern.compile("^[a-z0-9][a-z0-9._-]{7,79}$");
    private static final Pattern PACKAGE_NAME = Pattern.compile(
            "^[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)+$"
    );
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Set<String> CHANNELS = Set.of("debug", "beta", "stable");
    private static final Set<String> KEYS = Set.of(
            "releaseId",
            "channel",
            "packageName",
            "versionCode",
            "versionName",
            "requiredBridgeApiVersion",
            "minSdk",
            "apkUrl",
            "apkSha256",
            "apkSize",
            "certificateSha256",
            "downloadHosts",
            "mandatory",
            "rolloutPercent",
            "notes",
            "publishedAt"
    );

    final String releaseId;
    final String channel;
    final String packageName;
    final long versionCode;
    final String versionName;
    final int requiredBridgeApiVersion;
    final int minSdk;
    final String apkUrl;
    final String apkSha256;
    final long apkSize;
    final String certificateSha256;
    final List<String> downloadHosts;
    final boolean mandatory;
    final int rolloutPercent;
    final String notes;
    final String publishedAt;

    private AppReleaseManifest(
            String releaseId,
            String channel,
            String packageName,
            long versionCode,
            String versionName,
            int requiredBridgeApiVersion,
            int minSdk,
            String apkUrl,
            String apkSha256,
            long apkSize,
            String certificateSha256,
            List<String> downloadHosts,
            boolean mandatory,
            int rolloutPercent,
            String notes,
            String publishedAt
    ) {
        this.releaseId = releaseId;
        this.channel = channel;
        this.packageName = packageName;
        this.versionCode = versionCode;
        this.versionName = versionName;
        this.requiredBridgeApiVersion = requiredBridgeApiVersion;
        this.minSdk = minSdk;
        this.apkUrl = apkUrl;
        this.apkSha256 = apkSha256;
        this.apkSize = apkSize;
        this.certificateSha256 = certificateSha256;
        this.downloadHosts = List.copyOf(downloadHosts);
        this.mandatory = mandatory;
        this.rolloutPercent = rolloutPercent;
        this.notes = notes;
        this.publishedAt = publishedAt;
    }

    static AppReleaseManifest parse(byte[] manifestBytes) throws Exception {
        if (manifestBytes.length == 0 || manifestBytes.length > 64 * 1024) {
            throw new IllegalArgumentException("应用更新清单大小无效");
        }
        JSONObject source = new JSONObject(new String(manifestBytes, java.nio.charset.StandardCharsets.UTF_8));
        requireExactKeys(source);

        String releaseId = source.getString("releaseId");
        String channel = source.getString("channel");
        String packageName = source.getString("packageName");
        long versionCode = source.getLong("versionCode");
        String versionName = source.getString("versionName");
        int requiredBridgeApiVersion = source.getInt("requiredBridgeApiVersion");
        int minSdk = source.getInt("minSdk");
        String apkUrl = source.getString("apkUrl");
        String apkSha256 = source.getString("apkSha256").toLowerCase(Locale.ROOT);
        long apkSize = source.getLong("apkSize");
        String certificateSha256 = source
                .getString("certificateSha256")
                .toLowerCase(Locale.ROOT);
        JSONArray hostsSource = source.getJSONArray("downloadHosts");
        List<String> downloadHosts = new ArrayList<>();
        for (int index = 0; index < hostsSource.length(); index++) {
            String host = normalizeHost(hostsSource.getString(index));
            if (!downloadHosts.contains(host)) {
                downloadHosts.add(host);
            }
        }
        boolean mandatory = source.getBoolean("mandatory");
        int rolloutPercent = source.getInt("rolloutPercent");
        String notes = source.getString("notes");
        String publishedAt = source.getString("publishedAt");

        if (!RELEASE_ID.matcher(releaseId).matches()) {
            throw new IllegalArgumentException("应用更新版本编号无效");
        }
        if (!CHANNELS.contains(channel)) {
            throw new IllegalArgumentException("应用更新频道无效");
        }
        if (!PACKAGE_NAME.matcher(packageName).matches()) {
            throw new IllegalArgumentException("应用更新包名无效");
        }
        if (versionCode <= 0 || versionName.isBlank() || versionName.length() > 80) {
            throw new IllegalArgumentException("应用更新版本无效");
        }
        if (requiredBridgeApiVersion <= 0 || minSdk < 26 || minSdk > 100) {
            throw new IllegalArgumentException("应用更新兼容版本无效");
        }
        if (!SHA256.matcher(apkSha256).matches()
                || !SHA256.matcher(certificateSha256).matches()) {
            throw new IllegalArgumentException("应用更新摘要无效");
        }
        if (apkSize <= 0 || apkSize > AppReleaseVerifier.MAX_APK_BYTES) {
            throw new IllegalArgumentException("应用更新安装包大小无效");
        }
        if (downloadHosts.isEmpty() || downloadHosts.size() > 16) {
            throw new IllegalArgumentException("应用更新下载域名无效");
        }
        if (rolloutPercent < 0 || rolloutPercent > 100 || notes.length() > 4000) {
            throw new IllegalArgumentException("应用更新发布策略无效");
        }
        if (publishedAt.isBlank() || publishedAt.length() > 64) {
            throw new IllegalArgumentException("应用更新时间无效");
        }

        URI parsedUrl = URI.create(apkUrl);
        String apkHost = normalizeHost(parsedUrl.getHost());
        if (parsedUrl.getUserInfo() != null
                || apkHost.isBlank()
                || !downloadHosts.contains(apkHost)) {
            throw new IllegalArgumentException("应用更新下载地址无效");
        }

        return new AppReleaseManifest(
                releaseId,
                channel,
                packageName,
                versionCode,
                versionName,
                requiredBridgeApiVersion,
                minSdk,
                apkUrl,
                apkSha256,
                apkSize,
                certificateSha256,
                downloadHosts,
                mandatory,
                rolloutPercent,
                notes,
                publishedAt
        );
    }

    void requireDownloadUrlAllowed(boolean allowInsecure) {
        URI uri = URI.create(apkUrl);
        String scheme = uri.getScheme() == null
                ? ""
                : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = normalizeHost(uri.getHost());
        boolean secure = "https".equals(scheme);
        boolean localDebug = allowInsecure
                && "http".equals(scheme)
                && ("localhost".equals(host) || "127.0.0.1".equals(host));
        if (!secure && !localDebug) {
            throw new IllegalArgumentException("应用更新下载地址需要可信 HTTPS");
        }
        if (!downloadHosts.contains(host)) {
            throw new IllegalArgumentException("应用更新下载域名未经清单授权");
        }
    }

    private static void requireExactKeys(JSONObject source) throws JSONException {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            actual.add(keys.next());
        }
        if (!actual.equals(KEYS)) {
            throw new IllegalArgumentException("应用更新清单字段无效");
        }
    }

    private static String normalizeHost(String host) {
        if (host == null) {
            return "";
        }
        String normalized = host.trim().toLowerCase(Locale.ROOT);
        return normalized.endsWith(".")
                ? normalized.substring(0, normalized.length() - 1)
                : normalized;
    }
}
