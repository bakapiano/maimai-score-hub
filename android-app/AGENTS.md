# MaiScoreHub Android agent instructions

These instructions apply to the entire `android-app/` tree.

## Architectural invariant

MaiScoreHub is a thin native shell. Java owns only:

1. trusted-host WebView lifecycle and Android platform adapters for the photo
   picker and Credential Manager WebAuthn;
2. temporary VPN capture for WeChat OAuth callbacks;
3. in-memory DXNET CookieJar and constrained cookie-bearing GET/POST transport;
4. asynchronous events between native code and website JavaScript;
5. restoring the WebView task after OAuth so background timer throttling cannot
   stall the distributed Workflow.
6. downloading Backend-registered application releases, verifying the signed
   Manifest/APK and invoking Android's user-confirmed PackageInstaller flow.

Update/login orchestration, DXNET paths and payloads, Parser rules, catalog
mapping, Score Hub uploads, retry policy and progress belong to the Backend-
distributed Workflow ESM under:

```text
backend/src/modules/android-workflow/workflows/
```

Website host/runtime code belongs under:

```text
frontend/src/features/android-update/
```

Java source must stay free of score parsing, fixed difficulty/category loops,
Score Hub API clients and score upload logic.

## Bridge contract

Bridge API v2 retains the v1 surface and adds `getVersionCode`,
`getPackageName`, `getReleaseChannel`, `isAppUpdateRunning` and
`startAppUpdate(requestId, releaseId)`.

Increment `BRIDGE_API_VERSION` only when the native capability contract changes.
Set the new minimum in the Workflow Manifest. Preserve request IDs and terminal
events so website Promises always settle.

## Transport safety

- Keep the native DXNET origin fixed to Wahlap HTTPS.
- Accept relative paths with traversal checks.
- Keep cookies and `_t` values inside `DxnetTransport`.
- Bound request JSON, form-field count, response size and timeouts.
- Keep JavaScript interfaces active only for trusted Score Hub hosts.
- Keep OAuth broadcasts signature-protected and app-local.
- Log summaries and stages; keep callback query values and cookies out of logs.
- Accept only an immutable release ID from JavaScript. Fetch the release
  envelope from the compile-time Score Hub API origin and verify the Manifest
  with the currently installed app certificate before downloading its APK.
- Verify APK length, SHA-256, package, increasing versionCode and signing
  certificate before committing a PackageInstaller session.

## Application releases

- Backend owns channel policies, package names, certificate digests, dynamic
  download Host lists, rollout and immutable APK storage.
- `build-android-beta.yml` signs the Manifest with the Beta APK key. Production
  publication uses the separate `build-android-release.yml`, stable package and
  production signing key. Both publication paths require an explicit
  `workflow_dispatch` input.
- Keep `android-releases/` runtime files out of Git and preserve the host bind
  mount during Backend deployments.
- Use `scripts/run-app-update-e2e.ps1` for a real baseline-to-target upgrade;
  it must restore Drony and the legacy updater after the test.

## Workflow releases

- Every behavioral change gets a new immutable Workflow version/file.
- Update the current version in `AndroidWorkflowService`.
- Keep `workflowApiVersion`, `bridgeApiVersion`, entry path, byte length and
  SHA-256 aligned.
- Keep bundles self-contained because the WebView imports a verified Blob URL.
- Route all Score Hub calls through the host-provided `scoreHubRequest`.
- Report stage, numeric progress and user-facing message throughout each flow.

## Branding

- Project, launcher and APK artifact name: `MaiScoreHub`.
- Controlled Beta artifacts use `MaiScoreHub Beta` and the independent
  `com.bakapiano.maiscorehub.android.beta` application ID.
- Website icon source: `frontend/public/pwa-512x512.png`.
- Android copy: `app/src/main/res/drawable-nodpi/maiscorehub_icon.png`.

## Required verification

After native or Workflow changes:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
$env:GRADLE_USER_HOME = 'D:\Android\gradle-user-home'
.\gradlew.bat testDebugUnitTest testBetaUnitTest assembleDebug assembleBeta

npm --prefix ..\backend run typecheck
npm --prefix ..\backend test -- --runInBand android-workflow
npm --prefix ..\frontend test
npm --prefix ..\frontend run typecheck
npm --prefix ..\frontend run lint:check
npm --prefix ..\frontend run build
```

For completion, install `MaiScoreHub-debug.apk`, restore ADB reverse ports and run:

```powershell
.\scripts\run-real-device-e2e.ps1 -NotBefore (Get-Date)
```

The E2E must exercise dynamic quick login, Backend-fetched Workflow JavaScript,
native OAuth, native cookie transport, WebView parsing, WebView upload and final
Mongo persistence.

Before distributing a Beta artifact, download `MaiScoreHub-beta` from the
`build-android-beta.yml` Actions run and execute
`scripts/run-online-beta-e2e.ps1` against a physical phone. This verifies the
exact CI-signed APK with the production website, Workflow and API.

Before distributing a stable artifact, run `build-android-release.yml` once
with `publish=false`, inspect the signed artifact, then publish the same
revision with `publish=true`. Install the downloaded CI APK on a physical phone
and exercise login, recent and full modes against the production website/API.

## Repository hygiene

- Runtime OAuth data, cookies, device identifiers and credentials stay out of Git.
- `local.properties`, Gradle caches, APKs, screenshots and E2E artifacts stay ignored.
- Preserve unrelated workspace changes from the parent repository.
