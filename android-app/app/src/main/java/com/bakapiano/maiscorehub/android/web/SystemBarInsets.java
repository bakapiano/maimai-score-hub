package com.bakapiano.maiscorehub.android.web;

final class SystemBarInsets {
    private SystemBarInsets() { }

    static int contentBottom(int systemBarBottom, int imeBottom) {
        return Math.max(Math.max(0, systemBarBottom), Math.max(0, imeBottom));
    }
}
