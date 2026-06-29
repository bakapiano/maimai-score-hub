. "$PSScriptRoot\lib.ps1"

$root = Get-RepoRoot
Import-LocalDevEnv

Set-DefaultEnv PORT "9050"
Set-DefaultEnv HOST "127.0.0.1"
Set-DefaultEnv MONGO_HOST "127.0.0.1"
Set-DefaultEnv MONGO_PORT "27017"
Set-DefaultEnv MONGO_DB "maimai_web"
Set-DefaultEnv REDIS_HOST "127.0.0.1"
Set-DefaultEnv REDIS_PORT "6379"
Set-DefaultEnv REDIS_DB "0"
Set-DefaultEnv REDIS_KEY_PREFIX "maimai:"
Set-DefaultEnv AUTH_JWT_SECRET "change-me-local"
Set-DefaultEnv SKIP_AUTH "true"
Set-DefaultEnv OBSERVABILITY_ENV "dev"
Set-DefaultEnv OBSERVABILITY_INSTANCE "local-admin-dashboard"
Set-DefaultEnv CLICKHOUSE_DATABASE "maimai_observability"
Set-DefaultEnv CLICKHOUSE_FLUSH_INTERVAL_MS "1000"

$distMain = Join-Path $root "backend\dist\main.js"
if (-not (Test-Path $distMain)) {
  Write-Error "backend\dist\main.js not found. Run scripts\dev\start-local.ps1 first so backend is built."
  exit 1
}

Set-Location (Join-Path $root "backend")
& node $distMain
exit $LASTEXITCODE
