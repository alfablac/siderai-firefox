# Build dist/graphite-sider-<version>.xpi via tools/build-xpi.py.
# Usage: pwsh -File tools/build-xpi.ps1   (or: powershell -ExecutionPolicy Bypass -File tools/build-xpi.ps1)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'build-xpi.py'

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python 3 not found on PATH (tried: python, py)' }

if ($python.Name -eq 'py.exe') {
    & $python.Source -3 $script
} else {
    & $python.Source $script
}
exit $LASTEXITCODE
