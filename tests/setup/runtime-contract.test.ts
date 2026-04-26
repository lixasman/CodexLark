import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runtimeContractPath(): string {
  return path.join(process.cwd(), 'scripts', 'setup', 'runtime-contract.ps1');
}

function readRuntimeContractScript(): string {
  return readFileSync(runtimeContractPath(), 'utf8');
}

function readPowerShellScript(name: string): string {
  return readFileSync(path.join(process.cwd(), name), 'utf8');
}

function createProbeRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'codexlark-runtime-contract-'));
}

function buildProbeScript(lines: string[]): string {
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function runPowerShellProbe(
  executable: 'powershell.exe' | 'pwsh.exe',
  scriptLines: string[],
  options?: {
    timeoutMs?: number;
  }
): { stdout: string; stderr: string; exitCode: number } {
  const probeRoot = createProbeRoot();
  const probeScriptPath = path.join(probeRoot, 'probe.ps1');

  try {
    require('node:fs').writeFileSync(probeScriptPath, buildProbeScript(scriptLines), 'utf8');
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = execFileSync(
        executable,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScriptPath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options?.timeoutMs ?? 15_000
        }
      );
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        status?: number | null;
      };
      if (execError.code === 'EPERM') {
        throw Object.assign(new Error(`${executable} spawn was blocked in this environment.`), { code: 'EPERM' });
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

test('runtime contract helper exists and entry scripts invoke it before sensitive flows', () => {
  assert.equal(existsSync(runtimeContractPath()), true);

  const helper = readRuntimeContractScript();
  assert.match(helper, /function Get-CodexLarkRuntimeInfo\s*\{/);
  assert.match(helper, /function Assert-CodexLarkSupportedHost\s*\{/);
  assert.match(helper, /function Write-CodexLarkTerminalError\s*\{/);
  assert.match(helper, /\[AllowNull\(\)\]\[psobject\]\$RuntimeOverride/);
  assert.match(helper, /Get-CodexLarkRuntimeInfo -RuntimeOverride \$RuntimeOverride/);
  assert.match(helper, /FailureCategory = 'unsupported-host'/);
  assert.match(helper, /失败类别：\{0\}/);
  assert.match(helper, /日志路径：\{0\}/);
  assert.doesNotMatch(helper, /CODEXLARK_TEST_/);
  assert.match(helper, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(helper, /WriteAllText\(\$LogPath, \$json, \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)/);
  assert.doesNotMatch(helper, /Set-Content -LiteralPath \$LogPath -Encoding utf8/);

  const installScript = readPowerShellScript('Install-CodexLark.ps1');
  assert.match(installScript, /scripts\\setup\\runtime-contract\.ps1/);
  assert.match(installScript, /runtime-contract\.json/);
  assert.match(installScript, /Assert-CodexLarkSupportedHost[\s\S]*Assert-SupportedPlatform[\s\S]*Assert-NetworkAccess/);

  const adminScript = readPowerShellScript('run-admin-task.ps1');
  assert.match(adminScript, /scripts\\setup\\runtime-contract\.ps1/);
  assert.match(adminScript, /feishu-longconn-runtime-contract\.json/);
  assert.match(adminScript, /Assert-CodexLarkSupportedHost[\s\S]*Assert-StartupPrerequisites[\s\S]*Start-Process PowerShell/);

  const autostartInstaller = readPowerShellScript('Install-CodexLark-Autostart.ps1');
  assert.match(autostartInstaller, /scripts\\setup\\runtime-contract\.ps1/);
  assert.match(autostartInstaller, /autostart-install-runtime-contract\.json/);
  assert.match(autostartInstaller, /param\(\s*\[string\]\$TaskUser\s*\)/);
  assert.doesNotMatch(autostartInstaller, /\[string\]\$TaskUser\s*=\s*\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(autostartInstaller, /Assert-CodexLarkSupportedHost[\s\S]*Ensure-Administrator[\s\S]*Register-ScheduledTask/);
  assert.match(
    autostartInstaller,
    /Assert-CodexLarkSupportedHost[\s\S]*if \(\[string\]::IsNullOrWhiteSpace\(\$TaskUser\)\) \{[\s\S]*\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/
  );
  const autostartInstallerPreContract = autostartInstaller.slice(0, autostartInstaller.indexOf('$runtimeContract = Assert-CodexLarkSupportedHost'));
  assert.doesNotMatch(autostartInstallerPreContract, /\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)/);

  const autostartUninstaller = readPowerShellScript('Uninstall-CodexLark-Autostart.ps1');
  assert.match(autostartUninstaller, /scripts\\setup\\runtime-contract\.ps1/);
  assert.match(autostartUninstaller, /autostart-uninstall-runtime-contract\.json/);
  assert.match(autostartUninstaller, /Assert-CodexLarkSupportedHost[\s\S]*Ensure-Administrator[\s\S]*Get-ScheduledTask/);
});

test('runtime contract records PowerShell version, edition, and language mode for Windows PowerShell and pwsh', (t) => {
  const helperPath = runtimeContractPath();
  const logRoot = createProbeRoot();

  try {
    const windowsPsLogPath = path.join(logRoot, 'windows-powershell-runtime.json');
    const pwshLogPath = path.join(logRoot, 'pwsh-runtime.json');

    const windowsPsProbe = [
      '$ErrorActionPreference = \'Stop\'',
      `. '${escapePowerShellSingleQuoted(helperPath)}'`,
      `$override = [pscustomobject]@{ psEdition = 'Desktop'; psVersion = '5.1.26100.8115'; languageMode = 'FullLanguage'; supportsScheduledTasks = $true; isAdministrator = $false }`,
      `$result = Assert-CodexLarkSupportedHost -EntryPoint 'runtime-contract.test' -FailureCategory 'unsupported-host' -LogPath '${escapePowerShellSingleQuoted(windowsPsLogPath)}' -SupportDocPath 'README.md' -ManualFallbackHint 'README.md#快速开始' -RuntimeOverride $override`,
      '$result | ConvertTo-Json -Compress -Depth 6'
    ];
    const pwshProbe = [
      '$ErrorActionPreference = \'Stop\'',
      `. '${escapePowerShellSingleQuoted(helperPath)}'`,
      `$override = [pscustomobject]@{ psEdition = 'Core'; psVersion = '7.6.0'; languageMode = 'FullLanguage'; supportsScheduledTasks = $true; isAdministrator = $false }`,
      `$result = Assert-CodexLarkSupportedHost -EntryPoint 'runtime-contract.test' -FailureCategory 'unsupported-host' -LogPath '${escapePowerShellSingleQuoted(pwshLogPath)}' -SupportDocPath 'README.md' -ManualFallbackHint 'README.md#快速开始' -RuntimeOverride $override`,
      '$result | ConvertTo-Json -Compress -Depth 6'
    ];

    let windowsPsRun;
    try {
      windowsPsRun = runPowerShellProbe('powershell.exe', windowsPsProbe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Node child_process cannot spawn powershell.exe in this environment.');
        return;
      }
      throw error;
    }

    let pwshRun;
    try {
      pwshRun = runPowerShellProbe('pwsh.exe', pwshProbe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Node child_process cannot spawn pwsh.exe in this environment.');
        return;
      }
      throw error;
    }

    assert.equal(windowsPsRun.exitCode, 0, windowsPsRun.stderr || windowsPsRun.stdout);
    assert.equal(pwshRun.exitCode, 0, pwshRun.stderr || pwshRun.stdout);

    const windowsPsResult = JSON.parse(windowsPsRun.stdout.trim()) as {
      runtime: { psEdition: string; psVersion: string; languageMode: string };
    };
    const pwshResult = JSON.parse(pwshRun.stdout.trim()) as {
      runtime: { psEdition: string; psVersion: string; languageMode: string };
    };

    assert.equal(windowsPsResult.runtime.psEdition, 'Desktop');
    assert.match(windowsPsResult.runtime.psVersion, /^5\.1\./);
    assert.match(windowsPsResult.runtime.languageMode, /Language$/);

    assert.equal(pwshResult.runtime.psEdition, 'Core');
    assert.match(pwshResult.runtime.psVersion, /^7\./);
    assert.match(pwshResult.runtime.languageMode, /Language$/);

    const windowsPsLog = JSON.parse(readFileSync(windowsPsLogPath, 'utf8')) as {
      runtime: { psEdition: string; psVersion: string; languageMode: string };
    };
    const pwshLog = JSON.parse(readFileSync(pwshLogPath, 'utf8')) as {
      runtime: { psEdition: string; psVersion: string; languageMode: string };
    };

    assert.deepEqual(Object.keys(windowsPsLog.runtime).sort(), Object.keys(pwshLog.runtime).sort());
    assert.equal(windowsPsLog.runtime.psEdition, 'Desktop');
    assert.equal(pwshLog.runtime.psEdition, 'Core');
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('unsupported host errors include failure category, log path, and manual fallback guidance', (t) => {
  const helperPath = runtimeContractPath();
  const logRoot = createProbeRoot();

  try {
    const unsupportedLogPath = path.join(logRoot, 'unsupported-host.json');
    const probe = [
      '$ErrorActionPreference = \'Stop\'',
      `. '${escapePowerShellSingleQuoted(helperPath)}'`,
      `$override = [pscustomobject]@{ psEdition = 'Desktop'; psVersion = '5.1.26100.8115'; languageMode = 'ConstrainedLanguage'; supportsScheduledTasks = $true; isAdministrator = $null }`,
      'try {',
      `  Assert-CodexLarkSupportedHost -EntryPoint 'Install-CodexLark.ps1' -FailureCategory 'unsupported-host' -LogPath '${escapePowerShellSingleQuoted(unsupportedLogPath)}' -SupportDocPath 'docs/workflows/install-startup-support-matrix.md' -ManualFallbackHint '请改走 README 手动路径，先手动完成安装与启动。' -RuntimeOverride $override`,
      '  Write-Output \'unexpected success\'',
      '  exit 0',
      '} catch {',
      '  Write-Host $_.Exception.Message',
      '  exit 1',
      '}'
    ];

    let result;
    try {
      result = runPowerShellProbe('powershell.exe', probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Node child_process cannot spawn powershell.exe in this environment.');
        return;
      }
      throw error;
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.exitCode, 1, combined);
    assert.match(combined, /unsupported-host/);
    assert.match(combined, /ConstrainedLanguage|受限 PowerShell 环境/);
    assert.match(combined, new RegExp(unsupportedLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(combined, /README|手动路径|手动完成安装与启动/);
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('README and support matrix document the supported boundary and enterprise blockers', () => {
  const readme = readPowerShellScript('README.md');
  const supportMatrixPath = path.join(process.cwd(), 'docs', 'workflows', 'install-startup-support-matrix.md');

  assert.equal(existsSync(supportMatrixPath), true);
  const supportMatrix = readFileSync(supportMatrixPath, 'utf8');

  assert.match(readme, /ConstrainedLanguage/);
  assert.match(readme, /install-startup-support-matrix\.md/);
  assert.match(readme, /AppLocker/);
  assert.match(readme, /ExecutionPolicy/);
  assert.match(readme, /计划任务/);
  assert.match(readme, /可检测的主机前置条件|可检测的前置条件/);
  assert.match(readme, /原生错误/);
  assert.match(readme, /手动路径|快速开始/);
  assert.doesNotMatch(readme, /安装器与自启动脚本会统一 fail-fast/);
  assert.doesNotMatch(readme, /安装器现在不会因计划任务缺失而整体 fail-fast/);

  assert.match(supportMatrix, /PowerShell 5\.1/);
  assert.match(supportMatrix, /PowerShell 7/);
  assert.match(supportMatrix, /ConstrainedLanguage/);
  assert.match(supportMatrix, /AppLocker/);
  assert.match(supportMatrix, /ExecutionPolicy/);
  assert.match(supportMatrix, /杀毒|代理|防病毒/);
  assert.match(supportMatrix, /计划任务/);
  assert.match(supportMatrix, /可检测的前置条件/);
  assert.match(supportMatrix, /原生错误/);
  assert.match(supportMatrix, /手动路径|快速开始/);
});
