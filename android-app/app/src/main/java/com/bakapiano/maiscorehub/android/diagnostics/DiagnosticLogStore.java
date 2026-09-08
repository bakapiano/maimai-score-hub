package com.bakapiano.maiscorehub.android.diagnostics;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.regex.Pattern;

/** Bounded, app-private native diagnostics. Never pass HTTP bodies or OAuth payloads here. */
public final class DiagnosticLogStore {
    private static final int MAX_ENTRY_CHARS = 12_000;
    private static final Pattern HEADERS = Pattern.compile(
            "(?im)\\b(?:authorization|proxy-authorization|set-cookie|cookie)[\\\"']?\\s*[:=]\\s*[^\\r\\n]*"
    );
    private static final Pattern URL = Pattern.compile("(?i)https?://[^\\s<>\\\"']+");
    private static final Pattern SECRET = Pattern.compile(
            "(?i)((?<![A-Za-z0-9_])[\\\"']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|"
                    + "auth[_-]?token|session[_-]?key|token|_t|code|state|nonce|"
                    + "password|secret|cookie|authorization|openid|unionid)[\\\"']?\\s*[:=]\\s*)"
                    + "(?:\\\"[^\\\"]*\\\"|'[^']*'|[^\\s,;&]+)"
    );
    private static final Pattern OPAQUE_VALUE = Pattern.compile(
            "\\b(?=[A-Za-z0-9_+/=]{32,}\\b)(?=[A-Za-z0-9_+/=]*[0-9])[A-Za-z0-9_+/=]+\\b"
    );

    private final File directory;
    private final int maxFileBytes;

    public DiagnosticLogStore(File directory, int maxFileBytes) {
        if (maxFileBytes < 1024) throw new IllegalArgumentException("Log capacity is too small");
        this.directory = directory;
        this.maxFileBytes = maxFileBytes;
    }

    public synchronized void append(String entry) throws IOException {
        Files.createDirectories(directory.toPath());
        File current = new File(directory, "native.log");
        byte[] bytes = boundedUtf8(sanitize(entry) + "\n", maxFileBytes);
        if (current.length() + bytes.length > maxFileBytes) {
            if (current.exists()) {
                Files.move(current.toPath(), new File(directory, "native.previous.log").toPath(),
                        StandardCopyOption.REPLACE_EXISTING);
            }
        }
        try (FileOutputStream output = new FileOutputStream(current, true)) {
            output.write(bytes);
        }
    }

    public synchronized void saveCrash(String entry) throws IOException {
        Files.createDirectories(directory.toPath());
        File temporary = new File(directory, "crash.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(boundedUtf8(sanitize(entry), 32 * 1024));
            output.getFD().sync();
        }
        Files.move(temporary.toPath(), new File(directory, "crash.pending.log").toPath(),
                StandardCopyOption.REPLACE_EXISTING);
    }

    public synchronized boolean acknowledgePreviousCrash() throws IOException {
        File pending = new File(directory, "crash.pending.log");
        if (!pending.isFile()) return false;
        Files.move(pending.toPath(), new File(directory, "crash.previous.log").toPath(),
                StandardCopyOption.REPLACE_EXISTING);
        return true;
    }

    public synchronized String snapshot() throws IOException {
        StringBuilder result = new StringBuilder("MaiScoreHub native diagnostics\n");
        for (String name : new String[]{
                "native.previous.log", "native.log", "crash.previous.log", "crash.pending.log"
        }) {
            File file = new File(directory, name);
            if (file.isFile()) {
                result.append("\n--- ").append(name).append(" ---\n");
                result.append(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            }
        }
        return result.toString();
    }

    public static String sanitize(String value) {
        String text = value == null ? "" : value;
        if (text.length() > 64 * 1024) text = text.substring(0, 64 * 1024) + " [truncated]";
        // Redact before truncating so a boundary cannot expose half of a credential.
        text = HEADERS.matcher(text).replaceAll("[redacted header]");
        text = URL.matcher(text).replaceAll("[url]");
        text = SECRET.matcher(text).replaceAll("$1[redacted]");
        text = text.replaceAll("(?i)\\bBearer\\s+[^\\s,;]+", "Bearer [redacted]");
        text = OPAQUE_VALUE.matcher(text).replaceAll("[opaque]");
        text = text.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "?");
        return text.length() <= MAX_ENTRY_CHARS
                ? text : text.substring(0, MAX_ENTRY_CHARS) + "\n[truncated]";
    }

    public static String describe(Throwable error) {
        StringBuilder result = new StringBuilder();
        Set<Throwable> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        int causes = 0;
        while (error != null && causes++ < 4 && visited.add(error)) {
            if (result.length() > 0) result.append("\nCaused by: ");
            result.append(error.getClass().getName()).append(": ")
                    .append(sanitize(error.getMessage()));
            StackTraceElement[] frames = error.getStackTrace();
            for (int index = 0; index < Math.min(frames.length, 24); index++) {
                result.append("\n  at ").append(frames[index]);
            }
            if (frames.length > 24) result.append("\n  [frames truncated]");
            error = error.getCause();
        }
        return sanitize(result.toString());
    }

    private static byte[] boundedUtf8(String text, int maxBytes) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= maxBytes) return bytes;
        int end = maxBytes;
        while (end > 0 && (bytes[end] & 0xc0) == 0x80) end--;
        return java.util.Arrays.copyOf(bytes, end);
    }
}
