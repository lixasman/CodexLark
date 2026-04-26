import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type LegacyShortcutRecord = {
  path: string;
  targetPath?: string;
  arguments?: string;
};

type LegacyTaskRecord = {
  taskName: string;
  taskPath?: string;
  execute?: string;
  arguments?: string;
};

type LegacyTaskScanProbe = {
  items: LegacyTaskRecord[];
  warnings: string[];
};

type LegacyScanResult = {
  envVars: Array<{ name: string; value: string }>;
  scripts: Array<{ path: string; repoRoot: string; name: string }>;
  shortcuts: Array<LegacyShortcutRecord>;
  tasks: Array<LegacyTaskRecord>;
  stateRoots: Array<{ path: string; repoRoot: string; kind: string }>;
  warnings: string[];
  repoRoots: string[];
  hasLegacyArtifacts: boolean;
};

type LegacyMigrationState = {
  schemaVersion: number;
  handledEnvNames: string[];
};

type LegacyMigrationResult = {
  importedConfig: string[];
  disabledLegacyArtifacts: string[];
  retainedLegacyArtifacts: string[];
  warnings: string[];
  statePath: string;
  state: LegacyMigrationState;
  scan: LegacyScanResult;
};

type FirstRunCommandResult = {
  ok: boolean;
  status: string;
  message: string;
  legacyMigration: LegacyMigrationResult;
};

type RepairCommandResult = {
  ok: boolean;
  status: string;
  message: string;
  legacyMigration: LegacyMigrationResult;
};

type RuntimeManifest = {
  schemaVersion: number;
  installRoot: string;
  stateRoot: string;
  launcherPath: string;
  bridgeScriptPaths: {
    runAdminTask: string;
    installAutostart: string;
    uninstallAutostart: string;
  };
};

type LegacyScanModule = {
  scanLegacyArtifacts: (options?: {
    env?: NodeJS.ProcessEnv;
    repoRoots?: string[];
    searchRoots?: string[];
    listShortcuts?: () => LegacyShortcutRecord[];
    listScheduledTasks?: () => LegacyTaskRecord[] | LegacyTaskScanProbe;
  }) => LegacyScanResult;
  buildWindowsShortcutScanCommand?: (shortcutRoots: string[]) => string;
  buildWindowsScheduledTaskScanCommand?: () => string;
  extractLegacyScriptPaths?: (...segments: Array<string | undefined>) => string[];
  normalizeWindowsPath?: (candidatePath: string) => string;
  hasBlockingLegacyWarnings?: (warnings: string[]) => boolean;
};

type LegacyMigrationModule = {
  getLegacyMigrationStatePath: (env?: NodeJS.ProcessEnv) => string;
  readLegacyMigrationState: (env?: NodeJS.ProcessEnv) => LegacyMigrationState;
  runLegacyMigration: (options?: {
    env?: NodeJS.ProcessEnv;
    scanOptions?: {
      repoRoots?: string[];
    };
  }) => Promise<LegacyMigrationResult>;
};


type RuntimeManifestModule = {
  writeRuntimeManifest: (manifestPath: string, manifest: RuntimeManifest) => void;
};

type LauncherModule = {
  getCanonicalRuntimeManifestPath: (env?: NodeJS.ProcessEnv) => string;
};
type FirstRunCommandModule = {
  runFirstRunCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<FirstRunCommandResult>;
};

type RepairCommandModule = {
  runRepairCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<RepairCommandResult>;
};

type ConfigStoreModule = {
  readSetupSettings: (env?: NodeJS.ProcessEnv) => {
    schemaVersion: number;
    feishuAppId?: string;
    feishuAppSecretRef?: string;
    codexCliPath?: string;
  };
  writeSetupSettings: (
    input: {
      feishuAppId?: string;
      feishuAppSecretRef?: string;
      codexCliPath?: string;
    },
    env?: NodeJS.ProcessEnv
  ) => {
    schemaVersion: number;
    feishuAppId?: string;
    feishuAppSecretRef?: string;
    codexCliPath?: string;
  };
};

type SecretStoreModule = {
  storeSetupSecret: (
    input: { name: string; value: string },
    options?: { env?: NodeJS.ProcessEnv; protectSecret?: (secret: string) => Promise<string> | string }
  ) => Promise<{ reference: string; recordPath: string }>;
};

type CodexDependencyModule = {
  inspectCodexCliDependency: (options?: {
    env?: NodeJS.ProcessEnv;
    installWhenMissing?: boolean;
  }) => Promise<{
    present: boolean;
    installAttempted: boolean;
    resolvedPath?: string;
    version?: string;
    loginDetected: boolean;
    loginDetectionSource?: "marker" | "openai_api_key";
    failureCategory?: string;
  }>;
};

function legacyScanModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-scan.js");
}

function legacyMigrationModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-migration.js");
}

function firstRunCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "first-run.js");
}

function repairCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "repair.js");
}

function configStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "config-store.js");
}

function secretStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "secret-store.js");
}

function codexDependencyModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "codex-dependency.js");
}

function runtimeManifestModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "runtime-manifest.js");
}

function launcherModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "launcher.js");
}

function loadLegacyScanModule(): LegacyScanModule {
  const modulePath = legacyScanModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LegacyScanModule;
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShellCommand(command: string): string {
  return execFileSync(
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    }
  );
}

function loadLegacyMigrationModule(): LegacyMigrationModule {
  const modulePath = legacyMigrationModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LegacyMigrationModule;
}

function loadFirstRunCommandModule(): FirstRunCommandModule {
  const modulePath = firstRunCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as FirstRunCommandModule;
}

function loadRepairCommandModule(): RepairCommandModule {
  const modulePath = repairCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as RepairCommandModule;
}

function loadConfigStoreModule(): ConfigStoreModule {
  const modulePath = configStoreModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as ConfigStoreModule;
}

function loadSecretStoreModule(): SecretStoreModule {
  const modulePath = secretStoreModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as SecretStoreModule;
}

function loadCodexDependencyModule(): CodexDependencyModule {
  const modulePath = codexDependencyModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as CodexDependencyModule;
}

function loadRuntimeManifestModule(): RuntimeManifestModule {
  const modulePath = runtimeManifestModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as RuntimeManifestModule;
}

function loadLauncherModule(): LauncherModule {
  const modulePath = launcherModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LauncherModule;
}

function createSetupEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    CODEX_CLI_EXE: "",
    COMMUNICATE_FEISHU_DEBUG: "",
    LOCALAPPDATA: root,
    LocalAppData: root,
    USERPROFILE: root,
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    ...extra
  };
}


function writeCanonicalRuntimeManifest(env: NodeJS.ProcessEnv, installRoot: string): RuntimeManifest {
  const launcherModule = loadLauncherModule();
  const runtimeManifestModule = loadRuntimeManifestModule();
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    installRoot,
    stateRoot: path.win32.join(String(env.LocalAppData), "CodexLark", "state"),
    launcherPath: path.win32.join(installRoot, "Start-CodexLark.ps1"),
    bridgeScriptPaths: {
      runAdminTask: path.win32.join(installRoot, "run-admin-task.ps1"),
      installAutostart: path.win32.join(installRoot, "Install-CodexLark-Autostart.ps1"),
      uninstallAutostart: path.win32.join(installRoot, "Uninstall-CodexLark-Autostart.ps1")
    }
  };
  runtimeManifestModule.writeRuntimeManifest(launcherModule.getCanonicalRuntimeManifestPath(env), manifest);
  return manifest;
}

function writeCanonicalLauncherFiles(manifest: RuntimeManifest): void {
  const files = [
    manifest.launcherPath,
    path.win32.join(manifest.installRoot, "Repair-CodexLark.ps1"),
    manifest.bridgeScriptPaths.installAutostart,
    manifest.bridgeScriptPaths.uninstallAutostart,
    manifest.bridgeScriptPaths.runAdminTask
  ];
  for (const file of files) {
    mkdirSync(path.win32.dirname(file), { recursive: true });
    writeFileSync(file, "Write-Host 'canonical'\n", "utf8");
  }
}
async function withPatchedStoreSetupSecret<T>(callback: () => Promise<T>): Promise<T> {
  const secretStorePath = secretStoreModulePath();
  const migrationPath = legacyMigrationModulePath();
  const secretStoreModule = loadSecretStoreModule();
  const original = secretStoreModule.storeSetupSecret;
  secretStoreModule.storeSetupSecret = async (input, options = {}) =>
    await original(input, {
      ...options,
      protectSecret: () => "dpapi-test-payload"
    });
  delete require.cache[firstRunCommandModulePath()];
  delete require.cache[migrationPath];

  try {
    return await callback();
  } finally {
    secretStoreModule.storeSetupSecret = original;
    delete require.cache[secretStorePath];
    delete require.cache[firstRunCommandModulePath()];
    delete require.cache[migrationPath];
  }
}

async function withPatchedInspectCodexCliDependency<T>(
  callback: () => Promise<T>
): Promise<T> {
  const dependencyModulePath = codexDependencyModulePath();
  const dependencyModule = loadCodexDependencyModule();
  const original = dependencyModule.inspectCodexCliDependency;
  dependencyModule.inspectCodexCliDependency = async () => ({
    present: true,
    installAttempted: false,
    resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
    version: "0.121.1",
    loginDetected: true,
    loginDetectionSource: "openai_api_key"
  });
  delete require.cache[firstRunCommandModulePath()];

  try {
    return await callback();
  } finally {
    dependencyModule.inspectCodexCliDependency = original;
    delete require.cache[dependencyModulePath];
    delete require.cache[firstRunCommandModulePath()];
  }
}

test("scanLegacyArtifacts detects legacy env vars, launchers, task targets, and repo-local state roots", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-scan-"));
  const legacyRepoRoot = path.join(tempRoot, "legacy-repo");
  const startScriptPath = path.join(legacyRepoRoot, "Start-CodexLark.ps1");
  const repairScriptPath = path.join(legacyRepoRoot, "Repair-CodexLark.ps1");
  const adminScriptPath = path.join(legacyRepoRoot, "run-admin-task.ps1");

  try {
    mkdirSync(path.join(legacyRepoRoot, "artifacts", "setup"), { recursive: true });
    mkdirSync(path.join(legacyRepoRoot, "logs", "communicate"), { recursive: true });
    mkdirSync(path.join(legacyRepoRoot, "state"), { recursive: true });
    writeFileSync(startScriptPath, "Write-Host 'start'\n", "utf8");
    writeFileSync(repairScriptPath, "Write-Host 'repair'\n", "utf8");
    writeFileSync(adminScriptPath, "Write-Host 'admin'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "Install-CodexLark-Autostart.ps1"), "Write-Host 'install autostart'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "Uninstall-CodexLark-Autostart.ps1"), "Write-Host 'uninstall autostart'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "logs", "communicate", "registry.json"), "{}", "utf8");

    const legacyScanModule = loadLegacyScanModule();
    const result = legacyScanModule.scanLegacyArtifacts({
      env: createSetupEnv(tempRoot, {
        FEISHU_APP_ID: "cli_legacy_app",
        FEISHU_APP_SECRET: "secret-legacy-value"
      }),
      searchRoots: [tempRoot],
      listScheduledTasks: () => [
        {
          taskName: "CodexLark Legacy LongConn",
          taskPath: "\\CodexLark\\",
          execute: "powershell.exe",
          arguments: `-ExecutionPolicy Bypass -File "${adminScriptPath}"`
        }
      ],
      listShortcuts: () => [
        {
          path: path.join(tempRoot, "Desktop", "Start CodexLark.lnk"),
          targetPath: startScriptPath
        }
      ]
    });

    assert.equal(result.hasLegacyArtifacts, true);
    assert.deepEqual(
      result.envVars.map((entry) => entry.name).sort(),
      ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
    );
    assert.deepEqual(result.repoRoots, [legacyRepoRoot]);
    assert.deepEqual(
      result.scripts.map((entry) => path.basename(entry.path)).sort(),
      [
        "Install-CodexLark-Autostart.ps1",
        "Repair-CodexLark.ps1",
        "Start-CodexLark.ps1",
        "Uninstall-CodexLark-Autostart.ps1"
      ]
    );
    assert.equal(result.shortcuts.length, 1);
    assert.equal(result.shortcuts[0]?.targetPath, startScriptPath);
    assert.equal(result.tasks.length, 1);
    assert.match(String(result.tasks[0]?.arguments), /run-admin-task\.ps1/i);
    assert.deepEqual(
      result.stateRoots.map((entry) => entry.kind).sort(),
      ["artifacts", "logs", "registry", "state"]
    );
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scanLegacyArtifacts discovers legacy repo roots from USERPROFILE search even without shortcuts or tasks", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-search-"));
  const legacyRepoRoot = path.join(tempRoot, "Projects", "CodexLark");

  try {
    mkdirSync(path.join(legacyRepoRoot, "artifacts"), { recursive: true });
    mkdirSync(path.join(legacyRepoRoot, "logs", "communicate"), { recursive: true });
    writeFileSync(path.join(legacyRepoRoot, "Start-CodexLark.ps1"), "Write-Host 'start'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "Repair-CodexLark.ps1"), "Write-Host 'repair'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "run-admin-task.ps1"), "Write-Host 'admin'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "Install-CodexLark-Autostart.ps1"), "Write-Host 'install autostart'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "Uninstall-CodexLark-Autostart.ps1"), "Write-Host 'uninstall autostart'\n", "utf8");
    writeFileSync(path.join(legacyRepoRoot, "logs", "communicate", "registry.json"), "{}", "utf8");

    const legacyScanModule = loadLegacyScanModule();
    const result = legacyScanModule.scanLegacyArtifacts({
      env: createSetupEnv(tempRoot),
      searchRoots: [tempRoot],
      listScheduledTasks: () => [],
      listShortcuts: () => []
    });

    assert.equal(result.hasLegacyArtifacts, true);
    assert.deepEqual(result.repoRoots, [legacyRepoRoot]);
    assert.deepEqual(
      result.scripts.map((entry) => path.basename(entry.path)).sort(),
      [
        "Install-CodexLark-Autostart.ps1",
        "Repair-CodexLark.ps1",
        "Start-CodexLark.ps1",
        "Uninstall-CodexLark-Autostart.ps1"
      ]
    );
    assert.equal(result.tasks.length, 0);
    assert.equal(result.shortcuts.length, 0);
    assert.match(result.stateRoots.map((entry) => `${entry.kind}:${entry.path}`).join("\n"), /registry\.json/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scanLegacyArtifacts keeps partial scheduled-task warnings visible without inventing legacy tasks", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-task-warning-"));

  try {
    const legacyScanModule = loadLegacyScanModule();
    const result = legacyScanModule.scanLegacyArtifacts({
      env: createSetupEnv(tempRoot),
      searchRoots: [tempRoot],
      listShortcuts: () => [],
      listScheduledTasks: () => ({
        items: [],
        warnings: ["Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks."]
      })
    });

    assert.equal(result.tasks.length, 0);
    assert.equal(result.hasLegacyArtifacts, false);
    assert.match(result.warnings.join("\n"), /scheduled task scan was partial/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("legacy PowerShell scan commands survive the real node-to-powershell command boundary", (t) => {
  const legacyScanModule = loadLegacyScanModule();
  assert.equal(typeof legacyScanModule.buildWindowsShortcutScanCommand, "function");
  assert.equal(typeof legacyScanModule.buildWindowsScheduledTaskScanCommand, "function");

  try {
    const shortcutOutput = runPowerShellCommand(
      legacyScanModule.buildWindowsShortcutScanCommand?.([path.win32.join("C:\\", "__CodexLarkMissingRoot__")]) ?? ""
    );
    const scheduledTaskOutput = runPowerShellCommand(legacyScanModule.buildWindowsScheduledTaskScanCommand?.() ?? "");
    const scheduledTaskPayload = JSON.parse(scheduledTaskOutput.trim()) as {
      items?: unknown[];
      warnings?: string[];
    };

    assert.deepEqual(JSON.parse(shortcutOutput.trim()), []);
    assert.ok(Array.isArray(scheduledTaskPayload.items));
    assert.ok(Array.isArray(scheduledTaskPayload.warnings));
    assert.match(legacyScanModule.buildWindowsScheduledTaskScanCommand?.() ?? "", /鎷掔粷璁块棶|鏉冮檺/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Node child_process cannot spawn powershell.exe in this environment.");
      return;
    }
    throw error;
  }
});


test("legacy script path extraction recognizes current autostart scripts", () => {
  const legacyScanModule = loadLegacyScanModule();
  assert.equal(typeof legacyScanModule.extractLegacyScriptPaths, "function");

  const installRoot = path.win32.join("D:\\", "CodexLark");
  const extracted = legacyScanModule.extractLegacyScriptPaths?.(
    "powershell.exe",
    `-ExecutionPolicy Bypass -File "${path.win32.join(installRoot, "Install-CodexLark-Autostart.ps1")}"; "${path.win32.join(installRoot, "Uninstall-CodexLark-Autostart.ps1" )}"`
  );

  assert.deepEqual(extracted?.sort(), [
    path.win32.join(installRoot, "Install-CodexLark-Autostart.ps1"),
    path.win32.join(installRoot, "Uninstall-CodexLark-Autostart.ps1")
  ].sort());
});

test("legacy scheduled task scan uses a 15 second timeout", () => {
  const legacyScanModule = loadLegacyScanModule();
  assert.equal(typeof legacyScanModule.normalizeWindowsPath, "function");

  const source = readFileSync(legacyScanModulePath(), "utf8");
  const scheduledTaskFunction = source.slice(source.indexOf("function listWindowsScheduledTasks"));

  assert.match(scheduledTaskFunction, /timeout:\s*15000/);
  assert.doesNotMatch(scheduledTaskFunction, /timeout:\s*5000/);
});
test("legacy scheduled task scan warnings are treated as non-blocking", () => {
  const legacyScanModule = loadLegacyScanModule();
  assert.equal(typeof legacyScanModule.hasBlockingLegacyWarnings, "function");
  assert.equal(
    legacyScanModule.hasBlockingLegacyWarnings?.([
      "Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks."
    ]),
    false
  );
  assert.equal(legacyScanModule.hasBlockingLegacyWarnings?.(["Legacy shortcut scan failed: simulated access denied"]), true);
});


test("runLegacyMigration does not retain canonical launcher scripts or shortcuts", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-current-"));
  const env = createSetupEnv(tempRoot);
  const installRoot = path.win32.join(tempRoot, "current-install");
  const manifest = writeCanonicalRuntimeManifest(env, installRoot);
  writeCanonicalLauncherFiles(manifest);
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [
      {
        name: "Start-CodexLark.ps1",
        path: manifest.launcherPath,
        repoRoot: installRoot
      },
      {
        name: "Repair-CodexLark.ps1",
        path: path.win32.join(installRoot, "Repair-CodexLark.ps1"),
        repoRoot: installRoot
      },
      {
        name: "Install-CodexLark-Autostart.ps1",
        path: manifest.bridgeScriptPaths.installAutostart,
        repoRoot: installRoot
      },
      {
        name: "Uninstall-CodexLark-Autostart.ps1",
        path: manifest.bridgeScriptPaths.uninstallAutostart,
        repoRoot: installRoot
      }
    ],
    shortcuts: [
      {
        path: path.win32.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "CodexLark", "Launch CodexLark.lnk"),
        targetPath: manifest.launcherPath
      },
      {
        path: path.win32.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "CodexLark", "Repair CodexLark.lnk"),
        targetPath: path.win32.join(installRoot, "Repair-CodexLark.ps1")
      }
    ],
    tasks: [],
    stateRoots: [],
    warnings: [],
    repoRoots: [installRoot],
    hasLegacyArtifacts: true
  });
  delete require.cache[legacyMigrationPath];

  try {
    const migrationModule = loadLegacyMigrationModule();
    const result = await migrationModule.runLegacyMigration({ env });

    assert.deepEqual(result.retainedLegacyArtifacts, []);
    assert.equal(result.scan.scripts.length, 4);
    assert.equal(result.scan.shortcuts.length, 2);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[runtimeManifestModulePath()];
    delete require.cache[launcherModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("runLegacyMigration retains canonical shortcuts and tasks when their targets are missing", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-missing-target-"));
  const env = createSetupEnv(tempRoot);
  const installRoot = path.win32.join(tempRoot, "missing-install");
  const manifest = writeCanonicalRuntimeManifest(env, installRoot);
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [],
    shortcuts: [
      {
        path: path.win32.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "CodexLark", "Launch CodexLark.lnk"),
        targetPath: manifest.launcherPath
      }
    ],
    tasks: [
      {
        taskName: "CodexLark Missing Autostart Target",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: `-ExecutionPolicy Bypass -File "${manifest.bridgeScriptPaths.installAutostart}"`
      }
    ],
    stateRoots: [],
    warnings: [],
    repoRoots: [installRoot],
    hasLegacyArtifacts: true
  });
  delete require.cache[legacyMigrationPath];

  try {
    const migrationModule = loadLegacyMigrationModule();
    const result = await migrationModule.runLegacyMigration({ env });
    const retained = result.retainedLegacyArtifacts.join("\n");

    assert.match(retained, /shortcut:.*Launch CodexLark\.lnk/i);
    assert.match(retained, /task:.*Missing Autostart Target/i);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[runtimeManifestModulePath()];
    delete require.cache[launcherModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("runLegacyMigration retains drifted legacy launchers while allowing current autostart scripts", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-drift-"));
  const env = createSetupEnv(tempRoot);
  const installRoot = path.win32.join(tempRoot, "current-install");
  const legacyRoot = path.win32.join(tempRoot, "legacy-install");
  const manifest = writeCanonicalRuntimeManifest(env, installRoot);
  writeCanonicalLauncherFiles(manifest);
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [
      {
        name: "Start-CodexLark.ps1",
        path: path.win32.join(legacyRoot, "Start-CodexLark.ps1"),
        repoRoot: legacyRoot
      },
      {
        name: "Repair-CodexLark.ps1",
        path: path.win32.join(legacyRoot, "Repair-CodexLark.ps1"),
        repoRoot: legacyRoot
      }
    ],
    shortcuts: [
      {
        path: path.win32.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "CodexLark", "Launch CodexLark.lnk"),
        targetPath: path.win32.join(legacyRoot, "Start-CodexLark.ps1")
      },
      {
        path: path.win32.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "CodexLark", "Repair CodexLark.lnk"),
        targetPath: path.win32.join(installRoot, "Repair-CodexLark.ps1")
      }
    ],
    tasks: [
      {
        taskName: "CodexLark Legacy LongConn",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: `-ExecutionPolicy Bypass -File "${path.win32.join(legacyRoot, "run-admin-task.ps1")}"`
      },
      {
        taskName: "CodexLark Current Admin Task Should Still Block",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: `-ExecutionPolicy Bypass -File "${manifest.bridgeScriptPaths.runAdminTask}"`
      },
      {
        taskName: "CodexLark Current Autostart Task",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: `-ExecutionPolicy Bypass -File "${manifest.bridgeScriptPaths.installAutostart}"`
      },
      {
        taskName: "CodexLark Current Uninstall Autostart Task",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: `-ExecutionPolicy Bypass -File "${manifest.bridgeScriptPaths.uninstallAutostart}"`
      },
      {
        taskName: "CodexLark Mixed Legacy Admin Still Blocks",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: `-File "${path.win32.join(legacyRoot, "run-admin-task.ps1")}" -Cleanup "${manifest.bridgeScriptPaths.installAutostart}"`
      }
    ],
    stateRoots: [],
    warnings: [],
    repoRoots: [installRoot, legacyRoot],
    hasLegacyArtifacts: true
  });
  delete require.cache[legacyMigrationPath];

  try {
    assert.equal(manifest.bridgeScriptPaths.installAutostart, path.win32.join(installRoot, "Install-CodexLark-Autostart.ps1"));
    const migrationModule = loadLegacyMigrationModule();
    const result = await migrationModule.runLegacyMigration({ env });
    const retained = result.retainedLegacyArtifacts.join("\n");

    assert.ok(retained.includes(`script:${path.win32.join(legacyRoot, "Start-CodexLark.ps1")}`));
    assert.ok(retained.includes(`script:${path.win32.join(legacyRoot, "Repair-CodexLark.ps1")}`));
    assert.match(retained, /shortcut:.*Launch CodexLark\.lnk/i);
    assert.match(retained, /task:.*CodexLark Legacy LongConn/i);
    assert.match(retained, /task:.*Current Admin Task Should Still Block/i);
    assert.doesNotMatch(retained, /task:.*Current Autostart Task/i);
    assert.doesNotMatch(retained, /task:.*Current Uninstall Autostart Task/i);
    assert.match(retained, /task:.*Mixed Legacy Admin Still Blocks/i);
    assert.doesNotMatch(retained, /Repair CodexLark\.lnk/i);
    assert.doesNotMatch(retained, /Install-CodexLark-Autostart\.ps1/i);
    assert.doesNotMatch(retained, /Uninstall-CodexLark-Autostart\.ps1/i);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[runtimeManifestModulePath()];
    delete require.cache[launcherModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("runFirstRunCommand imports legacy env once and ignores the same env on subsequent runs", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-first-run-"));
  const firstEnv = createSetupEnv(tempRoot, {
    FEISHU_APP_ID: "cli_legacy_app",
    FEISHU_APP_SECRET: "secret-first-value"
  });
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  try {
    legacyScanModule.scanLegacyArtifacts = (options = {}) =>
      originalScan({
        ...options,
        searchRoots: [tempRoot],
        listScheduledTasks: () => [],
        listShortcuts: () => []
      });
    delete require.cache[legacyMigrationPath];
    delete require.cache[firstRunCommandModulePath()];

    await withPatchedStoreSetupSecret(async () =>
      await withPatchedInspectCodexCliDependency(async () => {
        const commandModule = loadFirstRunCommandModule();
        const configStoreModule = loadConfigStoreModule();
        const migrationModule = loadLegacyMigrationModule();

        const firstResult = await commandModule.runFirstRunCommand?.({ env: firstEnv });
        const firstSettings = configStoreModule.readSetupSettings(firstEnv);

        assert.equal(firstResult?.ok, true);
        assert.deepEqual(firstResult?.legacyMigration.importedConfig.sort(), ["feishuAppId", "feishuAppSecret"]);
        assert.match(firstResult?.legacyMigration.disabledLegacyArtifacts.join("\n") ?? "", /FEISHU_APP_ID/i);
        assert.equal(firstSettings.feishuAppId, "cli_legacy_app");
        assert.ok(firstSettings.feishuAppSecretRef);
        assert.deepEqual(
          migrationModule.readLegacyMigrationState(firstEnv).handledEnvNames.sort(),
          ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
        );
        assert.equal(firstResult?.legacyMigration.statePath, migrationModule.getLegacyMigrationStatePath(firstEnv));

        configStoreModule.writeSetupSettings(
          {
            feishuAppId: "feishu-canonical-app-fixture"
          },
          firstEnv
        );
        const secondEnv = createSetupEnv(tempRoot, {
          FEISHU_APP_ID: "cli_should_be_ignored",
          FEISHU_APP_SECRET: "secret-second-value"
        });

        const secondResult = await commandModule.runFirstRunCommand?.({ env: secondEnv });
        const secondSettings = configStoreModule.readSetupSettings(secondEnv);

        assert.equal(secondResult?.ok, true);
        assert.deepEqual(secondResult?.legacyMigration.importedConfig, []);
        assert.match(secondResult?.legacyMigration.warnings.join("\n") ?? "", /ignored|already/i);
        assert.equal(secondSettings.feishuAppId, "feishu-canonical-app-fixture");
        assert.equal(secondSettings.feishuAppSecretRef, firstSettings.feishuAppSecretRef);
      })
    );
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[firstRunCommandModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLegacyMigration imports legacy CODEX_CLI_EXE and keeps lingering env-backed config non-blocking", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-codex-env-"));
  const env = createSetupEnv(tempRoot, {
    FEISHU_APP_ID: "cli_legacy_app",
    FEISHU_APP_SECRET: "secret-legacy-value",
    CODEX_CLI_EXE: "D:\\Portable\\codex.cmd",
    COMMUNICATE_FEISHU_DEBUG: "1"
  });
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  try {
    legacyScanModule.scanLegacyArtifacts = (options = {}) =>
      originalScan({
        ...options,
        searchRoots: [tempRoot],
        listScheduledTasks: () => [],
        listShortcuts: () => []
      });
    delete require.cache[legacyMigrationPath];

    await withPatchedStoreSetupSecret(async () => {
      const migrationModule = loadLegacyMigrationModule();
      const configStoreModule = loadConfigStoreModule();
      const result = await migrationModule.runLegacyMigration({
        env
      });

      const storedSettings = configStoreModule.readSetupSettings(env);
      const legacySecretEntry = result.scan.envVars.find((entry) => entry.name === "FEISHU_APP_SECRET");
      assert.deepEqual(result.importedConfig.sort(), ["codexCliPath", "feishuAppId", "feishuAppSecret"]);
      assert.equal(result.retainedLegacyArtifacts.length, 0);
      assert.match(result.disabledLegacyArtifacts.join("\n"), /CODEX_CLI_EXE/i);
      assert.match(result.disabledLegacyArtifacts.join("\n"), /COMMUNICATE_FEISHU_DEBUG/i);
      assert.doesNotMatch(JSON.stringify(result), /secret-legacy-value/);
      assert.equal(legacySecretEntry?.value, "[redacted]");
      assert.equal(storedSettings.codexCliPath, "D:\\Portable\\codex.cmd");
      assert.deepEqual(
        result.state.handledEnvNames.sort(),
        ["CODEX_CLI_EXE", "COMMUNICATE_FEISHU_DEBUG", "FEISHU_APP_ID", "FEISHU_APP_SECRET"]
      );
    });
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand blocks ready status when legacy launchers still need manual cleanup", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-first-run-gate-"));
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [
      {
        name: "Start-CodexLark.ps1",
        path: "D:\\LegacyRepo\\Start-CodexLark.ps1",
        repoRoot: "D:\\LegacyRepo"
      }
    ],
    shortcuts: [],
    tasks: [],
    stateRoots: [],
    warnings: [],
    repoRoots: ["D:\\LegacyRepo"],
    hasLegacyArtifacts: true
  });
  delete require.cache[legacyMigrationPath];
  delete require.cache[firstRunCommandModulePath()];

  try {
    await withPatchedInspectCodexCliDependency(async () => {
      const commandModule = loadFirstRunCommandModule();
      const result = await commandModule.runFirstRunCommand?.({
        env: createSetupEnv(tempRoot)
      });

      assert.equal(result?.ok, false);
      assert.equal(result?.status, "action-required");
      assert.match(String(result?.message), /legacy/i);
      assert.match(result?.legacyMigration.retainedLegacyArtifacts.join("\n") ?? "", /Start-CodexLark\.ps1/i);
    });
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[firstRunCommandModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand blocks ready status when legacy scanning is incomplete", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-first-run-warning-"));
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [],
    shortcuts: [],
    tasks: [],
    stateRoots: [],
    warnings: ["Legacy shortcut scan failed: simulated access denied"],
    repoRoots: [],
    hasLegacyArtifacts: false
  });
  delete require.cache[legacyMigrationPath];
  delete require.cache[firstRunCommandModulePath()];

  try {
    await withPatchedInspectCodexCliDependency(async () => {
      const commandModule = loadFirstRunCommandModule();
      const result = await commandModule.runFirstRunCommand?.({
        env: createSetupEnv(tempRoot)
      });

      assert.equal(result?.ok, false);
      assert.equal(result?.status, "action-required");
      assert.match(String(result?.message), /scan|review|legacy/i);
      assert.match(result?.legacyMigration.warnings.join("\n") ?? "", /scan failed/i);
    });
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[firstRunCommandModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand stays ready when only scheduled-task scan warnings are present", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-first-run-task-warning-"));
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [],
    shortcuts: [],
    tasks: [],
    stateRoots: [],
    warnings: ["Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks."],
    repoRoots: [],
    hasLegacyArtifacts: false
  });
  delete require.cache[legacyMigrationPath];
  delete require.cache[firstRunCommandModulePath()];

  try {
    await withPatchedInspectCodexCliDependency(async () => {
      const commandModule = loadFirstRunCommandModule();
      const result = await commandModule.runFirstRunCommand?.({
        env: createSetupEnv(tempRoot)
      });

      assert.equal(result?.ok, true);
      assert.equal(result?.status, "ready");
      assert.match(String(result?.message), /ready|continue|scheduled task/i);
      assert.match(result?.legacyMigration.warnings.join("\n") ?? "", /scheduled task scan was partial/i);
    });
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[firstRunCommandModulePath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});



test("runRepairCommand stays ready when only non-blocking migration warnings remain", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-repair-env-warning-"));
  const env = createSetupEnv(tempRoot, {
    COMMUNICATE_FEISHU_DEBUG: "1"
  });
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const repairCommandPath = repairCommandModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = (options = {}) =>
    originalScan({
      ...options,
      searchRoots: [tempRoot],
      listScheduledTasks: () => [],
      listShortcuts: () => []
    });
  delete require.cache[legacyMigrationPath];
  delete require.cache[repairCommandPath];

  try {
    const repairModule = loadRepairCommandModule();
    const result = await repairModule.runRepairCommand?.({ env });

    assert.equal(result?.ok, true);
    assert.equal(result?.status, "ready");
    assert.match(result?.legacyMigration.warnings.join("\n") ?? "", /COMMUNICATE_FEISHU_DEBUG/i);
    assert.deepEqual(result?.legacyMigration.scan.warnings, []);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[repairCommandPath];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("runRepairCommand stays ready when only non-blocking retained legacy artifacts remain", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-repair-nonblocking-"));
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const repairCommandPath = repairCommandModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [],
    shortcuts: [],
    tasks: [],
    stateRoots: [
      {
        kind: "logs",
        path: "D:\\LegacyRepo\\logs",
        repoRoot: "D:\\LegacyRepo"
      }
    ],
    warnings: [],
    repoRoots: ["D:\\LegacyRepo"],
    hasLegacyArtifacts: true
  });
  delete require.cache[legacyMigrationPath];
  delete require.cache[repairCommandPath];

  try {
    const repairModule = loadRepairCommandModule();
    const result = await repairModule.runRepairCommand?.({
      env: createSetupEnv(tempRoot)
    });

    assert.equal(result?.ok, true);
    assert.equal(result?.status, "ready");
    assert.match(result?.legacyMigration.retainedLegacyArtifacts.join("\n") ?? "", /state-root:/i);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[repairCommandPath];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("runRepairCommand returns action-required when legacy artifacts still need manual cleanup", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-repair-"));
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const repairCommandPath = repairCommandModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [
      {
        name: "Start-CodexLark.ps1",
        path: "D:\\LegacyRepo\\Start-CodexLark.ps1",
        repoRoot: "D:\\LegacyRepo"
      }
    ],
    shortcuts: [],
    tasks: [
      {
        taskName: "CodexLark Legacy LongConn",
        taskPath: "\\CodexLark\\",
        execute: "powershell.exe",
        arguments: "-File D:\\LegacyRepo\\run-admin-task.ps1"
      }
    ],
    stateRoots: [
      {
        kind: "logs",
        path: "D:\\LegacyRepo\\logs",
        repoRoot: "D:\\LegacyRepo"
      }
    ],
    warnings: [],
    repoRoots: ["D:\\LegacyRepo"],
    hasLegacyArtifacts: true
  });
  delete require.cache[legacyMigrationPath];
  delete require.cache[repairCommandPath];

  try {
    const repairModule = loadRepairCommandModule();
    const result = await repairModule.runRepairCommand?.({
      env: createSetupEnv(tempRoot)
    });

    assert.equal(result?.ok, false);
    assert.equal(result?.status, "action-required");
    assert.match(String(result?.message), /legacy/i);
    assert.match(result?.legacyMigration.retainedLegacyArtifacts.join("\n") ?? "", /Start-CodexLark\.ps1/i);
    assert.match(result?.legacyMigration.retainedLegacyArtifacts.join("\n") ?? "", /Legacy LongConn/i);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[repairCommandPath];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runRepairCommand stays ready when only scheduled-task scan warnings are present", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-legacy-repair-warning-"));
  const legacyScanPath = legacyScanModulePath();
  const legacyMigrationPath = legacyMigrationModulePath();
  const repairCommandPath = repairCommandModulePath();
  const legacyScanModule = loadLegacyScanModule();
  const originalScan = legacyScanModule.scanLegacyArtifacts;

  legacyScanModule.scanLegacyArtifacts = () => ({
    envVars: [],
    scripts: [],
    shortcuts: [],
    tasks: [],
    stateRoots: [],
    warnings: ["Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks."],
    repoRoots: [],
    hasLegacyArtifacts: false
  });
  delete require.cache[legacyMigrationPath];
  delete require.cache[repairCommandPath];

  try {
    const repairModule = loadRepairCommandModule();
    const result = await repairModule.runRepairCommand?.({
      env: createSetupEnv(tempRoot)
    });

    assert.equal(result?.ok, true);
    assert.equal(result?.status, "ready");
    assert.match(String(result?.message), /scheduled tasks could not be inspected|no blocking legacy/i);
    assert.match(result?.legacyMigration.warnings.join("\n") ?? "", /scan was partial/i);
  } finally {
    legacyScanModule.scanLegacyArtifacts = originalScan;
    delete require.cache[legacyScanPath];
    delete require.cache[legacyMigrationPath];
    delete require.cache[repairCommandPath];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
