import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readRuntimeManifest } from "../../src/setup/runtime-manifest";

type RuntimeManifest = ReturnType<typeof readRuntimeManifest>;

type LauncherRoute = {
  verb: string;
  manifestPath: string;
  path: string;
  arguments: string[];
  runtimeManifest: RuntimeManifest;
};

type LauncherDrift = {
  drifted: boolean;
  expectedPath: string;
  actualPath: string;
};

type EnsuredLauncherManifest = {
  manifestPath: string;
  manifest: RuntimeManifest;
  updated: boolean;
};

type LauncherModule = {
  getCanonicalRuntimeManifestPath: (env?: NodeJS.ProcessEnv) => string;
  ensureSourceRuntimeManifest: (installRoot: string, env?: NodeJS.ProcessEnv) => EnsuredLauncherManifest;
  resolveCanonicalLauncherRoute: (
    verb: "launch" | "repair" | "configure-autostart",
    env?: NodeJS.ProcessEnv
  ) => LauncherRoute;
  classifyLauncherDrift: (
    route: Pick<LauncherRoute, "verb" | "path" | "arguments">,
    observed: { path: string; arguments?: string[] }
  ) => LauncherDrift;
};

type RepairCommandResult = {
  ok: boolean;
  status: string;
  message: string;
  summaryPath: string;
  launcher?: {
    manifestPath: string;
    manifestUpdated: boolean;
    routes: {
      launch: { path: string };
      repair: { path: string };
      configureAutostart: { path: string };
    };
  };
};

type RepairCommandModule = {
  runRepairCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<RepairCommandResult>;
};

type LegacyMigrationModule = {
  runLegacyMigration: (options?: { env?: NodeJS.ProcessEnv }) => Promise<{
    importedConfig: string[];
    disabledLegacyArtifacts: string[];
    retainedLegacyArtifacts: string[];
    warnings: string[];
    statePath: string;
    state: {
      schemaVersion: number;
      handledEnvNames: string[];
      completedAt?: string;
    };
    scan: {
      envVars: unknown[];
      scripts: unknown[];
      shortcuts: unknown[];
      tasks: unknown[];
      stateRoots: unknown[];
      warnings: string[];
      repoRoots: string[];
      hasLegacyArtifacts: boolean;
    };
  }>;
};

function launcherModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "launcher.js");
}

function repairCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "repair.js");
}

function legacyMigrationModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-migration.js");
}

function loadLauncherModule(): LauncherModule {
  const modulePath = launcherModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LauncherModule;
}

function loadRepairCommandModule(): RepairCommandModule {
  const modulePath = repairCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as RepairCommandModule;
}

function loadLegacyMigrationModule(): LegacyMigrationModule {
  const modulePath = legacyMigrationModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LegacyMigrationModule;
}

function createSetupEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCALAPPDATA: root,
    LocalAppData: root,
    USERPROFILE: root,
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    ...extra
  };
}

async function withPatchedLegacyMigrationClean<T>(envRoot: string, callback: () => Promise<T>): Promise<T> {
  const migrationPath = legacyMigrationModulePath();
  const repairPath = repairCommandModulePath();
  const migrationModule = loadLegacyMigrationModule();
  const original = migrationModule.runLegacyMigration;
  migrationModule.runLegacyMigration = async () => ({
    importedConfig: [],
    disabledLegacyArtifacts: [],
    retainedLegacyArtifacts: [],
    warnings: [],
    statePath: path.join(envRoot, "CodexLark", "state", "legacy-migration.json"),
    state: {
      schemaVersion: 1,
      handledEnvNames: [],
      completedAt: "2026-04-19T00:00:00.000Z"
    },
    scan: {
      envVars: [],
      scripts: [],
      shortcuts: [],
      tasks: [],
      stateRoots: [],
      warnings: [],
      repoRoots: [],
      hasLegacyArtifacts: false
    }
  });
  delete require.cache[repairPath];

  try {
    return await callback();
  } finally {
    migrationModule.runLegacyMigration = original;
    delete require.cache[migrationPath];
    delete require.cache[repairPath];
  }
}

function readPowerShellScript(scriptName: string): string {
  return readFileSync(path.join(process.cwd(), scriptName), "utf8");
}

test("launch, repair, and autostart routes share the same canonical runtime manifest", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-launcher-routing-"));
  const repoRoot = "D:\\Source\\CodexLark";

  try {
    const launcherModule = loadLauncherModule();
    const env = createSetupEnv(tempRoot);
    const ensured = launcherModule.ensureSourceRuntimeManifest(repoRoot, env);
    const launch = launcherModule.resolveCanonicalLauncherRoute("launch", env);
    const repair = launcherModule.resolveCanonicalLauncherRoute("repair", env);
    const autostart = launcherModule.resolveCanonicalLauncherRoute("configure-autostart", env);

    assert.equal(launch.manifestPath, ensured.manifestPath);
    assert.equal(repair.manifestPath, ensured.manifestPath);
    assert.equal(autostart.manifestPath, ensured.manifestPath);
    assert.equal(launch.path, path.win32.join(repoRoot, "Start-CodexLark.ps1"));
    assert.equal(repair.path, path.win32.join(repoRoot, "Repair-CodexLark.ps1"));
    assert.equal(autostart.path, path.win32.join(repoRoot, "Install-CodexLark-Autostart.ps1"));
    assert.equal(existsSync(ensured.manifestPath), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("launcher drift classification detects target mismatches", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-launcher-drift-"));

  try {
    const launcherModule = loadLauncherModule();
    const env = createSetupEnv(tempRoot);
    launcherModule.ensureSourceRuntimeManifest("D:\\Source\\CodexLark", env);
    const launch = launcherModule.resolveCanonicalLauncherRoute("launch", env);
    const drift = launcherModule.classifyLauncherDrift(launch, {
      path: "D:\\LegacyRepo\\Start-CodexLark.ps1"
    });

    assert.equal(drift.drifted, true);
    assert.equal(drift.expectedPath, launch.path);
    assert.equal(drift.actualPath, "D:\\LegacyRepo\\Start-CodexLark.ps1");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensureSourceRuntimeManifest heals stale runtime manifest targets", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-launcher-heal-"));
  const staleRepoRoot = "D:\\LegacyRepo";
  const currentRepoRoot = "D:\\CurrentRepo";

  try {
    const launcherModule = loadLauncherModule();
    const env = createSetupEnv(tempRoot);
    const manifestPath = launcherModule.getCanonicalRuntimeManifestPath(env);
    launcherModule.ensureSourceRuntimeManifest(staleRepoRoot, env);

    const healed = launcherModule.ensureSourceRuntimeManifest(currentRepoRoot, env);
    const stored = readRuntimeManifest(manifestPath);

    assert.equal(healed.updated, true);
    assert.equal(stored.installRoot, currentRepoRoot);
    assert.equal(stored.launcherPath, path.win32.join(currentRepoRoot, "Start-CodexLark.ps1"));
    assert.equal(stored.bridgeScriptPaths.runAdminTask, path.win32.join(currentRepoRoot, "run-admin-task.ps1"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runRepairCommand heals canonical launcher manifest drift", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-launcher-repair-"));
  const originalCwd = process.cwd();
  const repoRoot = path.join(tempRoot, "repo");

  try {
    const launcherModule = loadLauncherModule();
    const env = createSetupEnv(tempRoot);
    launcherModule.ensureSourceRuntimeManifest("D:\\LegacyRepo", env);
    mkdirSync(repoRoot, { recursive: true });
    process.chdir(repoRoot);

    const result = await withPatchedLegacyMigrationClean(tempRoot, async () => {
      const repairModule = loadRepairCommandModule();
      return (await repairModule.runRepairCommand?.({ env })) as RepairCommandResult;
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.launcher?.manifestUpdated, true);
    assert.equal(result.launcher?.routes.launch.path, path.win32.join(repoRoot, "Start-CodexLark.ps1"));
    assert.equal(result.launcher?.routes.repair.path, path.win32.join(repoRoot, "Repair-CodexLark.ps1"));
    assert.equal(
      result.launcher?.routes.configureAutostart.path,
      path.win32.join(repoRoot, "Install-CodexLark-Autostart.ps1")
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("runRepairCommand updates canonical manifest before legacy migration scans current launchers", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-launcher-repair-order-"));
  const originalCwd = process.cwd();
  const repoRoot = path.join(tempRoot, "repo");
  const observedLaunchPaths: string[] = [];

  try {
    const launcherModule = loadLauncherModule();
    const env = createSetupEnv(tempRoot);
    launcherModule.ensureSourceRuntimeManifest("D:\\LegacyRepo", env);
    mkdirSync(repoRoot, { recursive: true });
    process.chdir(repoRoot);

    const migrationPath = legacyMigrationModulePath();
    const repairPath = repairCommandModulePath();
    const migrationModule = loadLegacyMigrationModule();
    const original = migrationModule.runLegacyMigration;
    migrationModule.runLegacyMigration = async (options = {}) => {
      observedLaunchPaths.push(launcherModule.resolveCanonicalLauncherRoute("launch", options.env).path);
      return await original(options);
    };
    delete require.cache[repairPath];

    try {
      const repairModule = loadRepairCommandModule();
      await repairModule.runRepairCommand?.({ env });

      assert.deepEqual(observedLaunchPaths, [path.win32.join(repoRoot, "Start-CodexLark.ps1")]);
    } finally {
      migrationModule.runLegacyMigration = original;
      delete require.cache[migrationPath];
      delete require.cache[repairPath];
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("PowerShell bridge scripts consume runtime-manifest driven paths", () => {
  const runAdminTask = readPowerShellScript("run-admin-task.ps1");
  assert.match(runAdminTask, /\$repoRoot = \$PSScriptRoot/);
  assert.match(runAdminTask, /Get-CodexLarkRuntimeProductPaths/);
  assert.doesNotMatch(runAdminTask, /\$registryPath = Join-Path \$repoRoot 'logs\\communicate\\registry\.json'/);

  const autostartInstaller = readPowerShellScript("Install-CodexLark-Autostart.ps1");
  assert.match(autostartInstaller, /\$adminScriptPath = Join-Path \$repoRoot 'run-admin-task\.ps1'/);

  const autostartUninstaller = readPowerShellScript("Uninstall-CodexLark-Autostart.ps1");
  assert.doesNotMatch(autostartUninstaller, /scriptSelfPath/);

  const installScript = readPowerShellScript("Install-CodexLark.ps1");
  assert.match(installScript, /function Sync-CanonicalLauncherManifest\s*\{/);
  assert.match(installScript, /ensureSourceRuntimeManifest/);
  assert.match(installScript, /New-LauncherScripts[\s\S]*Sync-CanonicalLauncherManifest -NodeCommand \$nodeCommand/);
});
