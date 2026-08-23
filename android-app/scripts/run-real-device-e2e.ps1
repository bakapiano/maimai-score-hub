param(
    [datetime]$NotBefore = (Get-Date).Date.AddHours(7).AddMinutes(1),
    [string]$DeviceSerial = 'b223378f',
    [string]$AdbPath = 'D:\Android\Sdk\platform-tools\adb.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$workspaceDirectory = Split-Path -Parent $projectDirectory
$apkPath = Join-Path $projectDirectory 'app\build\outputs\apk\debug\MaiScoreHub-debug.apk'
$artifactDirectory = Join-Path $projectDirectory 'app\build\real-device-e2e'
$statusPath = Join-Path $artifactDirectory 'status.log'

New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null

function Write-E2eStatus([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Add-Content -LiteralPath $statusPath -Value $line -Encoding utf8
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
            if ($status.mode -eq $Mode) {
                if ($status.terminal -eq $true) {
                    return [pscustomobject]@{
                        Success = $status.success -eq $true
                        Message = [string]$status.message
                    }
                }
                break
            }
        }
        Start-Sleep -Seconds 5
    }
    throw "$Mode did not reach a terminal state in $TimeoutSeconds seconds"
}

function Start-PhoneUpdate([ValidateSet('login', 'recent', 'full')][string]$Mode) {
    Write-E2eStatus "START mode=$Mode"
    Invoke-Adb shell am force-stop com.bakapiano.maimai.updater | Out-Null
    Invoke-Adb shell am force-stop com.bakapiano.maiscorehub.android | Out-Null
    Invoke-Adb shell am force-stop com.tencent.mm | Out-Null
    Invoke-Adb logcat -c | Out-Null
    Invoke-Adb shell input keyevent 224 | Out-Null
    Invoke-Adb shell wm dismiss-keyguard | Out-Null
    Invoke-Adb shell input keyevent 82 | Out-Null
    Invoke-Adb shell am start -n com.bakapiano.maiscorehub.android/.MainActivity --es e2e_mode $Mode | Out-Null
    Start-Sleep -Seconds 12

    # LauncherUI hands the local URL directly to WeChat's own WebViewUI.
    Invoke-Adb shell screencap -p "/sdcard/msh-$Mode-wechat.png" | Out-Null
    Save-PhoneArtifact "/sdcard/msh-$Mode-wechat.png" "$Mode-wechat.png"

    $timeout = if ($Mode -eq 'full') { 900 } else { 360 }
    $terminal = Wait-ForTerminal -Mode $Mode -TimeoutSeconds $timeout
    Invoke-Adb shell screencap -p "/sdcard/msh-$Mode-result.png" | Out-Null
    Save-PhoneArtifact "/sdcard/msh-$Mode-result.png" "$Mode-result.png"
    Invoke-Adb shell am start -n com.bakapiano.maiscorehub.android/.MainActivity | Out-Null
    Start-Sleep -Seconds 3
    Invoke-Adb shell screencap -p "/sdcard/msh-$Mode-app-result.png" | Out-Null
    Save-PhoneArtifact "/sdcard/msh-$Mode-app-result.png" "$Mode-app-result.png"
    Invoke-Adb shell uiautomator dump "/sdcard/msh-$Mode-result.xml" | Out-Null
    Save-PhoneArtifact "/sdcard/msh-$Mode-result.xml" "$Mode-result.xml"
    Write-E2eStatus "TERMINAL mode=$Mode success=$($terminal.Success) message=$($terminal.Message)"
    return $terminal
}

$exitCode = 0
try {
    Set-Content -LiteralPath $statusPath -Value '' -Encoding utf8
    while ((Get-Date) -lt $NotBefore) {
        $remaining = [math]::Ceiling(($NotBefore - (Get-Date)).TotalSeconds)
        Write-E2eStatus "WAIT remainingSeconds=$remaining"
        Start-Sleep -Seconds ([math]::Min(30, [math]::Max(1, $remaining)))
    }

    if (-not (Test-Path -LiteralPath $apkPath)) {
        throw "Debug APK not found: $apkPath"
    }
    $devices = (& $AdbPath devices) -join "`n"
    if ($devices -notmatch "(?m)^$([regex]::Escape($DeviceSerial))\s+device\b") {
        throw "Android device is not online: $DeviceSerial"
    }

    $backendHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:9050/api/v1/health' -TimeoutSec 10
    if ($backendHealth.status -ne 'ok') {
        throw 'Local Backend health check failed'
    }
    $frontendHealth = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/app/sync' -TimeoutSec 10
    if ($frontendHealth.StatusCode -ne 200) {
        throw 'Local frontend health check failed'
    }
    $baselineScript = Join-Path $PSScriptRoot 'capture-backend-baseline.mjs'
    & node $baselineScript
    if ($LASTEXITCODE -ne 0) {
        throw "Backend baseline capture failed with exit code $LASTEXITCODE"
    }

    Invoke-Adb install -r $apkPath | Out-Null
    Invoke-Adb reverse tcp:3001 tcp:3001 | Out-Null
    Invoke-Adb reverse tcp:9050 tcp:9050 | Out-Null

    $loginResult = Start-PhoneUpdate -Mode 'login'
    if (-not $loginResult.Success) {
        throw "login failed: $($loginResult.Message)"
    }

    $pm2Path = Join-Path $workspaceDirectory 'node_modules\.bin\pm2.cmd'
    if (Test-Path -LiteralPath $pm2Path) {
        & $pm2Path stop msh-worker | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Unable to pause msh-worker for isolated persistence verification'
        }
    }

    foreach ($mode in @('recent', 'full')) {
        $completed = $false
        for ($attempt = 1; $attempt -le 4 -and -not $completed; $attempt++) {
            Write-E2eStatus "ATTEMPT mode=$mode number=$attempt"
            $result = Start-PhoneUpdate -Mode $mode
            if ($result.Success) {
                $completed = $true
                continue
            }
            if ($result.Message -match '维护中') {
                Start-Sleep -Seconds 300
                continue
            }
            if ($result.Message -match 'connection abort|timeout|timed out|connection reset|unexpected end of stream|stream was reset') {
                Start-Sleep -Seconds 5
                continue
            }
            throw "$mode failed: $($result.Message)"
        }
        if (-not $completed) {
            throw "$mode remained unavailable after maintenance retries"
        }
    }
    $verifierPath = Join-Path $PSScriptRoot 'verify-backend-e2e.mjs'
    & node $verifierPath
    if ($LASTEXITCODE -ne 0) {
        throw "Backend persistence verifier failed with exit code $LASTEXITCODE"
    }
    Write-E2eStatus 'COMPLETE login + phone modes passed'
} catch {
    Write-E2eStatus "FAILED $($_.Exception.Message)"
    $exitCode = 1
} finally {
    $pm2Path = Join-Path $workspaceDirectory 'node_modules\.bin\pm2.cmd'
    if (Test-Path -LiteralPath $pm2Path) {
        $workerOutput = & $pm2Path start msh-worker 2>&1
        $workerExitCode = $LASTEXITCODE
        Set-Content -LiteralPath (Join-Path $artifactDirectory 'worker-restore.log') -Value $workerOutput -Encoding utf8
        Write-E2eStatus "RESTORE msh-worker exitCode=$workerExitCode"
    } else {
        Write-E2eStatus 'RESTORE msh-worker skipped: PM2 command missing'
    }
}
exit $exitCode
