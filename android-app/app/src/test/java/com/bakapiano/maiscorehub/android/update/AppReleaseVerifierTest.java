package com.bakapiano.maiscorehub.android.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;

public final class AppReleaseVerifierTest {
    @Test
    public void verifiesSignedReleaseAndAllowsLocalDebugDownload() throws Exception {
        KeyPair keyPair = rsaKeyPair();
        String manifest = manifest("http://localhost:9050/api/v1/android/app/releases/debug-0004/apk");

        AppReleaseManifest parsed = AppReleaseVerifier.verifyEnvelope(
                envelope(manifest, keyPair),
                keyPair.getPublic()
        );

        assertEquals("debug-0004", parsed.releaseId);
        assertEquals(4, parsed.versionCode);
        parsed.requireDownloadUrlAllowed(true);
        assertThrows(
                IllegalArgumentException.class,
                () -> parsed.requireDownloadUrlAllowed(false)
        );
    }

    @Test
    public void rejectsManifestTamperingAndUnexpectedFields() throws Exception {
        KeyPair keyPair = rsaKeyPair();
        String manifest = manifest("https://api.maiscorehub.bakapiano.com/update.apk");
        String signed = envelope(manifest, keyPair);
        JSONObject tampered = new JSONObject(signed);
        byte[] original = Base64.getDecoder().decode(
                tampered.getString("manifestBase64")
        );
        tampered.put(
                "manifestBase64",
                Base64.getEncoder().encodeToString(
                        new String(original, StandardCharsets.UTF_8)
                                .replace("debug-0004", "debug-0005")
                                .getBytes(StandardCharsets.UTF_8)
                )
        );

        assertThrows(
                IllegalArgumentException.class,
                () -> AppReleaseVerifier.verifyEnvelope(
                        tampered.toString(),
                        keyPair.getPublic()
                )
        );

        JSONObject envelope = new JSONObject(signed).put("url", "https://example.com");
        assertThrows(
                IllegalArgumentException.class,
                () -> AppReleaseVerifier.verifyEnvelope(
                        envelope.toString(),
                        keyPair.getPublic()
                )
        );
    }

    private static KeyPair rsaKeyPair() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        return generator.generateKeyPair();
    }

    private static String envelope(String manifest, KeyPair keyPair) throws Exception {
        byte[] bytes = manifest.getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(keyPair.getPrivate());
        signer.update(bytes);
        return new JSONObject()
                .put("manifestBase64", Base64.getEncoder().encodeToString(bytes))
                .put(
                        "signatureBase64",
                        Base64.getEncoder().encodeToString(signer.sign())
                )
                .put("signatureAlgorithm", "SHA256withRSA")
                .toString();
    }

    private static String manifest(String apkUrl) {
        String host = apkUrl.contains("localhost")
                ? "localhost"
                : "api.maiscorehub.bakapiano.com";
        return "{"
                + "\"releaseId\":\"debug-0004\","
                + "\"channel\":\"debug\","
                + "\"packageName\":\"com.bakapiano.maiscorehub.android\","
                + "\"versionCode\":4,"
                + "\"versionName\":\"0.2.2\","
                + "\"requiredBridgeApiVersion\":2,"
                + "\"minSdk\":26,"
                + "\"apkUrl\":" + JSONObject.quote(apkUrl) + ","
                + "\"apkSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
                + "\"apkSize\":1024,"
                + "\"certificateSha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
                + "\"downloadHosts\":[" + JSONObject.quote(host) + "],"
                + "\"mandatory\":false,"
                + "\"rolloutPercent\":100,"
                + "\"notes\":\"test\","
                + "\"publishedAt\":\"2026-08-24T00:00:00Z\""
                + "}";
    }
}
