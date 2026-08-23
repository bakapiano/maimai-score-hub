# WeChat 8.0.68 WebView launch handoff

Validated on WeChat `8.0.68` (`versionCode=3003`) and OnePlus device
`b223378f` on 2026-08-22.

## Working path

`com.tencent.mm.ui.LauncherUI` is exported. Its `handleJump(Intent)` tail reads
an XML value from:

```text
intent_params_ + bw4.b.class.getSimpleName()
```

For this build the resulting key is `intent_params_b`. `bw4.b` serializes the
three fields `activity`, `extra_key`, and `extra` under `start_ui_params`.
LauncherUI creates an explicit internal Intent from those values. The tested
payload is:

```xml
<start_ui_params>
  <activity>com.tencent.mm.plugin.webview.ui.tools.WebViewUI</activity>
  <extra_key>rawUrl</extra_key>
  <extra>http://10.77.0.2:PORT/launch?nonce=NONCE</extra>
</start_ui_params>
```

This opens the URL in WeChat's authenticated WebView without OpenSDK app-id
registration, a share sheet, ADB, AccessibilityService, or a user-installed CA.
The app implementation accepts only its own `10.77.0.2` `/launch` URL before
constructing the payload.

## Other verified paths

- `weixin://dl/businessWebview/link` reaches WeChat's server-side translate
  check and resolves to `deeplink/noaccess` for an unregistered caller.
- `WXCommProvider` `openWebview`, `getA8Key`, and `handleScanResult` bind the
  supplied app id to the calling Android package and signature.
- `NfcDeepLinkUI` changes the internal launch scene, while business WebView
  URLs still pass through the same server-side check.
- `com.tencent.mm.action.BIZSHORTCUT` accepts a plaintext contact username and
  can open `filehelper` directly. It remains a useful one-tap fallback.
- The system-share `/checksystemshare` path normally continues to the contact
  picker; its optional server-provided error URL is not caller-controlled.

The handoff is an undocumented implementation detail. Re-test the manifest,
`LauncherUI.handleJump`, the serialized class name, and the XML field names
when the installed WeChat version changes.
