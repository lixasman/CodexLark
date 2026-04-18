$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = $PSScriptRoot
$distCli = Join-Path $repoRoot 'dist\agent-cli.js'
$logDir = Join-Path $repoRoot 'artifacts\feishu-realtest'
$bootstrapLog = Join-Path $logDir 'feishu-longconn-bootstrap.err.log'
$stdoutLog = Join-Path $logDir 'feishu-longconn.out.log'
$stderrLog = Join-Path $logDir 'feishu-longconn.err.log'
$stdoutPathFile = Join-Path $logDir 'feishu-longconn.stdout-path'
$stderrPathFile = Join-Path $logDir 'feishu-longconn.stderr-path'
$instanceTagPathFile = Join-Path $logDir 'feishu-longconn.instance-tag-path'
$pidFile = Join-Path $logDir 'feishu-longconn.pid'
$pidRegistryFile = Join-Path $logDir 'feishu-longconn.pids.json'
$instanceTagFile = Join-Path $logDir 'feishu-longconn.instance-tag'
$cleanupLog = Join-Path $logDir 'feishu-longconn-cleanup.log'
$registryPath = Join-Path $repoRoot 'logs\communicate\registry.json'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Resolve-EffectiveEnv {
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

function Write-BootstrapFailureLog {
  param(
    [Parameter(Mandatory = $true)][string]$Message
  )

  $line = "[{0}] {1}" -f ((Get-Date).ToString('s')), $Message
  try {
    Add-Content -Path $bootstrapLog -Value $line -Encoding utf8
  } catch {
    # Best-effort bootstrap diagnostics only.
  }
}

function ConvertTo-SingleQuotedPowerShellLiteral {
  param(
    [AllowNull()][string]$Value
  )

  if ($null -eq $Value) {
    return ''
  }

  return $Value.Replace("'", "''")
}

function Get-ElevatedBootstrapCommand {
  $commandSegments = @()
  $tcpProxyDiag = Resolve-EffectiveEnv -Name 'COMMUNICATE_CODEX_TCP_PROXY_DIAG'
  if (-not [string]::IsNullOrWhiteSpace($tcpProxyDiag)) {
    $escapedDiagValue = ConvertTo-SingleQuotedPowerShellLiteral -Value $tcpProxyDiag
    $commandSegments += "[Environment]::SetEnvironmentVariable('COMMUNICATE_CODEX_TCP_PROXY_DIAG', '$escapedDiagValue', 'Process')"
  }

  $escapedScriptPath = ConvertTo-SingleQuotedPowerShellLiteral -Value $PSCommandPath
  $commandSegments += "& '$escapedScriptPath'"
  return [string]::Join('; ', $commandSegments)
}

function Assert-StartupPrerequisites {
  if (-not (Test-Path $distCli)) {
    throw "Missing build artifact: $distCli"
  }

  if ([string]::IsNullOrWhiteSpace((Resolve-EffectiveEnv -Name 'FEISHU_APP_ID'))) {
    throw 'Missing FEISHU_APP_ID.'
  }
  if ([string]::IsNullOrWhiteSpace((Resolve-EffectiveEnv -Name 'FEISHU_APP_SECRET'))) {
    throw 'Missing FEISHU_APP_SECRET.'
  }
  if ([string]::IsNullOrWhiteSpace((Resolve-EffectiveEnv -Name 'CODEX_CLI_EXE'))) {
    throw 'Missing CODEX_CLI_EXE.'
  }

  [void](Get-Command node -ErrorAction Stop)
}

function Test-UacCancellation {
  param(
    [Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord]$ErrorRecord
  )

  $exception = $ErrorRecord.Exception
  $nativeCode = $exception.PSObject.Properties['NativeErrorCode']
  if ($nativeCode -and [int]$nativeCode.Value -eq 1223) {
    return $true
  }

  $message = [string]$exception.Message
  return $message -match 'cancelled by the user|canceled by the user|已取消'
}

trap {
  $detail = $_.ScriptStackTrace
  if ([string]::IsNullOrWhiteSpace($detail)) {
    Write-BootstrapFailureLog -Message $_.Exception.Message
  } else {
    Write-BootstrapFailureLog -Message ("{0}`n{1}" -f $_.Exception.Message, $detail)
  }
  throw
}

Assert-StartupPrerequisites

if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  try {
    $bootstrapCommand = Get-ElevatedBootstrapCommand
    $encodedBootstrapCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrapCommand))
    Start-Process PowerShell -ArgumentList "-ExecutionPolicy Bypass -EncodedCommand $encodedBootstrapCommand" -Verb RunAs -WindowStyle Hidden -ErrorAction Stop | Out-Null
  } catch {
    if (Test-UacCancellation -ErrorRecord $_) {
      Write-BootstrapFailureLog -Message '已取消管理员授权，本次未启动飞书长连接。'
      Write-Host '已取消管理员授权，本次未启动飞书长连接。'
      exit 1
    }
    throw
  }
  exit
}

Set-Location $repoRoot

function Remove-FeishuManagedFiles {
  param(
    [Parameter(Mandatory = $true)][string[]]$Paths
  )

  foreach ($path in $Paths) {
    if ([string]::IsNullOrWhiteSpace($path)) {
      continue
    }

    try {
      if ([System.IO.File]::Exists($path)) {
        [System.IO.File]::Delete($path)
      }
    } catch {
      Write-FeishuCleanupLog ("Failed to delete managed file {0}: {1}" -f $path, $_.Exception.Message)
    }
  }
}

function Write-FeishuManagedTextFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Resolve-FeishuManagedArtifactPath {
  param(
    [Parameter(Mandatory = $true)][string]$PreferredPath,
    [Parameter(Mandatory = $true)][string]$InstanceTag,
    [Parameter(Mandatory = $true)][string]$Kind
  )

  try {
    if ([System.IO.File]::Exists($PreferredPath)) {
      $probe = [System.IO.File]::Open($PreferredPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $probe.Dispose()
      [System.IO.File]::Delete($PreferredPath)
    } else {
      $probe = [System.IO.File]::Open($PreferredPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $probe.Dispose()
      [System.IO.File]::Delete($PreferredPath)
    }
    return $PreferredPath
  } catch {
    $directory = [System.IO.Path]::GetDirectoryName($PreferredPath)
    $extension = [System.IO.Path]::GetExtension($PreferredPath)
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($PreferredPath)
    $fallbackPath = Join-Path $directory ('{0}.{1}{2}' -f $baseName, $InstanceTag, $extension)
    Write-FeishuCleanupLog ("Primary {0} path locked; falling back to {1}" -f $Kind, $fallbackPath)
    try {
      if ([System.IO.File]::Exists($fallbackPath)) {
        [System.IO.File]::Delete($fallbackPath)
      }
    } catch {
      Write-FeishuCleanupLog ("Failed to clear fallback {0} path {1}: {2}" -f $Kind, $fallbackPath, $_.Exception.Message)
    }
    return $fallbackPath
  }
}

function Get-FeishuManagedArtifactFiles {
  $paths = @(
    $pidFile,
    $pidRegistryFile,
    $instanceTagFile,
    $instanceTagPathFile,
    $stdoutPathFile,
    $stderrPathFile
  )

  $patterns = @(
    'feishu-longconn.*.pid',
    'feishu-longconn.pids.*.json',
    'feishu-longconn.*.instance-tag',
    'feishu-longconn.*.instance-tag-path',
    'feishu-longconn.*.stdout-path',
    'feishu-longconn.*.stderr-path'
  )

  foreach ($pattern in $patterns) {
    $paths += @(
      Get-ChildItem -Path $logDir -Filter $pattern -File -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    )
  }

  return @(
    $paths |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
      Sort-Object -Unique
  )
}

function Write-FeishuCleanupLog {
  param(
    [Parameter(Mandatory = $true)][string]$Message
  )

  $line = "[{0}] {1}" -f ((Get-Date).ToString('s')), $Message
  Write-Host $line
  $targetCleanupLog = $cleanupLog
  $activeCleanupLogVar = Get-Variable -Name activeCleanupLog -Scope Script -ErrorAction SilentlyContinue
  if ($activeCleanupLogVar -and -not [string]::IsNullOrWhiteSpace([string]$activeCleanupLogVar.Value)) {
    $targetCleanupLog = [string]$activeCleanupLogVar.Value
  }
  try {
    Add-Content -Path $targetCleanupLog -Value $line -Encoding utf8
  } catch {
    # Cleanup logging must not block restart flow.
  }
}

function Read-TrackedFeishuLongConnections {
  $records = @()

  $pidRegistryCandidates = @($pidRegistryFile)
  $pidRegistryCandidates += @(
    Get-ChildItem -Path $logDir -Filter 'feishu-longconn.pids.*.json' -File -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  )

  foreach ($candidatePath in $pidRegistryCandidates | Sort-Object -Unique) {
    if (-not (Test-Path $candidatePath)) {
      continue
    }

    try {
      $parsed = Get-Content $candidatePath -Raw | ConvertFrom-Json
      foreach ($item in @($parsed)) {
        if ($null -eq $item) {
          continue
        }

        if ($item.PSObject.Properties.Match('pid').Count -eq 0) {
          continue
        }

        $pidValue = 0
        if ([int]::TryParse([string]$item.pid, [ref]$pidValue) -and $pidValue -gt 0) {
          $records += [pscustomobject]@{
            pid = $pidValue
            startedAt = if ([string]::IsNullOrWhiteSpace([string]$item.startedAt)) { $null } else { [string]$item.startedAt }
          }
        }
      }
    } catch {
      Write-Warning "Failed to read PID registry ${candidatePath}: $($_.Exception.Message)"
    }
  }

  if (Test-Path $pidFile) {
    $legacyPidValue = 0
    if ([int]::TryParse(((Get-Content $pidFile -Raw).Trim()), [ref]$legacyPidValue) -and $legacyPidValue -gt 0) {
      if (-not ($records | Where-Object { $_.pid -eq $legacyPidValue })) {
        $records += [pscustomobject]@{
          pid = $legacyPidValue
          startedAt = $null
        }
      }
    }
  }

  return @($records)
}

function Get-TrackedProcessStartStamp {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId
  )

  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  return $process.StartTime.ToUniversalTime().ToString('o')
}

function Test-TrackedFeishuLongConnectionAlive {
  param(
    [Parameter(Mandatory = $true)][pscustomobject]$Record
  )

  $process = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
  if (-not $process) {
    return $false
  }

  if (-not [string]::IsNullOrWhiteSpace([string]$Record.startedAt)) {
    $actualStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
    if ($actualStartedAt -ne [string]$Record.startedAt) {
      Write-Host "Skipping PID $($Record.pid) because start time changed to $actualStartedAt"
      return $false
    }
  }

  return $true
}

function Write-TrackedFeishuLongConnections {
  param(
    [Parameter(Mandatory = $true)][array]$Records,
    [string]$Path = $pidRegistryFile
  )

  $payload = @($Records | ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.pid
      startedAt = if ([string]::IsNullOrWhiteSpace([string]$_.startedAt)) { $null } else { [string]$_.startedAt }
    }
  })

  # ConvertTo-Json collapses a single-item array into an object, so force a stable array payload on disk.
  $json = if ($payload.Count -eq 0) {
    '[]'
  } elseif ($payload.Count -eq 1) {
    "[{0}]" -f (($payload[0] | ConvertTo-Json -Depth 3 -Compress))
  } else {
    $payload | ConvertTo-Json -Depth 3 -Compress
  }

  Write-FeishuManagedTextFile -Path $Path -Content $json
}

function Get-NodeExternalHttpsConnections {
  $nodePids = @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($nodePids.Count -eq 0) {
    return @()
  }

  try {
    return @(
      Get-NetTCPConnection -State Established -ErrorAction Stop | Where-Object {
        $nodePids -contains $_.OwningProcess -and
        $_.RemotePort -eq 443 -and
        $_.RemoteAddress -notin @('127.0.0.1', '::1')
      }
    )
  } catch {
    Write-FeishuCleanupLog ("Failed to inspect node external 443 connections: {0}" -f $_.Exception.Message)
    return @()
  }
}

function Get-SuspectedUntrackedFeishuLongConnections {
  param(
    [array]$TrackedRecords = @(),
    [datetime]$StartedBefore = [DateTime]::MaxValue
  )

  $trackedPidSet = @{}
  foreach ($record in @($TrackedRecords)) {
    if ($null -ne $record -and $record.pid) {
      $trackedPidSet[[int]$record.pid] = $true
    }
  }

  $connections = @(Get-NodeExternalHttpsConnections)
  if ($connections.Count -eq 0) {
    return @()
  }

  $processRows = @{}
  try {
    foreach ($row in @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'node' })) {
      $processRows[[int]$row.ProcessId] = $row
    }
  } catch {
    Write-FeishuCleanupLog ("Failed to inspect node command lines: {0}" -f $_.Exception.Message)
  }

  $candidates = @()
  foreach ($group in @($connections | Group-Object OwningProcess)) {
    $pidValue = 0
    if (-not [int]::TryParse([string]$group.Name, [ref]$pidValue) -or $pidValue -le 0) {
      continue
    }
    if ($trackedPidSet.ContainsKey($pidValue)) {
      continue
    }

    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }
    if ($process.StartTime -ge $StartedBefore) {
      continue
    }

    $commandLine = ''
    if ($processRows.ContainsKey($pidValue)) {
      $commandLine = [string]$processRows[$pidValue].CommandLine
    }

    $reasons = @()
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
      $reasons += 'blank-command-line-with-external-443'
    } elseif ($commandLine -match 'dist\\agent-cli\.js' -and $commandLine -match 'feishu-longconn') {
      $reasons += 'tracked-feishu-command-line'
    } elseif ($commandLine -match 'feishu-longconn') {
      $reasons += 'mentions-feishu-longconn'
    }

    if ($reasons.Count -eq 0) {
      continue
    }

    $remoteEndpoints = @(
      $group.Group |
        ForEach-Object { '{0}:{1}' -f $_.RemoteAddress, $_.RemotePort } |
        Sort-Object -Unique
    )

    $candidates += [pscustomobject]@{
      pid = $pidValue
      startedAt = $process.StartTime.ToUniversalTime().ToString('o')
      commandLine = if ([string]::IsNullOrWhiteSpace($commandLine)) { '<blank>' } else { $commandLine }
      reasons = @($reasons)
      remoteEndpoints = @($remoteEndpoints)
    }
  }

  return @($candidates)
}

function Stop-SuspectedUntrackedFeishuLongConnections {
  param(
    [array]$TrackedRecords = @(),
    [datetime]$StartedBefore = [DateTime]::MaxValue
  )

  $candidates = @(Get-SuspectedUntrackedFeishuLongConnections -TrackedRecords $TrackedRecords -StartedBefore $StartedBefore)
  if ($candidates.Count -eq 0) {
    Write-FeishuCleanupLog 'No suspected untracked Feishu long connection processes found.'
    return
  }

  foreach ($candidate in $candidates) {
    Write-FeishuCleanupLog ("Stopping suspected untracked PID {0} reasons={1} remotes={2}" -f $candidate.pid, (($candidate.reasons -join ',')), (($candidate.remoteEndpoints -join ',')))
    Stop-Process -Id $candidate.pid -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $alive = @($candidates | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 300
  }

  $stillAlive = @($candidates | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
  if ($stillAlive.Count -gt 0) {
    $summary = ($stillAlive | ForEach-Object { '{0}@{1}' -f $_.pid, $_.startedAt }) -join ', '
    throw "Suspected untracked Feishu long connections are still running: $summary"
  }

  Write-FeishuCleanupLog ("Stopped {0} suspected untracked Feishu long connection process(es)." -f $candidates.Count)
}

function Wait-FeishuLongConnectionsDrained {
  param(
    [datetime]$StartedBefore = [DateTime]::MaxValue,
    [int]$TimeoutSec = 10
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $remaining = @(Get-SuspectedUntrackedFeishuLongConnections -TrackedRecords @() -StartedBefore $StartedBefore)
    if ($remaining.Count -eq 0) {
      Write-FeishuCleanupLog 'No older Feishu long connection processes remain before launch.'
      return
    }
    Start-Sleep -Milliseconds 300
  }

  $stillRunning = @(Get-SuspectedUntrackedFeishuLongConnections -TrackedRecords @() -StartedBefore $StartedBefore)
  if ($stillRunning.Count -gt 0) {
    $summary = ($stillRunning | ForEach-Object { '{0}@{1}' -f $_.pid, $_.startedAt }) -join ', '
    throw "Older Feishu long connections are still running before launch: $summary"
  }
}

function Stop-AllFeishuLongConnections {
  $tracked = @(Read-TrackedFeishuLongConnections)

  foreach ($record in $tracked) {
    if (-not (Test-TrackedFeishuLongConnectionAlive -Record $record)) {
      continue
    }

    Write-Host "Stopping tracked Feishu long connection PID: $($record.pid)"
    Stop-Process -Id $record.pid -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $alive = @($tracked | Where-Object { Test-TrackedFeishuLongConnectionAlive -Record $_ })
    if ($alive.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 300
  }

  $stillAlive = @($tracked | Where-Object { Test-TrackedFeishuLongConnectionAlive -Record $_ })
  if ($stillAlive.Count -gt 0) {
    $summary = ($stillAlive | ForEach-Object { "$($_.pid)@$($_.startedAt)" }) -join ', '
    throw "Tracked Feishu long connections are still running: $summary"
  }

  Remove-FeishuManagedFiles -Paths @(Get-FeishuManagedArtifactFiles)
}

function Wait-FeishuReady {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$StdoutLog,
    [Parameter(Mandatory = $true)][string]$StderrLog,
    [int]$TimeoutSec = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
      $stdoutTail = if (Test-Path $StdoutLog) { (Get-Content $StdoutLog -Tail 40) -join "`n" } else { '' }
      $stderrTail = if (Test-Path $StderrLog) { (Get-Content $StderrLog -Tail 40) -join "`n" } else { '' }
      throw "Feishu long connection exited early.`nSTDOUT:`n$stdoutTail`nSTDERR:`n$stderrTail"
    }

    if (Test-Path $StdoutLog) {
      $stdout = Get-Content $StdoutLog -Raw -ErrorAction SilentlyContinue
      if ($stdout -match 'feishu long connection ready') {
        return
      }
    }

    Start-Sleep -Milliseconds 500
  }

  $stdoutTail = if (Test-Path $StdoutLog) { (Get-Content $StdoutLog -Tail 40) -join "`n" } else { '' }
  $stderrTail = if (Test-Path $StderrLog) { (Get-Content $StderrLog -Tail 40) -join "`n" } else { '' }
  throw "Timed out waiting for 'feishu long connection ready'.`nSTDOUT:`n$stdoutTail`nSTDERR:`n$stderrTail"
}

if (-not (Test-Path $distCli)) {
  throw "Missing dist CLI: $distCli"
}

$feishuAppId = Resolve-EffectiveEnv -Name 'FEISHU_APP_ID'
$feishuAppSecret = Resolve-EffectiveEnv -Name 'FEISHU_APP_SECRET'
$codexCliExe = Resolve-EffectiveEnv -Name 'CODEX_CLI_EXE'
$tcpProxyDiag = Resolve-EffectiveEnv -Name 'COMMUNICATE_CODEX_TCP_PROXY_DIAG'
$nodeExe = (Get-Command node -ErrorAction Stop).Source

if ([string]::IsNullOrWhiteSpace($feishuAppId)) {
  throw 'Missing FEISHU_APP_ID.'
}
if ([string]::IsNullOrWhiteSpace($feishuAppSecret)) {
  throw 'Missing FEISHU_APP_SECRET.'
}
if ([string]::IsNullOrWhiteSpace($codexCliExe)) {
  throw 'Missing CODEX_CLI_EXE.'
}

$env:FEISHU_APP_ID = $feishuAppId
$env:FEISHU_APP_SECRET = $feishuAppSecret
$env:CODEX_CLI_EXE = $codexCliExe
if (-not [string]::IsNullOrWhiteSpace($tcpProxyDiag)) {
  $env:COMMUNICATE_CODEX_TCP_PROXY_DIAG = $tcpProxyDiag
}
$env:COMMUNICATE_FEISHU_DEBUG = '1'
$env:COMMUNICATE_SESSION_REGISTRY_PATH = $registryPath
$instanceTag = 'realtest-{0}' -f ([Guid]::NewGuid().ToString('N'))
$env:COMMUNICATE_FEISHU_INSTANCE_TAG = $instanceTag

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$activeCleanupLog = Resolve-FeishuManagedArtifactPath -PreferredPath $cleanupLog -InstanceTag $instanceTag -Kind 'cleanup-log'
Write-FeishuCleanupLog 'Starting Feishu long connection restart sequence.'
$cleanupStartedAt = Get-Date
Stop-AllFeishuLongConnections
Stop-SuspectedUntrackedFeishuLongConnections -TrackedRecords @() -StartedBefore $cleanupStartedAt
Wait-FeishuLongConnectionsDrained -StartedBefore $cleanupStartedAt
Remove-FeishuManagedFiles -Paths @(Get-FeishuManagedArtifactFiles)
$activeStdoutLog = Resolve-FeishuManagedArtifactPath -PreferredPath $stdoutLog -InstanceTag $instanceTag -Kind 'stdout'
$activeStderrLog = Resolve-FeishuManagedArtifactPath -PreferredPath $stderrLog -InstanceTag $instanceTag -Kind 'stderr'
$activePidFile = Resolve-FeishuManagedArtifactPath -PreferredPath $pidFile -InstanceTag $instanceTag -Kind 'pid'
$activePidRegistryFile = Resolve-FeishuManagedArtifactPath -PreferredPath $pidRegistryFile -InstanceTag $instanceTag -Kind 'pid-registry'
$activeInstanceTagFile = Resolve-FeishuManagedArtifactPath -PreferredPath $instanceTagFile -InstanceTag $instanceTag -Kind 'instance-tag'
$activeInstanceTagPathFile = Resolve-FeishuManagedArtifactPath -PreferredPath $instanceTagPathFile -InstanceTag $instanceTag -Kind 'instance-tag-path'
$activeStdoutPathFile = Resolve-FeishuManagedArtifactPath -PreferredPath $stdoutPathFile -InstanceTag $instanceTag -Kind 'stdout-path'
$activeStderrPathFile = Resolve-FeishuManagedArtifactPath -PreferredPath $stderrPathFile -InstanceTag $instanceTag -Kind 'stderr-path'

$arguments = @(
  '.\dist\agent-cli.js',
  'feishu-longconn',
  '--feishuAppId', $env:FEISHU_APP_ID,
  '--feishuAppSecretEnv', 'FEISHU_APP_SECRET',
  '--codexExe', $env:CODEX_CLI_EXE
)

$proc = Start-Process -FilePath $nodeExe `
  -ArgumentList $arguments `
  -WorkingDirectory $repoRoot `
  -PassThru `
  -RedirectStandardOutput $activeStdoutLog `
  -RedirectStandardError $activeStderrLog `
  -WindowStyle Hidden

Write-FeishuManagedTextFile -Path $activePidFile -Content ([string]$proc.Id)
Write-FeishuManagedTextFile -Path $activeInstanceTagFile -Content $instanceTag
Write-FeishuManagedTextFile -Path $activeInstanceTagPathFile -Content $activeInstanceTagFile
Write-FeishuManagedTextFile -Path $activeStdoutPathFile -Content $activeStdoutLog
Write-FeishuManagedTextFile -Path $activeStderrPathFile -Content $activeStderrLog
Write-TrackedFeishuLongConnections -Records @(
  [pscustomobject]@{
    pid = $proc.Id
    startedAt = Get-TrackedProcessStartStamp -ProcessId $proc.Id
  }
) -Path $activePidRegistryFile
Wait-FeishuReady -ProcessId $proc.Id -StdoutLog $activeStdoutLog -StderrLog $activeStderrLog
Write-FeishuCleanupLog ("Feishu long connection ready PID={0} instanceTag={1}" -f $proc.Id, $instanceTag)

Write-Host "Started Feishu long connection PID: $($proc.Id)"
Write-Host "instance tag: $instanceTag"
Write-Host "stdout: $activeStdoutLog"
Write-Host "stderr: $activeStderrLog"
Write-Host "cleanup log: $activeCleanupLog"
Write-Host "registry: $registryPath"
