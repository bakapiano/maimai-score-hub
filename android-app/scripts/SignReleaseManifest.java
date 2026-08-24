import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Key;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public final class SignReleaseManifest {
    private SignReleaseManifest() { }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseOptions(args);
        Path apk = Path.of(required(options, "apk"));
        Path output = Path.of(required(options, "output"));
        String apkUrl = required(options, "apk-url");
        String host = URI.create(apkUrl).getHost();
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("APK URL has no host");
        }

        Path keystorePath = Path.of(requiredEnv("ANDROID_RELEASE_KEYSTORE_PATH"));
        char[] storePassword = requiredEnv("ANDROID_RELEASE_STORE_PASSWORD").toCharArray();
        String alias = requiredEnv("ANDROID_RELEASE_KEY_ALIAS");
        char[] keyPassword = requiredEnv("ANDROID_RELEASE_KEY_PASSWORD").toCharArray();

        KeyStore keystore = KeyStore.getInstance("JKS");
        try (InputStream input = Files.newInputStream(keystorePath)) {
            keystore.load(input, storePassword);
        }
        Key key = keystore.getKey(alias, keyPassword);
        if (!(key instanceof PrivateKey privateKey)
                || !"RSA".equalsIgnoreCase(privateKey.getAlgorithm())) {
            throw new IllegalArgumentException("Release signing key must be RSA");
        }
        Certificate certificate = keystore.getCertificate(alias);
        if (certificate == null) {
            throw new IllegalArgumentException("Release signing certificate is missing");
        }

        long apkSize = Files.size(apk);
        String apkSha256 = hex(sha256(Files.readAllBytes(apk)));
        String certificateSha256 = hex(sha256(certificate.getEncoded()));
        String publicKeyBase64 = Base64.getEncoder().encodeToString(
                certificate.getPublicKey().getEncoded()
        );
        String notes = options.containsKey("notes-file")
                ? Files.readString(Path.of(options.get("notes-file")), StandardCharsets.UTF_8)
                : options.getOrDefault("notes", "");
        String publishedAt = options.getOrDefault("published-at", Instant.now().toString());

        String manifest = "{"
                + field("releaseId", required(options, "release-id")) + ","
                + field("channel", required(options, "channel")) + ","
                + field("packageName", required(options, "package-name")) + ","
                + numberField("versionCode", required(options, "version-code")) + ","
                + field("versionName", required(options, "version-name")) + ","
                + numberField(
                        "requiredBridgeApiVersion",
                        options.getOrDefault("required-bridge-api-version", "2")
                ) + ","
                + numberField("minSdk", options.getOrDefault("min-sdk", "26")) + ","
                + field("apkUrl", apkUrl) + ","
                + field("apkSha256", apkSha256) + ","
                + "\"apkSize\":" + apkSize + ","
                + field("certificateSha256", certificateSha256) + ","
                + "\"downloadHosts\":[\"" + escape(host.toLowerCase(Locale.ROOT)) + "\"],"
                + booleanField("mandatory", options.getOrDefault("mandatory", "false")) + ","
                + numberField("rolloutPercent", options.getOrDefault("rollout-percent", "100")) + ","
                + field("notes", notes) + ","
                + field("publishedAt", publishedAt)
                + "}";
        byte[] manifestBytes = manifest.getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(privateKey);
        signer.update(manifestBytes);
        String manifestBase64 = Base64.getEncoder().encodeToString(manifestBytes);
        String signatureBase64 = Base64.getEncoder().encodeToString(signer.sign());

        String policy = "{"
                + field("channel", required(options, "channel")) + ","
                + field("packageName", required(options, "package-name")) + ","
                + field("certificateSha256", certificateSha256) + ","
                + field("manifestPublicKeyBase64", publicKeyBase64) + ","
                + "\"allowedDownloadHosts\":[\""
                + escape(host.toLowerCase(Locale.ROOT)) + "\"],"
                + "\"maxApkBytes\":52428800,"
                + "\"enabled\":true"
                + "}";
        String envelope = "{"
                + field("manifestBase64", manifestBase64) + ","
                + field("signatureBase64", signatureBase64) + ","
                + field("signatureAlgorithm", "SHA256withRSA")
                + "}";
        String result = "{"
                + "\"policy\":" + policy + ","
                + "\"envelope\":" + envelope + ","
                + "\"manifest\":" + manifest
                + "}";
        Files.createDirectories(output.toAbsolutePath().getParent());
        Files.writeString(output, result, StandardCharsets.UTF_8);
        System.out.println("releaseId=" + required(options, "release-id"));
        System.out.println("apkSha256=" + apkSha256);
        System.out.println("certificateSha256=" + certificateSha256);
    }

    private static Map<String, String> parseOptions(String[] args) {
        Map<String, String> result = new LinkedHashMap<>();
        for (int index = 0; index < args.length; index += 2) {
            if (index + 1 >= args.length || !args[index].startsWith("--")) {
                throw new IllegalArgumentException("Options must use --name value pairs");
            }
            result.put(args[index].substring(2), args[index + 1]);
        }
        return result;
    }

    private static String required(Map<String, String> values, String key) {
        String value = values.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing --" + key);
        }
        return value;
    }

    private static String requiredEnv(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing environment variable " + key);
        }
        return value;
    }

    private static String field(String name, String value) {
        return "\"" + name + "\":\"" + escape(value) + "\"";
    }

    private static String numberField(String name, String value) {
        long parsed = Long.parseLong(value);
        return "\"" + name + "\":" + parsed;
    }

    private static String booleanField(String name, String value) {
        if (!"true".equals(value) && !"false".equals(value)) {
            throw new IllegalArgumentException(name + " must be true or false");
        }
        return "\"" + name + "\":" + value;
    }

    private static String escape(String value) {
        StringBuilder output = new StringBuilder(value.length() + 16);
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            switch (current) {
                case '\"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (current < 0x20) {
                        output.append(String.format(Locale.ROOT, "\\u%04x", (int) current));
                    } else {
                        output.append(current);
                    }
                }
            }
        }
        return output.toString();
    }

    private static byte[] sha256(byte[] value) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(value);
    }

    private static String hex(byte[] value) {
        StringBuilder output = new StringBuilder(value.length * 2);
        for (byte current : value) {
            output.append(String.format(Locale.ROOT, "%02x", current & 0xff));
        }
        return output.toString();
    }
}
