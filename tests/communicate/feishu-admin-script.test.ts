import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('run-admin-task stages bootstrap diagnostics through an encrypted payload before elevated relaunch', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /\$script:ActiveBootstrapPayloadPath = \$null/);
  assert.match(script, /function Get-BootstrapProcessEnvironmentNames\s*\{/);
  assert.match(script, /'COMMUNICATE_CODEX_TCP_PROXY_DIAG'/);
  assert.match(script, /function Write-BootstrapEnvironmentPayload\s*\{/);
  assert.match(script, /Add-Type -AssemblyName System\.Security/);
  assert.match(script, /ProtectedData\]::Protect/);
  assert.match(script, /-BootstrapEnvPayloadPath '\$escapedPayloadPath'/);
  assert.match(script, /-EncodedCommand /);
  assert.match(script, /Text\.Encoding\]::Unicode\.GetBytes\(\$bootstrapCommand\)/);
  assert.match(script, /Convert\]::ToBase64String\(/);
  assert.match(script, /try \{ & '\$escapedScriptPath' -BootstrapEnvPayloadPath '\$escapedPayloadPath' \} finally \{ if \(Test-Path '\$escapedPayloadPath'\) \{ Remove-Item -LiteralPath '\$escapedPayloadPath' -Force -ErrorAction SilentlyContinue \} \}/);
  assert.doesNotMatch(script, /SetEnvironmentVariable\('\$escapedEnvName', '\$escapedEnvValue', 'Process'\)/);
});

test('run-admin-task stages source-repo launch env through the encrypted bootstrap payload', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /'FEISHU_APP_ID'/);
  assert.match(script, /'FEISHU_APP_SECRET'/);
  assert.match(script, /'CODEX_CLI_EXE'/);
  assert.match(script, /Resolve-EffectiveEnv -Name \$envName/);
  assert.match(script, /function Import-BootstrapEnvironmentPayload\s*\{/);
  assert.match(script, /Add-Type -AssemblyName System\.Security/);
  assert.match(script, /ProtectedData\]::Unprotect/);
  assert.match(script, /\[Environment\]::SetEnvironmentVariable\(\$property.Name, \[string\]\$property.Value, 'Process'\)/);
  assert.match(script, /Import-BootstrapEnvironmentPayload -Path \$BootstrapEnvPayloadPath/);
});

test('run-admin-task writes resolved tcp proxy diagnostics into the current process before spawning node', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /\$tcpProxyDiag = Resolve-EffectiveEnv -Name 'COMMUNICATE_CODEX_TCP_PROXY_DIAG'/);
  assert.match(
    script,
    /if \(-not \[string\]::IsNullOrWhiteSpace\(\$tcpProxyDiag\)\) \{[\s\S]*\$env:COMMUNICATE_CODEX_TCP_PROXY_DIAG = \$tcpProxyDiag/
  );
});

test('run-admin-task restores bootstrap-only node and payload env before elevated prerequisites run', () => {
  const script = loadRunAdminTaskScript();
  const bootstrapEnvNamesFunction = extractPowerShellFunction(script, 'Get-BootstrapProcessEnvironmentNames');

  assert.match(script, /Resolve-EffectiveEnv -Name 'CODEXLARK_BOOTSTRAP_NODE_EXE'/);
  assert.match(bootstrapEnvNamesFunction, /'CODEXLARK_BOOTSTRAP_NODE_EXE'/);
  const importIndex = script.indexOf('Import-BootstrapEnvironmentPayload -Path ');
  const topLevelPrereqIndex = script.lastIndexOf('Assert-StartupPrerequisites');
  assert.notEqual(importIndex, -1);
  assert.notEqual(topLevelPrereqIndex, -1);
  assert.ok(importIndex < topLevelPrereqIndex, 'expected payload import before top-level prerequisite check');
});

test('run-admin-task keeps source-repo launch mode when elevated bootstrap reuses the resolved node path', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /function Resolve-LaunchMode\s*\{/);
  assert.match(script, /launchMode = \$launchMode/);
  assert.match(script, /if \(\[string\]\$NodeResolution\.launchMode -eq 'source-repo'\) \{\s*return Resolve-EnvironmentLaunchEnvironment/);
  assert.doesNotMatch(script, /if \(\[string\]\$NodeResolution\.source -eq 'system-node'\)/);
});

test('run-admin-task preserves supported Codex and lease overrides across the bootstrap payload handoff', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /'CODEX_HOME'/);
  assert.match(script, /'COMMUNICATE_FEISHU_LEASE_DIR'/);
});

test('run-admin-task cleans staged bootstrap payload files when elevation fails early', () => {
  const script = loadRunAdminTaskScript();
  const managedArtifactsFunction = extractPowerShellFunction(script, 'Get-FeishuManagedArtifactFiles');
  const stalePayloadFunction = extractPowerShellFunction(script, 'Get-StaleBootstrapEnvironmentPayloadFiles');

  assert.match(script, /function Remove-BootstrapEnvironmentPayload\s*\{/);
  assert.match(script, /Remove-BootstrapEnvironmentPayload -Path \$script:ActiveBootstrapPayloadPath/);
  assert.doesNotMatch(managedArtifactsFunction, /'feishu-longconn\.bootstrap-env\.\*\.bin'/);
  assert.match(stalePayloadFunction, /'feishu-longconn\.bootstrap-env\.\*\.bin'/);
  assert.match(stalePayloadFunction, /LastWriteTimeUtc -lt \$OlderThanUtc/);
  assert.match(
    script,
    /Remove-FeishuManagedFiles -Paths @\(Get-StaleBootstrapEnvironmentPayloadFiles -OlderThanUtc \$staleBootstrapCutoff -ExcludePath \$script:ActiveBootstrapPayloadPath\)/
  );
});

test('run-admin-task allows empty cleanup batches without masking missing -Paths callsites', (t) => {
  const script = loadRunAdminTaskScript();
  const removeManagedFilesFunction = extractPowerShellFunction(script, 'Remove-FeishuManagedFiles');
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'run-admin-task-cleanup-'));
  const tempScriptPath = path.join(tempRoot, 'remove-managed-files-probe.ps1');
  const probeScript = [
    '$ErrorActionPreference = \'Stop\'',
    'Set-StrictMode -Version Latest',
    'function Write-FeishuCleanupLog { param([string]$Message) }',
    removeManagedFilesFunction,
    '$emptyAccepted = $false',
    '$missingRejected = $false',
    'try {',
    '  Remove-FeishuManagedFiles -Paths @()',
    '  $emptyAccepted = $true',
    '} catch {',
    '  Write-Output ("emptyError=" + $_.Exception.Message)',
    '}',
    'try {',
    '  Remove-FeishuManagedFiles',
    '} catch {',
    '  $missingRejected = $true',
    '}',
    'Write-Output ("emptyAccepted=" + $emptyAccepted)',
    'Write-Output ("missingRejected=" + $missingRejected)'
  ].join('\r\n');

  assert.match(removeManagedFilesFunction, /\[Parameter\(Mandatory = \$true\)\]\[AllowEmptyCollection\(\)\]\[AllowNull\(\)\]\[string\[\]\]\$Paths/);

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

    assert.match(output, /emptyAccepted=True/i);
    assert.match(output, /missingRejected=True/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('run-admin-task resolves launch prerequisites from canonical setup state instead of raw FEISHU_* env vars', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /dist\\setup-cli\.js/);
  assert.match(script, /resolve-launch-env/);
  assert.match(script, /ConvertFrom-Json/);
  assert.doesNotMatch(script, /throw 'Missing FEISHU_APP_ID\.'/);
  assert.doesNotMatch(script, /throw 'Missing FEISHU_APP_SECRET\.'/);
  assert.doesNotMatch(script, /throw 'Missing CODEX_CLI_EXE\.'/);
});

test('run-admin-task does not require FEISHU_APP_SECRET in resolve-launch-env stdout', () => {
  const script = loadRunAdminTaskScript();
  const launchFunction = extractPowerShellFunction(script, 'Resolve-CanonicalLaunchEnvironment');
  const secretFunction = extractPowerShellFunction(script, 'Resolve-CanonicalFeishuAppSecret');

  assert.match(launchFunction, /Resolve-CanonicalFeishuAppSecret/);
  assert.match(launchFunction, /Add-Member[\s\S]*FEISHU_APP_SECRET/);
  assert.doesNotMatch(launchFunction, /\$result\.runtimeEnv\.FEISHU_APP_SECRET/);
  assert.match(secretFunction, /feishuAppSecretRef/);
  assert.match(secretFunction, /ConvertTo-SecureString -String \$protectedValue/);
  assert.match(secretFunction, /PtrToStringBSTR/);
});

test('run-admin-task preserves source-repo fallback when bundled node.exe is absent', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /function Resolve-LaunchNodeExecutable\s*\{/);
  assert.match(script, /function Test-IsSourceRepoLayout\s*\{/);
  assert.match(script, /function Resolve-LaunchMode\s*\{/);
  assert.match(script, /if \(\[string\]\$launchMode -eq 'source-repo'\) \{/);
  assert.match(script, /path = \(Get-Command node -ErrorAction Stop\)\.Source/);
  assert.match(script, /throw "Missing bundled node\.exe: \$bundledNodeExe"/);
  assert.match(script, /function Resolve-EnvironmentLaunchEnvironment\s*\{/);
  assert.match(script, /Resolve-EffectiveEnv -Name 'FEISHU_APP_ID'/);
  assert.match(script, /Resolve-EffectiveEnv -Name 'FEISHU_APP_SECRET'/);
  assert.match(script, /Resolve-EffectiveEnv -Name 'CODEX_CLI_EXE'/);
  const repoBranchIndex = script.indexOf("if ([string]$launchMode -eq 'source-repo') {");
  const bundledBranchIndex = script.indexOf('if (Test-Path $bundledNodeExe) {');
  assert.notEqual(repoBranchIndex, -1);
  assert.notEqual(bundledBranchIndex, -1);
  assert.ok(repoBranchIndex < bundledBranchIndex, 'expected source-repo launch mode to win before bundled node detection');
});

test('run-admin-task keeps runtime logs and markers under LocalAppData-backed product paths', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /Get-CodexLarkRuntimeProductPaths/);
  assert.doesNotMatch(script, /\$logDir = Join-Path \$repoRoot 'artifacts\\feishu-realtest'/);
  assert.doesNotMatch(script, /\$registryPath = Join-Path \$repoRoot 'logs\\communicate\\registry\.json'/);
});

test('run-admin-task elevated bootstrap command round-trips source-repo launch env and diagnostics after clearing the parent process env', (t) => {
  const script = loadRunAdminTaskScript();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'run-admin-task-'));
  const tempScriptPath = path.join(tempRoot, "run-admin-task-o'hare.ps1");
  const diagValue = `diagnostic 'single' "double"`;
  const escapedDiagValue = diagValue.replaceAll("'", "''");
  const escapedTempRoot = tempRoot.replaceAll("'", "''");
  const probeScript = [
    'param([string]$BootstrapEnvPayloadPath)',
    '$ErrorActionPreference = \'Stop\'',
    '$repoRoot = (Get-Location).ProviderPath',
    '$bundledNodeExe = Join-Path $repoRoot \'node.exe\'',
    '$sourceRepoMarkerPath = Join-Path $repoRoot \'package.json\'',
    `$logDir = '${escapedTempRoot}'`,
    '$script:ActiveBootstrapPayloadPath = $null',
    extractPowerShellFunction(script, 'Resolve-EffectiveEnv'),
    extractPowerShellFunction(script, 'Test-IsSourceRepoLayout'),
    extractPowerShellFunction(script, 'Resolve-LaunchMode'),
    extractPowerShellFunction(script, 'Resolve-LaunchNodeExecutable'),
    extractPowerShellFunction(script, 'ConvertTo-SingleQuotedPowerShellLiteral'),
    extractPowerShellFunction(script, 'Get-BootstrapProcessEnvironmentNames'),
    extractPowerShellFunction(script, 'Initialize-BootstrapEnvironmentCrypto'),
    extractPowerShellFunction(script, 'Write-BootstrapEnvironmentPayload'),
    extractPowerShellFunction(script, 'Remove-BootstrapEnvironmentPayload'),
    extractPowerShellFunction(script, 'Import-BootstrapEnvironmentPayload'),
    extractPowerShellFunction(script, 'Get-ElevatedBootstrapCommand'),
    'Import-BootstrapEnvironmentPayload -Path $BootstrapEnvPayloadPath',
    'if ($env:ROUNDTRIP_PROBE -eq \'1\') {',
    '  Write-Output ("appId=" + $env:FEISHU_APP_ID)',
    '  Write-Output ("hasSecret=" + [string](-not [string]::IsNullOrWhiteSpace($env:FEISHU_APP_SECRET)))',
    '  Write-Output ("codexExe=" + $env:CODEX_CLI_EXE)',
    '  Write-Output ("bootstrapNode=" + $env:CODEXLARK_BOOTSTRAP_NODE_EXE)',
    '  Write-Output ("nodeSource=" + (Resolve-LaunchNodeExecutable).source)',
    '  Write-Output ("diag=" + $env:COMMUNICATE_CODEX_TCP_PROXY_DIAG)',
    '  Write-Output ("path=" + $PSCommandPath)',
    '  exit 0',
    '}',
    '$env:FEISHU_APP_ID = \'repo-app-id\'',
    '$env:FEISHU_APP_SECRET = \'repo-app-secret\'',
    '$env:CODEX_CLI_EXE = \'C:\\\\Program Files\\\\nodejs\\\\node.exe\'',
    '$env:CODEXLARK_BOOTSTRAP_NODE_EXE = \'C:\\\\Program Files\\\\nodejs\\\\node.exe\'',
    `$env:COMMUNICATE_CODEX_TCP_PROXY_DIAG = '${escapedDiagValue}'`,
    '$bootstrapCommand = Get-ElevatedBootstrapCommand',
    '$encodedBootstrapCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrapCommand))',
    '[Environment]::SetEnvironmentVariable(\'FEISHU_APP_ID\', $null, \'Process\')',
    '[Environment]::SetEnvironmentVariable(\'FEISHU_APP_SECRET\', $null, \'Process\')',
    '[Environment]::SetEnvironmentVariable(\'CODEX_CLI_EXE\', $null, \'Process\')',
    '[Environment]::SetEnvironmentVariable(\'CODEXLARK_BOOTSTRAP_NODE_EXE\', $null, \'Process\')',
    '[Environment]::SetEnvironmentVariable(\'COMMUNICATE_CODEX_TCP_PROXY_DIAG\', $null, \'Process\')',
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
    const escapedDiagPattern = diagValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(output, /appId=repo-app-id/);
    assert.match(output, /hasSecret=True/i);
    assert.match(output, /codexExe=C:\\\\Program Files\\\\nodejs\\\\node\.exe/i);
    assert.match(output, /bootstrapNode=C:\\\\Program Files\\\\nodejs\\\\node\.exe/i);
    assert.match(output, /nodeSource=bootstrap-node/i);
    assert.match(output, new RegExp(`diag=${escapedDiagPattern}`));
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
  const assignmentMatches = script.match(/\$script:ActiveLaunchStderrPath = /g) ?? [];
  const initialAssignIndex = script.indexOf('$script:ActiveLaunchStderrPath = $stderrLog');
  const activeLogIndex = script.indexOf("$activeStderrLog = Resolve-FeishuManagedArtifactPath -PreferredPath $stderrLog -InstanceTag $instanceTag -Kind 'stderr'");
  const activeAssignIndex = script.indexOf('$script:ActiveLaunchStderrPath = $activeStderrLog');
  const startProcessIndex = script.indexOf('$proc = Start-Process');

  assert.match(script, /\$bootstrapLog = Join-Path \$logDir 'feishu-longconn-bootstrap\.err\.log'/);
  assert.match(script, /\$script:ActiveLaunchStderrPath = \$stderrLog/);
  assert.match(script, /\$script:ActiveLaunchStderrPath = \$activeStderrLog/);
  assert.match(script, /function Write-BootstrapFailureLog\s*\{/);
  assert.match(script, /function Assert-StartupPrerequisites\s*\{/);
  assert.match(script, /trap\s*\{/);
  assert.match(script, /stderrPath = \$script:ActiveLaunchStderrPath/);
  assert.match(script, /Write-BootstrapFailureLog/);
  assert.equal(assignmentMatches.length, 2);
  assert.notEqual(initialAssignIndex, -1);
  assert.notEqual(activeLogIndex, -1);
  assert.notEqual(activeAssignIndex, -1);
  assert.notEqual(startProcessIndex, -1);
  assert.ok(initialAssignIndex < activeAssignIndex, 'expected the fallback stderr assignment before the active-log reassignment');
  assert.ok(activeLogIndex < activeAssignIndex, 'expected active stderr path reassignment after resolving the active stderr log path');
  assert.ok(activeAssignIndex < startProcessIndex, 'expected active stderr path reassignment before launching the node child process');
});

test('run-admin-task parses setup-cli JSON when stderr contains a Node warning', (t) => {
  const script = loadRunAdminTaskScript();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'run-admin-task-json-channel-'));
  const tempScriptPath = path.join(tempRoot, 'setup-cli-json-probe.ps1');
  const fakeNodePath = path.join(tempRoot, 'fake-node.cmd');
  const fakeSetupCliPath = path.join(tempRoot, 'dist', 'setup-cli.js');
  const stateRoot = path.join(tempRoot, 'state');
  const bootstrapLog = path.join(tempRoot, 'bootstrap.err.log');
  const functionSource = extractPowerShellFunction(script, 'Invoke-SetupCliJsonCommand');
  const probeScript = [
    "$ErrorActionPreference = 'Stop'",
    `$setupCli = '${fakeSetupCliPath.replace(/'/g, "''")}'`,
    `$bootstrapLog = '${bootstrapLog.replace(/'/g, "''")}'`,
    `$runtimePaths = [pscustomobject]@{ stateRoot = '${stateRoot.replace(/'/g, "''")}' }`,
    'function Write-BootstrapFailureLog { param([string]$Message) Add-Content -LiteralPath $bootstrapLog -Value $Message -Encoding utf8 }',
    functionSource,
    `$result = Invoke-SetupCliJsonCommand -Command 'resolve-launch-env' -NodeExe '${fakeNodePath.replace(/'/g, "''")}'`,
    "if (-not $result.ok) { throw 'expected ok result' }",
    'if ($result.value -ne 42) { throw "unexpected value: $($result.value)" }',
    "if (-not (Test-Path $bootstrapLog)) { throw 'missing bootstrap stderr log' }",
    '$logText = Get-Content -LiteralPath $bootstrapLog -Raw',
    "if ($logText -notmatch 'DEP0190') { throw 'stderr warning was not logged' }",
    "Write-Output 'json-ok'"
  ].join('\r\n');

  try {
    mkdirSync(path.dirname(fakeSetupCliPath), { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(fakeSetupCliPath, '', 'utf8');
    writeFileSync(
      fakeNodePath,
      '@echo off\r\necho {"ok":true,"value":42}\r\necho (node:1) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities. 1>&2\r\nexit /b 0\r\n',
      'utf8'
    );
    writeFileSync(tempScriptPath, `\ufeff${probeScript}`, 'utf8');

    let output = '';
    try {
      output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempScriptPath], {
        encoding: 'utf8',
        timeout: 15_000
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Node child_process cannot spawn PowerShell in this environment.');
        return;
      }
      throw error;
    }

    assert.match(output, /json-ok/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('run-admin-task resolves canonical Feishu secret locally instead of reading it from setup-cli stdout', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows DPAPI-backed secret resolution is Windows-specific.');
    return;
  }

  const script = loadRunAdminTaskScript();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'run-admin-task-canonical-secret-'));
  const tempScriptPath = path.join(tempRoot, 'canonical-secret-probe.ps1');
  const fakeNodePath = path.join(tempRoot, 'fake-node.cmd');
  const fakeSetupCliPath = path.join(tempRoot, 'dist', 'setup-cli.js');
  const configRoot = path.join(tempRoot, 'config');
  const stateRoot = path.join(tempRoot, 'state');
  const bootstrapLog = path.join(tempRoot, 'bootstrap.err.log');
  const invokeFunction = extractPowerShellFunction(script, 'Invoke-SetupCliJsonCommand');
  const secretFunction = extractPowerShellFunction(script, 'Resolve-CanonicalFeishuAppSecret');
  const launchFunction = extractPowerShellFunction(script, 'Resolve-CanonicalLaunchEnvironment');
  const probeScript = [
    "$ErrorActionPreference = 'Stop'",
    `$setupCli = '${fakeSetupCliPath.replace(/'/g, "''")}'`,
    `$bootstrapLog = '${bootstrapLog.replace(/'/g, "''")}'`,
    `$runtimePaths = [pscustomobject]@{ configRoot = '${configRoot.replace(/'/g, "''")}'; stateRoot = '${stateRoot.replace(/'/g, "''")}' }`,
    'function Write-BootstrapFailureLog { param([string]$Message) Add-Content -LiteralPath $bootstrapLog -Value $Message -Encoding utf8 }',
    invokeFunction,
    secretFunction,
    launchFunction,
    "New-Item -ItemType Directory -Force -Path $runtimePaths.configRoot,(Join-Path $runtimePaths.stateRoot 'secrets') | Out-Null",
    "$protected = ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String 'secret-local-only' -AsPlainText -Force)",
    "$settingsJson = [ordered]@{ feishuAppId = 'app-from-cli'; feishuAppSecretRef = 'secret://feishu-app-secret' } | ConvertTo-Json -Compress",
    "[System.IO.File]::WriteAllText((Join-Path $runtimePaths.configRoot 'settings.json'), $settingsJson, [System.Text.UTF8Encoding]::new($false))",
    "$recordJson = [ordered]@{ protectedValue = $protected } | ConvertTo-Json -Compress",
    "[System.IO.File]::WriteAllText((Join-Path (Join-Path $runtimePaths.stateRoot 'secrets') 'feishu-app-secret.json'), $recordJson, [System.Text.UTF8Encoding]::new($false))",
    `$state = Resolve-CanonicalLaunchEnvironment -NodeExe '${fakeNodePath.replace(/'/g, "''")}'`,
    "if ([string]$state.runtimeEnv.FEISHU_APP_SECRET -ne 'secret-local-only') { throw 'secret was not resolved locally' }",
    "if ([string]$state.runtimeEnv.FEISHU_APP_ID -ne 'app-from-cli') { throw 'safe runtime env was not preserved' }",
    "Write-Output 'canonical-secret-ok'"
  ].join('\r\n');

  try {
    mkdirSync(path.dirname(fakeSetupCliPath), { recursive: true });
    writeFileSync(fakeSetupCliPath, '', 'utf8');
    writeFileSync(
      fakeNodePath,
      '@echo off\r\necho {"ok":true,"runtimeEnv":{"FEISHU_APP_ID":"app-from-cli","CODEX_CLI_EXE":"D:\\\\Tools\\\\codex.cmd"}}\r\nexit /b 0\r\n',
      'utf8'
    );
    writeFileSync(tempScriptPath, `\ufeff${probeScript}`, 'utf8');

    let output = '';
    try {
      output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempScriptPath], {
        encoding: 'utf8',
        timeout: 15_000
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Node child_process cannot spawn PowerShell in this environment.');
        return;
      }
      throw error;
    }

    assert.match(output, /canonical-secret-ok/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('run-admin-task keeps setup-cli stderr out of the JSON parse channel', () => {
  const script = loadRunAdminTaskScript();
  const fn = extractPowerShellFunction(script, 'Invoke-SetupCliJsonCommand');

  assert.doesNotMatch(fn, /2>&1/);
  assert.match(fn, /\$previousErrorActionPreference = \$ErrorActionPreference/);
  assert.match(fn, /\$ErrorActionPreference = 'Continue'/);
  assert.match(fn, />\s+\$stdoutPath\s+2>\s+\$stderrPath/);
  assert.match(fn, /ConvertFrom-Json/);
  assert.match(fn, /Write-BootstrapFailureLog/);
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

test('run-admin-task treats raced tracked-process start-time reads as stale cleanup records instead of failing launch', () => {
  const script = loadRunAdminTaskScript();

  assert.match(script, /function Test-TrackedFeishuLongConnectionAlive\s*\{/);
  assert.match(
    script,
    /try \{\s*\$actualStartedAt = \$process\.StartTime\.ToUniversalTime\(\)\.ToString\('o'\)\s*\} catch \{\s*Write-Host "Skipping PID \$\(\$Record\.pid\) because the tracked process exited before its start time could be verified\."\s*return \$false\s*\}/
  );
});

test('run-codexlark Feishu realtest script delegates to the hardened admin restart flow', () => {
  const script = loadRunCodexLarkRealtestScript();

  assert.match(script, /\$delegateScript = Join-Path \$PSScriptRoot 'run-admin-task\.ps1'/);
  assert.match(script, /& \$delegateScript/);
});
