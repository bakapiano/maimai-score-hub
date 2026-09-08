package com.bakapiano.maiscorehub.android.vpn;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.Test;

public final class OAuthStartupGuardTest {
    @Test
    public void startsForegroundBeforeDispatchingOAuth() {
        List<String> stages = new ArrayList<>();
        assertTrue(OAuthStartupGuard.start(
                () -> stages.add("foreground"), () -> stages.add("oauth"),
                (stage, error) -> fail(stage)
        ));
        assertEquals(Arrays.asList("foreground", "oauth"), stages);
    }

    @Test
    public void foregroundDenialReportsOnceAndLeavesExecutorIdle() {
        List<String> failures = new ArrayList<>();
        AtomicBoolean running = new AtomicBoolean(true);
        assertFalse(OAuthStartupGuard.start(
                () -> { throw new SecurityException("foreground denied"); },
                () -> fail("OAuth must start after foreground promotion"),
                (stage, error) -> {
                    failures.add(stage);
                    assertTrue(error instanceof SecurityException);
                    running.set(false);
                }
        ));
        assertEquals(Arrays.asList("foreground_start"), failures);
        assertFalse(running.get());
    }

    @Test
    public void executorRejectionReportsDispatchFailure() {
        List<String> failures = new ArrayList<>();
        assertFalse(OAuthStartupGuard.start(
                () -> { }, () -> { throw new RejectedExecutionException(); },
                (stage, error) -> failures.add(stage)
        ));
        assertEquals(Arrays.asList("oauth_dispatch"), failures);
    }

    @Test
    public void capturesPlatformStartAndCompatibilityExceptions() {
        for (Throwable failure : new Throwable[]{new IllegalStateException(), new NoSuchMethodError()}) {
            List<Throwable> received = new ArrayList<>();
            assertFalse(OAuthStartupGuard.run("service_start", () -> {
                if (failure instanceof RuntimeException) throw (RuntimeException) failure;
                throw (LinkageError) failure;
            }, (stage, error) -> received.add(error)));
            assertEquals(Arrays.asList(failure), received);
        }
    }

    @Test
    public void vmErrorsRemainFatal() {
        assertThrows(OutOfMemoryError.class, () -> OAuthStartupGuard.run("service_start",
                () -> { throw new OutOfMemoryError(); }, (stage, error) -> fail(stage)));
    }
}
