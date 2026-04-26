[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CodexLarkRuntimeOverrideValue {
  param(
    [AllowNull()][psobject]$RuntimeOverride,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $RuntimeOverride) {
    return $null
  }

  $property = $RuntimeOverride.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Get-CodexLarkLocalAppDataRoot {
  $userProfileLocalAppData = $null
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $userProfileLocalAppData = Join-Path $env:USERPROFILE 'AppData\Local'
  }

  $candidates = @(
    [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process'),
    [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'User'),
    $userProfileLocalAppData
  )

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
      return [string]$candidate
    }
  }

  return 'C:\Users\Default\AppData\Local'
}

function Get-CodexLarkRuntimeDataRoot {
  return Join-Path (Get-CodexLarkLocalAppDataRoot) 'CodexLark'
}

function Get-CodexLarkRuntimeProductPaths {
  $dataRoot = Get-CodexLarkRuntimeDataRoot
  return [pscustomobject][ordered]@{
    dataRoot = $dataRoot
    configRoot = Join-Path $dataRoot 'config'
    logsRoot = Join-Path $dataRoot 'logs'
    stateRoot = Join-Path $dataRoot 'state'
    artifactsRoot = Join-Path $dataRoot 'artifacts'
  }
}

function Get-CodexLarkRuntimeManifestPath {
  return Join-Path (Join-Path (Get-CodexLarkRuntimeDataRoot) 'state') 'runtime-manifest.json'
}

function New-CodexLarkFallbackRuntimeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot
  )

  $dataRoot = Get-CodexLarkRuntimeDataRoot
  return [pscustomobject][ordered]@{
    schemaVersion = 1
    installRoot = $InstallRoot
    stateRoot = Join-Path $dataRoot 'state'
    launcherPath = Join-Path $InstallRoot 'Start-CodexLark.ps1'
    bridgeScriptPaths = [pscustomobject][ordered]@{
      runAdminTask = Join-Path $InstallRoot 'run-admin-task.ps1'
      installAutostart = Join-Path $InstallRoot 'Install-CodexLark-Autostart.ps1'
      uninstallAutostart = Join-Path $InstallRoot 'Uninstall-CodexLark-Autostart.ps1'
    }
  }
}

function Read-CodexLarkRuntimeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRootFallback
  )

  $manifestPath = Get-CodexLarkRuntimeManifestPath
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    return New-CodexLarkFallbackRuntimeManifest -InstallRoot $InstallRootFallback
  }

  $parsed = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($null -eq $parsed) {
    return New-CodexLarkFallbackRuntimeManifest -InstallRoot $InstallRootFallback
  }

  return $parsed
}

function Test-CodexLarkAdministrator {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $null
  }
}

function Get-CodexLarkRuntimeInfo {
  param(
    [AllowNull()][psobject]$RuntimeOverride
  )

  $languageMode = [string](Get-CodexLarkRuntimeOverrideValue -RuntimeOverride $RuntimeOverride -Name 'languageMode')
  if ([string]::IsNullOrWhiteSpace($languageMode)) {
    $languageMode = [string]$ExecutionContext.SessionState.LanguageMode
  }

  $runtimePsEdition = [string](Get-CodexLarkRuntimeOverrideValue -RuntimeOverride $RuntimeOverride -Name 'psEdition')
  if ([string]::IsNullOrWhiteSpace($runtimePsEdition)) {
    $runtimePsEdition = [string]$PSVersionTable.PSEdition
  }

  $runtimePsVersion = [string](Get-CodexLarkRuntimeOverrideValue -RuntimeOverride $RuntimeOverride -Name 'psVersion')
  if ([string]::IsNullOrWhiteSpace($runtimePsVersion)) {
    $runtimePsVersion = [string]$PSVersionTable.PSVersion
  }

  $supportsScheduledTasks = Get-CodexLarkRuntimeOverrideValue -RuntimeOverride $RuntimeOverride -Name 'supportsScheduledTasks'
  if ($null -eq $supportsScheduledTasks) {
    $supportsScheduledTasks = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
  } else {
    $supportsScheduledTasks = [bool]$supportsScheduledTasks
  }

  $isAdministrator = Get-CodexLarkRuntimeOverrideValue -RuntimeOverride $RuntimeOverride -Name 'isAdministrator'
  if ($null -eq $isAdministrator -and $languageMode -eq 'FullLanguage') {
    $isAdministrator = Test-CodexLarkAdministrator
  } elseif ($null -ne $isAdministrator) {
    $isAdministrator = [bool]$isAdministrator
  }

  return [pscustomobject][ordered]@{
    languageMode = $languageMode
    psEdition = $runtimePsEdition
    psVersion = $runtimePsVersion
    isAdministrator = $isAdministrator
    supportsScheduledTasks = $supportsScheduledTasks
  }
}

function Write-CodexLarkRuntimeLog {
  param(
    [Parameter(Mandatory = $true)][string]$EntryPoint,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][psobject]$Runtime,
    [Parameter(Mandatory = $true)][string]$Status,
    [string]$FailureCategory,
    [string]$Summary,
    [string[]]$Warnings = @(),
    [string]$SupportDocPath,
    [string]$ManualFallbackHint
  )

  $logDir = Split-Path -Parent $LogPath
  if (-not [string]::IsNullOrWhiteSpace($logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }

  $payload = [ordered]@{
    checkedAt = (Get-Date).ToString('s')
    entryPoint = $EntryPoint
    status = $Status
    runtime = $Runtime
  }

  if (-not [string]::IsNullOrWhiteSpace($FailureCategory)) {
    $payload.failureCategory = $FailureCategory
  }
  if (-not [string]::IsNullOrWhiteSpace($Summary)) {
    $payload.summary = $Summary
  }
  if ($Warnings.Count -gt 0) {
    $payload.warnings = @($Warnings)
  }
  if (-not [string]::IsNullOrWhiteSpace($SupportDocPath)) {
    $payload.supportDocPath = $SupportDocPath
  }
  if (-not [string]::IsNullOrWhiteSpace($ManualFallbackHint)) {
    $payload.manualFallbackHint = $ManualFallbackHint
  }

  $json = $payload | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($LogPath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Write-CodexLarkTerminalError {
  param(
    [Parameter(Mandatory = $true)][string]$FailureCategory,
    [Parameter(Mandatory = $true)][string]$Summary,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][psobject]$Runtime,
    [Parameter(Mandatory = $true)][string]$ManualFallbackHint,
    [string]$SupportDocPath
  )

  $lines = @(
    ('[{0}] {1}' -f $FailureCategory, $Summary),
    ('失败类别：{0}' -f $FailureCategory),
    ('日志路径：{0}' -f $LogPath),
    ('运行时：PowerShell {0} / {1} / {2}' -f $Runtime.psVersion, $Runtime.psEdition, $Runtime.languageMode),
    ('手动 fallback：{0}' -f $ManualFallbackHint)
  )

  if (-not [string]::IsNullOrWhiteSpace($SupportDocPath)) {
    $lines += ('参考文档：{0}' -f $SupportDocPath)
  }

  $message = $lines -join [Environment]::NewLine
  Write-Host $message -ForegroundColor Red
  return $message
}

function Assert-CodexLarkSupportedHost {
  param(
    [Parameter(Mandatory = $true)][string]$EntryPoint,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [string]$FailureCategory = 'unsupported-host',
    [string]$SupportDocPath = 'docs/workflows/install-startup-support-matrix.md',
    [string]$ManualFallbackHint = '请改走 README.md 的手动路径（快速开始），按文档手动完成安装、构建与启动。',
    [switch]$RequireScheduledTasks,
    [AllowNull()][psobject]$RuntimeOverride
  )

  $runtime = Get-CodexLarkRuntimeInfo -RuntimeOverride $RuntimeOverride
  $warnings = @()
  $status = 'supported'
  $summary = '运行时契约检查通过。'

  if ($env:OS -ne 'Windows_NT') {
    $summary = '当前入口脚本仅支持 Windows 主机。'
    Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
    $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
    throw $message
  }

  if ($runtime.languageMode -in @('ConstrainedLanguage', 'RestrictedLanguage')) {
    $summary = '检测到受限 PowerShell 环境（ConstrainedLanguage / RestrictedLanguage）；当前安装与启动入口只支持 FullLanguage。'
    Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
    $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
    throw $message
  }

  $parsedVersion = $null
  try {
    $parsedVersion = [version]$runtime.psVersion
  } catch {
    $parsedVersion = $null
  }

  if ($null -eq $parsedVersion) {
    $summary = ('无法识别当前 PowerShell 版本：{0}' -f $runtime.psVersion)
    Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
    $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
    throw $message
  }

  switch ($runtime.psEdition) {
    'Desktop' {
      if ($parsedVersion -lt [version]'5.1') {
        $summary = '当前入口脚本仅支持 Windows PowerShell 5.1 及以上版本。'
        Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
        $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
        throw $message
      }
    }
    'Core' {
      if ($parsedVersion -lt [version]'7.0') {
        $summary = '当前入口脚本仅支持 PowerShell 7 及以上版本。'
        Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
        $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
        throw $message
      }

      if ($RequireScheduledTasks) {
        $warnings += '当前是 PowerShell 7 主机；计划任务命令会依赖 Windows 兼容层。若注册失败，请改用 Windows PowerShell 5.1 FullLanguage 重新执行。'
      }
    }
    default {
      $summary = ('当前入口脚本不支持 PowerShell Edition：{0}' -f $runtime.psEdition)
      Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
      $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
      throw $message
    }
  }

  if ($RequireScheduledTasks -and -not $runtime.supportsScheduledTasks) {
    $summary = '当前主机缺少 ScheduledTasks 支持，无法注册或删除开机自启动任务。'
    Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status 'unsupported' -FailureCategory $FailureCategory -Summary $summary -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint
    $message = Write-CodexLarkTerminalError -FailureCategory $FailureCategory -Summary $summary -LogPath $LogPath -Runtime $runtime -ManualFallbackHint $ManualFallbackHint -SupportDocPath $SupportDocPath
    throw $message
  }

  if ($warnings.Count -gt 0) {
    $status = 'warning'
    $summary = '运行时契约检查通过，但当前主机有兼容性提示。'
    Write-Host ('[runtime-warning] {0}' -f ($warnings -join ' ')) -ForegroundColor Yellow
  }

  Write-CodexLarkRuntimeLog -EntryPoint $EntryPoint -LogPath $LogPath -Runtime $runtime -Status $status -Summary $summary -Warnings $warnings -SupportDocPath $SupportDocPath -ManualFallbackHint $ManualFallbackHint

  return [pscustomobject][ordered]@{
    status = $status
    logPath = $LogPath
    runtime = $runtime
    warnings = @($warnings)
  }
}
