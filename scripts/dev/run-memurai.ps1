. "$PSScriptRoot\lib.ps1"

$memurai = "C:\ProgramData\chocolatey\bin\memurai.exe"
$dir = "C:\ProgramData\MemuraiDev"

if (-not (Test-Path $memurai)) {
  Write-Error "Memurai executable not found: $memurai"
  exit 1
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
& $memurai --port 6379 --dir $dir
exit $LASTEXITCODE
