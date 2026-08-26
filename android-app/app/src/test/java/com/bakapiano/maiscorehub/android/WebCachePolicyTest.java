package com.bakapiano.maiscorehub.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WebCachePolicyTest {
    @Test
    public void refreshesOnFirstLaunchAndUpgrade() {
        assertTrue(WebCachePolicy.shouldRefresh(0, 6));
        assertTrue(WebCachePolicy.shouldRefresh(5, 6));
    }

    @Test
    public void keepsCacheForCurrentVersion() {
        assertFalse(WebCachePolicy.shouldRefresh(6, 6));
    }

    @Test
    public void rejectsInvalidCurrentVersion() {
        assertFalse(WebCachePolicy.shouldRefresh(0, 0));
    }
}
