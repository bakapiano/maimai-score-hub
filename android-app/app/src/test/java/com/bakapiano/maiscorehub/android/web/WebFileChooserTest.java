package com.bakapiano.maiscorehub.android.web;

import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public final class WebFileChooserTest {
    @Test
    public void defaultsToImagesAndNormalizesExtensions() {
        assertArrayEquals(
                new String[]{"image/*"},
                WebFileChooser.normalizeImageAcceptTypes(null)
        );
        assertArrayEquals(
                new String[]{"image/jpeg", "image/png", "image/webp"},
                WebFileChooser.normalizeImageAcceptTypes(
                        new String[]{".jpg,image/png", "image/webp", "text/plain"}
                )
        );
    }
}
