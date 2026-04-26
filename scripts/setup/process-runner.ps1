Set-StrictMode -Version Latest

function Resolve-CodexLarkCommandSource {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Name
  )

  if (Test-Path -LiteralPath $Name) {
    return (Resolve-Path -LiteralPath $Name -ErrorAction Stop).ProviderPath
  }

  $commands = @(Get-Command $Name -All -ErrorAction SilentlyContinue)
  if ($commands.Count -eq 0) {
    return $null
  }

  $applicationCommand = $commands | Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
  if ($applicationCommand) {
    return $applicationCommand.Source
  }

  return ($commands | Select-Object -First 1).Source
}

function Initialize-CodexLarkProcessLogs {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )

  foreach ($path in @($StdoutPath, $StderrPath)) {
    $parent = Split-Path -Parent $path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
  }

  Remove-Item -Path @($StdoutPath, $StderrPath) -Force -ErrorAction SilentlyContinue
}

function ConvertTo-CodexLarkProcessArgument {
  [CmdletBinding()]
  param(
    [AllowNull()][string]$Value
  )

  if ($null -eq $Value -or $Value.Length -eq 0) {
    return '""'
  }

  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashCount = 0

  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq '\') {
      $backslashCount += 1
      continue
    }

    if ($char -eq '"') {
      if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
        $backslashCount = 0
      }

      [void]$builder.Append('\"')
      continue
    }

    if ($backslashCount -gt 0) {
      [void]$builder.Append(('\' * $backslashCount))
      $backslashCount = 0
    }

    [void]$builder.Append($char)
  }

  if ($backslashCount -gt 0) {
    [void]$builder.Append(('\' * ($backslashCount * 2)))
  }

  [void]$builder.Append('"')
  return $builder.ToString()
}

function ConvertTo-CodexLarkProcessArguments {
  [CmdletBinding()]
  param(
    [string[]]$ArgumentList = @()
  )

  if ($null -eq $ArgumentList -or $ArgumentList.Count -eq 0) {
    return ''
  }

  return ($ArgumentList | ForEach-Object { ConvertTo-CodexLarkProcessArgument -Value ([string]$_) }) -join ' '
}

function New-CodexLarkProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ResolvedPath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = (Get-Location).Path,
    [switch]$Interactive
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $ResolvedPath
  $startInfo.Arguments = ConvertTo-CodexLarkProcessArguments -ArgumentList $ArgumentList
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = -not $Interactive
  $startInfo.RedirectStandardOutput = -not $Interactive
  $startInfo.RedirectStandardError = -not $Interactive

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  return $process
}

function New-CodexLarkTimeoutException {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$TimeoutSec,
    [Parameter(Mandatory = $true)][string]$ResolvedPath,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $timeoutError = [System.TimeoutException]::new("Timed out after $TimeoutSec seconds.")
  $timeoutError.Data['TimedOut'] = $true
  $timeoutError.Data['ResolvedPath'] = $ResolvedPath
  if (-not [string]::IsNullOrWhiteSpace($StdoutPath)) {
    $timeoutError.Data['StdoutPath'] = $StdoutPath
  }
  if (-not [string]::IsNullOrWhiteSpace($StderrPath)) {
    $timeoutError.Data['StderrPath'] = $StderrPath
  }
  return $timeoutError
}

function Get-CodexLarkRemainingTimeoutMs {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Stopwatch,
    [Parameter(Mandatory = $true)][int]$TimeoutSec
  )

  return [Math]::Max(0, ($TimeoutSec * 1000) - [int]$Stopwatch.ElapsedMilliseconds)
}

function Get-CodexLarkDescendantProcessIds {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$RootId
  )

  $pending = New-Object 'System.Collections.Generic.Queue[int]'
  $pending.Enqueue($RootId)
  $descendants = New-Object 'System.Collections.Generic.List[int]'

  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
      $childId = [int]$child.ProcessId
      if (-not $descendants.Contains($childId)) {
        $descendants.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }

  return @($descendants)
}

function Stop-CodexLarkProcessTree {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$RootId
  )

  $processIds = @(Get-CodexLarkDescendantProcessIds -RootId $RootId)
  $processIds += $RootId

  foreach ($processIdToStop in ($processIds | Select-Object -Unique | Sort-Object -Descending)) {
    Stop-Process -Id $processIdToStop -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-CodexLarkCommand {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [string]$WorkingDirectory = (Get-Location).Path,
    [int]$TimeoutSec = 1200
  )

  $resolvedPath = Resolve-CodexLarkCommandSource -Name $FilePath
  if ([string]::IsNullOrWhiteSpace($resolvedPath)) {
    throw "Unable to resolve command source: $FilePath"
  }

  Initialize-CodexLarkProcessLogs -StdoutPath $StdoutPath -StderrPath $StderrPath

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = $null
  $stdoutStream = $null
  $stderrStream = $null
  $stdoutTask = $null
  $stderrTask = $null
  $timedOut = $false

  try {
    $stdoutStream = [System.IO.File]::Open($StdoutPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $stderrStream = [System.IO.File]::Open($StderrPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $process = New-CodexLarkProcess -ResolvedPath $resolvedPath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory

    if (-not $process.Start()) {
      throw "Failed to start process: $resolvedPath"
    }

    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
    $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrStream)

    $remainingMs = Get-CodexLarkRemainingTimeoutMs -Stopwatch $stopwatch -TimeoutSec $TimeoutSec
    if (-not $process.WaitForExit($remainingMs)) {
      $timedOut = $true
    }

    if (-not $timedOut) {
      $remainingMs = Get-CodexLarkRemainingTimeoutMs -Stopwatch $stopwatch -TimeoutSec $TimeoutSec
      if (-not $stdoutTask.Wait($remainingMs)) {
        $timedOut = $true
      }
    }

    if (-not $timedOut) {
      $remainingMs = Get-CodexLarkRemainingTimeoutMs -Stopwatch $stopwatch -TimeoutSec $TimeoutSec
      if (-not $stderrTask.Wait($remainingMs)) {
        $timedOut = $true
      }
    }

    if ($timedOut) {
      Stop-CodexLarkProcessTree -RootId $process.Id
      if ($stdoutTask) {
        [void]$stdoutTask.Wait(1000)
      }
      if ($stderrTask) {
        [void]$stderrTask.Wait(1000)
      }
      throw (New-CodexLarkTimeoutException -TimeoutSec $TimeoutSec -ResolvedPath $resolvedPath -StdoutPath $StdoutPath -StderrPath $StderrPath)
    }

    $process.WaitForExit()
    $null = $stdoutTask.GetAwaiter().GetResult()
    $null = $stderrTask.GetAwaiter().GetResult()
    $stdoutStream.Flush()
    $stderrStream.Flush()

    return [pscustomobject]@{
      ExitCode = [int]$process.ExitCode
      StdoutPath = $StdoutPath
      StderrPath = $StderrPath
      ResolvedPath = $resolvedPath
      DurationMs = [int]$stopwatch.ElapsedMilliseconds
      Mode = 'non-interactive'
    }
  } finally {
    $stopwatch.Stop()
    if ($stdoutTask) {
      try {
        if ($timedOut) {
          [void]$stdoutTask.Wait(1000)
        } else {
          $null = $stdoutTask.GetAwaiter().GetResult()
        }
      } catch {
      }
    }
    if ($stderrTask) {
      try {
        if ($timedOut) {
          [void]$stderrTask.Wait(1000)
        } else {
          $null = $stderrTask.GetAwaiter().GetResult()
        }
      } catch {
      }
    }
    if ($stdoutStream) {
      $stdoutStream.Dispose()
    }
    if ($stderrStream) {
      $stderrStream.Dispose()
    }
    if ($process) {
      $process.Dispose()
    }
  }
}

function Invoke-CodexLarkInteractiveCommand {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = (Get-Location).Path
  )

  $resolvedPath = Resolve-CodexLarkCommandSource -Name $FilePath
  if ([string]::IsNullOrWhiteSpace($resolvedPath)) {
    throw "Unable to resolve command source: $FilePath"
  }

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = $null

  try {
    $process = New-CodexLarkProcess -ResolvedPath $resolvedPath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -Interactive
    if (-not $process.Start()) {
      throw "Failed to start process: $resolvedPath"
    }

    $process.WaitForExit()
    $exitCode = [int]$process.ExitCode
  } finally {
    $stopwatch.Stop()
    if ($process) {
      $process.Dispose()
    }
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    ResolvedPath = $resolvedPath
    DurationMs = [int]$stopwatch.ElapsedMilliseconds
    Mode = 'interactive'
  }
}
