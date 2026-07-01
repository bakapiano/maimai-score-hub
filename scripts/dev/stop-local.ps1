. "$PSScriptRoot\lib.ps1"

Invoke-Pm2 delete msh-devtunnel msh-sdgb-worker msh-worker msh-frontend msh-backend msh-memurai
Invoke-Pm2 status
