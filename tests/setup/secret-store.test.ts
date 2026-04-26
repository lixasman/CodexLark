import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type CodexDependencyResult = {
  present: boolean;
  installAttempted: boolean;
  resolvedPath?: string;
  version?: string;
  loginDetected: boolean;
  loginDetectionSource?: "marker" | "openai_api_key";
  failureCategory?: "missing" | "install-failed" | "unsupported-version" | "login-missing";
};

type SetupCommandResult = {
  schemaVersion: number;
  verb: string;
  ok: boolean;
  status: string;
  message: string;
  summaryPath: string;
  legacyMigration?: {
    retainedLegacyArtifacts: string[];
    warnings: string[];
  };
};

type SetupCommandModule = {
  runFirstRunCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<SetupCommandResult>;
};

type ConfigStoreModule = {
  getSettingsPath: (env?: NodeJS.ProcessEnv) => string;
  readSetupSettings: (env?: NodeJS.ProcessEnv) => {
    schemaVersion: number;
    feishuAppId?: string;
    feishuAppSecretRef?: string;
  };
  writeSetupSettings: (
    input: { feishuAppId?: string; feishuAppSecretRef?: string },
    env?: NodeJS.ProcessEnv
  ) => {
    schemaVersion: number;
    feishuAppId?: string;
    feishuAppSecretRef?: string;
  };
};

type SecretStoreModule = {
  storeSetupSecret: (
    input: { name: string; value: string },
    options?: { env?: NodeJS.ProcessEnv; protectSecret?: (secret: string) => Promise<string> | string }
  ) => Promise<{ reference: string; recordPath: string }>;
  readStoredSecretRecord: (
    reference: string,
    options?: { env?: NodeJS.ProcessEnv }
  ) => {
    schemaVersion: number;
    name: string;
    reference: string;
    protectedValue: string;
  };
};

type CodexDependencyModule = {
  inspectCodexCliDependency: (options?: {
    env?: NodeJS.ProcessEnv;
    installWhenMissing?: boolean;
  }) => Promise<CodexDependencyResult>;
};

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

type LegacyScanResult = {
  envVars: Array<{ name: string; value: string }>;
  scripts: Array<{ path: string; repoRoot: string; name: string }>;
  shortcuts: LegacyShortcutRecord[];
  tasks: LegacyTaskRecord[];
  stateRoots: Array<{ path: string; repoRoot: string; kind: string }>;
  warnings: string[];
  repoRoots: string[];
  hasLegacyArtifacts: boolean;
};

type LegacyScanModule = {
  scanLegacyArtifacts: (options?: {
    env?: NodeJS.ProcessEnv;
    repoRoots?: string[];
    searchRoots?: string[];
    listShortcuts?: () => LegacyShortcutRecord[];
    listScheduledTasks?: () => LegacyTaskRecord[];
  }) => LegacyScanResult;
};

function legacyScanModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-scan.js");
}

function firstRunCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "first-run.js");
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

function legacyMigrationModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-migration.js");
}

function loadFirstRunCommandModule(): SetupCommandModule {
  const modulePath = firstRunCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as SetupCommandModule;
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

function loadLegacyScanModule(): LegacyScanModule {
  const modulePath = legacyScanModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LegacyScanModule;
}

function createSetupEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    LOCALAPPDATA: root,
    LocalAppData: root,
    USERPROFILE: root,
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    ...extra
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withPatchedInspectCodexCliDependency<T>(
  patched: CodexDependencyModule["inspectCodexCliDependency"],
  callback: () => Promise<T>
): Promise<T> {
  const dependencyModulePath = codexDependencyModulePath();
  const dependencyModule = loadCodexDependencyModule();
  const original = dependencyModule.inspectCodexCliDependency;
  dependencyModule.inspectCodexCliDependency = patched;
  delete require.cache[firstRunCommandModulePath()];

  try {
    return await callback();
  } finally {
    dependencyModule.inspectCodexCliDependency = original;
    delete require.cache[dependencyModulePath];
    delete require.cache[firstRunCommandModulePath()];
  }
}

async function withPatchedStoreSetupSecret<T>(callback: () => Promise<T>): Promise<T> {
  const secretStorePath = secretStoreModulePath();
  const secretStoreModule = loadSecretStoreModule();
  const original = secretStoreModule.storeSetupSecret;
  secretStoreModule.storeSetupSecret = async (input, options = {}) =>
    await original(input, {
      ...options,
      protectSecret: () => "dpapi-test-payload"
    });
  delete require.cache[firstRunCommandModulePath()];

  try {
    return await callback();
  } finally {
    secretStoreModule.storeSetupSecret = original;
    delete require.cache[secretStorePath];
    delete require.cache[firstRunCommandModulePath()];
  }
}

async function withPatchedLegacyScanClean<T>(envRoot: string, callback: () => Promise<T>): Promise<T> {
  const scanPath = legacyScanModulePath();
  const migrationPath = legacyMigrationModulePath();
  const scanModule = loadLegacyScanModule();
  const original = scanModule.scanLegacyArtifacts;
  scanModule.scanLegacyArtifacts = (options = {}) =>
    original({
      ...options,
      repoRoots: [],
      searchRoots: [envRoot],
      listShortcuts: () => [],
      listScheduledTasks: () => []
    });
  delete require.cache[migrationPath];
  delete require.cache[firstRunCommandModulePath()];

  try {
    return await callback();
  } finally {
    scanModule.scanLegacyArtifacts = original;
    delete require.cache[scanPath];
    delete require.cache[migrationPath];
    delete require.cache[firstRunCommandModulePath()];
  }
}

test("runFirstRunCommand stores FEISHU_APP_ID in settings.json without persisting FEISHU_APP_SECRET in plaintext", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-secret-store-"));
  const appId = "cli_test_app_id";
  const secretValue = "secret-task4-value";
  const secretPattern = new RegExp(escapeRegExp(secretValue));

  try {
    await withPatchedLegacyScanClean(
      tempRoot,
      async () =>
        await withPatchedStoreSetupSecret(async () =>
          await withPatchedInspectCodexCliDependency(
            async () => ({
              present: true,
              installAttempted: false,
              resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
              version: "0.121.1",
              loginDetected: true,
              loginDetectionSource: "openai_api_key"
            }),
            async () => {
              const commandModule = loadFirstRunCommandModule();
              const result = await commandModule.runFirstRunCommand?.({
                env: createSetupEnv(tempRoot, {
                  FEISHU_APP_ID: appId,
                  FEISHU_APP_SECRET: secretValue
                })
              });
              assert.equal(result?.ok, true);
            }
          )
        )
    );

    const env = createSetupEnv(tempRoot);
    const configStoreModule = loadConfigStoreModule();
    const secretStoreModule = loadSecretStoreModule();
    const settingsPath = configStoreModule.getSettingsPath(env);
    const settingsText = readFileSync(settingsPath, "utf8");
    const settings = configStoreModule.readSetupSettings(env);

    assert.equal(settings.feishuAppId, appId);
    assert.ok(settings.feishuAppSecretRef);
    assert.doesNotMatch(settingsText, secretPattern);

    const storedSecret = secretStoreModule.readStoredSecretRecord(settings.feishuAppSecretRef!, { env });
    assert.equal(storedSecret.reference, settings.feishuAppSecretRef);
    assert.ok(storedSecret.protectedValue.length > 0);
    assert.doesNotMatch(JSON.stringify(storedSecret), secretPattern);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand keeps a machine-readable summary when secret storage fails", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-secret-store-fail-"));

  try {
    const secretStorePath = secretStoreModulePath();
    const migrationPath = legacyMigrationModulePath();
    const secretStoreModule = loadSecretStoreModule();
    const original = secretStoreModule.storeSetupSecret;
    secretStoreModule.storeSetupSecret = async () => {
      throw new Error("dpapi unavailable");
    };
    delete require.cache[firstRunCommandModulePath()];
    delete require.cache[migrationPath];

    try {
      await withPatchedLegacyScanClean(
        tempRoot,
        async () =>
          await withPatchedInspectCodexCliDependency(
            async () => ({
              present: true,
              installAttempted: false,
              resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
              version: "0.121.1",
              loginDetected: true,
              loginDetectionSource: "openai_api_key"
            }),
            async () => {
              const commandModule = loadFirstRunCommandModule();
              const result = await commandModule.runFirstRunCommand?.({
                env: createSetupEnv(tempRoot, {
                  FEISHU_APP_ID: "cli_test_app_id",
                  FEISHU_APP_SECRET: "secret-task4-value"
                })
              });

              assert.equal(result?.ok, false);
              assert.equal(result?.status, "action-required");
              assert.match(String(result?.message), /secret/i);
              assert.equal(result?.legacyMigration?.warnings.length, 1);
              assert.match(result?.legacyMigration?.warnings[0] ?? "", /secure storage|dpapi/i);
              assert.equal(
                (result?.legacyMigration?.retainedLegacyArtifacts ?? []).some((entry) => entry.startsWith("state-root:")),
                false
              );
              assert.ok(result?.summaryPath);
              assert.equal(existsSync(String(result?.summaryPath)), true);
              assert.deepEqual(readFileSync(String(result?.summaryPath), "utf8"), JSON.stringify(result, null, 2));
            }
          )
      );
    } finally {
      secretStoreModule.storeSetupSecret = original;
      delete require.cache[secretStorePath];
      delete require.cache[firstRunCommandModulePath()];
      delete require.cache[migrationPath];
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand keeps canonical settings when legacy env reappears after migration storage is already complete", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-secret-store-preserve-"));
  const env = createSetupEnv(tempRoot, {
    FEISHU_APP_ID: "cli_new_app_id",
    FEISHU_APP_SECRET: "secret-task4-value"
  });
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();

  try {
    const existingSecret = await secretStoreModule.storeSetupSecret(
      {
        name: "existing-feishu-secret",
        value: "secret-existing-value"
      },
      {
        env,
        protectSecret: () => "dpapi-existing-payload"
      }
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_old_app_id",
        feishuAppSecretRef: existingSecret.reference
      },
      env
    );

    const secretStorePath = secretStoreModulePath();
    const migrationPath = legacyMigrationModulePath();
    const original = secretStoreModule.storeSetupSecret;
    secretStoreModule.storeSetupSecret = async () => {
      throw new Error("dpapi unavailable");
    };
    delete require.cache[firstRunCommandModulePath()];
    delete require.cache[migrationPath];

    try {
      await withPatchedLegacyScanClean(
        tempRoot,
        async () =>
          await withPatchedInspectCodexCliDependency(
            async () => ({
              present: true,
              installAttempted: false,
              resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
              version: "0.121.1",
              loginDetected: true,
              loginDetectionSource: "openai_api_key"
            }),
            async () => {
              const commandModule = loadFirstRunCommandModule();
              const result = await commandModule.runFirstRunCommand?.({ env });
              assert.equal(result?.ok, true);
              assert.equal(result?.status, "ready");
            }
          )
      );
    } finally {
      secretStoreModule.storeSetupSecret = original;
      delete require.cache[secretStorePath];
      delete require.cache[firstRunCommandModulePath()];
      delete require.cache[migrationPath];
    }

    const settings = configStoreModule.readSetupSettings(env);
    assert.equal(settings.feishuAppId, "cli_old_app_id");
    assert.equal(settings.feishuAppSecretRef, existingSecret.reference);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
