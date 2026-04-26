[CmdletBinding()]
param(
  [string]$ReleaseRoot,
  [int]$BuildTimeoutSec = 1200,
  [int]$TestTimeoutSec = 1800,
  [int]$PackageTimeoutSec = 1800,
  [string]$BundledNodePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repoRoot 'scripts\setup\process-runner.ps1')

function Resolve-ReleaseDryRunPath {
  param(
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    return Join-Path $repoRoot "artifacts\release-dry-run\$timestamp"
  }

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Path))
}

function Save-ReleaseDryRunSummary {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Specialized.OrderedDictionary]$Summary,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $json = $Summary | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Resolve-ReleaseDryRunCommandSource {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][System.Collections.Specialized.OrderedDictionary]$Summary,
    [Parameter(Mandatory = $true)][string]$SummaryPath
  )

  $resolvedPath = Resolve-CodexLarkCommandSource -Name $Name
  if ([string]::IsNullOrWhiteSpace($resolvedPath)) {
    $message = "Unable to resolve command source: $Name"
    $Summary.preflight.checks = @($Summary.preflight.checks) + @([pscustomobject][ordered]@{
      name = $Name
      status = 'failed'
      resolvedPath = $null
      errorMessage = $message
    })
    $Summary.preflight.status = 'failed'
    $Summary.preflight.failedCommand = $Name
    $Summary.preflight.errorMessage = $message
    Save-ReleaseDryRunSummary -Summary $Summary -Path $SummaryPath
    throw $message
  }

  $Summary.preflight.checks = @($Summary.preflight.checks) + @([pscustomobject][ordered]@{
    name = $Name
    status = 'passed'
    resolvedPath = $resolvedPath
    errorMessage = $null
  })
  $Summary.preflight[$Name] = $resolvedPath
  Save-ReleaseDryRunSummary -Summary $Summary -Path $SummaryPath
  return $resolvedPath
}

function Invoke-ReleaseDryRunStep {
  param(
    [Parameter(Mandatory = $true)][string]$StepKey,
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)][int]$TimeoutSec,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][System.Collections.Specialized.OrderedDictionary]$Summary,
    [Parameter(Mandatory = $true)][string]$SummaryPath
  )

  $stdoutPath = Join-Path $OutputRoot "$StepKey.out.log"
  $stderrPath = Join-Path $OutputRoot "$StepKey.err.log"
  Write-Host "[$StepKey] $DisplayName"

  try {
    $result = Invoke-CodexLarkCommand `
      -FilePath $FilePath `
      -ArgumentList $ArgumentList `
      -StdoutPath $stdoutPath `
      -StderrPath $stderrPath `
      -WorkingDirectory $WorkingDirectory `
      -TimeoutSec $TimeoutSec

  } catch {
    $exception = $_.Exception
    $resolvedPath = $null
    $timedOut = $false

    if ($exception.Data.Contains('ResolvedPath')) {
      $resolvedPath = [string]$exception.Data['ResolvedPath']
    }
    if ($exception.Data.Contains('TimedOut')) {
      $timedOut = [bool]$exception.Data['TimedOut']
    }
    if ($exception.Data.Contains('StdoutPath')) {
      $stdoutPath = [string]$exception.Data['StdoutPath']
    }
    if ($exception.Data.Contains('StderrPath')) {
      $stderrPath = [string]$exception.Data['StderrPath']
    }
    if (-not (Test-Path -LiteralPath $stdoutPath)) {
      Set-Content -Path $stdoutPath -Value '' -Encoding UTF8
    }
    if (-not (Test-Path -LiteralPath $stderrPath)) {
      Set-Content -Path $stderrPath -Value $exception.Message -Encoding UTF8
    }

    $stepRecord = [ordered]@{
      key = $StepKey
      name = $DisplayName
      status = 'failed'
      filePath = $FilePath
      arguments = @($ArgumentList)
      timeoutSec = $TimeoutSec
      exitCode = $null
      durationMs = $null
      resolvedPath = $resolvedPath
      stdoutPath = $stdoutPath
      stderrPath = $stderrPath
      timedOut = $timedOut
      errorMessage = $exception.Message
    }

    $Summary.steps = @($Summary.steps) + @([pscustomobject]$stepRecord)
    Save-ReleaseDryRunSummary -Summary $Summary -Path $SummaryPath
    throw
  }

  if ($result.ExitCode -ne 0) {
    $message = "Step failed: $DisplayName exited with code $($result.ExitCode). See $stdoutPath and $stderrPath"
    $stepRecord = [ordered]@{
      key = $StepKey
      name = $DisplayName
      status = 'failed'
      filePath = $FilePath
      arguments = @($ArgumentList)
      timeoutSec = $TimeoutSec
      exitCode = $result.ExitCode
      durationMs = $result.DurationMs
      resolvedPath = $result.ResolvedPath
      stdoutPath = $stdoutPath
      stderrPath = $stderrPath
      timedOut = $false
      errorMessage = $message
    }

    $Summary.steps = @($Summary.steps) + @([pscustomobject]$stepRecord)
    Save-ReleaseDryRunSummary -Summary $Summary -Path $SummaryPath
    throw $message
  }

  $stepRecord = [ordered]@{
    key = $StepKey
    name = $DisplayName
    status = 'passed'
    filePath = $FilePath
    arguments = @($ArgumentList)
    timeoutSec = $TimeoutSec
    exitCode = $result.ExitCode
    durationMs = $result.DurationMs
    resolvedPath = $result.ResolvedPath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    timedOut = $false
    errorMessage = $null
  }

  $Summary.steps = @($Summary.steps) + @([pscustomobject]$stepRecord)
  Save-ReleaseDryRunSummary -Summary $Summary -Path $SummaryPath
  return $result
}

$releaseRoot = Resolve-ReleaseDryRunPath -Path $ReleaseRoot
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

$summaryPath = Join-Path $releaseRoot 'release-dry-run-summary.json'
$summary = [ordered]@{
  startedAt = (Get-Date).ToString('o')
  repoRoot = $repoRoot
  releaseRoot = $releaseRoot
  docs = [ordered]@{
    runbook = (Join-Path $repoRoot 'docs\workflows\product-installer-release-dry-run.md')
    releaseGates = (Join-Path $repoRoot 'docs\workflows\product-installer-release-gates.md')
    supportMatrix = (Join-Path $repoRoot 'docs\workflows\install-startup-support-matrix.md')
  }
  preflight = [ordered]@{
    status = 'running'
    checks = @()
  }
  steps = @()
  installer = $null
  failed = $false
}

Save-ReleaseDryRunSummary -Summary $summary -Path $summaryPath

try {
  $nodeCommandSource = Resolve-ReleaseDryRunCommandSource -Name 'node' -Summary $summary -SummaryPath $summaryPath
  $npmCommandSource = Resolve-ReleaseDryRunCommandSource -Name 'npm' -Summary $summary -SummaryPath $summaryPath
  $isccCommandSource = Resolve-ReleaseDryRunCommandSource -Name 'iscc' -Summary $summary -SummaryPath $summaryPath

  $summary.preflight.status = 'passed'
  $summary.preflight.node = $nodeCommandSource
  $summary.preflight.npm = $npmCommandSource
  $summary.preflight.iscc = $isccCommandSource
  $summary.preflight.buildScript = (Join-Path $repoRoot 'scripts\package\build-installer.ps1')
  $summary.preflight.testRunner = (Join-Path $repoRoot 'scripts\run-node-tests.cjs')
  Save-ReleaseDryRunSummary -Summary $summary -Path $summaryPath

  Invoke-ReleaseDryRunStep `
    -StepKey '01-build' `
    -DisplayName 'npm run build' `
    -FilePath 'npm' `
    -ArgumentList @('run', 'build') `
    -TimeoutSec $BuildTimeoutSec `
    -WorkingDirectory $repoRoot `
    -OutputRoot $releaseRoot `
    -Summary $summary `
    -SummaryPath $summaryPath | Out-Null

  Invoke-ReleaseDryRunStep `
    -StepKey '02-tests' `
    -DisplayName 'node .\scripts\run-node-tests.cjs' `
    -FilePath 'node' `
    -ArgumentList @('.\scripts\run-node-tests.cjs') `
    -TimeoutSec $TestTimeoutSec `
    -WorkingDirectory $repoRoot `
    -OutputRoot $releaseRoot `
    -Summary $summary `
    -SummaryPath $summaryPath | Out-Null

  $packageArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '.\scripts\package\build-installer.ps1')
  if (-not [string]::IsNullOrWhiteSpace($BundledNodePath)) {
    $packageArgs += @('-BundledNodePath', $BundledNodePath)
  }

  Invoke-ReleaseDryRunStep `
    -StepKey '03-package' `
    -DisplayName 'powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1' `
    -FilePath 'powershell' `
    -ArgumentList $packageArgs `
    -TimeoutSec $PackageTimeoutSec `
    -WorkingDirectory $repoRoot `
    -OutputRoot $releaseRoot `
    -Summary $summary `
    -SummaryPath $summaryPath | Out-Null

  $installer = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'artifacts\packaging\output') -Filter 'CodexLark-Setup-*.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $installer) {
    throw 'Packaging completed without a CodexLark-Setup-*.exe output.'
  }

  $hash = Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
  $summary.installer = [ordered]@{
    path = $installer.FullName
    lastWriteTimeUtc = $installer.LastWriteTimeUtc.ToString('o')
    sha256 = $hash.Hash
  }
  $summary.manualValidation = @(
    'Fresh install the new EXE on a clean Windows machine.',
    'If upgrade behavior matters, install the previous EXE first and then run the new installer over it.',
    'Verify Launch CodexLark, Repair CodexLark, and Uninstall CodexLark are present.',
    'Run the installed export-diagnostics command, confirm setup-diagnostics.json exists, and confirm it is redacted.',
    'Record signing status plus Defender/SmartScreen results, and mark the release as preview if the installer is unsigned.',
    'Finish with an uninstall pass, confirm Program Files is cleaned up, and confirm old Launch/Repair shortcuts no longer point at the removed install.'
  )
  $summary.completedAt = (Get-Date).ToString('o')
  Save-ReleaseDryRunSummary -Summary $summary -Path $summaryPath

  Write-Host ''
  Write-Host "Release dry-run package ready: $($installer.FullName)"
  Write-Host "SHA256: $($hash.Hash)"
  Write-Host "Summary: $summaryPath"
  Write-Host "Logs: $releaseRoot"
  Write-Host ''
  Write-Host 'Next manual validation steps:'
  Write-Host '  1. Fresh install the new EXE on a clean Windows machine.'
  Write-Host '  2. If you need upgrade coverage, install the previous EXE first and then run the new installer over it.'
  Write-Host '  3. Verify Launch CodexLark, Repair CodexLark, and Uninstall CodexLark are present.'
  Write-Host '  4. Run the installed export-diagnostics command, confirm setup-diagnostics.json exists, and confirm it is redacted.'
  Write-Host '  5. Record signing status plus Defender/SmartScreen results, and mark the release as preview if the installer is unsigned.'
  Write-Host '  6. Finish with an uninstall pass, confirm Program Files is cleaned up, confirm old Launch/Repair shortcuts no longer point at the removed install, and record the result in the release notes.'
} catch {
  if ($summary.preflight.status -eq 'running') {
    $summary.preflight.status = 'failed'
    $summary.preflight.errorMessage = $_.Exception.Message
  }
  $summary.failed = $true
  $summary.failureMessage = $_.Exception.Message
  $summary.completedAt = (Get-Date).ToString('o')
  Save-ReleaseDryRunSummary -Summary $summary -Path $summaryPath
  throw
}
