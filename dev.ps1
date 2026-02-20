# Dev startup script for maimai-score-hub
# Usage: .\dev.ps1 [service...]
# Examples:
#   .\dev.ps1           → Start all services
#   .\dev.ps1 backend   → Start backend only
#   .\dev.ps1 backend frontend → Start backend and frontend

param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Services
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# ── Colors ──
function Write-Header($msg) { Write-Host "`n>>> $msg" -ForegroundColor Cyan }

# ── Build shared first ──
Write-Header "Building shared..."
Push-Location "$Root\shared"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "shared build failed!" -ForegroundColor Red; exit 1 }
Pop-Location

# ── Service definitions ──
$AllServices = @{
    backend    = @{ Path = "$Root\backend";    Cmd = "npm run start:dev" }
    frontend   = @{ Path = "$Root\frontend";   Cmd = "npm run dev" }
    worker     = @{ Path = "$Root\worker";     Cmd = "npm run start:dev" }
    automation = @{ Path = "$Root\automation"; Cmd = "python app.py" }
}

# Filter by requested services (or all)
if ($Services.Count -eq 0) {
    $targets = $AllServices.Keys
} else {
    $targets = $Services | Where-Object { $AllServices.ContainsKey($_) }
    $invalid = $Services | Where-Object { -not $AllServices.ContainsKey($_) }
    if ($invalid) { Write-Host "Unknown services: $($invalid -join ', ')" -ForegroundColor Yellow }
}

# ── Launch each service in a new Windows Terminal tab (or fallback to new window) ──
$jobs = @()
foreach ($name in $targets) {
    $svc = $AllServices[$name]
    Write-Header "Starting $name..."

    $job = Start-Job -Name $name -ScriptBlock {
        param($path, $cmd)
        Set-Location $path
        Invoke-Expression $cmd
    } -ArgumentList $svc.Path, $svc.Cmd

    $jobs += $job
}

Write-Host "`n✅ All services started. Press Ctrl+C to stop." -ForegroundColor Green
Write-Host "Running: $($targets -join ', ')`n" -ForegroundColor DarkGray

# ── Stream output until Ctrl+C ──
try {
    while ($true) {
        foreach ($job in $jobs) {
            Receive-Job -Job $job -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Write-Host "`nStopping all services..." -ForegroundColor Yellow
    $jobs | Stop-Job -PassThru | Remove-Job -Force
    Write-Host "Done." -ForegroundColor Green
}
