package com.bakapiano.maiscorehub.android.web;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Base64;

public class WebImageSaverTest {
    private static final byte[] PNG = new byte[]{
            (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00
    };

    @Test
    public void decodesBoundedPngPayload() {
        String encoded = Base64.getEncoder().encodeToString(PNG);
        assertArrayEquals(PNG, WebImageSaver.decodeImage("image/png", encoded));
    }

    @Test
    public void rejectsPayloadWhoseSignatureDoesNotMatchMimeType() {
        String encoded = Base64.getEncoder().encodeToString(PNG);
        assertThrows(
                IllegalArgumentException.class,
                () -> WebImageSaver.decodeImage("image/jpeg", encoded)
        );
    }

    @Test
    public void normalizesMimeTypeAndSanitizesFileName() {
        assertEquals(
                "image/png",
                WebImageSaver.normalizeMimeType("IMAGE/PNG; charset=binary")
        );
        String fileName = WebImageSaver.sanitizeFileName("version/PRiSM:*?", "image/png");
        assertEquals("version_PRiSM___.png", fileName);
        assertTrue(fileName.endsWith(".png"));
    }
}
