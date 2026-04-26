import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function installerPath(): string {
  return path.join(process.cwd(), 'Install-CodexLark-Autostart.ps1');
}

function uninstallerPath(): string {
  return path.join(process.cwd(), 'Uninstall-CodexLark-Autostart.ps1');
}

function readInstallerScript(): string {
  return readFileSync(installerPath(), 'utf8');
}

function readInstallerBytes(): Buffer {
  return readFileSync(installerPath());
}

function readUninstallerScript(): string {
  return readFileSync(uninstallerPath(), 'utf8');
}

test('auto-start installer exists and is saved with a UTF-8 BOM', () => {
  assert.equal(existsSync(installerPath()), true);

  const bytes = readInstallerBytes();
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('auto-start installer registers a highest-privilege logon scheduled task for run-admin-task', () => {
  const script = readInstallerScript();

  assert.match(script, /param\(\s*\[string\]\$TaskUser\s*\)/);
  assert.match(script, /Assert-CodexLarkSupportedHost[\s\S]*if \(\[string\]::IsNullOrWhiteSpace\(\$TaskUser\)\) \{\s*\$TaskUser = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name[\s\S]*Ensure-Administrator/);
  assert.match(script, /\$taskPath = '\\CodexLark\\'/);
  assert.match(script, /\$legacyTaskPath = '\\'/);
  assert.match(script, /\$taskName = 'CodexLark-FeishuLongConn'/);
  assert.match(script, /\$adminScriptPath = Join-Path \$repoRoot 'run-admin-task\.ps1'/);
  assert.match(script, /function Ensure-ScheduledTaskFolder\s*\{/);
  assert.match(script, /New-Object -ComObject 'Schedule\.Service'/);
  assert.match(script, /Ensure-ScheduledTaskFolder -TaskPath \$taskPath/);
  assert.match(script, /function Remove-ScheduledTaskIfPresent\s*\{/);
  assert.match(script, /Remove-ScheduledTaskIfPresent -TaskPath \$legacyTaskPath -TaskName \$taskName/);
  assert.match(script, /Unregister-ScheduledTask -TaskPath \$TaskPath -TaskName \$TaskName -Confirm:\$false/);
  assert.match(script, /CreateFolder\(\$segment, \$null\)/);
  assert.match(script, /'-TaskUser', \$TaskUser/);
  assert.match(script, /New-ScheduledTaskAction -Execute \$powershellExe -Argument \$taskArgument/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$TaskUser/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$TaskUser -LogonType Interactive -RunLevel Highest/);
  assert.match(script, /New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew/);
  assert.match(script, /-ExecutionTimeLimit \(New-TimeSpan -Seconds 0\)/);
  assert.match(script, /-RestartCount 3/);
  assert.match(script, /-RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /Register-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/);
  assert.match(script, /run-admin-task\.ps1/);
  const registerIndex = script.indexOf('Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName');
  const legacyCleanupIndex = script.lastIndexOf('Remove-ScheduledTaskIfPresent -TaskPath $legacyTaskPath -TaskName $taskName');
  assert.notEqual(registerIndex, -1);
  assert.notEqual(legacyCleanupIndex, -1);
  assert.ok(registerIndex < legacyCleanupIndex, 'expected canonical registration before legacy task cleanup');
});

test('auto-start installer reports the installed task and target script', () => {
  const script = readInstallerScript();

  assert.match(script, /Write-Host '已注册开机自启动任务。'/);
  assert.match(script, /Write-Host "- 计划任务：\$taskPath\$taskName"/);
  assert.match(script, /Write-Host "- 目标脚本：\$adminScriptPath"/);
  assert.match(script, /Write-Host "- 运行用户：\$TaskUser"/);
});

test('auto-start uninstaller removes the scheduled task if present', () => {
  assert.equal(existsSync(uninstallerPath()), true);

  const script = readUninstallerScript();
  assert.match(script, /\$taskPath = '\\CodexLark\\'/);
  assert.match(script, /\$legacyTaskPath = '\\'/);
  assert.match(script, /\$taskName = 'CodexLark-FeishuLongConn'/);
  assert.match(script, /function Remove-ScheduledTaskIfPresent\s*\{/);
  assert.match(script, /Get-ScheduledTask -TaskPath \$TaskPath -TaskName \$TaskName -ErrorAction SilentlyContinue/);
  assert.match(script, /Unregister-ScheduledTask -TaskPath \$TaskPath -TaskName \$TaskName -Confirm:\$false/);
  assert.match(script, /Remove-ScheduledTaskIfPresent -TaskPath \$taskPath -TaskName \$taskName/);
  assert.match(script, /Remove-ScheduledTaskIfPresent -TaskPath \$legacyTaskPath -TaskName \$taskName/);
  assert.match(script, /Write-Host '已删除开机自启动任务。'/);
  assert.match(script, /Write-Host '已删除旧路径开机自启动任务。'/);
});
