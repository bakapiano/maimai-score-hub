function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Import-LocalDevEnv {
  $root = Get-RepoRoot
  $envFile = Join-Path $root ".env.local-dev"
  if (-not (Test-Path $envFile)) {
    Write-Warning ".env.local-dev not found. Copy .env.local-dev.example and fill local secrets if admin/observability is needed."
    return
  }

  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $idx = $line.IndexOf("=")
    if ($idx -le 0) {
      return
    }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

function Set-DefaultEnv {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name, "Process"))) {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  }
}

function Invoke-Pm2 {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $root = Get-RepoRoot
  Push-Location $root
  try {
    & npx pm2 @Args
    return $LASTEXITCODE
  } finally {
    Pop-Location
  }
}
