param(
    [string]$DeviceSerial = 'b223378f',
    [string]$AdbPath = 'D:\Android\Sdk\platform-tools\adb.exe',
    [int]$TargetVersionCode = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$workspaceDirectory = Split-Path -Parent $projectDirectory
$artifactDirectory = Join-Path $projectDirectory 'app\build\app-update-e2e'
$baselineApk = Join-Path $artifactDirectory 'MaiScoreHub-update-base.apk'
$targetApk = Join-Path $artifactDirectory 'MaiScoreHub-update-target.apk'
$publishPath = Join-Path $artifactDirectory 'release-publish.json'
$notesPath = Join-Path $artifactDirectory 'release-notes.txt'
$statusPath = Join-Path $artifactDirectory 'status.log'
$packageName = 'com.bakapiano.maiscorehub.android'
$releaseId = ''
$headers = $null

if ($TargetVersionCode -le 0) {
    $minutes = [math]::Floor(
        ((Get-Date).ToUniversalTime() - [datetime]'2026-01-01T00:00:00Z').TotalMinutes
    )
    $TargetVersionCode = 100000 + [int]$minutes
}
$baselineVersionCode = $TargetVersionCode - 1
$targetVersionName = "0.3.0-e2e.$TargetVersionCode"
$baselineVersionName = "0.3.0-e2e.$baselineVersionCode"

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

function Get-LocalSecret([string]$Name) {
    $envFile = Join-Path $workspaceDirectory '.env.local-dev'
    $line = Get-Content -LiteralPath $envFile | Where-Object {
        $_ -match "^$([regex]::Escape($Name))="
    } | Select-Object -Last 1
    if (-not $line) {
        throw "$Name is missing from .env.local-dev"
    }
    $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
    if (-not $value) {
        throw "$Name is empty in .env.local-dev"
    }
    return $value
}

function Get-UiNodes {
    $remotePath = '/sdcard/msh-app-update-ui.xml'
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

function Tap-StableUiAction([string]$PackageName, [string]$Text) {
    Start-Sleep -Milliseconds 500
    $fresh = @(Get-UiNodes)
    $node = $fresh | Where-Object {
        [string]$_.package -eq $PackageName -and [string]$_.text -eq $Text
    } | Select-Object -First 1
    if (-not $node) {
        return $false
    }
    return Tap-UiNode $node
}

function Get-InstalledVersionCode {
    $dump = Invoke-Adb shell dumpsys package $packageName
    $match = [regex]::Match($dump, 'versionCode=(\d+)')
    return $match.Success ? [int]$match.Groups[1].Value : 0
}

function Build-Apk([int]$VersionCode, [string]$VersionName, [string]$Target) {
    Push-Location $projectDirectory
    try {
        & .\gradlew.bat assembleDebug `
            "-PmshVersionCode=$VersionCode" `
            "-PmshVersionName=$VersionName"
        if ($LASTEXITCODE -ne 0) {
            throw "Gradle build failed for versionCode=$VersionCode"
        }
        Copy-Item -LiteralPath `
            'app\build\outputs\apk\debug\MaiScoreHub-debug.apk' `
            -Destination $Target -Force
    } finally {
        Pop-Location
    }
}

$dronyWasRunning = $false
$updaterWasRunning = $false
try {
    $devices = (& $AdbPath devices) -join "`n"
    if ($devices -notmatch "(?m)^$([regex]::Escape($DeviceSerial))\s+device\b") {
        throw "Android device is not online: $DeviceSerial"
    }
    if ((Invoke-RestMethod -Uri 'http://127.0.0.1:9050/api/v1/health').status -ne 'ok') {
        throw 'Local Backend health check failed'
    }
    if ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/app/settings').StatusCode -ne 200) {
        throw 'Local Frontend health check failed'
    }

    $env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
    $env:GRADLE_USER_HOME = 'D:\Android\gradle-user-home'
    Write-E2eStatus "BUILD baseline=$baselineVersionCode target=$TargetVersionCode"
    Build-Apk $baselineVersionCode $baselineVersionName $baselineApk
    Build-Apk $TargetVersionCode $targetVersionName $targetApk

    $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetApk).Hash.ToLowerInvariant()
    $releaseId = "android-debug-$TargetVersionCode-$($targetHash.Substring(0, 12))"
    $apkUrl = "http://localhost:9050/api/v1/android/app/releases/$releaseId/apk"
    Set-Content -LiteralPath $notesPath `
        -Value "本地应用内更新 E2E $targetVersionName" -Encoding utf8 -NoNewline

    $env:ANDROID_RELEASE_KEYSTORE_PATH = Join-Path $env:USERPROFILE '.android\debug.keystore'
    $env:ANDROID_RELEASE_STORE_PASSWORD = 'android'
    $env:ANDROID_RELEASE_KEY_ALIAS = 'androiddebugkey'
    $env:ANDROID_RELEASE_KEY_PASSWORD = 'android'
    $java = Join-Path $env:JAVA_HOME 'bin\java.exe'
    Push-Location $projectDirectory
    try {
        & $java scripts\SignReleaseManifest.java `
            --apk $targetApk `
            --output $publishPath `
            --release-id $releaseId `
            --channel debug `
            --package-name $packageName `
            --version-code $TargetVersionCode `
            --version-name $targetVersionName `
            --required-bridge-api-version 2 `
            --min-sdk 26 `
            --apk-url $apkUrl `
            --mandatory false `
            --rollout-percent 100 `
            --notes-file $notesPath
        if ($LASTEXITCODE -ne 0) {
            throw 'Release manifest signing failed'
        }
    } finally {
        Pop-Location
    }

    $publish = Get-Content -LiteralPath $publishPath -Raw | ConvertFrom-Json
    $headers = @{ 'X-API-Secret' = Get-LocalSecret 'API_SHARED_SECRET' }
    $base = 'http://127.0.0.1:9050/api/v1'
    Invoke-RestMethod `
        -Method Put `
        -Uri "$base/admin/android/app/releases/policies/debug" `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body ($publish.policy | ConvertTo-Json -Compress -Depth 10) | Out-Null
    Invoke-RestMethod `
        -Method Put `
        -Uri "$base/admin/android/app/releases/$releaseId/apk" `
        -Headers $headers `
        -ContentType 'application/vnd.android.package-archive' `
        -InFile $targetApk | Out-Null
    Invoke-RestMethod `
        -Method Put `
        -Uri "$base/admin/android/app/releases/$releaseId" `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body ($publish.envelope | ConvertTo-Json -Compress -Depth 10) | Out-Null
    $latest = Invoke-RestMethod -Uri (
        "$base/android/app/releases/latest?channel=debug" +
        "&packageName=$packageName&currentVersionCode=$baselineVersionCode" +
        "&installationId=e2e-$TargetVersionCode"
    )
    if (-not $latest.updateAvailable -or $latest.release.releaseId -ne $releaseId) {
        throw 'Backend did not publish the expected Android update'
    }
    Write-E2eStatus "PUBLISHED releaseId=$releaseId sha256=$targetHash"

    $dronyPid = (& $AdbPath -s $DeviceSerial shell pidof org.sandroproxy.drony 2>$null) -join ''
    $updaterPid = (& $AdbPath -s $DeviceSerial shell pidof com.bakapiano.maimai.updater 2>$null) -join ''
    $dronyWasRunning = -not [string]::IsNullOrWhiteSpace($dronyPid)
    $updaterWasRunning = -not [string]::IsNullOrWhiteSpace($updaterPid)
    Invoke-Adb shell am force-stop org.sandroproxy.drony | Out-Null
    Invoke-Adb shell am force-stop com.bakapiano.maimai.updater | Out-Null

    Invoke-Adb install -r -d $baselineApk | Out-Null
    Invoke-Adb reverse tcp:3001 tcp:3001 | Out-Null
    Invoke-Adb reverse tcp:9050 tcp:9050 | Out-Null
    & $AdbPath -s $DeviceSerial shell appops set $packageName REQUEST_INSTALL_PACKAGES deny 2>$null | Out-Null
    Invoke-Adb shell input keyevent 224 | Out-Null
    Invoke-Adb shell wm dismiss-keyguard | Out-Null
    Invoke-Adb shell input keyevent 82 | Out-Null
    Invoke-Adb shell am force-stop $packageName | Out-Null
    Invoke-Adb logcat -c | Out-Null
    Invoke-Adb shell am start -n "$packageName/.MainActivity" `
        --es e2e_mode app_update --es e2e_release_id $releaseId | Out-Null
    Write-E2eStatus "START installed=$baselineVersionCode releaseId=$releaseId"

    $deadline = (Get-Date).AddMinutes(5)
    $permissionHandled = $false
    while ((Get-Date) -lt $deadline) {
        if ((Get-InstalledVersionCode) -eq $TargetVersionCode) {
            break
        }
        $nodes = @(Get-UiNodes)
        $market = $nodes | Where-Object {
            $_.package -eq 'com.heytap.market'
        } | Select-Object -First 1
        if ($market) {
            Invoke-Adb shell input keyevent 4 | Out-Null
            Write-E2eStatus 'INSTALLER returned from app-market detour'
            Start-Sleep -Seconds 1
            continue
        }
        $settingsSwitch = $nodes | Where-Object {
            $_.package -eq 'com.android.settings' -and
            ($_.class -match 'Switch' -or $_.'resource-id' -match 'switch_widget')
        } | Select-Object -First 1
        if ($settingsSwitch) {
            if ([string]$settingsSwitch.checked -ne 'true') {
                Tap-UiNode $settingsSwitch | Out-Null
                Start-Sleep -Milliseconds 700
            }
            if (-not $permissionHandled) {
                $permissionHandled = $true
                Invoke-Adb shell input keyevent 4 | Out-Null
                Write-E2eStatus 'PERMISSION unknown-sources approved'
            }
            Start-Sleep -Seconds 1
            continue
        }

        $risk = $nodes | Where-Object {
            $_.text -eq '已知悉该应用存在风险'
        } | Select-Object -First 1
        if ($risk -and [string]$risk.checked -ne 'true') {
            Tap-StableUiAction ([string]$risk.package) ([string]$risk.text) | Out-Null
            Start-Sleep -Milliseconds 400
            continue
        }

        $oplusContinue = $nodes | Where-Object {
            $_.package -eq 'com.oplus.appdetail' -and $_.text -eq '仍然继续'
        } | Select-Object -First 1
        if ($oplusContinue) {
            if (Tap-StableUiAction 'com.oplus.appdetail' '仍然继续') {
                Write-E2eStatus 'INSTALLER tapped=仍然继续'
            }
            Start-Sleep -Seconds 2
            continue
        }

        $oplusAuthorize = $nodes | Where-Object {
            $_.package -eq 'com.oplus.appdetail' -and $_.text -eq '授权本次安装'
        } | Select-Object -First 1
        if ($oplusAuthorize) {
            if (Tap-StableUiAction 'com.oplus.appdetail' '授权本次安装') {
                Write-E2eStatus 'INSTALLER tapped=授权本次安装'
            }
            Start-Sleep -Seconds 2
            continue
        }

        $install = $nodes | Where-Object {
            $_.package -match '(packageinstaller|permissioncontroller|securitypermission)' -and
            $_.text -in @('安装', '更新', '仍然安装', '允许本次安装')
        } | Select-Object -First 1
        if ($install) {
            if (Tap-StableUiAction ([string]$install.package) ([string]$install.text)) {
                Write-E2eStatus "INSTALLER tapped=$($install.text)"
            }
            Start-Sleep -Seconds 2
            continue
        }

        $log = Invoke-Adb logcat -d -s 'MshWebView:I' '*:S'
        if ($log -match '\[MaiScoreHubAppUpdate\].*"success":false.*"terminal":true') {
            throw "Native app update failed`n$log"
        }
        Start-Sleep -Seconds 1
    }

    $installed = Get-InstalledVersionCode
    if ($installed -ne $TargetVersionCode) {
        throw "App update did not install target version: expected=$TargetVersionCode actual=$installed"
    }
    $finalLog = Invoke-Adb logcat -d -s 'MshWebView:I' '*:S'
    Set-Content -LiteralPath (Join-Path $artifactDirectory 'logcat.txt') `
        -Value $finalLog -Encoding utf8
    Invoke-Adb shell screencap -p /sdcard/msh-app-update-final.png | Out-Null
    Invoke-Adb pull /sdcard/msh-app-update-final.png `
        (Join-Path $artifactDirectory 'final.png') | Out-Null
    Write-E2eStatus "COMPLETE versionCode=$installed versionName=$targetVersionName"
} catch {
    Write-E2eStatus "FAILED $($_.Exception.Message)"
    throw
} finally {
    if ($releaseId -and $headers) {
        try {
            Invoke-RestMethod `
                -Method Delete `
                -Uri "http://127.0.0.1:9050/api/v1/admin/android/app/releases/$releaseId" `
                -Headers $headers | Out-Null
            Write-E2eStatus "CLEANUP revoked=$releaseId"
        } catch {
            Write-E2eStatus "CLEANUP failed=$($_.Exception.Message)"
        }
    }
    if ($dronyWasRunning) {
        & $AdbPath -s $DeviceSerial shell am start `
            -n org.sandroproxy.drony/.DronyMainActivity 2>$null | Out-Null
    }
    if ($updaterWasRunning) {
        & $AdbPath -s $DeviceSerial shell am start `
            -n com.bakapiano.maimai.updater/.ui.MainActivity 2>$null | Out-Null
    }
    Write-E2eStatus "RESTORE drony=$dronyWasRunning updater=$updaterWasRunning"
}
