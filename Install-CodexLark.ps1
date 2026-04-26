[CmdletBinding()]
param(
  [switch]$Repair
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSCommandPath
Set-Location $repoRoot

$setupLogDir = Join-Path $repoRoot 'artifacts\setup'
$installSummaryPath = Join-Path $setupLogDir 'install-summary.json'
$nodeInstallOutLog = Join-Path $setupLogDir 'install-node.out.log'
$nodeInstallErrLog = Join-Path $setupLogDir 'install-node.err.log'
$codexInstallOutLog = Join-Path $setupLogDir 'install-codex.out.log'
$codexInstallErrLog = Join-Path $setupLogDir 'install-codex.err.log'
$npmInstallOutLog = Join-Path $setupLogDir 'npm-install.out.log'
$npmInstallErrLog = Join-Path $setupLogDir 'npm-install.err.log'
$buildOutLog = Join-Path $setupLogDir 'build.out.log'
$buildErrLog = Join-Path $setupLogDir 'build.err.log'
$doctorOutLog = Join-Path $setupLogDir 'doctor.out.log'
$doctorErrLog = Join-Path $setupLogDir 'doctor.err.log'
$launcherSyncOutLog = Join-Path $setupLogDir 'launcher-sync.out.log'
$launcherSyncErrLog = Join-Path $setupLogDir 'launcher-sync.err.log'
$autostartOutLog = Join-Path $setupLogDir 'autostart-enable.out.log'
$autostartErrLog = Join-Path $setupLogDir 'autostart-enable.err.log'
$startLauncherPath = Join-Path $repoRoot 'Start-CodexLark.ps1'
$repairLauncherPath = Join-Path $repoRoot 'Repair-CodexLark.ps1'
$autostartInstallerPath = Join-Path $repoRoot 'Install-CodexLark-Autostart.ps1'
$adminScriptPath = Join-Path $repoRoot 'run-admin-task.ps1'
$doctorScriptPath = Join-Path $repoRoot 'scripts\doctor.cjs'
$runtimeContractPath = Join-Path $repoRoot 'scripts\setup\runtime-contract.ps1'
$processRunnerPath = Join-Path $repoRoot 'scripts\setup\process-runner.ps1'
$runtimeContractLogPath = Join-Path $setupLogDir 'runtime-contract.json'
. $runtimeContractPath
. $processRunnerPath
$runtimeContract = Assert-CodexLarkSupportedHost -EntryPoint 'Install-CodexLark.ps1' -LogPath $runtimeContractLogPath -FailureCategory 'unsupported-host' -SupportDocPath 'docs/workflows/install-startup-support-matrix.md' -ManualFallbackHint '请改走 README.md 的手动路径（快速开始），按文档手动完成安装、构建与启动。'

$global:SetupState = [ordered]@{
  repair = [bool]$Repair
  startedAt = (Get-Date).ToString('s')
  hostContractStatus = $runtimeContract.status
  hostRuntimeLog = $runtimeContract.logPath
  runtime = $runtimeContract.runtime
  hostWarnings = @($runtimeContract.warnings)
  nodeVersion = $null
  codexVersion = $null
  envUpdated = $false
  doctorOk = $false
  autostartEnabled = $false
  generatedLaunchers = @()
  resolvedCommands = @()
  steps = @()
}

function Initialize-SetupLogging {
  New-Item -ItemType Directory -Path $setupLogDir -Force | Out-Null
}

function Write-SetupStage {
  param(
    [Parameter(Mandatory = $true)][int]$StepNumber,
    [Parameter(Mandatory = $true)][int]$TotalSteps,
    [Parameter(Mandatory = $true)][string]$Title
  )

  Write-Host ("[{0}/{1}] {2}" -f $StepNumber, $TotalSteps, $Title) -ForegroundColor Cyan
}

function Set-StepStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Status,
    [string]$Detail
  )

  $entry = [ordered]@{
    name = $Name
    status = $Status
  }
  if (-not [string]::IsNullOrWhiteSpace($Detail)) {
    $entry.detail = $Detail
  }
  $global:SetupState.steps += [pscustomobject]$entry
}

function Write-Utf8BomFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $encoding = [System.Text.UTF8Encoding]::new($true)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-InstallSummary {
  $global:SetupState.completedAt = (Get-Date).ToString('s')
  $json = $global:SetupState | ConvertTo-Json -Depth 8
  Write-Utf8BomFile -Path $installSummaryPath -Content $json
}

function Refresh-SessionPath {
  $segments = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User'),
    $env:Path
  )
  $paths = foreach ($segment in $segments) {
    if ([string]::IsNullOrWhiteSpace($segment)) {
      continue
    }

    foreach ($part in ($segment -split ';')) {
      $trimmed = $part.Trim()
      if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
        $trimmed
      }
    }
  }

  $env:Path = ($paths | Select-Object -Unique) -join ';'
}

function Ensure-AppDataNpmOnPath {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    return
  }

  $npmShimDir = Join-Path $env:APPDATA 'npm'
  if (-not (Test-Path $npmShimDir)) {
    return
  }

  $pathEntries = @($env:Path -split ';')
  if ($pathEntries -contains $npmShimDir) {
    return
  }

  $env:Path = "$npmShimDir;$env:Path"
}

function Resolve-CommandSource {
  param(
    [Parameter(Mandatory = $true)][string]$Name
  )

  return Resolve-CodexLarkCommandSource -Name $Name
}

function Invoke-SetupStep {
  param(
    [Parameter(Mandatory = $true)][string]$StepName,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [int]$TimeoutSec = 1200,
    [string]$WorkingDirectory = $repoRoot
  )

  Initialize-SetupLogging
  Set-StepStatus -Name $StepName -Status 'started'

  try {
    $result = Invoke-CodexLarkCommand -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -StdoutPath $StdoutPath -StderrPath $StderrPath -TimeoutSec $TimeoutSec
  } catch {
    $exception = $_.Exception
    if (-not $exception.Data.Contains('StepName')) {
      $exception.Data['StepName'] = $StepName
    }
    if (-not $exception.Data.Contains('StdoutPath')) {
      $exception.Data['StdoutPath'] = $StdoutPath
    }
    if (-not $exception.Data.Contains('StderrPath')) {
      $exception.Data['StderrPath'] = $StderrPath
    }
    $resolvedPath = $exception.Data['ResolvedPath']
    if (-not [string]::IsNullOrWhiteSpace([string]$resolvedPath)) {
      $global:SetupState.resolvedCommands += [pscustomobject]@{
        step = $StepName
        mode = 'non-interactive'
        resolvedPath = [string]$resolvedPath
        stdoutPath = $StdoutPath
        stderrPath = $StderrPath
      }
    }
    Set-StepStatus -Name $StepName -Status 'failed' -Detail "See $StdoutPath and $StderrPath"
    throw $exception
  }

  $global:SetupState.resolvedCommands += [pscustomobject]@{
    step = $StepName
    mode = $result.Mode
    resolvedPath = $result.ResolvedPath
    exitCode = $result.ExitCode
    stdoutPath = $result.StdoutPath
    stderrPath = $result.StderrPath
  }

  if ($result.ExitCode -ne 0) {
    Set-StepStatus -Name $StepName -Status 'failed' -Detail "ExitCode=$($result.ExitCode). See $StdoutPath and $StderrPath"
    $failure = [System.Exception]::new("步骤失败：$StepName 退出码为 $($result.ExitCode)。请检查日志：$StdoutPath 和 $StderrPath")
    $failure.Data['StepName'] = $StepName
    $failure.Data['ExitCode'] = [int]$result.ExitCode
    $failure.Data['StdoutPath'] = $result.StdoutPath
    $failure.Data['StderrPath'] = $result.StderrPath
    $failure.Data['ResolvedPath'] = $result.ResolvedPath
    throw $failure
  }

  Set-StepStatus -Name $StepName -Status 'passed' -Detail "Resolved=$($result.ResolvedPath). See $StdoutPath and $StderrPath"
  return $result
}

function Invoke-SetupInteractiveStep {
  param(
    [Parameter(Mandatory = $true)][string]$StepName,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [string]$WorkingDirectory = $repoRoot
  )

  Initialize-SetupLogging
  Set-StepStatus -Name $StepName -Status 'started'

  try {
    $result = Invoke-CodexLarkInteractiveCommand -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory
  } catch {
    $exception = $_.Exception
    if (-not $exception.Data.Contains('StepName')) {
      $exception.Data['StepName'] = $StepName
    }
    Set-StepStatus -Name $StepName -Status 'failed' -Detail ([string]$exception.Message)
    throw $exception
  }

  $global:SetupState.resolvedCommands += [pscustomobject]@{
    step = $StepName
    mode = $result.Mode
    resolvedPath = $result.ResolvedPath
    exitCode = $result.ExitCode
  }

  if ($result.ExitCode -ne 0) {
    Set-StepStatus -Name $StepName -Status 'failed' -Detail "ExitCode=$($result.ExitCode). Resolved=$($result.ResolvedPath)"
    $failure = [System.Exception]::new("步骤失败：$StepName 退出码为 $($result.ExitCode)。")
    $failure.Data['StepName'] = $StepName
    $failure.Data['ExitCode'] = [int]$result.ExitCode
    $failure.Data['ResolvedPath'] = $result.ResolvedPath
    throw $failure
  }

  Set-StepStatus -Name $StepName -Status 'passed' -Detail "Resolved=$($result.ResolvedPath)"
  return $result
}

function Assert-SupportedPlatform {
  if ($env:OS -ne 'Windows_NT') {
    throw '当前安装器仅支持 Windows 10/11 个人电脑。'
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw '当前安装器仅支持带 winget 的普通个人 Windows 电脑，请先安装或启用 App Installer 后重试。'
  }
}

function Assert-NetworkAccess {
  try {
    $null = Invoke-WebRequest -Uri 'https://registry.npmjs.org/-/ping' -UseBasicParsing -TimeoutSec 15
  } catch {
    throw '当前无法访问外部网络，安装 Node.js、Codex CLI 和 npm 依赖前请先确认网络连接。'
  }
}

function Get-CommandVersionString {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @('--version')
  )

  $output = & $FilePath @ArgumentList 2>$null
  return [string]($output | Select-Object -First 1)
}

function Get-NodeMajorVersion {
  $nodeCommand = Resolve-CommandSource 'node'
  if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
    return $null
  }

  $versionText = Get-CommandVersionString -FilePath $nodeCommand -ArgumentList @('--version')
  if ([string]::IsNullOrWhiteSpace($versionText)) {
    return $null
  }

  $normalized = $versionText.TrimStart('v')
  return [int]($normalized.Split('.')[0])
}

function Ensure-NodeJs {
  $nodeCommand = Resolve-CommandSource 'node'
  $nodeMajor = Get-NodeMajorVersion
  if ($nodeCommand -and $nodeMajor -ge 24) {
    $global:SetupState.nodeVersion = Get-CommandVersionString -FilePath $nodeCommand -ArgumentList @('--version')
    return $nodeCommand
  }

  $wingetCommand = (Get-Command winget -ErrorAction Stop).Source
  Invoke-SetupStep -StepName 'Install Node.js' -FilePath $wingetCommand -ArgumentList @('install', '--id', 'OpenJS.NodeJS.LTS', '--accept-package-agreements', '--accept-source-agreements', '--silent') -StdoutPath $nodeInstallOutLog -StderrPath $nodeInstallErrLog -TimeoutSec 1800 | Out-Null

  Refresh-SessionPath
  $nodeCommand = Resolve-CommandSource 'node'
  $nodeMajor = Get-NodeMajorVersion
  if (-not $nodeCommand -or $nodeMajor -lt 24) {
    throw "Node.js 安装后仍不可用，或版本低于 24。请检查日志：$nodeInstallOutLog 和 $nodeInstallErrLog"
  }

  $global:SetupState.nodeVersion = Get-CommandVersionString -FilePath $nodeCommand -ArgumentList @('--version')
  return $nodeCommand
}

function Ensure-CodexCli {
  param(
    [Parameter(Mandatory = $true)][string]$NpmCommand
  )

  $codexCommand = Resolve-CommandSource 'codex'
  if (-not $codexCommand) {
    Invoke-SetupStep -StepName 'Install Codex CLI' -FilePath $NpmCommand -ArgumentList @('install', '-g', '@openai/codex') -StdoutPath $codexInstallOutLog -StderrPath $codexInstallErrLog -TimeoutSec 1800 | Out-Null
    Refresh-SessionPath
    Ensure-AppDataNpmOnPath
    $codexCommand = Resolve-CommandSource 'codex'
  }

  if (-not $codexCommand) {
    throw "Codex CLI 安装后仍不可用。请检查日志：$codexInstallOutLog 和 $codexInstallErrLog"
  }

  $global:SetupState.codexVersion = Get-CommandVersionString -FilePath $codexCommand -ArgumentList @('--version')
  return $codexCommand
}

function Get-EffectiveEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue
  }

  $userValue = [Environment]::GetEnvironmentVariable($Name, 'User')
  if (-not [string]::IsNullOrWhiteSpace($userValue)) {
    return $userValue
  }

  return $null
}

function Read-YesNo {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [bool]$DefaultYes = $true
  )

  $suffix = if ($DefaultYes) { ' [Y/n]' } else { ' [y/N]' }
  $answer = Read-Host ($Prompt + $suffix)
  if ([string]::IsNullOrWhiteSpace($answer)) {
    return $DefaultYes
  }

  return $answer.Trim().ToUpperInvariant().StartsWith('Y')
}

function Test-CodexLoginMarker {
  if (-not [string]::IsNullOrWhiteSpace((Get-EffectiveEnvValue -Name 'OPENAI_API_KEY'))) {
    return $true
  }

  $codexHome = Get-EffectiveEnvValue -Name 'COMMUNICATE_CODEX_HOME'
  if ([string]::IsNullOrWhiteSpace($codexHome)) {
    $codexHome = Get-EffectiveEnvValue -Name 'CODEX_HOME'
  }
  if ([string]::IsNullOrWhiteSpace($codexHome)) {
    $codexHome = Join-Path $env:USERPROFILE '.codex'
  }

  $markers = @(
    (Join-Path $codexHome 'auth.json'),
    (Join-Path $codexHome 'credentials.json')
  )

  return [bool]($markers | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

function Ensure-CodexLogin {
  param(
    [Parameter(Mandatory = $true)][string]$CodexCommand
  )

  if (Test-CodexLoginMarker) {
    return
  }

  Write-Host '请先完成 Codex 登录。' -ForegroundColor Yellow
  Read-Host '确认后按 Enter 运行 codex --login'
  Invoke-SetupInteractiveStep -StepName 'codex --login' -FilePath $CodexCommand -ArgumentList @('--login') | Out-Null

  Read-Host '确认已完成 Codex 登录后按 Enter 继续'
  if (-not (Test-CodexLoginMarker)) {
    if (-not (Read-YesNo -Prompt '未检测到可用的 Codex 登录标记；如果你刚刚已经完成登录，是否继续安装？' -DefaultYes $false)) {
      throw '未检测到可用的 Codex 登录状态，请确认登录成功后重新运行安装器。'
    }
  }
}

function Resolve-ConfigValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$DefaultValue,
    [switch]$AllowEmpty,
    [switch]$ForcePrompt
  )

  $existingValue = Get-EffectiveEnvValue -Name $Name
  if (-not $ForcePrompt -and -not [string]::IsNullOrWhiteSpace($existingValue)) {
    if ($Repair) {
      return $existingValue
    }

    if (-not (Read-YesNo -Prompt "检测到已有 $Name，是否覆盖？" -DefaultYes $false)) {
      return $existingValue
    }
  }

  while ($true) {
    $entered = Read-Host $Prompt
    $value = if ([string]::IsNullOrWhiteSpace($entered)) { $DefaultValue } else { $entered.Trim() }
    if ($AllowEmpty -or -not [string]::IsNullOrWhiteSpace($value)) {
      return $value
    }

    Write-Host "$Name 不能为空，请重新输入。" -ForegroundColor Yellow
  }
}

function Read-FirstRunConfig {
  $assistantCwd = Get-EffectiveEnvValue -Name 'COMMUNICATE_ASSISTANT_CWD'
  if ([string]::IsNullOrWhiteSpace($assistantCwd)) {
    $assistantCwd = $repoRoot
  }

  if (-not $Repair) {
    $useRepoRoot = Read-YesNo -Prompt "默认工作目录是否使用当前仓库目录？`n$repoRoot" -DefaultYes $true
    if (-not $useRepoRoot) {
      $assistantCwd = Resolve-ConfigValue -Name 'COMMUNICATE_ASSISTANT_CWD' -Prompt '请输入默认工作目录的 Windows 绝对路径' -DefaultValue $assistantCwd
    }
  }

  $debugDefault = Get-EffectiveEnvValue -Name 'COMMUNICATE_FEISHU_DEBUG'
  if ([string]::IsNullOrWhiteSpace($debugDefault)) {
    $debugDefault = '0'
  }

  return [ordered]@{
    FEISHU_APP_ID = Resolve-ConfigValue -Name 'FEISHU_APP_ID' -Prompt '请输入 FEISHU_APP_ID' -DefaultValue ''
    FEISHU_APP_SECRET = Resolve-ConfigValue -Name 'FEISHU_APP_SECRET' -Prompt '请输入 FEISHU_APP_SECRET' -DefaultValue ''
    CODEX_CLI_EXE = Resolve-ConfigValue -Name 'CODEX_CLI_EXE' -Prompt '请输入 CODEX_CLI_EXE（直接回车使用 codex）' -DefaultValue 'codex'
    COMMUNICATE_ASSISTANT_CWD = $assistantCwd
    COMMUNICATE_FEISHU_IMAGE_DIR = Resolve-ConfigValue -Name 'COMMUNICATE_FEISHU_IMAGE_DIR' -Prompt '请输入图片落盘目录（直接回车使用 .\Communicate）' -DefaultValue '.\Communicate'
    COMMUNICATE_FEISHU_DEBUG = if (Read-YesNo -Prompt '是否开启飞书调试日志？' -DefaultYes ($debugDefault -eq '1')) { '1' } else { '0' }
  }
}

function Save-UserEnvironment {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Config
  )

  foreach ($entry in $Config.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'User')
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
  }

  $global:SetupState.envUpdated = $true
}

function Install-And-BuildProject {
  param(
    [Parameter(Mandatory = $true)][string]$NpmCommand
  )

  Invoke-SetupStep -StepName 'npm install' -FilePath $NpmCommand -ArgumentList @('install') -StdoutPath $npmInstallOutLog -StderrPath $npmInstallErrLog -TimeoutSec 2400 | Out-Null
  Invoke-SetupStep -StepName 'npm run build' -FilePath $NpmCommand -ArgumentList @('run', 'build') -StdoutPath $buildOutLog -StderrPath $buildErrLog -TimeoutSec 1200 | Out-Null
}

function Run-DoctorChecks {
  param(
    [Parameter(Mandatory = $true)][string]$NodeCommand
  )

  $doctorResult = Invoke-SetupStep -StepName 'doctor' -FilePath $NodeCommand -ArgumentList @('.\scripts\doctor.cjs', '--json') -StdoutPath $doctorOutLog -StderrPath $doctorErrLog -TimeoutSec 300
  $doctorPayload = Get-Content -Path $doctorResult.StdoutPath -Raw | ConvertFrom-Json
  $global:SetupState.doctorOk = [bool]$doctorPayload.ok
  if (-not $global:SetupState.doctorOk) {
    throw "本地预检仍有 FAIL 项，请检查日志：$doctorOutLog 和 $doctorErrLog"
  }
}

function Write-LauncherScript {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$DelegateScript,
    [string[]]$ArgumentList = @()
  )

  $quotedDelegate = "'$(Split-Path -Leaf $DelegateScript)'"
  $argExpression = if ($ArgumentList.Count -gt 0) {
    ($ArgumentList | ForEach-Object { "'$_'" }) -join ', '
  } else {
    ''
  }
  $launcherCommandLine = if ($ArgumentList.Count -gt 0) {
    "& `$delegateScript @($argExpression)"
  } else {
    '& $delegateScript'
  }

  $content = @(
    '[CmdletBinding()]',
    'param()',
    '',
    "`$delegateScript = Join-Path `$PSScriptRoot $quotedDelegate",
    'if (-not (Test-Path $delegateScript)) {',
    '  throw "缺少委托脚本：$delegateScript"',
    '}',
    'Set-Location $PSScriptRoot',
    $launcherCommandLine
  ) -join "`r`n"

  Write-Utf8BomFile -Path $Path -Content ($content + "`r`n")
}

function New-LauncherScripts {
  Write-LauncherScript -Path $startLauncherPath -DelegateScript $adminScriptPath
  Write-LauncherScript -Path $repairLauncherPath -DelegateScript (Join-Path $repoRoot 'Install-CodexLark.ps1') -ArgumentList @('-Repair')
  $global:SetupState.generatedLaunchers = @('Start-CodexLark.ps1', 'Repair-CodexLark.ps1')
}

function Sync-CanonicalLauncherManifest {
  param(
    [Parameter(Mandatory = $true)][string]$NodeCommand
  )

  $syncScript = "const { ensureSourceRuntimeManifest } = require('./dist/setup/launcher.js'); ensureSourceRuntimeManifest(process.cwd(), process.env);"
  Invoke-SetupStep -StepName 'Sync launcher manifest' -FilePath $NodeCommand -ArgumentList @('-e', $syncScript) -StdoutPath $launcherSyncOutLog -StderrPath $launcherSyncErrLog -TimeoutSec 300 | Out-Null
}

function Configure-OptionalAutostart {
  if (-not (Read-YesNo -Prompt '是否启用开机自启动？' -DefaultYes $false)) {
    Set-StepStatus -Name 'Enable auto-start' -Status 'skipped' -Detail 'User declined optional auto-start setup.'
    Write-Host "已跳过开机自启动配置，你也可以稍后运行 $autostartInstallerPath。"
    return
  }

  if (-not (Test-Path $autostartInstallerPath)) {
    Set-StepStatus -Name 'Enable auto-start' -Status 'warning' -Detail "Missing optional auto-start installer: $autostartInstallerPath"
    Write-Host "未找到开机自启动安装脚本：$autostartInstallerPath" -ForegroundColor Yellow
    return
  }

  $powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

  try {
    Invoke-SetupStep -StepName 'Enable auto-start' -FilePath $powershellExe -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', $autostartInstallerPath) -StdoutPath $autostartOutLog -StderrPath $autostartErrLog -TimeoutSec 900 | Out-Null
    $global:SetupState.autostartEnabled = $true
    Write-Host '已启用开机自启动。'
  } catch {
    $global:SetupState.autostartEnabled = $false
    $global:SetupState.autostartError = $_.Exception.Message
    Write-Host "开机自启动未启用：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "如需稍后重试，可运行：$autostartInstallerPath" -ForegroundColor Yellow
  }
}

function Complete-FirstRun {
  Write-Host ''
  Write-Host '本地前置准备已完成。' -ForegroundColor Green
  Write-Host "- 启动入口：$startLauncherPath"
  Write-Host "- 修复入口：$repairLauncherPath"
  Write-Host "- 安装摘要：$installSummaryPath"
  Write-Host '下一步：请根据你的飞书开放平台配置视频完成后台设置，然后去飞书发一条消息验证链路。'

  if (Read-YesNo -Prompt '是否立即启动飞书长连接？' -DefaultYes $false) {
    & $adminScriptPath
  } else {
    Write-Host '已跳过立即启动，你可以稍后运行 Start-CodexLark.ps1。'
  }
}

Initialize-SetupLogging

try {
  $totalSteps = if ($Repair) { 9 } else { 10 }

  Write-SetupStage -StepNumber 1 -TotalSteps $totalSteps -Title '检查系统支持范围'
  Assert-SupportedPlatform
  Assert-NetworkAccess

  Write-SetupStage -StepNumber 2 -TotalSteps $totalSteps -Title '检查或安装 Node.js'
  $nodeCommand = Ensure-NodeJs

  Write-SetupStage -StepNumber 3 -TotalSteps $totalSteps -Title '检查或安装 Codex CLI'
  Refresh-SessionPath
  Ensure-AppDataNpmOnPath
  $npmCommand = Resolve-CommandSource 'npm'
  if (-not $npmCommand) {
    throw '已检测到 Node.js，但找不到 npm，请检查 Node.js 安装状态。'
  }
  $codexCommand = Ensure-CodexCli -NpmCommand $npmCommand

  Write-SetupStage -StepNumber 4 -TotalSteps $totalSteps -Title '确认 Codex 登录状态'
  Ensure-CodexLogin -CodexCommand $codexCommand

  Write-SetupStage -StepNumber 5 -TotalSteps $totalSteps -Title '收集飞书与本地配置'
  $config = Read-FirstRunConfig
  Save-UserEnvironment -Config $config

  Write-SetupStage -StepNumber 6 -TotalSteps $totalSteps -Title '安装项目依赖并构建'
  Install-And-BuildProject -NpmCommand $npmCommand

  Write-SetupStage -StepNumber 7 -TotalSteps $totalSteps -Title '运行本地 doctor 预检'
  Run-DoctorChecks -NodeCommand $nodeCommand

  Write-SetupStage -StepNumber 8 -TotalSteps $totalSteps -Title '生成后续启动与修复入口'
  New-LauncherScripts
  Sync-CanonicalLauncherManifest -NodeCommand $nodeCommand

  if (-not $Repair) {
    Write-SetupStage -StepNumber 9 -TotalSteps $totalSteps -Title '可选配置开机自启动'
    Configure-OptionalAutostart
  }

  $finalStepNumber = if ($Repair) { 9 } else { 10 }
  Write-SetupStage -StepNumber $finalStepNumber -TotalSteps $totalSteps -Title '完成安装并等待你的启动确认'
  Complete-FirstRun
} catch {
  $global:SetupState.failed = $true
  $global:SetupState.failureMessage = $_.Exception.Message
  $failureData = $_.Exception.Data
  $failureExitCode = 1
  if ($failureData -and $failureData.Contains('ExitCode') -and $null -ne $failureData['ExitCode']) {
    $failureExitCode = [int]$failureData['ExitCode']
  }
  $global:SetupState.failureExitCode = $failureExitCode
  if ($failureData -and $failureData.Contains('StepName')) {
    $global:SetupState.failureStep = [string]$failureData['StepName']
  }
  if ($failureData -and ($failureData.Contains('StdoutPath') -or $failureData.Contains('StderrPath'))) {
    $global:SetupState.failureLogs = [ordered]@{
      stdout = [string]$failureData['StdoutPath']
      stderr = [string]$failureData['StderrPath']
    }
  }
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "安装日志位于：$setupLogDir" -ForegroundColor Yellow
  exit $failureExitCode
} finally {
  Write-InstallSummary
}
