param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^emulator-\d+$')]
    [string]$DeviceSerial,
    [string]$AdbPath = 'D:\Android\Sdk\platform-tools\adb.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$packageName = 'com.bakapiano.maiscorehub.android.devicetest'
$runner = "$packageName.test/com.bakapiano.maiscorehub.android.tests.NativeSmokeInstrumentation"

function Invoke-Adb {
    $result = & $AdbPath -s $DeviceSerial @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ADB failed: $($args[0])" }
    return ($result -join "`n")
}

if ((Invoke-Adb shell getprop ro.kernel.qemu).Trim() -ne '1') {
    throw 'This harness requires an Android Emulator'
}
$avdName = (Invoke-Adb emu avd name).Split("`n")[0].Trim()
if ($avdName -notmatch '^msh-native-api\d+$') {
    throw 'Use an isolated msh-native-api* AVD for this destructive test-data reset'
}
$api = [int](Invoke-Adb shell getprop ro.build.version.sdk).Trim()
$artifactDirectory = Join-Path $projectDirectory "app\build\native-emulator-e2e\api-$api"
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$oldReverse = (Invoke-Adb reverse --list).Split("`n") |
    Where-Object { $_ -match '\stcp:19310\s' } | Select-Object -First 1
$fixture = $null
$configured = $false
$results = @()
try {
    if (Get-NetTCPConnection -State Listen -LocalPort 19310 -ErrorAction SilentlyContinue) {
        throw 'Fixture port 19310 is already in use'
    }
    $fixture = Start-Process -FilePath (Get-Command node).Source -WindowStyle Hidden -PassThru `
        -ArgumentList (Join-Path $PSScriptRoot 'native-emulator-fixture.mjs') `
        -RedirectStandardOutput (Join-Path $artifactDirectory 'fixture-out.log') `
        -RedirectStandardError (Join-Path $artifactDirectory 'fixture-error.log')
    Invoke-Adb install -r (Join-Path $projectDirectory 'app\build\outputs\apk\deviceTest\MaiScoreHub-deviceTest.apk') | Out-Null
    Invoke-Adb install -r (Join-Path $projectDirectory 'app\build\outputs\apk\androidTest\deviceTest\app-deviceTest-androidTest.apk') | Out-Null
    Invoke-Adb reverse tcp:19310 tcp:19310 | Out-Null
    $configured = $true
    Invoke-Adb shell input keyevent 224 | Out-Null
    Invoke-Adb shell wm dismiss-keyguard | Out-Null
    foreach ($scenario in @('compatibility', 'foreground-allowed', 'foreground-denied')) {
        # This resets only our test package on the validated, task-owned emulator.
        Invoke-Adb shell pm clear $packageName | Out-Null
        Invoke-Adb shell cmd appops set $packageName ACTIVATE_VPN allow | Out-Null
        $mode = if ($scenario -eq 'foreground-denied') { 'deny' } else { 'allow' }
        Invoke-Adb shell cmd appops set $packageName START_FOREGROUND $mode | Out-Null
        Write-Host "START api=$api scenario=$scenario"
        $output = Invoke-Adb shell am instrument -w -e scenario $scenario $runner
        Set-Content -LiteralPath (Join-Path $artifactDirectory "$scenario.txt") -Value $output -Encoding utf8
        $nativeLog = Invoke-Adb logcat -d -v time -s 'MshNative:I' '*:S'
        Set-Content -LiteralPath (Join-Path $artifactDirectory "$scenario-native.log") -Value $nativeLog -Encoding utf8
        $match = [regex]::Match($output, '(?m)^INSTRUMENTATION_RESULT: result=(\{[^\r\n]+\})')
        if (!$match.Success) { throw "Missing instrumentation result: $scenario" }
        $result = $match.Groups[1].Value | ConvertFrom-Json
        $results += $result
        if (!$result.PSObject.Properties['passed'] -or !$result.passed) {
            throw "Instrumentation failed: $scenario; inspect the saved result"
        }
        Write-Host "PASS api=$api scenario=$scenario"
    }
} finally {
    if ($configured) {
        & $AdbPath -s $DeviceSerial shell cmd appops set $packageName START_FOREGROUND allow | Out-Null
        & $AdbPath -s $DeviceSerial shell am force-stop $packageName | Out-Null
        if ($oldReverse) {
            $oldTarget = ($oldReverse.Trim() -split '\s+')[-1]
            & $AdbPath -s $DeviceSerial reverse tcp:19310 $oldTarget | Out-Null
        } else {
            & $AdbPath -s $DeviceSerial reverse --remove tcp:19310 | Out-Null
        }
    }
    if ($fixture -and !$fixture.HasExited) { Stop-Process -Id $fixture.Id }
    $results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $artifactDirectory 'results.json') -Encoding utf8
}
