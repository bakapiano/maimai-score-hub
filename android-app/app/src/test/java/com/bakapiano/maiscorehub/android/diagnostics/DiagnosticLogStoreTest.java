package com.bakapiano.maiscorehub.android.diagnostics;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class DiagnosticLogStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void removesUrlsHeadersAndCredentialValues() {
        String result = DiagnosticLogStore.sanitize(
                "GET https://example.test/callback/private-path?code=url-secret&state=url-state\n"
                        + "Cookie: sid=cookie-secret; another=also-secret\n"
                        + "Authorization: Bearer auth-secret\n"
                        + "Authorization=Bearer equals-auth-secret\n"
                        + "Cookie=sid=first-secret; second=second-secret\n"
                        + "accessToken=camel-secret sessionKey=session-secret\n"
                        + "{\"access_token\":\"json-secret\", \"_t\":\"csrf-secret\"}\n"
                        + "openid=openid-secret nonce=nonce-secret password='space secret'\n"
                        + "Bearer standalone-secret"
        );
        for (String value : new String[]{
                "example.test", "private-path", "url-secret", "url-state", "cookie-secret",
                "also-secret", "auth-secret", "json-secret", "csrf-secret", "openid-secret",
                "nonce-secret", "space secret", "standalone-secret", "equals-auth-secret",
                "first-secret", "second-secret", "camel-secret", "session-secret"
        }) assertFalse(value, result.contains(value));
    }

    @Test
    public void preservesPlatformExceptionNamesAndCorrelationFields() {
        String text = "ForegroundServiceStartNotAllowedException "
                + "ForegroundServiceTypeNotAllowedException "
                + "FOREGROUND_SERVICE_SYSTEM_EXEMPTED versionCode=7 "
                + "requestId=673bca95-3b5b-4d9d-a3b4-c09abc768371";
        assertEquals(text, DiagnosticLogStore.sanitize(text));
    }

    @Test
    public void storesBoundedUtf8AndRotatesToOnePreviousFile() throws Exception {
        File root = temporary.newFolder();
        DiagnosticLogStore store = new DiagnosticLogStore(root, 2048);
        for (int i = 0; i < 20; i++) store.append("record-" + i + " 诊断".repeat(80));
        assertTrue(new File(root, "native.log").length() <= 2048);
        assertTrue(new File(root, "native.previous.log").length() <= 2048);
        assertEquals(2, root.list().length);
        assertTrue(store.snapshot().contains("record-19"));
        assertFalse(store.snapshot().contains("record-0 "));
        assertFalse(store.snapshot().contains("\ufffd"));
    }

    @Test
    public void boundsSingleLargeEntryAtUtf8Boundary() throws Exception {
        File root = temporary.newFolder();
        DiagnosticLogStore store = new DiagnosticLogStore(root, 1024);
        store.append("诊断".repeat(2000));
        assertTrue(new File(root, "native.log").length() <= 1024);
        assertFalse(store.snapshot().contains("\ufffd"));
    }

    @Test
    public void crashSurvivesRestartAndRemainsExportableAfterAcknowledgement() throws Exception {
        File root = temporary.newFolder();
        DiagnosticLogStore first = new DiagnosticLogStore(root, 2048);
        first.append("stage=foreground_start requestId=test-request");
        first.saveCrash("SecurityException token=private-value");
        DiagnosticLogStore restarted = new DiagnosticLogStore(root, 2048);
        assertTrue(restarted.acknowledgePreviousCrash());
        assertFalse(restarted.acknowledgePreviousCrash());
        assertTrue(restarted.snapshot().contains("SecurityException"));
        assertTrue(restarted.snapshot().contains("stage=foreground_start"));
        assertFalse(restarted.snapshot().contains("private-value"));
    }

    @Test
    public void keepsCauseAndStackWhileRedactingExceptionMessages() throws Exception {
        SecurityException cause = new SecurityException("permission denied token=secret-value");
        RuntimeException outer = new RuntimeException("https://host.test/?code=private-code", cause);
        String result = DiagnosticLogStore.describe(outer);
        assertTrue(result.contains("java.lang.SecurityException"));
        assertTrue(result.contains("Caused by:"));
        assertTrue(result.contains("DiagnosticLogStoreTest"));
        assertFalse(result.contains("secret-value"));
        assertFalse(result.contains("private-code"));
        File root = temporary.newFolder();
        new DiagnosticLogStore(root, 16 * 1024).append(result);
        String persisted = new String(Files.readAllBytes(new File(root, "native.log").toPath()),
                StandardCharsets.UTF_8);
        assertFalse(persisted.contains("secret-value"));
    }
}
