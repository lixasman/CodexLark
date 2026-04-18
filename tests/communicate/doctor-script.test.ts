import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

type DoctorCheck = {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'info';
  summary: string;
};

type DoctorPayload = {
  ok: boolean;
  checks: DoctorCheck[];
};

type DoctorModule = {
  runDoctor: () => DoctorPayload;
};

function loadDoctorModule(repoRoot = process.cwd()): DoctorModule {
  return require(path.join(repoRoot, 'scripts', 'doctor.cjs')) as DoctorModule;
}

test('doctor reports missing codex CLI and required env vars in JSON mode', () => {
  const missingCodexPath = path.join(process.cwd(), 'missing-codex-cli.cmd');
  assert.equal(existsSync(missingCodexPath), false);

  const previousAppId = process.env.FEISHU_APP_ID;
  const previousSecret = process.env.FEISHU_APP_SECRET;
  const previousCodexExe = process.env.CODEX_CLI_EXE;
  try {
    process.env.FEISHU_APP_ID = '';
    process.env.FEISHU_APP_SECRET = '';
    process.env.CODEX_CLI_EXE = missingCodexPath;

    const { runDoctor } = loadDoctorModule();
    const payload = runDoctor();
    assert.equal(Array.isArray(payload.checks), true);
    const checks = new Map(payload.checks.map((check) => [check.id, check]));

    assert.equal(payload.ok, false);
    assert.equal(checks.get('node_version')?.status, 'pass');
    assert.equal(checks.get('codex_cli')?.status, 'fail');
    assert.equal(checks.get('feishu_app_id')?.status, 'fail');
    assert.equal(checks.get('feishu_app_secret')?.status, 'fail');
    assert.notEqual(checks.get('dist_agent_cli')?.status, undefined);
    assert.equal(checks.get('admin_startup')?.status, 'info');
  } finally {
    if (previousAppId === undefined) {
      delete process.env.FEISHU_APP_ID;
    } else {
      process.env.FEISHU_APP_ID = previousAppId;
    }
    if (previousSecret === undefined) {
      delete process.env.FEISHU_APP_SECRET;
    } else {
      process.env.FEISHU_APP_SECRET = previousSecret;
    }
    if (previousCodexExe === undefined) {
      delete process.env.CODEX_CLI_EXE;
    } else {
      process.env.CODEX_CLI_EXE = previousCodexExe;
    }
  }
});

test('doctor resolves codex from APPDATA npm shims like the runtime does', () => {
  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codexlark-doctor-appdata-'));
  const appDataDir = path.join(tempRoot, 'AppData', 'Roaming');
  const npmDir = path.join(appDataDir, 'npm');
  const codexCmdPath = path.join(npmDir, 'codex.cmd');
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(codexCmdPath, '@echo off\r\n', 'utf8');

  const previousAppData = process.env.APPDATA;
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousSecret = process.env.FEISHU_APP_SECRET;
  const previousCodexExe = process.env.CODEX_CLI_EXE;
  try {
    process.env.APPDATA = appDataDir;
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
    process.env.CODEX_CLI_EXE = 'codex';

    const { runDoctor } = loadDoctorModule(repoRoot);
    const payload = runDoctor();
    const checks = new Map(payload.checks.map((check) => [check.id, check]));

    assert.equal(checks.get('codex_cli')?.status, 'pass');
  } finally {
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
    if (previousAppId === undefined) {
      delete process.env.FEISHU_APP_ID;
    } else {
      process.env.FEISHU_APP_ID = previousAppId;
    }
    if (previousSecret === undefined) {
      delete process.env.FEISHU_APP_SECRET;
    } else {
      process.env.FEISHU_APP_SECRET = previousSecret;
    }
    if (previousCodexExe === undefined) {
      delete process.env.CODEX_CLI_EXE;
    } else {
      process.env.CODEX_CLI_EXE = previousCodexExe;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('doctor anchors repository checks to the script location instead of the current cwd', () => {
  const repoRoot = process.cwd();
  const tempCwd = mkdtempSync(path.join(os.tmpdir(), 'codexlark-doctor-cwd-'));
  const fakeCodexPath = path.join(tempCwd, 'codex.cmd');
  writeFileSync(fakeCodexPath, '@echo off\r\n', 'utf8');

  const previousAppId = process.env.FEISHU_APP_ID;
  const previousSecret = process.env.FEISHU_APP_SECRET;
  const previousCodexExe = process.env.CODEX_CLI_EXE;
  const originalCwd = process.cwd();
  try {
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';
    process.env.CODEX_CLI_EXE = fakeCodexPath;
    process.chdir(tempCwd);

    const { runDoctor } = loadDoctorModule(repoRoot);
    const payload = runDoctor();
    const checks = new Map(payload.checks.map((check) => [check.id, check]));

    assert.equal(checks.get('dist_agent_cli')?.status, 'pass');
    assert.equal(checks.get('feishu_config')?.status, 'pass');
  } finally {
    process.chdir(originalCwd);
    if (previousAppId === undefined) {
      delete process.env.FEISHU_APP_ID;
    } else {
      process.env.FEISHU_APP_ID = previousAppId;
    }
    if (previousSecret === undefined) {
      delete process.env.FEISHU_APP_SECRET;
    } else {
      process.env.FEISHU_APP_SECRET = previousSecret;
    }
    if (previousCodexExe === undefined) {
      delete process.env.CODEX_CLI_EXE;
    } else {
      process.env.CODEX_CLI_EXE = previousCodexExe;
    }
    rmSync(tempCwd, { recursive: true, force: true });
  }
});
