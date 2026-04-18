import { execFileSync } from 'node:child_process';

export type CodexProcessInfo = {
  pid: number;
  commandLine?: string;
  user?: string;
};

export function filterCodexCliProcesses(processes: CodexProcessInfo[]): CodexProcessInfo[] {
  return processes.filter((proc) => {
    const cmd = (proc.commandLine || '').toLowerCase();
    if (!cmd.includes('codex')) return false;
    if (cmd.includes('app-server')) return false;
    return true;
  });
}

export function listCodexCliProcesses(): CodexProcessInfo[] {
  const output = execFileSync('powershell', [
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ], { encoding: 'utf8' });

  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId),
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : ''
    }))
    .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
}

export function terminateCodexCliProcesses(processes: CodexProcessInfo[]): { killed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let killed = 0;
  let failed = 0;
  for (const proc of processes) {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      killed += 1;
    } catch (error) {
      failed += 1;
      errors.push(String(error));
    }
  }
  return { killed, failed, errors };
}

