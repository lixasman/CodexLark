import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ProbeResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

class SpawnBlockedError extends Error {
  code = 'EPERM';
}

type InstallSummary = {
  failed?: boolean;
  failureExitCode?: number;
  failureStep?: string;
  failureLogs?: {
    stdout?: string;
    stderr?: string;
  };
  resolvedCommands?: Array<{
    step?: string;
    resolvedPath?: string;
    mode?: string;
    exitCode?: number;
  }>;
  steps?: Array<{
    name?: string;
    status?: string;
    detail?: string;
  }>;
};

function installScriptPath(): string {
  return path.join(process.cwd(), 'Install-CodexLark.ps1');
}

function processRunnerPath(): string {
  return path.join(process.cwd(), 'scripts', 'setup', 'process-runner.ps1');
}

function readInstallerScript(): string {
  return readFileSync(installScriptPath(), 'utf8');
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

function extractOptionalPowerShellFunction(script: string, functionName: string): string | null {
  const marker = `function ${functionName} {`;
  return script.includes(marker) ? extractPowerShellFunction(script, functionName) : null;
}

function buildProbeScript(lines: string[]): string {
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

function createProbeRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function runPowerShellProbe(
  scriptLines: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }
): ProbeResult {
  const probeRoot = createProbeRoot('codexlark-install-behavior-');
  const probeScriptPath = path.join(probeRoot, 'probe.ps1');

  try {
    writeFileSync(probeScriptPath, buildProbeScript(scriptLines), 'utf8');

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScriptPath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            ...options?.env
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options?.timeoutMs ?? 20_000
        }
      );
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        status?: number | null;
      };

      if (execError.code === 'EPERM') {
        throw Object.assign(new Error('Node child_process cannot spawn PowerShell in this environment.'), {
          code: 'EPERM'
        });
      }

      stdout = typeof execError.stdout === 'string' ? execError.stdout : String(execError.stdout ?? '');
      stderr = typeof execError.stderr === 'string' ? execError.stderr : String(execError.stderr ?? '');
      exitCode = execError.status ?? 1;
      return { stdout, stderr, exitCode };
    }

    return { stdout, stderr, exitCode };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function parseMarkedJson<T>(output: string, marker: string): T {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(marker));
  assert.ok(line, `missing ${marker} marker in output:\n${output}`);
  return JSON.parse(line.slice(marker.length)) as T;
}

function writeCmdScript(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join('\r\n')}\r\n`, 'utf8');
}

function setupInstallFunctions(): string[] {
  const script = readInstallerScript();
  const required = [
    'Initialize-SetupLogging',
    'Set-StepStatus',
    'Write-Utf8BomFile',
    'Write-InstallSummary',
    'Get-EffectiveEnvValue',
    'Read-YesNo',
    'Test-CodexLoginMarker',
    'Ensure-CodexLogin',
    'Install-And-BuildProject',
    'Run-DoctorChecks'
  ];
  const optional = [
    'Invoke-SetupStep',
    'Invoke-SetupCommandStep',
    'Invoke-SetupInteractiveStep'
  ];

  return [
    ...required.map((name) => extractPowerShellFunction(script, name)),
    ...optional
      .map((name) => extractOptionalPowerShellFunction(script, name))
      .filter((block): block is string => block !== null)
  ];
}

function buildInstallProbePrelude(repoRoot: string): string[] {
  const runner = processRunnerPath();

  return [
    '$ErrorActionPreference = \'Stop\'',
    ...(existsSync(runner) ? [`. '${escapePowerShellSingleQuoted(runner)}'`] : []),
    ...setupInstallFunctions(),
    `$repoRoot = '${escapePowerShellSingleQuoted(repoRoot)}'`,
    '$setupLogDir = Join-Path $repoRoot \'artifacts\\setup\'',
    '$installSummaryPath = Join-Path $setupLogDir \'install-summary.json\'',
    '$npmInstallOutLog = Join-Path $setupLogDir \'npm-install.out.log\'',
    '$npmInstallErrLog = Join-Path $setupLogDir \'npm-install.err.log\'',
    '$buildOutLog = Join-Path $setupLogDir \'build.out.log\'',
    '$buildErrLog = Join-Path $setupLogDir \'build.err.log\'',
    '$doctorOutLog = Join-Path $setupLogDir \'doctor.out.log\'',
    '$doctorErrLog = Join-Path $setupLogDir \'doctor.err.log\'',
    '$global:SetupState = [ordered]@{',
    '  steps = @()',
    '  resolvedCommands = @()',
    '  doctorOk = $false',
    '}'
  ];
}

function createFakeCommands(root: string): { npmPath: string; nodePath: string; codexPath: string; codexHome: string } {
  const binDir = path.join(root, 'fake-bin');
  const codexHome = path.join(root, 'codex-home');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const npmPath = path.join(binDir, 'npm.cmd');
  writeCmdScript(npmPath, [
    '@echo off',
    'setlocal EnableExtensions',
    'if /I "%~1"=="install" (',
    '  if not "%FAKE_NPM_INSTALL_STDOUT%"=="" echo %FAKE_NPM_INSTALL_STDOUT%',
    '  if not "%FAKE_NPM_INSTALL_STDERR%"=="" >&2 echo %FAKE_NPM_INSTALL_STDERR%',
    '  exit /b %FAKE_NPM_INSTALL_EXIT_CODE%',
    ')',
    'if /I "%~1"=="run" if /I "%~2"=="build" (',
    '  if not "%FAKE_NPM_BUILD_STDOUT%"=="" echo %FAKE_NPM_BUILD_STDOUT%',
    '  if not "%FAKE_NPM_BUILD_STDERR%"=="" >&2 echo %FAKE_NPM_BUILD_STDERR%',
    '  exit /b %FAKE_NPM_BUILD_EXIT_CODE%',
    ')',
    '>&2 echo unexpected npm args %*',
    'exit /b 97'
  ]);

  const nodePath = path.join(binDir, 'node.cmd');
  writeCmdScript(nodePath, [
    '@echo off',
    'setlocal EnableExtensions',
    'if /I "%~2"=="--json" (',
    '  if not "%FAKE_DOCTOR_JSON%"=="" echo %FAKE_DOCTOR_JSON%',
    '  if not "%FAKE_DOCTOR_STDERR%"=="" >&2 echo %FAKE_DOCTOR_STDERR%',
    '  exit /b %FAKE_DOCTOR_EXIT_CODE%',
    ')',
    '>&2 echo unexpected node args %*',
    'exit /b 98'
  ]);

  const codexPath = path.join(binDir, 'codex.cmd');
  writeCmdScript(codexPath, [
    '@echo off',
    'setlocal EnableExtensions',
    'if /I "%~1"=="--login" (',
    '  echo INTERACTIVE LOGIN START',
    '  if not exist "%COMMUNICATE_CODEX_HOME%" mkdir "%COMMUNICATE_CODEX_HOME%"',
    '  > "%COMMUNICATE_CODEX_HOME%\\auth.json" echo {}',
    '  exit /b %FAKE_CODEX_LOGIN_EXIT_CODE%',
    ')',
    '>&2 echo unexpected codex args %*',
    'exit /b 99'
  ]);

  return { npmPath, nodePath, codexPath, codexHome };
}

function runInstallAndBuildProbe(
  t: TestContext,
  env: NodeJS.ProcessEnv
): { run: ProbeResult; summary: InstallSummary; repoRoot: string } {
  const repoRoot = createProbeRoot('codexlark-install-repo-');
  const commands = createFakeCommands(repoRoot);
  const scriptLines = [
    ...buildInstallProbePrelude(repoRoot),
    '$script:probeExitCode = 0',
    'try {',
    `  Install-And-BuildProject -NpmCommand '${escapePowerShellSingleQuoted(commands.npmPath)}'`,
    '} catch {',
    '  $global:SetupState.failed = $true',
    '  $global:SetupState.failureMessage = $_.Exception.Message',
    '  if ($_.Exception.Data.Contains(\'ExitCode\')) { $global:SetupState.failureExitCode = [int]$_.Exception.Data[\'ExitCode\'] }',
    '  if ($_.Exception.Data.Contains(\'StepName\')) { $global:SetupState.failureStep = [string]$_.Exception.Data[\'StepName\'] }',
    '  if ($_.Exception.Data.Contains(\'StdoutPath\') -or $_.Exception.Data.Contains(\'StderrPath\')) {',
    '    $global:SetupState.failureLogs = [ordered]@{',
    '      stdout = [string]$_.Exception.Data[\'StdoutPath\']',
    '      stderr = [string]$_.Exception.Data[\'StderrPath\']',
    '    }',
    '  }',
    '  if ($global:SetupState.failureExitCode -is [int]) {',
    '    $script:probeExitCode = [int]$global:SetupState.failureExitCode',
    '  } else {',
    '    $script:probeExitCode = 1',
    '  }',
    '} finally {',
    '  Write-InstallSummary',
    '  Write-Output (\'__SUMMARY__\' + ((Get-Content -Raw $installSummaryPath | ConvertFrom-Json) | ConvertTo-Json -Compress -Depth 8))',
    '}',
    'exit $script:probeExitCode'
  ];

  let run: ProbeResult;
  try {
    run = runPowerShellProbe(scriptLines, {
      env: {
        ...env,
        COMMUNICATE_CODEX_HOME: commands.codexHome,
        CODEX_HOME: commands.codexHome
      },
      timeoutMs: 20_000
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new SpawnBlockedError('Node child_process cannot spawn PowerShell in this environment.');
    }
    throw error;
  }

  const summary = parseMarkedJson<InstallSummary>(run.stdout, '__SUMMARY__');
  return { run, summary, repoRoot };
}

function runCommandTimeoutProbe(t: TestContext): { run: ProbeResult; result: { elapsedMs: number; timedOut: boolean; message: string } } {
  const repoRoot = createProbeRoot('codexlark-runner-timeout-');
  const timeoutScriptPath = path.join(repoRoot, 'timeout-wrapper.cmd');
  writeCmdScript(timeoutScriptPath, [
    '@echo off',
    'start "bg" /b powershell.exe -NoProfile -Command "Start-Sleep -Seconds 4"',
    'exit /b 0'
  ]);

  const scriptLines = [
    '$ErrorActionPreference = \'Stop\'',
    `. '${escapePowerShellSingleQuoted(processRunnerPath())}'`,
    `$repoRoot = '${escapePowerShellSingleQuoted(repoRoot)}'`,
    `$timeoutScriptPath = '${escapePowerShellSingleQuoted(timeoutScriptPath)}'`,
    '$stdoutLog = Join-Path $repoRoot \'timeout.out.log\'',
    '$stderrLog = Join-Path $repoRoot \'timeout.err.log\'',
    '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
    'try {',
    '  Invoke-CodexLarkCommand -FilePath $timeoutScriptPath -ArgumentList @() -StdoutPath $stdoutLog -StderrPath $stderrLog -WorkingDirectory $repoRoot -TimeoutSec 1 | Out-Null',
    '  $sw.Stop()',
    '  $result = [ordered]@{',
    '    elapsedMs = [int]$sw.ElapsedMilliseconds',
    '    timedOut = $false',
    '    message = \'runner completed unexpectedly\'',
    '  }',
    '} catch {',
    '  if ($sw.IsRunning) { $sw.Stop() }',
    '  $result = [ordered]@{',
    '    elapsedMs = [int]$sw.ElapsedMilliseconds',
    '    timedOut = [bool]$_.Exception.Data[\'TimedOut\']',
    '    message = [string]$_.Exception.Message',
    '  }',
    '}',
    'Write-Output (\'__RESULT__\' + ($result | ConvertTo-Json -Compress -Depth 6))'
  ];

  let run: ProbeResult;
  try {
    run = runPowerShellProbe(scriptLines, { timeoutMs: 15_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new SpawnBlockedError('Node child_process cannot spawn PowerShell in this environment.');
    }
    throw error;
  }

  return {
    run,
    result: parseMarkedJson(run.stdout, '__RESULT__')
  };
}

function runDoctorProbe(t: TestContext, env: NodeJS.ProcessEnv): { run: ProbeResult; result: { stdout: string; stderr: string; doctorOk: boolean } } {
  const repoRoot = createProbeRoot('codexlark-doctor-repo-');
  const commands = createFakeCommands(repoRoot);
  const scriptLines = [
    ...buildInstallProbePrelude(repoRoot),
    `Run-DoctorChecks -NodeCommand '${escapePowerShellSingleQuoted(commands.nodePath)}'`,
    '$result = [ordered]@{',
    '  stdout = [string](Get-Content -LiteralPath $doctorOutLog -Raw)',
    '  stderr = [string](Get-Content -LiteralPath $doctorErrLog -Raw)',
    '  doctorOk = [bool]$global:SetupState.doctorOk',
    '}',
    'Write-Output (\'__RESULT__\' + ($result | ConvertTo-Json -Compress -Depth 6))'
  ];

  let run: ProbeResult;
  try {
    run = runPowerShellProbe(scriptLines, { env, timeoutMs: 20_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new SpawnBlockedError('Node child_process cannot spawn PowerShell in this environment.');
    }
    throw error;
  }

  return {
    run,
    result: parseMarkedJson(run.stdout, '__RESULT__')
  };
}

function runLoginProbe(
  t: TestContext,
  env: NodeJS.ProcessEnv
): { run: ProbeResult; result: { markerExists: boolean; outLogExists: boolean; errLogExists: boolean; mode: string; resolvedPath: string; stepStatuses: string[] } } {
  const repoRoot = createProbeRoot('codexlark-login-repo-');
  const commands = createFakeCommands(repoRoot);
  const scriptLines = [
    ...buildInstallProbePrelude(repoRoot),
    'function global:Get-EffectiveEnvValue {',
    '  param([Parameter(Mandatory = $true)][string]$Name)',
    "  if ($Name -eq 'OPENAI_API_KEY') { return $null }",
    "  $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')",
    '  if (-not [string]::IsNullOrWhiteSpace($processValue)) { return $processValue }',
    "  $userValue = [Environment]::GetEnvironmentVariable($Name, 'User')",
    '  if (-not [string]::IsNullOrWhiteSpace($userValue)) { return $userValue }',
    '  return $null',
    '}',
    `function global:Read-Host { param([string]$Prompt) return '' }`,
    `$env:COMMUNICATE_CODEX_HOME = '${escapePowerShellSingleQuoted(commands.codexHome)}'`,
    `$env:CODEX_HOME = '${escapePowerShellSingleQuoted(commands.codexHome)}'`,
    `Ensure-CodexLogin -CodexCommand '${escapePowerShellSingleQuoted(commands.codexPath)}'`,
    '$result = [ordered]@{',
    '  markerExists = Test-Path (Join-Path $env:COMMUNICATE_CODEX_HOME \'auth.json\')',
    '  outLogExists = Test-Path (Join-Path $setupLogDir \'codex-login.out.log\')',
    '  errLogExists = Test-Path (Join-Path $setupLogDir \'codex-login.err.log\')',
    '  mode = [string]$global:SetupState.resolvedCommands[0].mode',
    '  resolvedPath = [string]$global:SetupState.resolvedCommands[0].resolvedPath',
    '  stepStatuses = @($global:SetupState.steps | Where-Object { $_.name -eq \'codex --login\' } | ForEach-Object { [string]$_.status })',
    '}',
    'Write-Output (\'__RESULT__\' + ($result | ConvertTo-Json -Compress -Depth 6))'
  ];

  let run: ProbeResult;
  try {
    run = runPowerShellProbe(scriptLines, {
      env: {
        ...env,
        COMMUNICATE_CODEX_HOME: commands.codexHome,
        CODEX_HOME: commands.codexHome
      },
      timeoutMs: 20_000
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new SpawnBlockedError('Node child_process cannot spawn PowerShell in this environment.');
    }
    throw error;
  }

  return {
    run,
    result: parseMarkedJson(run.stdout, '__RESULT__')
  };
}

test('installer proceeds to npm run build after npm install succeeds', (t) => {
  let probe;
  try {
    probe = runInstallAndBuildProbe(t, {
      FAKE_NPM_INSTALL_EXIT_CODE: '0',
      FAKE_NPM_INSTALL_STDOUT: 'up to date in 971ms',
      FAKE_NPM_BUILD_EXIT_CODE: '0',
      FAKE_NPM_BUILD_STDOUT: 'build complete'
    });
  } catch (error) {
    if (error instanceof SpawnBlockedError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  const { run, summary, repoRoot } = probe;

  try {
    assert.equal(run.exitCode, 0, run.stderr || run.stdout);
    assert.deepEqual(
      summary.steps?.filter((step) => step.status === 'started').map((step) => step.name),
      ['npm install', 'npm run build']
    );
    assert.deepEqual(
      summary.steps?.filter((step) => step.status === 'passed').map((step) => step.name),
      ['npm install', 'npm run build']
    );
    assert.equal(summary.resolvedCommands?.length, 2);
    assert.equal(summary.resolvedCommands?.every((entry) => entry.resolvedPath?.endsWith('npm.cmd')), true);
    assert.equal(summary.resolvedCommands?.every((entry) => entry.mode === 'non-interactive'), true);
    assert.match(readFileSync(path.join(repoRoot, 'artifacts', 'setup', 'build.out.log'), 'utf8'), /build complete/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('installer summary preserves the real npm install exit code when npm install fails', (t) => {
  let probe;
  try {
    probe = runInstallAndBuildProbe(t, {
      FAKE_NPM_INSTALL_EXIT_CODE: '23',
      FAKE_NPM_INSTALL_STDERR: 'network failed',
      FAKE_NPM_BUILD_EXIT_CODE: '0'
    });
  } catch (error) {
    if (error instanceof SpawnBlockedError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  const { run, summary, repoRoot } = probe;

  try {
    assert.equal(run.exitCode, 23, run.stderr || run.stdout);
    assert.equal(summary.failed, true);
    assert.equal(summary.failureStep, 'npm install');
    assert.equal(summary.failureExitCode, 23);
    assert.match(summary.failureLogs?.stderr ?? '', /npm-install\.err\.log/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('build failures surface the failed step and log paths clearly', (t) => {
  let probe;
  try {
    probe = runInstallAndBuildProbe(t, {
      FAKE_NPM_INSTALL_EXIT_CODE: '0',
      FAKE_NPM_BUILD_EXIT_CODE: '17',
      FAKE_NPM_BUILD_STDERR: 'build exploded'
    });
  } catch (error) {
    if (error instanceof SpawnBlockedError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  const { run, summary, repoRoot } = probe;

  try {
    assert.equal(run.exitCode, 17, run.stderr || run.stdout);
    assert.equal(summary.failureStep, 'npm run build');
    assert.equal(summary.failureExitCode, 17);
    assert.match(summary.failureLogs?.stdout ?? '', /build\.out\.log/i);
    assert.match(summary.failureLogs?.stderr ?? '', /build\.err\.log/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('codex login stays interactive and avoids redirected setup logs', (t) => {
  let probe;
  try {
    probe = runLoginProbe(t, {
      FAKE_CODEX_LOGIN_EXIT_CODE: '0'
    });
  } catch (error) {
    if (error instanceof SpawnBlockedError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  const { run, result } = probe;

  assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  assert.equal(result.markerExists, true);
  assert.equal(result.outLogExists, false);
  assert.equal(result.errLogExists, false);
  assert.equal(result.mode, 'interactive');
  assert.match(result.resolvedPath, /codex\.cmd$/i);
  assert.deepEqual(result.stepStatuses, ['started', 'passed']);
});

test('doctor json stdout stays machine-readable', (t) => {
  let probe;
  try {
    probe = runDoctorProbe(t, {
      FAKE_DOCTOR_EXIT_CODE: '0',
      FAKE_DOCTOR_JSON: '{"ok":true,"checks":[{"name":"node","status":"PASS"}]}',
      FAKE_DOCTOR_STDERR: 'doctor warning'
    });
  } catch (error) {
    if (error instanceof SpawnBlockedError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  const { run, result } = probe;

  assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    ok: true,
    checks: [{ name: 'node', status: 'PASS' }]
  });
  assert.match(result.stderr, /doctor warning/);
  assert.equal(result.doctorOk, true);
});

test('non-interactive runner enforces timeout even when batch wrapper leaves descendants behind', (t) => {
  let probe;
  try {
    probe = runCommandTimeoutProbe(t);
  } catch (error) {
    if (error instanceof SpawnBlockedError) {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  const { run, result } = probe;

  assert.equal(run.exitCode, 0, run.stderr || run.stdout);
  assert.equal(result.timedOut, true);
  assert.match(result.message, /Timed out after 1 seconds/i);
  assert.ok(
    result.elapsedMs < 2500,
    `runner timeout took ${result.elapsedMs}ms; expected a hard timeout close to 1000ms`
  );
});
