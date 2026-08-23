$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ocrApiRoot = Join-Path $root "ocr-api"
$mode = if ($env:OCR_MODE) { $env:OCR_MODE } else { "real" }
$pipelineRoot = if ($env:OCR_PIPELINE_ROOT) { $env:OCR_PIPELINE_ROOT } else { Join-Path $ocrApiRoot "pipeline" }
$pipelinePython = if ($env:OCR_PYTHON) { $env:OCR_PYTHON } else { "D:\ocr\ocr\.venv\Scripts\python.exe" }
$apiPython = Join-Path $ocrApiRoot ".venv\Scripts\python.exe"
$ocrPython = if ($mode -eq "real") { $pipelinePython } else { $apiPython }

if (-not (Test-Path -LiteralPath $ocrPython)) {
  if ($mode -eq "real") {
    throw "Real OCR Python environment not found: $ocrPython"
  }
  python -m venv (Join-Path $ocrApiRoot ".venv")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $ocrPython -c "import app, fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
  & $ocrPython -m pip install --disable-pip-version-check -e $ocrApiRoot
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not $env:OCR_MODE) { $env:OCR_MODE = $mode }
if (-not $env:OCR_PIPELINE_ROOT) { $env:OCR_PIPELINE_ROOT = $pipelineRoot }
if (-not $env:OCR_API_TOKEN) { $env:OCR_API_TOKEN = "change-me-local-ocr" }
if (-not $env:OCR_CATALOG_ENABLED) { $env:OCR_CATALOG_ENABLED = "false" }

Push-Location $ocrApiRoot
try {
  & $ocrPython -m uvicorn app.main:app --host 127.0.0.1 --port 19100
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
