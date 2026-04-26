[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSCommandPath
$setupLogDir = Join-Path $repoRoot 'artifacts\setup'
$taskPath = '\CodexLark\'
$legacyTaskPath = '\'
$taskName = 'CodexLark-FeishuLongConn'
$runtimeContractPath = Join-Path $repoRoot 'scripts\setup\runtime-contract.ps1'
$runtimeContractLogPath = Join-Path $setupLogDir 'autostart-uninstall-runtime-contract.json'
. $runtimeContractPath
$runtimeContract = Assert-CodexLarkSupportedHost -EntryPoint 'Uninstall-CodexLark-Autostart.ps1' -LogPath $runtimeContractLogPath -FailureCategory 'unsupported-host' -SupportDocPath 'docs/workflows/install-startup-support-matrix.md' -ManualFallbackHint '请改走 README.md 的手动路径，或在管理员 Windows PowerShell 5.1 FullLanguage 中手动删除计划任务。' -RequireScheduledTasks

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Administrator {
  if (Test-IsAdministrator) {
    return
  }

  try {
    $proc = Start-Process PowerShell -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs -PassThru -Wait -ErrorAction Stop
    exit $proc.ExitCode
  } catch {
    throw '已取消管理员授权，未删除开机自启动任务。'
  }
}

Ensure-Administrator

function Remove-ScheduledTaskIfPresent {
  param(
    [Parameter(Mandatory = $true)][string]$TaskPath,
    [Parameter(Mandatory = $true)][string]$TaskName
  )

  $existingTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $existingTask) {
    return $false
  }

  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
  return $true
}

$removedCanonicalTask = Remove-ScheduledTaskIfPresent -TaskPath $taskPath -TaskName $taskName
$removedLegacyTask = Remove-ScheduledTaskIfPresent -TaskPath $legacyTaskPath -TaskName $taskName

if (-not $removedCanonicalTask -and -not $removedLegacyTask) {
  Write-Host '未发现开机自启动任务，已跳过。'
  Write-Host "- 计划任务：$taskPath$taskName"
  Write-Host "- 旧计划任务：$legacyTaskPath$taskName"
  return
}

if ($removedCanonicalTask) {
  Write-Host '已删除开机自启动任务。'
  Write-Host "- 计划任务：$taskPath$taskName"
}
if ($removedLegacyTask) {
  Write-Host '已删除旧路径开机自启动任务。'
  Write-Host "- 旧计划任务：$legacyTaskPath$taskName"
}
