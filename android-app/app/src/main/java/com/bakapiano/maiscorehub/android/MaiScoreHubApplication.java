package com.bakapiano.maiscorehub.android;

import android.app.Application;
import com.bakapiano.maiscorehub.android.diagnostics.NativeDiagnostics;

public final class MaiScoreHubApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        NativeDiagnostics.initialize(this);
    }
}
