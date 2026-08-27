package com.bakapiano.maiscorehub.android.web;

/** Strict parser for website-supplied opaque system-bar colors. */
final class SystemBarStyle {
    private SystemBarStyle() { }

    static Integer parseOpaqueHexColor(String value) {
        if (value == null || !value.matches("^#[0-9A-Fa-f]{6}$")) {
            return null;
        }
        return 0xFF000000 | Integer.parseInt(value.substring(1), 16);
    }
}
