param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,
    [string]$DeviceSerial = 'b223378f',
    [string]$AdbPath = 'D:\Android\Sdk\platform-tools\adb.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$packageName = 'com.bakapiano.maiscorehub.android.beta'
$componentName = "$packageName/com.bakapiano.maiscorehub.android.MainActivity"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$artifactDirectory = Join-Path $projectDirectory 'app\build\online-beta-e2e'
$statusPath = Join-Path $artifactDirectory 'status.log'

New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
Set-Content -LiteralPath $statusPath -Value '' -Encoding utf8

function Write-E2eStatus([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Add-Content -LiteralPath $statusPath -Value $line -Encoding utf8
    Write-Host $line
}

function Invoke-Adb {
    $adbArguments = @($args)
    $output = & $AdbPath -s $DeviceSerial @adbArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "adb failed ($LASTEXITCODE): $($adbArguments -join ' ')`n$output"
    }
    return ($output -join "`n")
}

function Save-PhoneArtifact([string]$RemotePath, [string]$LocalName) {
    $target = Join-Path $artifactDirectory $LocalName
    Invoke-Adb pull $RemotePath $target | Out-Null
}

function Wait-ForTerminal([string]$Mode, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $log = Invoke-Adb logcat -d -s 'MshWebView:I' 'MshOAuthVpn:I' 'MshHttpProxy:I' 'MshDxnetTransport:I' '*:S'
        Set-Content -LiteralPath (Join-Path $artifactDirectory "$Mode-logcat.txt") -Value $log -Encoding utf8
        $events = [regex]::Matches($log, '\[MaiScoreHubWorkflow\]\s+(\{[^\r\n]+\})')
        for ($index = $events.Count - 1; $index -ge 0; $index--) {
            try {
                $status = $events[$index].Groups[1].Value | ConvertFrom-Json
            } catch {
                continue
            }
            if ($status.mode -eq $Mode -and $status.terminal -eq $true) {
                return [pscustomobject]@{
                    Success = $status.success -eq $true
                    Message = [string]$status.message
                }
            }
        }
        Start-Sleep -Seconds 5
    }
    throw "$Mode did not reach a terminal state in $TimeoutSeconds seconds"
}

function Start-OnlineMode(
    [ValidateSet('login', 'recent', 'full')]
    [string]$Mode
) {
    Write-E2eStatus "START mode=$Mode"
    Invoke-Adb shell am force-stop $packageName | Out-Null
    Invoke-Adb shell am force-stop com.tencent.mm | Out-Null
    Invoke-Adb logcat -c | Out-Null
    Invoke-Adb shell input keyevent 224 | Out-Null
    Invoke-Adb shell wm dismiss-keyguard | Out-Null
    Invoke-Adb shell input keyevent 82 | Out-Null
    Invoke-Adb shell am start -n $componentName --es e2e_mode $Mode | Out-Null
    Start-Sleep -Seconds 12

    Invoke-Adb shell screencap -p "/sdcard/msh-online-$Mode.png" | Out-Null
    Save-PhoneArtifact "/sdcard/msh-online-$Mode.png" "$Mode.png"
    $timeout = if ($Mode -eq 'full') { 900 } else { 360 }
    $terminal = Wait-ForTerminal -Mode $Mode -TimeoutSeconds $timeout
    Write-E2eStatus "TERMINAL mode=$Mode success=$($terminal.Success) message=$($terminal.Message)"
    if (-not $terminal.Success) {
        throw "$Mode failed: $($terminal.Message)"
    }
}

$resolvedApk = (Resolve-Path -LiteralPath $ApkPath).Path
$devices = (& $AdbPath devices) -join "`n"
if ($devices -notmatch "(?m)^$([regex]::Escape($DeviceSerial))\s+device\b") {
    throw "Android device is not online: $DeviceSerial"
}

$health = Invoke-RestMethod -Uri 'https://api.maiscorehub.bakapiano.com/api/v1/health' -TimeoutSec 20
if ($health.status -ne 'ok') {
    throw 'Production Backend health check failed'
}
$manifest = Invoke-RestMethod -Uri 'https://api.maiscorehub.bakapiano.com/api/v1/android/workflow/manifest' -TimeoutSec 20
if (-not $manifest.version -or -not $manifest.sha256) {
    throw 'Production Android Workflow manifest is invalid'
}
$assetLinksResponse = Invoke-WebRequest -UseBasicParsing -Uri 'https://maiscorehub.bakapiano.com/.well-known/assetlinks.json' -TimeoutSec 20
if ($assetLinksResponse.StatusCode -ne 200 -or
        $assetLinksResponse.Headers.'Content-Type' -notmatch 'application/json' -or
        $assetLinksResponse.Content -notmatch [regex]::Escape($packageName)) {
    throw 'Production Digital Asset Links does not include the Beta package'
}

Write-E2eStatus "ONLINE backend=ok workflow=$($manifest.version)"
& $AdbPath -s $DeviceSerial uninstall $packageName 2>$null | Out-Null
& $AdbPath -s $DeviceSerial install $resolvedApk | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to install the Beta APK'
}
Invoke-Adb shell pm grant $packageName android.permission.POST_NOTIFICATIONS | Out-Null
Invoke-Adb shell appops set $packageName ACTIVATE_VPN allow | Out-Null

$packageDump = Invoke-Adb shell dumpsys package $packageName
if ($packageDump -notmatch 'versionName=0\.2\.0-beta') {
    throw 'Installed Beta package version is unexpected'
}
Write-E2eStatus 'INSTALL package=com.bakapiano.maiscorehub.android.beta version=0.2.0-beta'

foreach ($mode in @('login', 'recent', 'full')) {
    Start-OnlineMode -Mode $mode
}

Invoke-Adb shell am start -n $componentName | Out-Null
Write-E2eStatus 'COMPLETE online login + recent + full passed'
