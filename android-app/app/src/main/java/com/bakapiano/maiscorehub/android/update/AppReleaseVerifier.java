package com.bakapiano.maiscorehub.android.update;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;

final class AppReleaseVerifier {
    static final long MAX_APK_BYTES = 50L * 1024L * 1024L;
    private static final Set<String> ENVELOPE_KEYS = Set.of(
            "manifestBase64",
            "signatureBase64",
            "signatureAlgorithm"
    );

    private AppReleaseVerifier() { }

    static AppReleaseManifest verifyEnvelope(String envelopeJson, PublicKey publicKey)
            throws Exception {
        if (envelopeJson == null || envelopeJson.isBlank() || envelopeJson.length() > 128 * 1024) {
            throw new IllegalArgumentException("应用更新签名清单大小无效");
        }
        JSONObject envelope = new JSONObject(envelopeJson);
        requireExactKeys(envelope);
        if (!"SHA256withRSA".equals(envelope.getString("signatureAlgorithm"))) {
            throw new IllegalArgumentException("应用更新签名算法无效");
        }
        byte[] manifest = decodeBase64Strict(envelope.getString("manifestBase64"));
        byte[] signatureBytes = decodeBase64Strict(envelope.getString("signatureBase64"));
        if (!"RSA".equalsIgnoreCase(publicKey.getAlgorithm())) {
            throw new IllegalArgumentException("应用签名公钥类型无效");
        }
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(publicKey);
        verifier.update(manifest);
        if (!verifier.verify(signatureBytes)) {
            throw new IllegalArgumentException("应用更新清单签名校验失败");
        }
        return AppReleaseManifest.parse(manifest);
    }

    static String sha256(File file) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            return sha256(input);
        }
    }

    static String sha256(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) >= 0) {
            digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    static String certificateSha256(byte[] certificateBytes) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return hex(digest.digest(certificateBytes));
    }

    static byte[] decodeBase64Strict(String value) {
        byte[] decoded = Base64.getDecoder().decode(value);
        if (!Base64.getEncoder().encodeToString(decoded).equals(value)) {
            throw new IllegalArgumentException("应用更新 Base64 数据无效");
        }
        return decoded;
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return output.toString();
    }

    private static void requireExactKeys(JSONObject source) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            actual.add(keys.next());
        }
        if (!actual.equals(ENVELOPE_KEYS)) {
            throw new IllegalArgumentException("应用更新签名清单字段无效");
        }
    }
}
