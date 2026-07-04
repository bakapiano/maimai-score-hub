. "$PSScriptRoot\lib.ps1"

$ErrorActionPreference = "Stop"
$root = Get-RepoRoot
$env:NODE_OPTIONS = "--max-old-space-size=4096"

Write-Host "== Checking local prerequisites =="
$mongoOk = Test-NetConnection -ComputerName 127.0.0.1 -Port 27017 -InformationLevel Quiet
if (-not $mongoOk) {
  throw "MongoDB is not reachable on 127.0.0.1:27017"
}
if (-not (Test-Path "C:\ProgramData\chocolatey\bin\memurai.exe")) {
  throw "Memurai not found at C:\ProgramData\chocolatey\bin\memurai.exe"
}

Write-Host "== Building shared and backend =="
Push-Location $root
try {
  npm --prefix shared run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm --prefix backend run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

Write-Host "== Starting PM2 local dev services =="
Invoke-Pm2 start ecosystem.local-dev.config.cjs --update-env
Invoke-Pm2 status

Write-Host ""
Write-Host "Services started. Useful commands:"
Write-Host "  npm run dev:local:status"
Write-Host "  npm run dev:local:logs"
Write-Host "  npm run dev:local:stop"
Write-Host ""
Write-Host "Dev tunnel URL appears in msh-devtunnel logs:"
Invoke-Pm2 logs msh-devtunnel --lines 20 --nostream
