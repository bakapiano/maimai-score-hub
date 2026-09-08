package com.bakapiano.maiscorehub.android.tests;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;

import com.bakapiano.maiscorehub.android.MainActivity;
import com.bakapiano.maiscorehub.android.diagnostics.DiagnosticLogStore;
import com.bakapiano.maiscorehub.android.update.AppUpdateManager;
import com.bakapiano.maiscorehub.android.vpn.ProxyUpdateVpnService;
import com.bakapiano.maiscorehub.android.wechat.WechatWebViewLauncher;

import org.json.JSONObject;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import okhttp3.MediaType;
import okhttp3.ResponseBody;

/** Device-side smoke tests: isolated emulator, synthetic data, no WeChat login or server API calls. */
public final class NativeSmokeInstrumentation extends Instrumentation {
    private Bundle arguments;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments == null ? new Bundle() : arguments;
        start();
    }

    @Override
    public void onStart() {
        Bundle output = new Bundle();
        JSONObject result = new JSONObject();
        try {
            String scenario = arguments.getString("scenario", "compatibility");
            result.put("scenario", scenario).put("sdk", Build.VERSION.SDK_INT);
            if ("compatibility".equals(scenario)) {
                compatibility(result);
            } else if ("foreground-allowed".equals(scenario) || "foreground-denied".equals(scenario)) {
                foreground(result, "foreground-denied".equals(scenario));
            } else {
                throw new AssertionError("Unknown scenario: " + scenario);
            }
            result.put("passed", true);
            output.putString("result", result.toString());
            finish(Activity.RESULT_OK, output);
        } catch (Throwable error) {
            output.putString("failure", DiagnosticLogStore.describe(error));
            output.putString("result", result.toString());
            finish(Activity.RESULT_CANCELED, output);
        }
    }

    private void compatibility(JSONObject result) throws Exception {
        boolean platformOverloadPresent;
        try {
            URLDecoder.class.getMethod("decode", String.class, Charset.class);
            platformOverloadPresent = true;
        } catch (NoSuchMethodException expected) {
            platformOverloadPresent = false;
        }
        result.put("platformCharsetOverload", platformOverloadPresent);
        try {
            oldDecoderCall();
            result.put("oldCallLinkageError", false);
        } catch (NoSuchMethodError expected) {
            result.put("oldCallLinkageError", true);
        }

        String url = "https://open.weixin.qq.com/connect/oauth2/authorize?appid=wx-example"
                + "&redirect_uri=http%3A%2F%2Ftgk-wcaime.wahlap.com%2Fwc_auth%2Foauth%2Fcallback%2Fmaimai-dx"
                + "&response_type=code&state=emulator-only";
        Intent intent = WechatWebViewLauncher.createIntent(url);
        require("com.tencent.mm".equals(intent.getComponent().getPackageName()), "WeChat intent target");
        require(intent.getStringExtra("intent_params_b").contains("&amp;state=emulator-only"), "WeChat URL decoding/escaping");
        WechatWebViewLauncher.createIntent("http://10.77.0.2:12345/launch?nonce=emulator-only");
        result.put("wechatHandoff", true);

        Method readBody = AppUpdateManager.class.getDeclaredMethod("readBoundedUtf8", ResponseBody.class, int.class);
        readBody.setAccessible(true);
        String text = "{\"message\":\"诊断 ✓\"}";
        try (ResponseBody body = ResponseBody.create(MediaType.parse("application/json; charset=utf-8"), text)) {
            require(text.equals(readBody.invoke(null, body, 1024)), "Update response UTF-8 decoding");
        }
        result.put("updateUtf8", true);

        DiagnosticLogStore store = new DiagnosticLogStore(new File(getTargetContext().getCacheDir(), "native-smoke"), 4096);
        store.append("stage=probe requestId=emulator-test token=emulator-secret https://example.test/?code=private");
        store.saveCrash(DiagnosticLogStore.describe(new SecurityException("emulator probe")));
        require(store.acknowledgePreviousCrash(), "Crash snapshot acknowledgement");
        String snapshot = store.snapshot();
        require(snapshot.contains("SecurityException") && snapshot.contains("stage=probe"), "Persisted diagnostics");
        require(!snapshot.contains("emulator-secret") && !snapshot.contains("https://"), "Diagnostic redaction");
        result.put("diagnosticPersistence", true);
    }

    @SuppressLint("NewApi") // Deliberately probe the old call on the actual platform; report its result.
    private static void oldDecoderCall() {
        URLDecoder.decode("%E6%8E%88%E6%9D%83", StandardCharsets.UTF_8);
    }

    private void foreground(JSONObject result, boolean denied) throws Exception {
        MainActivity activity = (MainActivity) startActivitySync(
                new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Field resumed = MainActivity.class.getDeclaredField("activityResumed");
        Field webViewField = MainActivity.class.getDeclaredField("webView");
        Field statusField = MainActivity.class.getDeclaredField("lastOAuthStatus");
        Method begin = MainActivity.class.getDeclaredMethod("beginOAuth", String.class);
        resumed.setAccessible(true);
        webViewField.setAccessible(true);
        statusField.setAccessible(true);
        begin.setAccessible(true);
        waitFor(() -> onUi(() -> {
            WebView view = (WebView) webViewField.get(activity);
            return resumed.getBoolean(activity) && view.getProgress() == 100
                    && view.getUrl() != null && view.getUrl().startsWith("http://localhost:19310/")
                    && "Native emulator diagnostics".equals(view.getTitle());
        }), "Fixture page resumed", 30_000);
        String requestId = UUID.randomUUID().toString();
        onUi(() -> { begin.invoke(activity, requestId); return true; });
        waitFor(() -> onUi(() -> {
            JSONObject status = (JSONObject) statusField.get(activity);
            return status != null && requestId.equals(status.optString("requestId"))
                    && status.optBoolean("terminal");
        }), "Terminal native OAuth status", 25_000);
        CountDownLatch delivered = new CountDownLatch(1);
        AtomicReference<String> webResult = new AtomicReference<>();
        onUi(() -> {
            WebView view = (WebView) webViewField.get(activity);
            view.evaluateJavascript("(function(){try{var s=JSON.parse(document.getElementById('status').textContent);"
                    + "return s.requestId==='" + requestId + "'&&s.terminal===true&&s.success===false;"
                    + "}catch(e){return false;}})()", value -> {
                webResult.set(value);
                delivered.countDown();
            });
            return true;
        });
        require(delivered.await(5, TimeUnit.SECONDS) && "true".equals(webResult.get()),
                "WebView received the matching terminal failure event");
        waitFor(() -> !ProxyUpdateVpnService.isRunning(), "Service ownership released", 5000);
        String logStage = denied ? "ERROR stage=" : "ERROR stage=preflight";
        File logFile = new File(getTargetContext().getFilesDir(), "diagnostics/native.log");
        waitFor(() -> {
            try {
                String text = new String(Files.readAllBytes(logFile.toPath()), StandardCharsets.UTF_8);
                return text.contains(requestId) && text.contains(logStage);
            } catch (Exception error) { return false; }
        }, "Failure persisted", 5000);
        String log = new String(Files.readAllBytes(logFile.toPath()), StandardCharsets.UTF_8);
        if (denied) {
            require(log.contains("ERROR stage=service_start") || log.contains("ERROR stage=foreground_start"),
                    "AppOps denial reached the startup guard");
        } else {
            require(log.contains("stage=foreground_started"), "Foreground promotion succeeded");
            require(log.contains("ERROR stage=preflight"), "Missing WeChat reported as a normal failure");
        }
        // Leave enough time for an incorrectly retained foreground-start deadline to fire.
        SystemClock.sleep(12_000);
        require(!ProxyUpdateVpnService.isRunning(), "Service remains idle after startup deadline");
        result.put("terminalFailure", true).put("webStatusDelivered", true)
                .put("serviceIdle", true).put("failurePersisted", true);
    }

    private boolean onUi(CheckedBoolean operation) {
        AtomicReference<Boolean> value = new AtomicReference<>(false);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> {
            try { value.set(operation.get()); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
        return value.get();
    }

    private static void waitFor(BooleanSupplier condition, String description, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition.getAsBoolean()) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("Timed out: " + description);
    }

    private static void require(boolean condition, String description) {
        if (!condition) throw new AssertionError(description);
    }

    private interface CheckedBoolean { boolean get() throws Exception; }
}
