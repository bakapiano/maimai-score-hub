package com.bakapiano.maiscorehub.android.web;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public final class SystemBarStyleTest {
    @Test
    public void acceptsOpaqueSixDigitHexColors() {
        assertEquals(
                Integer.valueOf(0xFFF8F9FA),
                SystemBarStyle.parseOpaqueHexColor("#f8f9fa")
        );
        assertEquals(
                Integer.valueOf(0xFF1A1B1E),
                SystemBarStyle.parseOpaqueHexColor("#1A1B1E")
        );
    }

    @Test
    public void rejectsNonOpaqueOrMalformedColors() {
        assertNull(SystemBarStyle.parseOpaqueHexColor(null));
        assertNull(SystemBarStyle.parseOpaqueHexColor("#fff"));
        assertNull(SystemBarStyle.parseOpaqueHexColor("#80ffffff"));
        assertNull(SystemBarStyle.parseOpaqueHexColor("rgb(255, 255, 255)"));
    }
}
