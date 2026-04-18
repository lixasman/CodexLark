[CmdletBinding()]
param(
  [string]$TaskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSCommandPath
$adminScriptPath = Join-Path $repoRoot 'run-admin-task.ps1'
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
    $proc = Start-Process PowerShell -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-TaskUser', $TaskUser) -Verb RunAs -PassThru -Wait -ErrorAction Stop
    exit $proc.ExitCode
  } catch {
    throw '已取消管理员授权，未安装开机自启动任务。'
  }
}

Ensure-Administrator

if (-not (Test-Path $adminScriptPath)) {
  throw "缺少启动脚本：$adminScriptPath"
}
if ([string]::IsNullOrWhiteSpace($TaskUser)) {
  throw '缺少计划任务目标用户。'
}

$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$taskArgument = "-ExecutionPolicy Bypass -File `"$adminScriptPath`""
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArgument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
$principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '开机自启动 CodexLark 飞书长连接。' -Force | Out-Null

Write-Host '已注册开机自启动任务。'
Write-Host "- 计划任务：$taskPath$taskName"
Write-Host "- 运行用户：$TaskUser"
Write-Host "- 目标脚本：$adminScriptPath"
Write-Host ''
Write-Host '如需移除，请运行 Uninstall-CodexLark-Autostart.ps1。'
