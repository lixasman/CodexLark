import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function loadRunAdminTaskScript(): string {
  return readFileSync(path.join(process.cwd(), 'run-admin-task.ps1'), 'utf8');
}

function loadRunAdminTaskScriptBytes(): Buffer {
  return readFileSync(path.join(process.cwd(), 'run-admin-task.ps1'));
}

function extractPowerShellFunction(script: string, functionName: string): string {
  const marker = `function ${functionName} {`;
  const start = script.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${functionName}`);

  let depth = 0;
  let opened = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index];
    if (char === '{') {
      depth += 1;
      opened = true;
    } else if (char === '}') {
      depth -= 1;
      if (opened && depth === 0) {
        return script.slice(start, index + 1);
      }
    }
  }

  throw new Error(`unterminated function ${functionName}`);
}

function loadRunCodexLarkRealtestScript(): string {
  return readFileSync(path.join(process.cwd(), 'run-codexlark-feishu-realtest.ps1'), 'utf8');
}

test('run-admin-task resolves managed artifact paths through a shared fallback helper', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /function Resolve-FeishuManagedArtifactPath\s*\{/);
  assert.match(script, /\$activePidFile = Resolve-FeishuManagedArtifactPath -PreferredPath \$pidFile -InstanceTag \$instanceTag -Kind 'pid'/);
  assert.match(script, /\$activePidRegistryFile = Resolve-FeishuManagedArtifactPath -PreferredPath \$pidRegistryFile -InstanceTag \$instanceTag -Kind 'pid-registry'/);
  assert.match(script, /\$activeInstanceTagFile = Resolve-FeishuManagedArtifactPath -PreferredPath \$instanceTagFile -InstanceTag \$instanceTag -Kind 'instance-tag'/);
  assert.match(script, /\$activeInstanceTagPathFile = Resolve-FeishuManagedArtifactPath -PreferredPath \$instanceTagPathFile -InstanceTag \$instanceTag -Kind 'instance-tag-path'/);
  assert.match(script, /\$activeStdoutPathFile = Resolve-FeishuManagedArtifactPath -PreferredPath \$stdoutPathFile -InstanceTag \$instanceTag -Kind 'stdout-path'/);
  assert.match(script, /\$activeStderrPathFile = Resolve-FeishuManagedArtifactPath -PreferredPath \$stderrPathFile -InstanceTag \$instanceTag -Kind 'stderr-path'/);
});

test('run-admin-task reads tracked long connections from per-instance PID registry snapshots', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /\$pidRegistryCandidates = @\(\$pidRegistryFile\)/);
  assert.match(script, /Get-ChildItem -Path \$logDir -Filter 'feishu-longconn\.pids\.\*\.json' -File -ErrorAction SilentlyContinue/);
  assert.match(script, /foreach \(\$candidatePath in \$pidRegistryCandidates \| Sort-Object -Unique\)/);
});

test('run-admin-task relaunches the elevated script hidden instead of keeping a debug console open', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /Start-Process PowerShell .* -Verb RunAs.*-WindowStyle Hidden/);
  assert.doesNotMatch(script, /Start-Process PowerShell .* -NoExit /);
});

test('run-admin-task forwards tcp proxy diagnostics through the elevated relaunch path with an encoded bootstrap command', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /COMMUNICATE_CODEX_TCP_PROXY_DIAG/);
  assert.match(script, /SetEnvironmentVariable\('COMMUNICATE_CODEX_TCP_PROXY_DIAG'/);
  assert.match(script, /-EncodedCommand /);
  assert.match(script, /Text\.Encoding\]::Unicode\.GetBytes\(\$bootstrapCommand\)/);
  assert.match(script, /Convert\]::ToBase64String\(/);
});

test('run-admin-task writes resolved tcp proxy diagnostics into the current process before spawning node', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /\$tcpProxyDiag = Resolve-EffectiveEnv -Name 'COMMUNICATE_CODEX_TCP_PROXY_DIAG'/);
  assert.match(
    script,
    /if \(-not \[string\]::IsNullOrWhiteSpace\(\$tcpProxyDiag\)\) \{[\s\S]*\$env:COMMUNICATE_CODEX_TCP_PROXY_DIAG = \$tcpProxyDiag/
  );
});

test('run-admin-task elevated bootstrap command round-trips diagnostic env and quoted script paths', (t) => {
  const script = loadRunAdminTaskScript();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'run-admin-task-'));
  const tempScriptPath = path.join(tempRoot, "run-admin-task-o'hare.ps1");
  const diagValue = `diagnostic 'single' "double"`;
  const escapedDiagValue = diagValue.replaceAll("'", "''");
  const probeScript = [
    '$ErrorActionPreference = \'Stop\'',
    extractPowerShellFunction(script, 'Resolve-EffectiveEnv'),
    extractPowerShellFunction(script, 'ConvertTo-SingleQuotedPowerShellLiteral'),
    extractPowerShellFunction(script, 'Get-ElevatedBootstrapCommand'),
    'if ($env:ROUNDTRIP_PROBE -eq \'1\') {',
    '  Write-Output ("diag=" + $env:COMMUNICATE_CODEX_TCP_PROXY_DIAG)',
    '  Write-Output ("path=" + $PSCommandPath)',
    '  exit 0',
    '}',
    `$env:COMMUNICATE_CODEX_TCP_PROXY_DIAG = '${escapedDiagValue}'`,
    '$bootstrapCommand = Get-ElevatedBootstrapCommand',
    '$encodedBootstrapCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrapCommand))',
    '$env:ROUNDTRIP_PROBE = \'1\'',
    'powershell.exe -NoProfile -EncodedCommand $encodedBootstrapCommand'
  ].join('\r\n');

  writeFileSync(tempScriptPath, `\ufeff${probeScript}`, 'utf8');

  try {
    let output: string;
    try {
      output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempScriptPath], {
        encoding: 'utf8',
        timeout: 15_000
      });
    } catch (error) {
      const spawnError = error as NodeJS.ErrnoException;
      if (spawnError.code === 'EPERM') {
        t.skip('Node child_process cannot spawn PowerShell in this environment.');
        return;
      }
      throw error;
    }
    assert.match(output, new RegExp(`diag=${diagValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /path=.*run-admin-task-o'hare\.ps1/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('run-admin-task is saved with a UTF-8 BOM for Windows PowerShell compatibility', () => {
  const bytes = loadRunAdminTaskScriptBytes();

  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('run-admin-task logs hidden bootstrap failures to a stable file before main startup begins', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /\$bootstrapLog = Join-Path \$logDir 'feishu-longconn-bootstrap\.err\.log'/);
  assert.match(script, /function Write-BootstrapFailureLog\s*\{/);
  assert.match(script, /function Assert-StartupPrerequisites\s*\{/);
  assert.match(script, /trap\s*\{/);
  assert.match(script, /Write-BootstrapFailureLog/);
});

test('run-admin-task reports UAC cancellation in the caller terminal and bootstrap log', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /function Test-UacCancellation\s*\{/);
  assert.match(script, /Start-Process PowerShell .* -Verb RunAs.*-ErrorAction Stop/);
  assert.match(script, /catch\s*\{/);
  assert.match(script, /if \(Test-UacCancellation -ErrorRecord \$_\)/);
  assert.match(script, /Write-BootstrapFailureLog -Message '已取消管理员授权，本次未启动飞书长连接。'/);
  assert.match(script, /Write-Host '已取消管理员授权，本次未启动飞书长连接。'/);
  assert.match(script, /exit 1/);
});

test('run-admin-task drains old long connection processes before starting the replacement instance', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /function Wait-FeishuLongConnectionsDrained\s*\{/);
  assert.match(script, /Wait-FeishuLongConnectionsDrained -StartedBefore \$cleanupStartedAt/);

  const drainIndex = script.indexOf('Wait-FeishuLongConnectionsDrained -StartedBefore $cleanupStartedAt');
  const startIndex = script.indexOf('$proc = Start-Process');
  assert.notEqual(drainIndex, -1);
  assert.notEqual(startIndex, -1);
  assert.ok(drainIndex < startIndex, 'expected drain step before Start-Process');
});

test('run-codexlark Feishu realtest script delegates to the hardened admin restart flow', () => {
  const script = loadRunCodexLarkRealtestScript();

  assert.match(script, /\$delegateScript = Join-Path \$PSScriptRoot 'run-admin-task\.ps1'/);
  assert.match(script, /& \$delegateScript/);
});
