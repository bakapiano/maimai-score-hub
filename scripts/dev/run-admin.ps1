. "$PSScriptRoot\lib.ps1"

$root = Get-RepoRoot
$vite = Join-Path $root "admin\node_modules\vite\bin\vite.js"
if (-not (Test-Path $vite)) {
  Write-Error "Vite not found under admin\node_modules. Run npm --prefix admin install first."
  exit 1
}

Set-Location (Join-Path $root "admin")
& node $vite --host 127.0.0.1 --port 3002
exit $LASTEXITCODE
