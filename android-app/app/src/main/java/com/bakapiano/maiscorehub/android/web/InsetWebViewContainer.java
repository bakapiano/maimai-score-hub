package com.bakapiano.maiscorehub.android.web;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Edge-to-edge root that keeps the entire WebView clear of system bars,
 * display cutouts and the on-screen keyboard.
 */
public final class InsetWebViewContainer extends FrameLayout {
    private static final int STATUS_BAR_COLOR = Color.rgb(34, 139, 230);

    private final WebView webView;
    private final View statusBarScrim;
    private final View navigationBarScrim;

    public InsetWebViewContainer(Activity activity) {
        super(activity);
        setBackgroundColor(Color.WHITE);

        webView = new WebView(activity);
        addView(
                webView,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                )
        );

        statusBarScrim = new View(activity);
        statusBarScrim.setBackgroundColor(STATUS_BAR_COLOR);
        addView(statusBarScrim, scrimLayoutParams(Gravity.TOP));

        navigationBarScrim = new View(activity);
        navigationBarScrim.setBackgroundColor(Color.WHITE);
        addView(navigationBarScrim, scrimLayoutParams(Gravity.BOTTOM));

        WindowCompat.setDecorFitsSystemWindows(activity.getWindow(), false);
        activity.getWindow().setStatusBarColor(Color.TRANSPARENT);
        activity.getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            activity.getWindow().setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
                activity.getWindow(),
                this
        );
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(true);

        ViewCompat.setOnApplyWindowInsetsListener(this, (view, windowInsets) -> {
            Insets safe = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            applyWebViewMargins(
                    safe.left,
                    safe.top,
                    safe.right,
                    SystemBarInsets.contentBottom(safe.bottom, ime.bottom)
            );
            setScrimHeight(statusBarScrim, safe.top, Gravity.TOP);
            setScrimHeight(navigationBarScrim, safe.bottom, Gravity.BOTTOM);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    public WebView getWebView() {
        return webView;
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        ViewCompat.requestApplyInsets(this);
    }

    private void applyWebViewMargins(int left, int top, int right, int bottom) {
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) webView.getLayoutParams();
        if (params.leftMargin == left
                && params.topMargin == top
                && params.rightMargin == right
                && params.bottomMargin == bottom) {
            return;
        }
        params.setMargins(left, top, right, bottom);
        webView.setLayoutParams(params);
    }

    private static FrameLayout.LayoutParams scrimLayoutParams(int gravity) {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0
        );
        params.gravity = gravity;
        return params;
    }

    private static void setScrimHeight(View scrim, int height, int gravity) {
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) scrim.getLayoutParams();
        if (params.height == height && params.gravity == gravity) {
            return;
        }
        params.height = Math.max(0, height);
        params.gravity = gravity;
        scrim.setLayoutParams(params);
        scrim.setVisibility(height > 0 ? View.VISIBLE : View.GONE);
    }
}
