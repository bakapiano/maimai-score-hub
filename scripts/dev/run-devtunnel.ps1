$script = Join-Path $PSScriptRoot "run-devtunnel.cjs"
& node $script
exit $LASTEXITCODE
