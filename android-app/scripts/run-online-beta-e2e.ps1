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

function Get-UiNodes {
    $remotePath = '/sdcard/msh-online-ui.xml'
    & $AdbPath -s $DeviceSerial shell uiautomator dump $remotePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        return @()
    }
    $content = (& $AdbPath -s $DeviceSerial shell cat $remotePath 2>$null) -join ''
    if ($LASTEXITCODE -ne 0 -or -not $content) {
        return @()
    }
    try {
        [xml]$document = $content
        return @($document.SelectNodes('//node'))
    } catch {
        return @()
    }
}

function Tap-UiNode($Node) {
    $match = [regex]::Match(
        [string]$Node.bounds,
        '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$'
    )
    if (-not $match.Success) {
        return $false
    }
    $x = [math]::Floor(
        ([int]$match.Groups[1].Value + [int]$match.Groups[3].Value) / 2
    )
    $y = [math]::Floor(
        ([int]$match.Groups[2].Value + [int]$match.Groups[4].Value) / 2
    )
    Invoke-Adb shell input tap $x $y | Out-Null
    return $true
}

function Install-BetaApk([string]$ResolvedApk) {
    $stdoutPath = Join-Path $artifactDirectory 'install.stdout.log'
    $stderrPath = Join-Path $artifactDirectory 'install.stderr.log'
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    $installOptions = @{
        FilePath = $AdbPath
        ArgumentList = @('-s', $DeviceSerial, 'install', $ResolvedApk)
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = $stdoutPath
        RedirectStandardError = $stderrPath
    }
    $install = Start-Process @installOptions
    $deadline = (Get-Date).AddMinutes(3)
    while (-not $install.HasExited -and (Get-Date) -lt $deadline) {
        $nodes = @(Get-UiNodes)
        $continue = $nodes | Where-Object { $_.text -eq '仍然继续' } | Select-Object -First 1
        if ($continue) {
            Tap-UiNode $continue | Out-Null
            Start-Sleep -Milliseconds 500
            continue
        }
        $checkbox = $nodes | Where-Object {
            $_.text -eq '已知悉该应用存在风险'
        } | Select-Object -First 1
        if ($checkbox -and [string]$checkbox.checked -ne 'true') {
            Tap-UiNode $checkbox | Out-Null
            Start-Sleep -Milliseconds 300
            continue
        }
        $authorize = $nodes | Where-Object {
            $_.text -eq '授权本次安装'
        } | Select-Object -First 1
        if ($authorize) {
            Tap-UiNode $authorize | Out-Null
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $install.HasExited) {
        $install.Kill()
        throw 'Beta APK installation timed out'
    }
    $install.WaitForExit()
    $stdout = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
    if ($install.ExitCode -ne 0 -or $stdout -notmatch 'Success') {
        throw "Unable to install the Beta APK: $stderr $stdout"
    }
    $done = @(Get-UiNodes) | Where-Object { $_.text -eq '完成' } | Select-Object -First 1
    if ($done) {
        Tap-UiNode $done | Out-Null
    }
}

function Approve-StartupConsents {
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        $nodes = @(Get-UiNodes)
        $notification = $nodes | Where-Object {
            $_.package -match 'permissioncontroller' -and (
                $_.'resource-id' -match 'permission_allow' -or
                $_.text -eq '允许'
            )
        } | Select-Object -First 1
        if ($notification) {
            Tap-UiNode $notification | Out-Null
            Write-E2eStatus 'Notification permission approved'
            Start-Sleep -Milliseconds 500
            continue
        }
        $allow = $nodes | Where-Object {
            $_.package -match '(vpndialogs|wirelesssettings)$' -and (
                $_.'resource-id' -eq 'android:id/button1' -or
                $_.text -eq '确定' -or
                $_.text -eq '允许'
            )
        } | Select-Object -First 1
        if ($allow) {
            Tap-UiNode $allow | Out-Null
            Write-E2eStatus 'VPN consent approved'
            return
        }
        Start-Sleep -Milliseconds 500
    }
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
    if ($Mode -eq 'login') {
        Approve-StartupConsents
    }
    Start-Sleep -Seconds 12

    Invoke-Adb shell screencap -p "/sdcard/msh-online-$Mode.png" | Out-Null
    Save-PhoneArtifact "/sdcard/msh-online-$Mode.png" "$Mode.png"
    $timeout = if ($Mode -eq 'full') { 900 } else { 360 }
    $terminal = Wait-ForTerminal -Mode $Mode -TimeoutSeconds $timeout
    Write-E2eStatus "TERMINAL mode=$Mode success=$($terminal.Success) message=$($terminal.Message)"
    if (-not $terminal.Success) {
        throw "$Mode failed: $($terminal.Message)"
    }
    if ($Mode -eq 'login') {
        # The terminal event is logged immediately before the website stores
        # the bearer token and redirects. Keep the WebView alive long enough
        # for that synchronous write plus navigation to finish.
        Start-Sleep -Seconds 3
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
if (-not $manifest.workflowVersion -or -not $manifest.sha256) {
    throw 'Production Android Workflow manifest is invalid'
}
if ([int]$manifest.bridgeApiVersion -gt 1) {
    throw 'Production Workflow requires a newer native bridge'
}
$bundleUrl = 'https://api.maiscorehub.bakapiano.com/api/v1' + [string]$manifest.entry
$bundle = Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -TimeoutSec 20
$bundleSha256 = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($bundle.Content)
    )
).ToLowerInvariant()
if ($bundle.StatusCode -ne 200 -or $bundleSha256 -ne $manifest.sha256) {
    throw 'Production Android Workflow bundle digest is invalid'
}
$assetLinksResponse = Invoke-WebRequest -UseBasicParsing -Uri 'https://maiscorehub.bakapiano.com/.well-known/assetlinks.json' -TimeoutSec 20
if ($assetLinksResponse.StatusCode -ne 200 -or
        $assetLinksResponse.Headers.'Content-Type' -notmatch 'application/json' -or
        $assetLinksResponse.Content -notmatch [regex]::Escape($packageName)) {
    throw 'Production Digital Asset Links does not include the Beta package'
}

Write-E2eStatus "ONLINE backend=ok workflow=$($manifest.workflowVersion)"
& $AdbPath -s $DeviceSerial uninstall $packageName 2>$null | Out-Null
Install-BetaApk -ResolvedApk $resolvedApk
& $AdbPath -s $DeviceSerial shell pm grant $packageName android.permission.POST_NOTIFICATIONS 2>$null | Out-Null

$packageDump = Invoke-Adb shell dumpsys package $packageName
if ($packageDump -notmatch 'versionName=0\.3\.0-beta') {
    throw 'Installed Beta package version is unexpected'
}
Write-E2eStatus 'INSTALL package=com.bakapiano.maiscorehub.android.beta version=0.3.0-beta'

foreach ($mode in @('login', 'recent', 'full')) {
    Start-OnlineMode -Mode $mode
}

Invoke-Adb shell am start -n $componentName | Out-Null
Write-E2eStatus 'COMPLETE online login + recent + full passed'
