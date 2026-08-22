. "$PSScriptRoot\lib.ps1"

$ErrorActionPreference = "Stop"
$root = Get-RepoRoot
Import-LocalDevEnv
$env:NODE_OPTIONS = "--max-old-space-size=4096"

Write-Host "== Checking local prerequisites =="
$mongoOk = Test-NetConnection -ComputerName 127.0.0.1 -Port 27017 -InformationLevel Quiet
if (-not $mongoOk) {
  throw "MongoDB is not reachable on 127.0.0.1:27017"
}
$memuraiBinary = "C:\ProgramData\chocolatey\lib\memurai-developer.portable\tools\memurai.exe"
if (-not (Test-Path $memuraiBinary)) {
  throw "Memurai not found at $memuraiBinary"
}

Write-Host "== Building shared and backend =="
$ocrApiRoot = Join-Path $root "ocr-api"
$ocrMode = if ($env:OCR_MODE) { $env:OCR_MODE } else { "real" }
$ocrPipelineRoot = if ($env:OCR_PIPELINE_ROOT) { $env:OCR_PIPELINE_ROOT } else { "D:\ocr\ocr" }
$apiPython = Join-Path $ocrApiRoot ".venv\Scripts\python.exe"
$pipelinePython = if ($env:OCR_PYTHON) {
  $env:OCR_PYTHON
} else {
  Join-Path $ocrPipelineRoot ".venv\Scripts\python.exe"
}
$ocrPython = if ($ocrMode -eq "real") { $pipelinePython } else { $apiPython }
if (-not (Test-Path -LiteralPath $ocrPython)) {
  if ($ocrMode -eq "real") {
    throw "Real OCR Python environment not found: $ocrPython"
  }
  Write-Host "== Creating fake OCR API virtual environment =="
  python -m venv (Join-Path $ocrApiRoot ".venv")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& $ocrPython -c "import app, fastapi, httpx, multipart, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "== Installing OCR API into selected Python environment =="
  & $ocrPython -m pip install --disable-pip-version-check -e $ocrApiRoot
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Push-Location $root
try {
  npm --prefix shared run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm --prefix backend run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm --prefix sdgb-worker run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

Write-Host "== Starting local Memurai =="
$memuraiPidFile = Join-Path $root ".local-dev\memurai.pid"
$redisReady = Test-NetConnection -ComputerName 127.0.0.1 -Port 6379 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $redisReady) {
  $memurai = Start-Process `
    -FilePath $memuraiBinary `
    -ArgumentList @("--port", "6379", "--dir", "C:\ProgramData\MemuraiDev") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $memuraiPidFile -Value $memurai.Id
}
$redisReady = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if (Test-NetConnection -ComputerName 127.0.0.1 -Port 6379 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    $redisReady = $true
    break
  }
  Start-Sleep -Milliseconds 250
}
if (-not $redisReady) {
  throw "Memurai did not bind 127.0.0.1:6379"
}
Write-Host "== Starting PM2 local dev services =="
$serviceApps = @(
  "msh-ocr-api",
  "msh-backend",
  "msh-frontend",
  "msh-admin",
  "msh-worker",
  "msh-sdgb-stable-a",
  "msh-sdgb-stable-b",
  "msh-sdgb-recoverable-a",
  "msh-sdgb-recoverable-b",
  "msh-devtunnel",
  "msh-admin-devtunnel"
) -join ","
# PM2 keeps the original executable when an existing app changes Python env.
# Recreate this one process so switching fake/real always uses the selected env.
Invoke-Pm2 delete msh-ocr-api *> $null
Invoke-Pm2 start ecosystem.local-dev.config.cjs --only $serviceApps --update-env
Invoke-Pm2 status

Write-Host ""
Write-Host "Services started. Useful commands:"
Write-Host "  npm run dev:local:status"
Write-Host "  npm run dev:local:logs"
Write-Host "  npm run dev:local:stop"
Write-Host ""
Write-Host "Dev tunnel URLs appear in these logs:"
Invoke-Pm2 logs msh-devtunnel --lines 20 --nostream
Invoke-Pm2 logs msh-admin-devtunnel --lines 20 --nostream
