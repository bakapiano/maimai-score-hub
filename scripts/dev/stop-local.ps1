. "$PSScriptRoot\lib.ps1"

$apps = @(
  "msh-devtunnel",
  "msh-admin-devtunnel",
  "msh-sdgb-stable-a",
  "msh-sdgb-stable-b",
  "msh-sdgb-recoverable-a",
  "msh-sdgb-recoverable-b",
  "msh-worker",
  "msh-admin",
  "msh-frontend",
  "msh-backend",
  "msh-memurai"
)
$root = Get-RepoRoot
$pm2 = Join-Path $root "node_modules\.bin\pm2.cmd"
$runningJson = (& $pm2 jlist) -join ""
$names = @(
  [regex]::Matches($runningJson, '"name":"([^"]+)"') |
    ForEach-Object { $_.Groups[1].Value }
)
foreach ($app in $apps) {
  if ($names -contains $app) {
    $null = Invoke-Pm2 delete $app
  }
}
Invoke-Pm2 status

$memuraiPidFile = Join-Path $root ".local-dev\memurai.pid"
if (Test-Path -LiteralPath $memuraiPidFile) {
  $memuraiPid = [int](Get-Content -LiteralPath $memuraiPidFile -Raw)
  $memurai = Get-Process -Id $memuraiPid -ErrorAction SilentlyContinue
  if ($memurai -and $memurai.ProcessName -eq "memurai") {
    Stop-Process -Id $memuraiPid -Force
  }
  Remove-Item -LiteralPath $memuraiPidFile -Force
}
