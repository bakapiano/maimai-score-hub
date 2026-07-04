. "$PSScriptRoot\lib.ps1"

Write-Host "== PM2 =="
Invoke-Pm2 status

Write-Host ""
Write-Host "== Ports =="
foreach ($port in @(6379, 9050, 3001)) {
  $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet
  Write-Host ("{0}: {1}" -f $port, $ok)
}

Write-Host ""
Write-Host "== Dev tunnel logs =="
Invoke-Pm2 logs msh-devtunnel --lines 20 --nostream
