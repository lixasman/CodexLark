[CmdletBinding()]
param(
  [string]$TaskUser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSCommandPath
$adminScriptPath = Join-Path $repoRoot 'run-admin-task.ps1'
$taskPath = '\CodexLark\'
$legacyTaskPath = '\'
$taskName = 'CodexLark-FeishuLongConn'
$setupLogDir = Join-Path $repoRoot 'artifacts\setup'
$runtimeContractPath = Join-Path $repoRoot 'scripts\setup\runtime-contract.ps1'
$runtimeContractLogPath = Join-Path $setupLogDir 'autostart-install-runtime-contract.json'
. $runtimeContractPath
$runtimeContract = Assert-CodexLarkSupportedHost -EntryPoint 'Install-CodexLark-Autostart.ps1' -LogPath $runtimeContractLogPath -FailureCategory 'unsupported-host' -SupportDocPath 'docs/workflows/install-startup-support-matrix.md' -ManualFallbackHint '请改走 README.md 的手动路径，或在管理员 Windows PowerShell 5.1 FullLanguage 中手动注册计划任务。' -RequireScheduledTasks

if ([string]::IsNullOrWhiteSpace($TaskUser)) {
  $TaskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
}

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

function Ensure-ScheduledTaskFolder {
  param(
    [Parameter(Mandatory = $true)][string]$TaskPath
  )

  $segments = @($TaskPath.Trim('\').Split('\') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($segments.Count -eq 0) {
    return
  }

  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $currentPath = ''

  foreach ($segment in $segments) {
    $currentPath = if ([string]::IsNullOrWhiteSpace($currentPath)) { "\$segment" } else { "$currentPath\$segment" }
    try {
      $folder = $service.GetFolder($currentPath)
    } catch {
      try {
        $folder = $folder.CreateFolder($segment, $null)
      } catch {
        $folder = $service.GetFolder($currentPath)
      }
    }
  }
}

if (-not (Test-Path $adminScriptPath)) {
  throw "缺少启动脚本：$adminScriptPath"
}
if ([string]::IsNullOrWhiteSpace($TaskUser)) {
  throw '缺少计划任务目标用户。'
}

Ensure-ScheduledTaskFolder -TaskPath $taskPath

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

$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$taskArgument = "-ExecutionPolicy Bypass -File `"$adminScriptPath`""
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArgument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
$principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '开机自启动 CodexLark 飞书长连接。' -Force | Out-Null

if (Remove-ScheduledTaskIfPresent -TaskPath $legacyTaskPath -TaskName $taskName) {
  Write-Host '已清理旧路径开机自启动任务。'
  Write-Host "- 旧计划任务：$legacyTaskPath$taskName"
}

Write-Host '已注册开机自启动任务。'
Write-Host "- 计划任务：$taskPath$taskName"
Write-Host "- 运行用户：$TaskUser"
Write-Host "- 目标脚本：$adminScriptPath"
Write-Host ''
Write-Host '如需移除，请运行 Uninstall-CodexLark-Autostart.ps1。'
