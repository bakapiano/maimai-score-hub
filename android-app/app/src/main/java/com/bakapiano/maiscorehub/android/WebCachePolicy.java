package com.bakapiano.maiscorehub.android;

/** Decides when an app upgrade needs a fresh copy of the hosted frontend. */
public final class WebCachePolicy {
    private WebCachePolicy() {}

    public static boolean shouldRefresh(int cachedVersionCode, int currentVersionCode) {
        return currentVersionCode > 0 && cachedVersionCode != currentVersionCode;
    }
}
