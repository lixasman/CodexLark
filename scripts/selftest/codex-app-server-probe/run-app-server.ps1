$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$artifactsRoot = Join-Path $repoRoot 'artifacts\selftest\codex-app-server-probe'
$logFile = Join-Path $artifactsRoot 'app-server.log'
$codexExe = if ($env:CODEX_CLI_EXE -and $env:CODEX_CLI_EXE.Trim()) { $env:CODEX_CLI_EXE.Trim() } elseif ($env:OS -eq 'Windows_NT') { 'codex.cmd' } else { 'codex' }
$listenUrl = if ($env:CODEX_APP_SERVER_LISTEN -and $env:CODEX_APP_SERVER_LISTEN.Trim()) { $env:CODEX_APP_SERVER_LISTEN.Trim() } else { 'ws://127.0.0.1:8788' }

New-Item -ItemType Directory -Force -Path $artifactsRoot | Out-Null

Push-Location $repoRoot
try {
  "=== START $(Get-Date -Format o) ===" | Out-File -FilePath $logFile -Append -Encoding utf8
  & $codexExe app-server --listen $listenUrl *>> $logFile
} finally {
  Pop-Location
}
