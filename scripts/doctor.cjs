const fs = require('node:fs');
const path = require('node:path');

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function envValue(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function resolveCommandPath(command) {
  const trimmed = (command || '').trim();
  if (!trimmed) return '';

  if (path.isAbsolute(trimmed) || trimmed.includes('\\') || trimmed.includes('/')) {
    return fs.existsSync(trimmed) ? trimmed : '';
  }

  if (process.platform === 'win32') {
    const appData = envValue('APPDATA');
    const appDataCandidates = [
      appData ? path.join(appData, 'npm', `${trimmed}.cmd`) : '',
      appData ? path.join(appData, 'npm', `${trimmed}.exe`) : '',
      appData ? path.join(appData, 'npm', trimmed) : ''
    ].filter(Boolean);
    const appDataMatch = appDataCandidates.find((candidate) => fs.existsSync(candidate));
    if (appDataMatch) {
      return appDataMatch;
    }
  }

  const pathEntries = (process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [''];

  for (const entry of pathEntries) {
    const basePath = path.join(entry, trimmed);
    const candidates = process.platform === 'win32'
      ? [basePath, ...extensions.map((ext) => `${basePath}${ext.toLowerCase()}`), ...extensions.map((ext) => `${basePath}${ext.toUpperCase()}`)]
      : [basePath];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return '';
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..');
}

function createCheck(id, status, summary, detail) {
  return {
    id,
    status,
    summary,
    ...(detail ? { detail } : {})
  };
}

function runDoctor() {
  const repoRoot = resolveRepoRoot();
  const checks = [];

  checks.push(
    createCheck(
      'platform',
      process.platform === 'win32' ? 'pass' : 'fail',
      process.platform === 'win32' ? 'Running on Windows.' : `Unsupported platform: ${process.platform}`,
      'CodexLark currently targets Windows + PowerShell workstations.'
    )
  );

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '', 10);
  checks.push(
    createCheck(
      'node_version',
      Number.isInteger(nodeMajor) && nodeMajor >= 24 ? 'pass' : 'fail',
      `Node.js ${process.versions.node}`,
      'README currently documents Node.js 24 or newer.'
    )
  );

  const codexCommand = envValue('CODEX_CLI_EXE') || 'codex';
  const resolvedCodex = resolveCommandPath(codexCommand);
  checks.push(
    createCheck(
      'codex_cli',
      resolvedCodex ? 'pass' : 'fail',
      resolvedCodex ? `Resolved Codex CLI: ${resolvedCodex}` : `Could not resolve Codex CLI: ${codexCommand}`,
      'Set CODEX_CLI_EXE to an absolute path if codex is not on PATH.'
    )
  );

  const feishuAppId = envValue('FEISHU_APP_ID');
  checks.push(
    createCheck(
      'feishu_app_id',
      feishuAppId ? 'pass' : 'fail',
      feishuAppId ? 'FEISHU_APP_ID is set.' : 'Missing FEISHU_APP_ID.',
      'Copy the value into your current PowerShell session before starting the runtime.'
    )
  );

  const feishuAppSecret = envValue('FEISHU_APP_SECRET');
  checks.push(
    createCheck(
      'feishu_app_secret',
      feishuAppSecret ? 'pass' : 'fail',
      feishuAppSecret ? 'FEISHU_APP_SECRET is set.' : 'Missing FEISHU_APP_SECRET.',
      'Do not commit the real secret to the repository.'
    )
  );

  const distAgentCliPath = path.join(repoRoot, 'dist', 'agent-cli.js');
  checks.push(
    createCheck(
      'dist_agent_cli',
      fs.existsSync(distAgentCliPath) ? 'pass' : 'fail',
      fs.existsSync(distAgentCliPath)
        ? `Build artifact exists: ${distAgentCliPath}`
        : 'Missing dist/agent-cli.js.',
      'Run npm run build before starting the Feishu long-connection runtime.'
    )
  );

  const feishuConfigPath = path.join(repoRoot, 'configs', 'communicate', 'feishu.json');
  checks.push(
    createCheck(
      'feishu_config',
      fs.existsSync(feishuConfigPath) ? 'pass' : 'fail',
      fs.existsSync(feishuConfigPath)
        ? `Feishu runtime config exists: ${feishuConfigPath}`
        : 'Missing configs/communicate/feishu.json.',
      'The runtime reads Feishu toggles and takeover settings from this file.'
    )
  );

  checks.push(
    createCheck(
      'admin_startup',
      'info',
      'Real Feishu long-connection runs should be started through run-admin-task.ps1.',
      'The long-connection process currently relies on an elevated PowerShell restart flow.'
    )
  );

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks
  };
}

function renderHuman(payload) {
  const iconByStatus = {
    pass: 'PASS',
    fail: 'FAIL',
    warn: 'WARN',
    info: 'INFO'
  };

  console.log('CodexLark doctor');
  console.log('');
  for (const check of payload.checks) {
    console.log(`[${iconByStatus[check.status]}] ${check.summary}`);
    if (check.detail) {
      console.log(`       ${check.detail}`);
    }
  }
  console.log('');
  console.log(payload.ok ? 'Doctor result: ready for the documented local flow.' : 'Doctor result: fix the FAIL items first.');
}

function main() {
  const payload = runDoctor();
  if (hasFlag('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    renderHuman(payload);
  }
  process.exitCode = payload.ok ? 0 : 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  runDoctor
};
