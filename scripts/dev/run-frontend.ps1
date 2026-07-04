. "$PSScriptRoot\lib.ps1"

$root = Get-RepoRoot
$vite = Join-Path $root "frontend\node_modules\vite\bin\vite.js"
if (-not (Test-Path $vite)) {
  Write-Error "Vite not found under frontend\node_modules. Run npm --prefix frontend install first."
  exit 1
}

Set-Location (Join-Path $root "frontend")
& node $vite --host 127.0.0.1 --port 3001
exit $LASTEXITCODE
