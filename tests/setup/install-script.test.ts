import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function installerPath(): string {
  return path.join(process.cwd(), 'Install-CodexLark.ps1');
}

function processRunnerPath(): string {
  return path.join(process.cwd(), 'scripts', 'setup', 'process-runner.ps1');
}

function readInstallerScript(): string {
  return readFileSync(installerPath(), 'utf8');
}

function readProcessRunnerScript(): string {
  return readFileSync(processRunnerPath(), 'utf8');
}

function readInstallerBytes(): Buffer {
  return readFileSync(installerPath());
}

test('Install-CodexLark exists and is saved with a UTF-8 BOM', () => {
  assert.equal(existsSync(installerPath()), true);

  const bytes = readInstallerBytes();
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('Install-CodexLark defines setup log directory and shared step runner', () => {
  const script = readInstallerScript();

  assert.match(script, /\$setupLogDir = Join-Path \$repoRoot 'artifacts\\setup'/);
  assert.match(script, /\$processRunnerPath = Join-Path \$repoRoot 'scripts\\setup\\process-runner\.ps1'/);
  assert.match(script, /\. \$processRunnerPath/);
  assert.match(script, /function Invoke-SetupStep\s*\{/);
  assert.match(script, /function Invoke-SetupInteractiveStep\s*\{/);
  assert.match(script, /function Write-SetupStage\s*\{/);
  assert.match(script, /Write-Host \("\[\{0\}\/\{1\}\] \{2\}" -f \$StepNumber, \$TotalSteps, \$Title\)/);
});

test('Install-CodexLark enforces the supported Windows and winget setup path', () => {
  const script = readInstallerScript();

  assert.match(script, /function Assert-SupportedPlatform\s*\{/);
  assert.match(script, /Get-Command winget -ErrorAction SilentlyContinue/);
  assert.match(script, /当前安装器仅支持带 winget 的普通个人 Windows 电脑/);
  assert.match(script, /OpenJS\.NodeJS\.LTS/);
  assert.match(script, /install-node\.out\.log/);
  assert.match(script, /install-node\.err\.log/);
});

test('Install-CodexLark installs Codex CLI and pauses for login', () => {
  const script = readInstallerScript();

  assert.match(script, /Resolve-CommandSource 'codex'/);
  assert.match(script, /@openai\/codex/);
  assert.match(script, /'install', '-g', '@openai\/codex'/);
  assert.match(script, /function Ensure-CodexLogin\s*\{/);
  assert.match(script, /codex --login/);
  assert.match(script, /请先完成 Codex 登录/);
  assert.match(script, /install-codex\.out\.log/);
  assert.match(script, /install-codex\.err\.log/);
});

test('process runner prefers application shims over PowerShell wrapper scripts and exposes split execution paths', () => {
  const script = readProcessRunnerScript();

  assert.match(script, /Get-Command \$Name -All -ErrorAction SilentlyContinue/);
  assert.match(script, /\$applicationCommand = \$commands \| Where-Object \{ \$_.CommandType -eq 'Application' \} \| Select-Object -First 1/);
  assert.match(script, /if \(\$applicationCommand\) \{\s*return \$applicationCommand\.Source\s*\}/);
  assert.match(script, /function Invoke-CodexLarkCommand\s*\{/);
  assert.match(script, /function Invoke-CodexLarkInteractiveCommand\s*\{/);
});

test('Install-CodexLark collects Feishu settings and writes user environment variables', () => {
  const script = readInstallerScript();

  assert.match(script, /'请输入 FEISHU_APP_ID'/);
  assert.match(script, /'请输入 FEISHU_APP_SECRET'/);
  assert.match(script, /FEISHU_APP_ID = Resolve-ConfigValue/);
  assert.match(script, /FEISHU_APP_SECRET = Resolve-ConfigValue/);
  assert.match(script, /CODEX_CLI_EXE = Resolve-ConfigValue/);
  assert.match(script, /COMMUNICATE_ASSISTANT_CWD = \$assistantCwd/);
  assert.match(script, /COMMUNICATE_FEISHU_IMAGE_DIR = Resolve-ConfigValue/);
  assert.match(script, /COMMUNICATE_FEISHU_DEBUG = if \(Read-YesNo/);
  assert.match(script, /\[Environment\]::SetEnvironmentVariable\(\$entry\.Key, \[string\]\$entry\.Value, 'User'\)/);
});

test('Install-CodexLark runs npm install, build, doctor, and writes an install summary', () => {
  const script = readInstallerScript();

  assert.match(script, /StepName 'npm install'/);
  assert.match(script, /ArgumentList @\('install'\)/);
  assert.match(script, /StepName 'npm run build'/);
  assert.match(script, /ArgumentList @\('run', 'build'\)/);
  assert.match(script, /ArgumentList @\('\.\\scripts\\doctor\.cjs', '--json'\)/);
  assert.match(script, /npm-install\.out\.log/);
  assert.match(script, /build\.out\.log/);
  assert.match(script, /doctor\.out\.log/);
  assert.match(script, /install-summary\.json/);
  assert.match(script, /exit \$failureExitCode/);
});

test('Install-CodexLark generates launchers and gates startup on explicit confirmation', () => {
  const script = readInstallerScript();

  assert.match(script, /Start-CodexLark\.ps1/);
  assert.match(script, /Repair-CodexLark\.ps1/);
  assert.match(script, /是否立即启动飞书长连接/);
  assert.match(script, /run-admin-task\.ps1/);
  assert.match(script, /function Write-LauncherScript\s*\{/);
});

test('Install-CodexLark optionally offers auto-start during first run but not repair mode', () => {
  const script = readInstallerScript();

  assert.match(script, /Install-CodexLark-Autostart\.ps1/);
  assert.match(script, /是否启用开机自启动/);
  assert.match(script, /DefaultYes \$false/);
  assert.match(script, /if \(-not \$Repair\)/);
  assert.match(script, /powershell\.exe/);
});

test('.gitignore ignores generated launcher scripts', () => {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const gitignore = readFileSync(gitignorePath, 'utf8');

  assert.match(gitignore, /^Start-CodexLark\.ps1$/m);
  assert.match(gitignore, /^Repair-CodexLark\.ps1$/m);
});
