package com.bakapiano.maiscorehub.android.web;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class SystemBarInsetsTest {
    @Test
    public void contentBottomUsesTheLargestVisibleObstruction() {
        assertEquals(132, SystemBarInsets.contentBottom(132, 0));
        assertEquals(980, SystemBarInsets.contentBottom(132, 980));
        assertEquals(0, SystemBarInsets.contentBottom(-1, -1));
    }
}
