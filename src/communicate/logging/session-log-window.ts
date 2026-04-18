import { execFileSync } from 'node:child_process';

type SpawnedWindowProcess = {
  pid?: number;
  kill?: () => boolean;
  unref?: () => void;
};

export type SessionLogWindow = {
  pid?: number;
  close: () => void;
};

export function buildSessionLogWindowCommand(input: { taskId: string; cwd: string; logPath: string }): string {
  const title = escapePowerShellLiteral(`Codex Session ${input.taskId} - ${input.cwd}`);
  const logPath = escapePowerShellLiteral(input.logPath);
  return [
    "$ErrorActionPreference='Continue'",
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$Host.UI.RawUI.WindowTitle = '${title}'`,
    `$logPath = '${logPath}'`,
    "if (-not (Test-Path -LiteralPath $logPath)) { New-Item -ItemType File -Path $logPath -Force | Out-Null }",
    '$utf8 = [System.Text.UTF8Encoding]::new($false, $false)',
    '$decoder = $utf8.GetDecoder()',
    '$charBuffer = New-Object char[] 4096',
    '$position = [int64]0',
    'while ($true) {',
    '  try {',
    '    $item = Get-Item -LiteralPath $logPath -ErrorAction Stop',
    '    if ($position -gt $item.Length) { $position = [int64]0; $decoder = $utf8.GetDecoder() }',
    '    if ($item.Length -gt $position) {',
    '      $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)',
    '      try {',
    '        [void]$stream.Seek($position, [System.IO.SeekOrigin]::Begin)',
    '        $buffer = New-Object byte[] 4096',
    '        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {',
    '          $position += $read',
    '          $flush = $stream.Position -ge $stream.Length',
    '          $chars = $decoder.GetChars($buffer, 0, $read, $charBuffer, 0, $flush)',
    '          if ($chars -gt 0) { [Console]::Out.Write($charBuffer, 0, $chars); [Console]::Out.Flush() }',
    '        }',
    '      } finally { $stream.Dispose() }',
    '    }',
    '  } catch { }',
    '  Start-Sleep -Milliseconds 200',
    '}'
  ].join('; ');
}

export function buildSessionLogWindowLauncherArgs(input: { taskId: string; cwd: string; logPath: string }): string[] {
  const encodedCommand = encodePowerShellCommand(buildSessionLogWindowCommand(input));
  const cwd = escapePowerShellLiteral(input.cwd);
  const launcherScript = [
    `$p = Start-Process -FilePath 'powershell.exe' -WorkingDirectory '${cwd}' -ArgumentList @('-NoExit','-EncodedCommand','${encodedCommand}') -PassThru`,
    '$p.Id'
  ].join('; ');
  return ['-NoProfile', '-Command', launcherScript];
}

export function createSessionLogWindow(input: {
  taskId: string;
  cwd: string;
  logPath: string;
  launchFactory?: (command: string, args: string[]) => SpawnedWindowProcess;
  killFactory?: (pid: number) => void;
}): SessionLogWindow {
  const launchFactory = input.launchFactory ?? defaultLaunchFactory;
  const killFactory = input.killFactory ?? defaultKillFactory;
  const args = buildSessionLogWindowLauncherArgs(input);
  const child = launchFactory('powershell.exe', args);

  return {
    pid: child.pid,
    close() {
      if (typeof child.kill === 'function') {
        try {
          child.kill();
          return;
        } catch {
        }
      }
      if (typeof child.pid === 'number' && Number.isFinite(child.pid)) {
        try {
          killFactory(child.pid);
        } catch {
        }
      }
    }
  };
}

function defaultLaunchFactory(command: string, args: string[]): SpawnedWindowProcess {
  const stdout = execFileSync(command, args, {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
  const pid = Number.parseInt(stdout.split(/\s+/).pop() ?? '', 10);
  return Number.isFinite(pid) ? { pid } : {};
}

function defaultKillFactory(pid: number): void {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true
  });
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
