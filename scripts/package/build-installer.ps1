[CmdletBinding()]
param(
  [string]$StageRoot,
  [string]$OutputRoot,
  [string]$AppVersion,
  [string]$BundledNodePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$packagingRoot = Join-Path $repoRoot 'artifacts\packaging'

if (-not $StageRoot) {
  $StageRoot = Join-Path $packagingRoot 'stage'
}

if (-not $OutputRoot) {
  $OutputRoot = Join-Path $packagingRoot 'output'
}

$issPath = Join-Path $repoRoot 'packaging\inno\CodexLark.iss'
$packageJsonPath = Join-Path $repoRoot 'package.json'
$nodeCommand = Get-Command node -ErrorAction Stop
$isccCommand = Get-Command iscc -ErrorAction Stop

if (-not (Test-Path $issPath)) {
  throw "Missing packaging script: $issPath"
}

if (-not $AppVersion) {
  $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
  $AppVersion = [string]$packageJson.version
}

if ([string]::IsNullOrWhiteSpace($AppVersion)) {
  throw 'Unable to resolve AppVersion from package.json.'
}

function Resolve-FullPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Path))
}

function Assert-SafePackagingPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $resolvedPath = Resolve-FullPath -Path $Path
  $resolvedPackagingRoot = Resolve-FullPath -Path $packagingRoot
  $rootWithSeparator = if ($resolvedPackagingRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $resolvedPackagingRoot
  } else {
    $resolvedPackagingRoot + [System.IO.Path]::DirectorySeparatorChar
  }

  if ($resolvedPath -eq $resolvedPackagingRoot -or -not $resolvedPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay under $resolvedPackagingRoot. Refusing unsafe path: $resolvedPath"
  }

  $pathRoot = [System.IO.Path]::GetPathRoot($resolvedPath)
  if ($resolvedPath -eq $pathRoot) {
    throw "$Label cannot point at a filesystem root: $resolvedPath"
  }

  return $resolvedPath
}

function Reset-Directory {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  if (Test-Path $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }

  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Ensure-ParentDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Copy-StagedFile {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $sourcePath = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path $sourcePath)) {
    throw "Missing required packaging input: $sourcePath"
  }

  $destinationPath = Join-Path $StageRoot $RelativePath
  Ensure-ParentDirectory -Path $destinationPath
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

function Copy-StagedDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $sourcePath = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path $sourcePath)) {
    throw "Missing required packaging input: $sourcePath"
  }

  $destinationPath = Join-Path $StageRoot $RelativePath
  Ensure-ParentDirectory -Path $destinationPath
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
}

function Write-Utf8BomFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  Ensure-ParentDirectory -Path $Path
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8Bom)
}

function Resolve-BundledNodePath {
  param(
    [string]$RequestedPath
  )

  $candidate = if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
    (& $nodeCommand.Source -p "process.execPath").Trim()
  } else {
    Resolve-FullPath -Path $RequestedPath
  }

  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw 'Unable to resolve a bundled node.exe path.'
  }

  if (-not (Test-Path $candidate)) {
    throw "Bundled node.exe path does not exist: $candidate"
  }

  $resolvedCandidate = (Resolve-Path $candidate).Path
  if ([System.IO.Path]::GetFileName($resolvedCandidate) -ine 'node.exe') {
    throw "Bundled runtime must resolve to node.exe. Resolved path: $resolvedCandidate"
  }

  return $resolvedCandidate
}

function New-LauncherScripts {
  $startLauncherPath = Join-Path $StageRoot 'Start-CodexLark.ps1'
  $repairLauncherPath = Join-Path $StageRoot 'Repair-CodexLark.ps1'

  $startLauncher = @(
    '[CmdletBinding()]',
    'param()',
    '',
    '$ErrorActionPreference = ''Stop''',
    'Set-StrictMode -Version Latest',
    '$repoRoot = $PSScriptRoot',
    '$runtimeContractPath = Join-Path $repoRoot ''scripts\setup\runtime-contract.ps1''',
    '. $runtimeContractPath',
    '$runtimePaths = Get-CodexLarkRuntimeProductPaths',
    '$runtimeContractLog = Join-Path $runtimePaths.logsRoot ''launcher-launch-runtime-contract.json''',
    '$nodeExe = Join-Path $repoRoot ''node.exe''',
    '$productCli = Join-Path $repoRoot ''dist\setup-product-cli.js''',
    'function Show-LauncherFailureAndWait {',
    '  param([Parameter(Mandatory = $true)][string]$Message)',
    '  Write-Host $Message -ForegroundColor Red',
    '  Read-Host ''按 Enter 键关闭窗口'' | Out-Null',
    '}',
    'try {',
    '  Assert-CodexLarkSupportedHost -EntryPoint ''Start-CodexLark.ps1'' -LogPath $runtimeContractLog -FailureCategory ''unsupported-host'' -SupportDocPath ''docs/workflows/install-startup-support-matrix.md'' -ManualFallbackHint ''Use the manual README.md path and start the Feishu long connection from an administrator FullLanguage PowerShell.'' | Out-Null',
    '  if (-not (Test-Path $nodeExe)) {',
    '    throw "Missing bundled node.exe: $nodeExe"',
    '  }',
    '  if (-not (Test-Path $productCli)) {',
    '    throw "Missing setup product CLI: $productCli"',
    '  }',
    '  Set-Location $repoRoot',
    '  & $nodeExe $productCli launch',
    '  if ($LASTEXITCODE -ne 0) {',
    '    Show-LauncherFailureAndWait -Message ''CodexLark launch did not complete. Read the diagnostics in this window.''',
    '    exit 1',
    '  }',
    '} catch {',
    '  Show-LauncherFailureAndWait -Message ([string]$_.Exception.Message)',
    '  exit 1',
    '}'
  ) -join "`r`n"

  $repairLauncher = @(
    '[CmdletBinding()]',
    'param()',
    '',
    '$ErrorActionPreference = ''Stop''',
    'Set-StrictMode -Version Latest',
    '$repoRoot = $PSScriptRoot',
    '$runtimeContractPath = Join-Path $repoRoot ''scripts\setup\runtime-contract.ps1''',
    '. $runtimeContractPath',
    '$runtimePaths = Get-CodexLarkRuntimeProductPaths',
    '$runtimeContractLog = Join-Path $runtimePaths.logsRoot ''launcher-repair-runtime-contract.json''',
    '$nodeExe = Join-Path $PSScriptRoot ''node.exe''',
    '$productCli = Join-Path $PSScriptRoot ''dist\setup-product-cli.js''',
    'function Show-LauncherFailureAndWait {',
    '  param([Parameter(Mandatory = $true)][string]$Message)',
    '  Write-Host $Message -ForegroundColor Red',
    '  Read-Host ''按 Enter 键关闭窗口'' | Out-Null',
    '}',
    'try {',
    '  Assert-CodexLarkSupportedHost -EntryPoint ''Repair-CodexLark.ps1'' -LogPath $runtimeContractLog -FailureCategory ''unsupported-host'' -SupportDocPath ''docs/workflows/install-startup-support-matrix.md'' -ManualFallbackHint ''Use the manual README.md path or run Repair from an administrator FullLanguage PowerShell.'' | Out-Null',
    '  if (-not (Test-Path $nodeExe)) {',
    '    throw "Missing bundled node.exe: $nodeExe"',
    '  }',
    '  if (-not (Test-Path $productCli)) {',
    '    throw "Missing setup product CLI: $productCli"',
    '  }',
    '  Set-Location $PSScriptRoot',
    '  & $nodeExe $productCli repair',
    '  if ($LASTEXITCODE -ne 0) {',
    '    Show-LauncherFailureAndWait -Message ''Repair flow did not complete. Read the diagnostics in this window.''',
    '    exit 1',
    '  }',
    '} catch {',
    '  Show-LauncherFailureAndWait -Message ([string]$_.Exception.Message)',
    '  exit 1',
    '}'
  ) -join "`r`n"

  Write-Utf8BomFile -Path $startLauncherPath -Content ($startLauncher + "`r`n")
  Write-Utf8BomFile -Path $repairLauncherPath -Content ($repairLauncher + "`r`n")
}

New-Item -ItemType Directory -Path $packagingRoot -Force | Out-Null
$StageRoot = Assert-SafePackagingPath -Path $StageRoot -Label 'StageRoot'
$OutputRoot = Assert-SafePackagingPath -Path $OutputRoot -Label 'OutputRoot'
$bundledNodeSourcePath = Resolve-BundledNodePath -RequestedPath $BundledNodePath

Reset-Directory -Path $StageRoot
Reset-Directory -Path $OutputRoot

Copy-Item -LiteralPath $bundledNodeSourcePath -Destination (Join-Path $StageRoot 'node.exe') -Force
Copy-StagedDirectory -RelativePath 'dist'
Copy-StagedDirectory -RelativePath 'scripts\setup'
Copy-StagedFile -RelativePath 'run-admin-task.ps1'
Copy-StagedFile -RelativePath 'Install-CodexLark-Autostart.ps1'
Copy-StagedFile -RelativePath 'Uninstall-CodexLark-Autostart.ps1'
Copy-StagedFile -RelativePath 'README.md'
Copy-StagedFile -RelativePath 'docs\workflows\install-startup-support-matrix.md'

if (Test-Path (Join-Path $repoRoot 'README.en.md')) {
  Copy-StagedFile -RelativePath 'README.en.md'
}

if (Test-Path (Join-Path $repoRoot 'LICENSE')) {
  Copy-StagedFile -RelativePath 'LICENSE'
}

New-LauncherScripts

& $isccCommand.Source "/DStageDir=$StageRoot" "/DOutputDir=$OutputRoot" "/DAppVersion=$AppVersion" $issPath

$installer = Get-ChildItem -LiteralPath $OutputRoot -Filter 'CodexLark-Setup-*.exe' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $installer) {
  throw "Inno Setup completed without producing an installer under $OutputRoot"
}

Write-Host "Built installer: $($installer.FullName)"
