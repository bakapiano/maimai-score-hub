package com.bakapiano.maiscorehub.android.vpn;

import java.util.function.BiConsumer;

/** Covers platform startup calls, before the asynchronous OAuth try/catch begins. */
public final class OAuthStartupGuard {
    private OAuthStartupGuard() { }

    public static boolean run(String stage, Runnable action, BiConsumer<String, Throwable> failed) {
        try {
            action.run();
            return true;
        } catch (RuntimeException | LinkageError error) {
            failed.accept(stage, error);
            return false;
        }
    }

    public static boolean start(
            Runnable promote,
            Runnable dispatch,
            BiConsumer<String, Throwable> failed
    ) {
        return run("foreground_start", promote, failed)
                && run("oauth_dispatch", dispatch, failed);
    }
}
