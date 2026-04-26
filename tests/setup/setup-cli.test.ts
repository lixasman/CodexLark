import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type SetupCommandResult = {
  schemaVersion: number;
  verb: string;
  ok: boolean;
  status: string;
  message: string;
  summaryPath: string;
};

type CodexDependencyResult = {
  present: boolean;
  installAttempted: boolean;
  resolvedPath?: string;
  version?: string;
  loginDetected: boolean;
  loginMarkerPath?: string;
  loginDetectionSource?: "marker" | "openai_api_key";
  failureCategory?: string;
};

type SetupCliModule = {
  main: (argv?: string[]) => Promise<SetupCommandResult>;
  runCli: (
    argv: string[],
    io?: {
      stdout: (text: string) => void;
      stderr: (text: string) => void;
    }
  ) => Promise<number>;
  usage: () => string;
};

type SetupModule = {
  runSetupCommand: (verb: string, context?: unknown) => Promise<SetupCommandResult>;
};

type SetupTypesModule = {
  SetupSchemaVersion: number;
};

type CodexDependencyModule = {
  inspectCodexCliDependency: (options?: {
    env?: NodeJS.ProcessEnv;
    installWhenMissing?: boolean;
  }) => Promise<CodexDependencyResult>;
};

type SecretStoreModule = {
  storeSetupSecret: (
    input: { name: string; value: string },
    options?: { env?: NodeJS.ProcessEnv; protectSecret?: (secret: string) => Promise<string> | string }
  ) => Promise<{ reference: string; recordPath: string }>;
  resolveSetupSecretValue: (
    reference: string,
    options?: { env?: NodeJS.ProcessEnv }
  ) => Promise<string> | string;
};

type ConfigStoreModule = {
  writeSetupSettings: (
    input: {
      feishuAppId?: string;
      feishuAppSecretRef?: string;
      codexCliPath?: string;
    },
    env?: NodeJS.ProcessEnv
  ) => {
    feishuAppId?: string;
    feishuAppSecretRef?: string;
    codexCliPath?: string;
  };
};

type LegacyMigrationModule = {
  runLegacyMigration: (options?: {
    env?: NodeJS.ProcessEnv;
  }) => Promise<{
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
    failureCategory?: string;
  }>;
};

type CapturedCliRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function setupCliPath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup-cli.js");
}

function setupModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "index.js");
}

function codexDependencyModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "codex-dependency.js");
}

function firstRunCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "first-run.js");
}

function doctorCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "doctor.js");
}

function repairCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "repair.js");
}

function secretStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "secret-store.js");
}

function configStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "config-store.js");
}

function runtimeContextModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "runtime-context.js");
}

function resolveLaunchEnvCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "resolve-launch-env.js");
}

function legacyMigrationModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-migration.js");
}

function setupTypesPath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "types.js");
}

function loadSetupCliModule(): SetupCliModule {
  const cliPath = setupCliPath();
  delete require.cache[cliPath];
  return require(cliPath) as SetupCliModule;
}

function loadSetupModule(): SetupModule {
  const modulePath = setupModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as SetupModule;
}

function loadCodexDependencyModule(): CodexDependencyModule {
  const modulePath = codexDependencyModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as CodexDependencyModule;
}

function loadSecretStoreModule(): SecretStoreModule {
  const modulePath = secretStoreModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as SecretStoreModule;
}

function loadConfigStoreModule(): ConfigStoreModule {
  const modulePath = configStoreModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as ConfigStoreModule;
}

function loadSetupTypesModule(): SetupTypesModule {
  const modulePath = setupTypesPath();
  delete require.cache[modulePath];
  return require(modulePath) as SetupTypesModule;
}

function loadLegacyMigrationModule(): LegacyMigrationModule {
  const modulePath = legacyMigrationModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LegacyMigrationModule;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function createSetupEnv(localAppDataRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCALAPPDATA: localAppDataRoot,
    LocalAppData: localAppDataRoot,
    USERPROFILE: localAppDataRoot,
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    CODEX_CLI_EXE: "",
    COMMUNICATE_FEISHU_DEBUG: "",
    ...extra
  };
}

async function withLocalAppData<T>(localAppDataRoot: string, callback: () => Promise<T>): Promise<T> {
  const previousUpper = process.env.LOCALAPPDATA;
  const previousPascal = process.env.LocalAppData;
  const previousFeishuAppId = process.env.FEISHU_APP_ID;
  const previousFeishuAppSecret = process.env.FEISHU_APP_SECRET;
  const previousCodexCliExe = process.env.CODEX_CLI_EXE;
  const previousFeishuDebug = process.env.COMMUNICATE_FEISHU_DEBUG;
  process.env.LOCALAPPDATA = localAppDataRoot;
  process.env.LocalAppData = localAppDataRoot;
  process.env.FEISHU_APP_ID = "";
  process.env.FEISHU_APP_SECRET = "";
  process.env.CODEX_CLI_EXE = "";
  process.env.COMMUNICATE_FEISHU_DEBUG = "";

  try {
    return await callback();
  } finally {
    if (previousUpper == null) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = previousUpper;
    }

    if (previousPascal == null) {
      delete process.env.LocalAppData;
    } else {
      process.env.LocalAppData = previousPascal;
    }
    if (previousFeishuAppId === undefined) {
      delete process.env.FEISHU_APP_ID;
    } else {
      process.env.FEISHU_APP_ID = previousFeishuAppId;
    }
    if (previousFeishuAppSecret === undefined) {
      delete process.env.FEISHU_APP_SECRET;
    } else {
      process.env.FEISHU_APP_SECRET = previousFeishuAppSecret;
    }
    if (previousCodexCliExe === undefined) {
      delete process.env.CODEX_CLI_EXE;
    } else {
      process.env.CODEX_CLI_EXE = previousCodexCliExe;
    }
    if (previousFeishuDebug === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = previousFeishuDebug;
    }
  }
}

async function withPatchedFeishuEnv<T>(values: { appId?: string; appSecret?: string }, callback: () => Promise<T>): Promise<T> {
  const previousAppId = process.env.FEISHU_APP_ID;
  const previousAppSecret = process.env.FEISHU_APP_SECRET;
  process.env.FEISHU_APP_ID = values.appId ?? "";
  process.env.FEISHU_APP_SECRET = values.appSecret ?? "";

  try {
    return await callback();
  } finally {
    if (previousAppId === undefined) {
      delete process.env.FEISHU_APP_ID;
    } else {
      process.env.FEISHU_APP_ID = previousAppId;
    }
    if (previousAppSecret === undefined) {
      delete process.env.FEISHU_APP_SECRET;
    } else {
      process.env.FEISHU_APP_SECRET = previousAppSecret;
    }
  }
}

async function runCliWithCapture(argv: string[], localAppDataRoot: string): Promise<CapturedCliRun> {
  const cli = loadSetupCliModule();
  let stdout = "";
  let stderr = "";
  let exitCode = -1;

  await withLocalAppData(localAppDataRoot, async () => {
    exitCode = await cli.runCli(argv, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    });
  });

  return { exitCode, stdout, stderr };
}

async function withPatchedRunSetupCommand<T>(
  patched: SetupModule["runSetupCommand"],
  callback: () => Promise<T>
): Promise<T> {
  const setupModule = loadSetupModule();
  const original = setupModule.runSetupCommand;
  setupModule.runSetupCommand = patched;
  delete require.cache[setupCliPath()];

  try {
    return await callback();
  } finally {
    setupModule.runSetupCommand = original;
    delete require.cache[setupCliPath()];
  }
}

test("setup CLI redacts FEISHU_APP_SECRET from machine-readable stdout", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-redact-"));
  const leakedSecret = "stdout-secret-should-not-leak";

  try {
    const result = await withPatchedRunSetupCommand(
      async () =>
        ({
          schemaVersion: 1,
          verb: "resolve-launch-env",
          ok: true,
          status: "ready",
          message: "ok",
          summaryPath: path.join(tempRoot, "CodexLark", "artifacts", "setup", "launch-env-summary.json"),
          runtimeEnv: {
            FEISHU_APP_ID: "cli_app_id",
            FEISHU_APP_SECRET: leakedSecret,
            CODEX_CLI_EXE: "D:\\Tools\\codex.cmd"
          }
        }) as SetupCommandResult,
      async () => await runCliWithCapture(["resolve-launch-env"], tempRoot)
    );
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      runtimeEnv?: {
        FEISHU_APP_ID?: string;
        FEISHU_APP_SECRET?: string;
        CODEX_CLI_EXE?: string;
      };
    };

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, new RegExp(leakedSecret));
    assert.equal(payload.runtimeEnv?.FEISHU_APP_ID, "cli_app_id");
    assert.equal(payload.runtimeEnv?.CODEX_CLI_EXE, "D:\\Tools\\codex.cmd");
    assert.equal(payload.runtimeEnv?.FEISHU_APP_SECRET, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI redacts legacy FEISHU_APP_SECRET name/value artifacts from stdout and summaries", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-legacy-redact-"));
  const leakedSecret = "legacy-secret-should-not-leak";
  const migrationModulePath = legacyMigrationModulePath();
  const migrationModule = loadLegacyMigrationModule();
  const original = migrationModule.runLegacyMigration;
  migrationModule.runLegacyMigration = async (options = {}) => ({
    importedConfig: [],
    disabledLegacyArtifacts: [],
    retainedLegacyArtifacts: [],
    warnings: [],
    statePath: path.join(String(options.env?.LOCALAPPDATA ?? ""), "CodexLark", "state", "legacy-migration.json"),
    state: {
      schemaVersion: 1,
      handledEnvNames: [],
      completedAt: "2026-04-19T00:00:00.000Z"
    },
    scan: {
      envVars: [
        {
          name: "FEISHU_APP_SECRET",
          value: leakedSecret
        },
        {
          name: "FEISHU_APP_ID",
          value: "cli_legacy_app"
        }
      ],
      scripts: [],
      shortcuts: [],
      tasks: [],
      stateRoots: [],
      warnings: [],
      repoRoots: [],
      hasLegacyArtifacts: true
    }
  });
  delete require.cache[repairCommandModulePath()];
  delete require.cache[setupModulePath()];
  delete require.cache[setupCliPath()];

  try {
    const result = await runCliWithCapture(["repair"], tempRoot);
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      legacyMigration?: {
        scan?: {
          envVars?: Array<{ name: string; value: string }>;
        };
      };
    };
    const summary = readJsonFile<typeof payload>(
      path.join(tempRoot, "CodexLark", "artifacts", "setup", "repair-summary.json")
    );
    const stdoutSecretEntry = payload.legacyMigration?.scan?.envVars?.find((entry) => entry.name === "FEISHU_APP_SECRET");
    const summarySecretEntry = summary.legacyMigration?.scan?.envVars?.find((entry) => entry.name === "FEISHU_APP_SECRET");

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, new RegExp(leakedSecret));
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(leakedSecret));
    assert.equal(stdoutSecretEntry?.value, "[redacted]");
    assert.equal(summarySecretEntry?.value, "[redacted]");
  } finally {
    migrationModule.runLegacyMigration = original;
    delete require.cache[migrationModulePath];
    delete require.cache[repairCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI resolve-launch-env does not decrypt Feishu secret before printing safe runtime env", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-resolve-safe-"));
  const env = createSetupEnv(tempRoot);
  const secretStorePath = secretStoreModulePath();
  const secretStoreModule = loadSecretStoreModule();
  const originalResolveSecret = secretStoreModule.resolveSetupSecretValue;

  try {
    const storedSecret = await secretStoreModule.storeSetupSecret(
      {
        name: "feishu-app-secret",
        value: "secret-that-must-not-be-decrypted-for-cli"
      },
      {
        env,
        protectSecret: () => "dpapi-test-payload"
      }
    );
    loadConfigStoreModule().writeSetupSettings(
      {
        feishuAppId: "cli_runtime_app_id",
        feishuAppSecretRef: storedSecret.reference,
        codexCliPath: "D:\\Tools\\codex.cmd"
      },
      env
    );
    secretStoreModule.resolveSetupSecretValue = () => {
      throw new Error("resolve-launch-env should not decrypt the Feishu secret for stdout output");
    };
    delete require.cache[runtimeContextModulePath()];
    delete require.cache[resolveLaunchEnvCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];

    const result = await withPatchedInspectCodexCliDependency(
      async () => ({
        present: true,
        installAttempted: false,
        resolvedPath: "D:\\Tools\\codex.cmd",
        version: "0.121.1",
        loginDetected: true,
        loginDetectionSource: "marker"
      }),
      async () => await runCliWithCapture(["resolve-launch-env"], tempRoot)
    );
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      runtimeEnv?: {
        FEISHU_APP_ID?: string;
        FEISHU_APP_SECRET?: string;
        CODEX_CLI_EXE?: string;
      };
      feishuAppSecretConfigured?: boolean;
    };
    const summary = readJsonFile<typeof payload>(
      path.join(tempRoot, "CodexLark", "artifacts", "setup", "launch-env-summary.json")
    );

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(payload.runtimeEnv?.FEISHU_APP_ID, "cli_runtime_app_id");
    assert.equal(payload.runtimeEnv?.CODEX_CLI_EXE, "D:\\Tools\\codex.cmd");
    assert.equal(payload.runtimeEnv?.FEISHU_APP_SECRET, undefined);
    assert.equal(payload.feishuAppSecretConfigured, true);
    assert.doesNotMatch(result.stdout, /secret-that-must-not-be-decrypted-for-cli/);
    assert.deepEqual(summary, payload);
  } finally {
    secretStoreModule.resolveSetupSecretValue = originalResolveSecret;
    delete require.cache[secretStorePath];
    delete require.cache[runtimeContextModulePath()];
    delete require.cache[resolveLaunchEnvCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function withPatchedInspectCodexCliDependency<T>(
  patched: CodexDependencyModule["inspectCodexCliDependency"],
  callback: () => Promise<T>
): Promise<T> {
  const dependencyModulePath = codexDependencyModulePath();
  const dependencyModule = loadCodexDependencyModule();
  const original = dependencyModule.inspectCodexCliDependency;
  dependencyModule.inspectCodexCliDependency = patched;
  delete require.cache[firstRunCommandModulePath()];
  delete require.cache[doctorCommandModulePath()];
  delete require.cache[runtimeContextModulePath()];
  delete require.cache[resolveLaunchEnvCommandModulePath()];
  delete require.cache[setupModulePath()];
  delete require.cache[setupCliPath()];

  try {
    return await callback();
  } finally {
    dependencyModule.inspectCodexCliDependency = original;
    delete require.cache[dependencyModulePath];
    delete require.cache[firstRunCommandModulePath()];
    delete require.cache[doctorCommandModulePath()];
    delete require.cache[runtimeContextModulePath()];
    delete require.cache[resolveLaunchEnvCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];
  }
}

async function assertRepairSetupVerb(
  summaryFileName: string,
  expectedMessage: RegExp
): Promise<void> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await runCliWithCapture(["repair"], tempRoot);
    const setupTypes = loadSetupTypesModule();
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      legacyMigration?: {
        retainedLegacyArtifacts?: string[];
        warnings?: string[];
      };
    };
    const expectedSummaryPath = path.join(tempRoot, "CodexLark", "artifacts", "setup", summaryFileName);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(payload.schemaVersion, setupTypes.SetupSchemaVersion);
    assert.equal(payload.verb, "repair");
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.match(payload.message, expectedMessage);
    assert.equal(payload.summaryPath, expectedSummaryPath);
    assert.deepEqual(payload.legacyMigration?.retainedLegacyArtifacts, []);
    assert.ok(Array.isArray(payload.legacyMigration?.warnings));
    assert.equal(existsSync(expectedSummaryPath), true);
    assert.deepEqual(readJsonFile<typeof payload>(expectedSummaryPath), payload);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("setup CLI runs repair and writes a machine-readable summary", async () => {
  const migrationModulePath = legacyMigrationModulePath();
  const migrationModule = loadLegacyMigrationModule();
  const original = migrationModule.runLegacyMigration;
  migrationModule.runLegacyMigration = async (options = {}) => ({
    importedConfig: [],
    disabledLegacyArtifacts: [],
    retainedLegacyArtifacts: [],
    warnings: [],
    statePath: path.join(String(options.env?.LOCALAPPDATA ?? ""), "CodexLark", "state", "legacy-migration.json"),
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
  delete require.cache[repairCommandModulePath()];
  delete require.cache[setupModulePath()];
  delete require.cache[setupCliPath()];

  try {
    await assertRepairSetupVerb("repair-summary.json", /No legacy CodexLark artifacts/i);
  } finally {
    migrationModule.runLegacyMigration = original;
    delete require.cache[migrationModulePath];
    delete require.cache[repairCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];
  }
});

test("setup CLI keeps repair ready when only scheduled-task scan warnings are present", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));
  const migrationModulePath = legacyMigrationModulePath();
  const migrationModule = loadLegacyMigrationModule();
  const original = migrationModule.runLegacyMigration;
  migrationModule.runLegacyMigration = async (options = {}) => ({
    importedConfig: [],
    disabledLegacyArtifacts: [],
    retainedLegacyArtifacts: [],
    warnings: ["Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks."],
    statePath: path.join(String(options.env?.LOCALAPPDATA ?? ""), "CodexLark", "state", "legacy-migration.json"),
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
      warnings: ["Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks."],
      repoRoots: [],
      hasLegacyArtifacts: false
    }
  });
  delete require.cache[repairCommandModulePath()];
  delete require.cache[setupModulePath()];
  delete require.cache[setupCliPath()];

  try {
    const result = await runCliWithCapture(["repair"], tempRoot);
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      legacyMigration?: {
        warnings?: string[];
      };
    };

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.match(payload.message, /scheduled tasks could not be inspected|no blocking legacy/i);
    assert.match(payload.legacyMigration?.warnings?.join("\n") ?? "", /scan was partial/i);
  } finally {
    migrationModule.runLegacyMigration = original;
    delete require.cache[migrationModulePath];
    delete require.cache[repairCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI runs export-diagnostics and writes a machine-readable summary", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const setupTypes = loadSetupTypesModule();
    const result = await runCliWithCapture(["export-diagnostics"], tempRoot);
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & { exportPath?: string };
    const expectedSummaryPath = path.join(tempRoot, "CodexLark", "artifacts", "setup", "export-diagnostics-summary.json");
    const expectedExportPath = path.join(tempRoot, "CodexLark", "artifacts", "diagnostics", "setup-diagnostics.json");

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(payload.schemaVersion, setupTypes.SetupSchemaVersion);
    assert.equal(payload.verb, "export-diagnostics");
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.message, "Setup diagnostics exported with redaction.");
    assert.equal(payload.summaryPath, expectedSummaryPath);
    assert.equal(payload.exportPath, expectedExportPath);
    assert.equal(existsSync(expectedSummaryPath), true);
    assert.equal(existsSync(expectedExportPath), true);
    assert.deepEqual(readJsonFile<SetupCommandResult & { exportPath: string }>(expectedSummaryPath), payload);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI keeps JSON stdout when first-run secret persistence fails", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));
  const secretStorePath = secretStoreModulePath();
  const migrationPath = legacyMigrationModulePath();
  const secretStoreModule = loadSecretStoreModule();
  const original = secretStoreModule.storeSetupSecret;
  secretStoreModule.storeSetupSecret = async () => {
    throw new Error("dpapi unavailable");
  };
  delete require.cache[firstRunCommandModulePath()];
  delete require.cache[setupModulePath()];
  delete require.cache[setupCliPath()];
  delete require.cache[migrationPath];

  try {
    const setupTypes = loadSetupTypesModule();
    const result = await withPatchedInspectCodexCliDependency(
      async () => ({
        present: true,
        installAttempted: false,
        resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
        version: "0.121.1",
        loginDetected: true,
        loginDetectionSource: "openai_api_key"
      }),
      async () => {
        const cli = loadSetupCliModule();
        let stdout = "";
        let stderr = "";
        let exitCode = -1;
        await withLocalAppData(tempRoot, async () => {
          await withPatchedFeishuEnv(
            {
              appId: "cli_test_app_id",
              appSecret: "secret-task4-value"
            },
            async () => {
              exitCode = await cli.runCli(["first-run"], {
                stdout: (text) => {
                  stdout += text;
                },
                stderr: (text) => {
                  stderr += text;
                }
              });
            }
          );
        });
        return { exitCode, stdout, stderr };
      }
    );
    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult;

    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.equal(payload.schemaVersion, setupTypes.SetupSchemaVersion);
    assert.equal(payload.verb, "first-run");
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "action-required");
    assert.match(payload.message, /secret/i);
    assert.equal(existsSync(payload.summaryPath), true);
    assert.deepEqual(readJsonFile<SetupCommandResult>(payload.summaryPath), payload);
  } finally {
    secretStoreModule.storeSetupSecret = original;
    delete require.cache[secretStorePath];
    delete require.cache[firstRunCommandModulePath()];
    delete require.cache[setupModulePath()];
    delete require.cache[setupCliPath()];
    delete require.cache[migrationPath];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI runs first-run and writes an action-required summary when codex needs operator action", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const setupTypes = loadSetupTypesModule();
    const result = await withPatchedInspectCodexCliDependency(
      async () => ({
        present: true,
        installAttempted: true,
        resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
        version: "0.121.1",
        loginDetected: false,
        failureCategory: "login-missing"
      }),
      async () => await runCliWithCapture(["first-run"], tempRoot)
    );

    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      codex: CodexDependencyResult;
    };
    const expectedSummaryPath = path.join(tempRoot, "CodexLark", "artifacts", "setup", "first-run-summary.json");

    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.equal(payload.schemaVersion, setupTypes.SetupSchemaVersion);
    assert.equal(payload.verb, "first-run");
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "action-required");
    assert.equal(payload.message, "Codex CLI is installed, but no login marker was detected.");
    assert.equal(payload.summaryPath, expectedSummaryPath);
    assert.equal(payload.codex.failureCategory, "login-missing");
    assert.equal(existsSync(expectedSummaryPath), true);
    assert.deepEqual(readJsonFile<typeof payload>(expectedSummaryPath), payload);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI runs doctor and writes a ready summary when codex is healthy", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const setupTypes = loadSetupTypesModule();
    const result = await withPatchedInspectCodexCliDependency(
      async () => ({
        present: true,
        installAttempted: false,
        resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
        version: "0.121.1",
        loginDetected: true,
        loginDetectionSource: "openai_api_key"
      }),
      async () => await runCliWithCapture(["doctor"], tempRoot)
    );

    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult & {
      codex: CodexDependencyResult;
    };
    const expectedSummaryPath = path.join(tempRoot, "CodexLark", "artifacts", "setup", "doctor-summary.json");

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(payload.schemaVersion, setupTypes.SetupSchemaVersion);
    assert.equal(payload.verb, "doctor");
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.message, "Codex CLI dependency is healthy.");
    assert.equal(payload.summaryPath, expectedSummaryPath);
    assert.equal(payload.codex.loginDetected, true);
    assert.equal(payload.codex.loginDetectionSource, "openai_api_key");
    assert.equal(existsSync(expectedSummaryPath), true);
    assert.deepEqual(readJsonFile<typeof payload>(expectedSummaryPath), payload);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI prints usage and exits zero for --help", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await runCliWithCapture(["--help"], tempRoot);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /用法：/);
    assert.match(result.stdout, /first-run/);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI exits non-zero with usage for missing command", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await runCliWithCapture([], tempRoot);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /用法：/);
    assert.match(combined, /缺少 command/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI exits non-zero with usage for an unknown verb", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await runCliWithCapture(["unknown-verb"], tempRoot);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /用法：/);
    assert.match(result.stdout, /first-run/);
    assert.match(result.stdout, /repair/);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /export-diagnostics/);
    assert.match(combined, /未知 command: unknown-verb/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI rejects extra positional arguments for a recognized verb", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await runCliWithCapture(["doctor", "extra"], tempRoot);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /用法：/);
    assert.match(combined, /extra/);
    assert.match(combined, /额外|positional/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI rejects unknown flags for a recognized verb", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await runCliWithCapture(["doctor", "--bogus"], tempRoot);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /用法：/);
    assert.match(combined, /--bogus/);
    assert.match(combined, /未知 flag/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI returns non-zero when a recognized verb reports ok false", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const setupTypes = loadSetupTypesModule();
    const result = await withPatchedRunSetupCommand(async () => ({
      schemaVersion: setupTypes.SetupSchemaVersion,
      verb: "doctor",
      ok: false,
      status: "action-required",
      message: "simulated failed health check",
      summaryPath: path.join(tempRoot, "CodexLark", "artifacts", "setup", "doctor-summary.json")
    }), async () => runCliWithCapture(["doctor"], tempRoot));

    const payload = JSON.parse(result.stdout.trim()) as SetupCommandResult;

    assert.notEqual(result.exitCode, 0);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "action-required");
    assert.equal(payload.message, "simulated failed health check");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup CLI does not print usage for execution-time exceptions", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-setup-cli-"));

  try {
    const result = await withPatchedRunSetupCommand(async () => {
      throw new Error("simulated execution failure");
    }, async () => runCliWithCapture(["doctor"], tempRoot));

    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /用法：/);
    assert.match(result.stderr, /simulated execution failure/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
