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
  ├─ Android photo picker + WebAuthn platform adapters
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

### Backend responsibilities

- Publish a no-cache Manifest and immutable versioned ESM bundle.
- Keep Workflow/Bridge API versions explicit.
- Serve the Parser, DXNET request sequence and upload logic as one self-contained
  JavaScript module.
- Validate and merge uploaded score batches through the normal authenticated API.
- Own release channels, package policies, dynamic download Host allowlists,
  deterministic rollout and immutable signed APK storage.

## Native bridge v2

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
The score Workflow currently declares minimum Bridge v1 because Bridge v2 is a
backward-compatible superset; application-release UI independently requires v2.

## Security boundary

- The WebView bridge is active only on `localhost`, `127.0.0.1` and the two
  Score Hub production hosts.
- DXNET transport uses a fixed `https://maimai.wahlap.com/maimai-mobile` base.
- Native request paths are relative and traversal-safe.
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

Stable builds use the dedicated production key and package
`com.bakapiano.maiscorehub.android`. The key is independent from both Debug and
Beta; every future stable update must retain it. The production workflow checks
the package, version, pinned certificate digest and APK signature before it can
publish to the Backend registry and GitHub Releases:

```bash
gh workflow run build-android-release.yml --ref main \
  -f publish=false -f version_code=4 -f version_name=0.2.2 \
  -f mandatory=false -f rollout_percent=100

gh workflow run build-android-release.yml --ref main \
  -f publish=true -f version_code=4 -f version_name=0.2.2 \
  -f mandatory=false -f rollout_percent=100 \
  -f notes='微信一键登录、代理更新与应用内更新。'
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

## Local device

Start the root local stack, connect the device and expose the website/API:

```powershell
npm run dev:local:start
adb reverse tcp:3001 tcp:3001
adb reverse tcp:9050 tcp:9050
adb install -r app\build\outputs\apk\debug\MaiScoreHub-debug.apk
```

Debug loads `http://localhost:3001/app/sync`; release loads the production site.

## Real-device E2E

The harness builds on the same WebView Workflow path used by users. It runs
quick login, recent and full updates, captures phone/log artifacts and verifies
Mongo score version/count/source changes:

```powershell
.\scripts\run-real-device-e2e.ps1 -NotBefore (Get-Date)
```

Artifacts are written under `app/build/real-device-e2e/`.

The application-update harness builds two Debug APK versions, publishes the
target through the local Backend, installs the baseline and automates Android
plus OnePlus installation confirmation:

```powershell
.\scripts\run-app-update-e2e.ps1
```

Artifacts are written under `app/build/app-update-e2e/`.
