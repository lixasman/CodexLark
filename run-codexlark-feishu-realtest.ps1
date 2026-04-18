$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$delegateScript = Join-Path $PSScriptRoot 'run-admin-task.ps1'
if (-not (Test-Path $delegateScript)) {
  throw "Missing delegate script: $delegateScript"
}

& $delegateScript
