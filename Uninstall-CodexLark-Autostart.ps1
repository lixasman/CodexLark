[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskPath = '\'
$taskName = 'CodexLark-FeishuLongConn'

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

$existingTask = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $existingTask) {
  Write-Host '未发现开机自启动任务，已跳过。'
  Write-Host "- 计划任务：$taskPath$taskName"
  return
}

Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false
Write-Host '已删除开机自启动任务。'
Write-Host "- 计划任务：$taskPath$taskName"
