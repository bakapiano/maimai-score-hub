# MaiScoreHub Android

MaiScoreHub Android is a thin WebView shell for the maimai Score Hub website.
The APK owns Android-only transport capabilities; Backend-distributed JavaScript
owns login/update orchestration, DXNET page parsing, Score Hub uploads and UI
progress.

## Architecture

```text
Backend
  ├─ GET /api/v1/android/workflow/manifest
  ├─ GET /api/v1/android/workflow/:version.js
  ├─ GET /api/v1/android/app/releases/latest
  └─ GET /api/v1/android/app/releases/:releaseId/{manifest,apk}
                    │ version + SHA-256
                    ▼
Score Hub WebView ── dynamic Workflow JS
  ├─ update/login orchestration
  ├─ DXNET request paths and form payloads
  ├─ DOM Parser and catalog mapping
  ├─ Score Hub upload batching/retry
  └─ progress/result UI
                    │ capability calls
                    ▼
MaiScoreHub APK
  ├─ trusted-host WebView
  ├─ Android photo picker, image saver + WebAuthn platform adapters
  ├─ OAuth callback VPN Service
  ├─ native DXNET CookieJar
  ├─ constrained GET/POST bridge
  └─ signed APK verifier + PackageInstaller adapter
                    │ cookies attached natively
                    ▼
maimai.wahlap.com
```

### APK responsibilities

- Load the Score Hub website in an Android WebView.
- Open image inputs directly in Android's privacy-preserving photo picker.
- Save website-generated PNG/JPEG/WebP exports through Android MediaStore.
- Enable Credential Manager WebAuthn for website-key registration and login.
- Launch WeChat OAuth through a temporary, callback-only VPN.
- Exchange the captured OAuth callback and keep DXNET cookies in memory.
- Restore the Score Hub WebView to the foreground after OAuth so JavaScript
  timers, polling and progress continue immediately.
- Execute constrained cookie-bearing GET/POST requests for dynamic Workflow JS.
- Return response status, final URL and HTML through asynchronous WebView events.
- Download a Backend-authorized APK, verify its signed Manifest, hash, package,
  version and signing certificate, then hand it to Android's PackageInstaller.

### Website responsibilities

- Download and SHA-256 verify the Backend Workflow bundle.
- Run quick login, recent update and full update flows.
- Render status, stage and numeric progress.
- Hold the Score Hub login token and call Score Hub APIs.
- Persist successful login tokens and refresh website data.
- Render the application-update card, release notes, permission prompts and
  download/install progress.
- Check application releases in the background and mark the Settings
  navigation item when a newer version is available.

### Backend responsibilities

- Publish a no-cache Manifest and immutable versioned ESM bundle.
- Keep Workflow/Bridge API versions explicit.
- Serve the Parser, DXNET request sequence and upload logic as one self-contained
  JavaScript module.
- Validate and merge uploaded score batches through the normal authenticated API.
- Own release channels, package policies, dynamic download Host allowlists,
  deterministic rollout and immutable signed APK storage.

## Native bridge v3

The website receives `window.MaiScoreHubAndroid`:

```ts
interface MaiScoreHubAndroid {
  isAvailable(): boolean;
  getVersion(): string;
  getBridgeApiVersion(): number;
  getVersionCode(): number;
  getPackageName(): string;
  getReleaseChannel(): "debug" | "beta" | "stable";
  isAppUpdateRunning(): boolean;
  startAppUpdate(requestId: string, releaseId: string): void;
  saveImage(
    requestId: string,
    fileName: string,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
    encodedImage: string
  ): void;
  isOAuthRunning(): boolean;
  startOAuth(requestId: string): void;
  dxnetRequest(requestId: string, requestJson: string): void;
}
```

Application-update progress is dispatched as
`msh-android-app-update-status`. The website supplies only an immutable
`releaseId`; Native fetches the signed Manifest again from its compile-time
Score Hub API origin.

## Signed application releases

The Pipeline signs the exact UTF-8 Manifest bytes with the same RSA private key
that signs the APK. Backend verifies the signature against the channel policy,
stores the immutable APK, and publishes metadata for the website. Native uses
the currently installed app certificate's public key and additionally verifies:

- release channel, package name and increasing versionCode;
- HTTPS download origin (localhost HTTP is enabled only in Debug);
- APK byte length and SHA-256;
- archive package/version and certificate SHA-256.

Ordinary devices retain Android's unknown-source permission and user install
confirmation screens. Beta publication uses `build-android-beta.yml`; stable
publication uses the manual-only `build-android-release.yml`. Both require the
explicit `publish=true` input.

The permanent public download address for the newest Stable release is:

```text
https://api.maiscorehub.bakapiano.com/api/v1/android/app/releases/stable/apk
```

It returns a no-cache redirect to the newest immutable signed APK URL, allowing
documentation and QR codes to remain unchanged across releases.

OAuth results are dispatched as `msh-android-oauth-status`:

```json
{
  "requestId": "uuid",
  "message": "微信授权完成，DXNET 会话已建立",
  "terminal": true,
  "success": true
}
```

HTTP results are dispatched as `msh-android-http-result`:

```json
{
  "requestId": "uuid",
  "success": true,
  "status": 200,
  "url": "https://maimai.wahlap.com/maimai-mobile/record/",
  "body": "<html>...</html>"
}
```

Image-save results are dispatched as `msh-android-image-save-status`:

```json
{
  "requestId": "uuid",
  "message": "图片已保存到相册的 MaiScoreHub 文件夹",
  "terminal": true,
  "success": true,
  "uri": "content://media/external/images/media/123"
}
```

The website transfers only bounded PNG/JPEG/WebP bytes from a trusted page.
Android 10 and newer save them under `Pictures/MaiScoreHub` through MediaStore;
Android 8 and 9 use the system document-save picker. These paths use scoped
storage and do not request broad photo-library access.

Request JSON uses a relative DXNET path:

```json
{
  "method": "POST",
  "path": "/friend/search/invite/",
  "form": { "idx": "123456789012345", "invite": "" },
  "attachCsrfToken": true
}
```

The native bridge accepts relative `/maimai-mobile` requests through the fixed
Wahlap origin, GET/POST methods, bounded form data and responses up to 4 MB.
Cookies and CSRF token values remain inside the native CookieJar.

## Dynamic Workflow contract

Manifest example:

```json
{
  "workflowVersion": "2026.08.24.1",
  "workflowApiVersion": 1,
  "bridgeApiVersion": 1,
  "entry": "/android/workflow/2026.08.24.1.js",
  "sha256": "...",
  "bytes": 32000
}
```

The bundle exports:

```js
export const workflowMetadata = {
  workflowVersion: "2026.08.24.1",
  workflowApiVersion: 1,
  bridgeApiVersion: 1,
  parserVersion: "webview-2026.08.24.1"
};

export async function run(context) {
  // context.mode: login | recent | full
}
```

The WebView host injects these capabilities:

- `startOAuth()`
- `dxnetRequest(request)`
- `scoreHubRequest(request)`
- `report(status)`
- `sleep(milliseconds)`

Changing five-difficulty requests to genre/category requests, updating selectors,
changing batch sizes or revising upload payloads requires a new Workflow version
and Backend deployment. The APK bridge version changes only when a new native
capability is required.
The score Workflow currently declares minimum Bridge v1 because Bridge v3
retains the v1 transport surface. Application-release UI independently requires
v2, while native image export is feature-detected and requires v3.

## Security boundary

- The WebView bridge is active only on `localhost`, `127.0.0.1` and the two
  Score Hub production hosts.
- DXNET transport uses a fixed `https://maimai.wahlap.com/maimai-mobile` base.
- Native request paths are relative and traversal-safe.
- Native image saves accept bounded Base64, safe filenames and verified image
  signatures from trusted Score Hub pages only.
- Native code owns cookies and injects the `_t` form token on request.
- The website verifies bundle length and SHA-256 before importing it.
- Versioned bundles are immutable and the Manifest is fetched with `no-store`.
- OAuth broadcast events require the app's signature-level internal permission.
- App-release Manifests use the installed APK certificate as their trust root;
  Backend Host policies remain dynamically configurable without accepting an
  unsigned URL from website JavaScript.
- WebAuthn relies on `frontend/public/.well-known/assetlinks.json`; every
  distributed APK signing certificate must be listed there before release.

## Build

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
$env:GRADLE_USER_HOME = 'D:\Android\gradle-user-home'
.\gradlew.bat testDebugUnitTest assembleDebug assembleRelease
```

Installable Beta builds use the independent package
`com.bakapiano.maiscorehub.android.beta`, the label `MaiScoreHub Beta`, and the
production website:

```powershell
.\gradlew.bat assembleBeta
adb install -r app\build\outputs\apk\beta\MaiScoreHub-beta.apk
```

Local Beta builds fall back to the Android debug key; CI artifacts use the
dedicated Beta signing key. Both can coexist with the production-signed
`com.bakapiano.maiscorehub.android` package.

Manual native-adapter checks can use the local-only Device Test variant. It
loads the local website/API like Debug and uses the independent package
`com.bakapiano.maiscorehub.android.devicetest`, so it can coexist with Stable
and Beta:

```powershell
.\gradlew.bat testDeviceTestUnitTest assembleDeviceTest
adb install -r app\build\outputs\apk\deviceTest\MaiScoreHub-deviceTest.apk
```

Stable builds use the dedicated production key and package
`com.bakapiano.maiscorehub.android`. The key is independent from both Debug and
Beta; every future stable update must retain it. The production workflow checks
the package, version, pinned certificate digest and APK signature before it can
publish to the Backend registry and GitHub Releases:

```bash
gh workflow run build-android-release.yml --ref main \
  -f publish=false -f version_code=5 -f version_name=0.3.0 \
  -f mandatory=false -f rollout_percent=100

gh workflow run build-android-release.yml --ref main \
  -f publish=true -f version_code=5 -f version_name=0.3.0 \
  -f mandatory=false -f rollout_percent=100 \
  -f notes='修复了图片导出'
```

`publish=true` writes the stable channel policy, immutable Manifest/APK and a
matching GitHub Release. The public Backend download URL is the APK URL carried
by the signed Manifest.

CI uses the dedicated Beta key stored in GitHub Actions Secrets and publishes
`MaiScoreHub-beta` as a workflow artifact. After downloading the artifact, run
the production E2E against a connected phone:

```powershell
.\scripts\run-online-beta-e2e.ps1 -ApkPath <downloaded-MaiScoreHub-beta.apk>
```

Artifacts:

```text
app/build/outputs/apk/debug/MaiScoreHub-debug.apk
app/build/outputs/apk/release/MaiScoreHub-release.apk
```

The launcher name is `MaiScoreHub`; the launcher icon is copied from
`frontend/public/pwa-512x512.png`.

## ADB real-device connection and testing

### 1. Prepare the phone and ADB

Enable **Developer options** and **USB debugging** on the phone. Connect USB,
unlock the screen and accept the phone's RSA debugging prompt. Use the SDK ADB
binary explicitly so every command uses the same server:

```powershell
$AdbPath = 'D:\Android\Sdk\platform-tools\adb.exe'
& $AdbPath version
& $AdbPath kill-server
& $AdbPath start-server
& $AdbPath devices -l
```

The ready state is `<serial> device ...`. For `unauthorized`, keep the phone
unlocked and accept the RSA prompt. For `offline`, reconnect USB and run:

```powershell
& $AdbPath reconnect
& $AdbPath devices -l
```

Store the exact serial reported by `devices -l`; use `-s` on every manual
command when multiple phones or emulators are visible:

```powershell
$DeviceSerial = '<adb-serial>'
& $AdbPath -s $DeviceSerial get-state
& $AdbPath -s $DeviceSerial shell getprop ro.product.model
```

### 2. Optional wireless debugging

Android 11 and newer can pair over the same LAN. On the phone, open
**Developer options → Wireless debugging → Pair device with pairing code**.
The pairing port and connection port shown by Android can differ:

```powershell
& $AdbPath pair '<phone-ip>:<pair-port>'
& $AdbPath connect '<phone-ip>:<connection-port>'
& $AdbPath devices -l
$DeviceSerial = '<phone-ip>:<connection-port>'
```

### 3. Start the local website/API and build Device Test

From the repository root, start the local stack. Then build the co-installable
APK from `android-app/` with JDK 17. Use Debug for the full E2E harness below:

```powershell
npm run dev:local:start

cd android-app
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
$env:GRADLE_USER_HOME = 'D:\Android\gradle-user-home'
.\gradlew.bat testDeviceTestUnitTest assembleDeviceTest
```

Confirm the two local endpoints before installing:

```powershell
Invoke-RestMethod http://127.0.0.1:9050/api/v1/health
Invoke-WebRequest http://127.0.0.1:3001/app/sync -UseBasicParsing
```

### 4. Expose localhost, install and launch

Device Test loads `http://localhost:3001/app/sync`; `adb reverse` maps that address
and the local API back to the Windows host:

```powershell
& $AdbPath -s $DeviceSerial reverse tcp:3001 tcp:3001
& $AdbPath -s $DeviceSerial reverse tcp:9050 tcp:9050
& $AdbPath -s $DeviceSerial reverse --list

& $AdbPath -s $DeviceSerial install -r `
  app\build\outputs\apk\deviceTest\MaiScoreHub-deviceTest.apk
& $AdbPath -s $DeviceSerial shell am force-stop `
  com.bakapiano.maiscorehub.android.devicetest
& $AdbPath -s $DeviceSerial shell am start -n `
  com.bakapiano.maiscorehub.android.devicetest/com.bakapiano.maiscorehub.android.MainActivity
```

The full-E2E Debug variant and Stable use the same package with different signing certificates. A
dedicated test device keeps this flow repeatable. When Android reports
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, intentionally clearing the installed app
before switching certificates also clears its WebView login data:

```powershell
& $AdbPath -s $DeviceSerial uninstall com.bakapiano.maiscorehub.android
```

Beta uses `com.bakapiano.maiscorehub.android.beta` and can coexist with Stable.

### 5. Inspect logs and mirror the screen

Clear logs immediately before a test, then filter the native/WebView tags:

```powershell
& $AdbPath -s $DeviceSerial logcat -c
& $AdbPath -s $DeviceSerial logcat -v time `
  -s MshWebView:I MshOAuthVpn:I MshHttpProxy:I MshDxnetTransport:I '*:S'
```

For interactive testing, select the device with scrcpy's `-s` flag. Display
size uses a named option:

```powershell
scrcpy -s $DeviceSerial --max-size 1080
```

For the image-export acceptance check, open the B50 page, tap **导出图片** and
wait for the native saved confirmation. Then inspect or pull the generated PNG:

```powershell
& $AdbPath -s $DeviceSerial shell ls -lt /sdcard/Pictures/MaiScoreHub
& $AdbPath -s $DeviceSerial pull `
  /sdcard/Pictures/MaiScoreHub `
  app\build\real-device-e2e\exported-images
```

### 6. Run the real-device E2E

The harness uses the same Backend-fetched Workflow path as production. It
installs Debug, restores both reverse ports, runs quick login plus recent/full
updates, captures phone/log artifacts and verifies Mongo persistence:

```powershell
.\scripts\run-real-device-e2e.ps1 `
  -DeviceSerial $DeviceSerial `
  -AdbPath $AdbPath `
  -NotBefore (Get-Date) `
  -OAuthPath direct
```

Use `-OAuthPath manual` to exercise the copied local-HTTP fallback. Artifacts
and terminal status are written under `app/build/real-device-e2e/`.

After USB reconnects, phone reboots or ADB server restarts, verify the device
and reapply the two `adb reverse` mappings before another manual run.

The application-update harness builds two Debug APK versions, publishes the
target through the local Backend, installs the baseline and automates Android
plus OnePlus installation confirmation:

```powershell
.\scripts\run-app-update-e2e.ps1
```

Artifacts are written under `app/build/app-update-e2e/`.
