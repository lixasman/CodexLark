import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type CodexDependencyResult = {
  present: boolean;
  installAttempted: boolean;
  resolvedPath?: string;
  version?: string;
  loginDetected: boolean;
  loginDetectionSource?: "marker" | "openai_api_key";
  failureCategory?: string;
};

type ResolveLaunchEnvironmentResult =
  | {
      ok: true;
      runtimeEnv: {
        FEISHU_APP_ID: string;
        FEISHU_APP_SECRET: string;
        CODEX_CLI_EXE: string;
      };
      codex: CodexDependencyResult;
      source: {
        codexCli: "env" | "settings" | "auto";
      };
    }
  | {
      ok: false;
      failureCategory: string;
      message: string;
      codex?: CodexDependencyResult;
    };

type RuntimeContextModule = {
  resolveLaunchEnvironment: (options?: {
    env?: NodeJS.ProcessEnv;
    inspectCodexDependency?: (options?: {
      env?: NodeJS.ProcessEnv;
      installWhenMissing?: boolean;
    }) => Promise<CodexDependencyResult>;
    resolveSecretValue?: (reference: string, options?: { env?: NodeJS.ProcessEnv }) => Promise<string> | string;
  }) => Promise<ResolveLaunchEnvironmentResult>;
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

type SecretStoreModule = {
  storeSetupSecret: (
    input: { name: string; value: string },
    options?: { env?: NodeJS.ProcessEnv; protectSecret?: (secret: string) => Promise<string> | string }
  ) => Promise<{ reference: string; recordPath: string }>;
};

function runtimeContextModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "runtime-context.js");
}

function configStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "config-store.js");
}

function secretStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "secret-store.js");
}

function loadRuntimeContextModule(): RuntimeContextModule {
  const modulePath = runtimeContextModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as RuntimeContextModule;
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

function createSetupEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FEISHU_APP_ID: "",
    FEISHU_APP_SECRET: "",
    CODEX_CLI_EXE: "",
    LOCALAPPDATA: root,
    LocalAppData: root,
    USERPROFILE: root,
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    ...extra
  };
}

test("resolveLaunchEnvironment consumes canonical config plus secret store without FEISHU_* env vars", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-runtime-context-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();
  const receivedOptions: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];

  try {
    const storedSecret = await secretStoreModule.storeSetupSecret(
      {
        name: "feishu-app-secret",
        value: "secret-from-store"
      },
      {
        env,
        protectSecret: () => "dpapi-test-payload"
      }
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_runtime_app_id",
        feishuAppSecretRef: storedSecret.reference,
        codexCliPath: "D:\\Tools\\codex.cmd"
      },
      env
    );

    const runtimeContext = loadRuntimeContextModule();
    const result = await runtimeContext.resolveLaunchEnvironment({
      env,
      resolveSecretValue: (reference) => {
        assert.equal(reference, storedSecret.reference);
        return "secret-from-store";
      },
      inspectCodexDependency: async (options) => {
        receivedOptions.push({
          env: options?.env,
          installWhenMissing: options?.installWhenMissing
        });
        return {
          present: true,
          installAttempted: false,
          resolvedPath: "D:\\Tools\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.runtimeEnv.FEISHU_APP_ID, "cli_runtime_app_id");
    assert.equal(result.runtimeEnv.FEISHU_APP_SECRET, "secret-from-store");
    assert.equal(result.runtimeEnv.CODEX_CLI_EXE, "D:\\Tools\\codex.cmd");
    assert.equal(result.source.codexCli, "settings");
    assert.equal(receivedOptions.length, 1);
    assert.equal(receivedOptions[0]?.installWhenMissing, false);
    assert.equal(receivedOptions[0]?.env?.CODEX_CLI_EXE, "D:\\Tools\\codex.cmd");
    assert.equal(receivedOptions[0]?.env?.FEISHU_APP_ID ?? "", "");
    assert.equal(receivedOptions[0]?.env?.FEISHU_APP_SECRET ?? "", "");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLaunchEnvironment prefers canonical Codex settings over legacy CODEX_CLI_EXE env overrides", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-runtime-context-priority-"));
  const env = createSetupEnv(tempRoot, {
    CODEX_CLI_EXE: "D:\\Legacy\\codex.cmd"
  });
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();
  const receivedOptions: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];

  try {
    const storedSecret = await secretStoreModule.storeSetupSecret(
      {
        name: "feishu-app-secret",
        value: "secret-from-store"
      },
      {
        env,
        protectSecret: () => "dpapi-test-payload"
      }
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_runtime_app_id",
        feishuAppSecretRef: storedSecret.reference,
        codexCliPath: "D:\\Canonical\\codex.cmd"
      },
      env
    );

    const runtimeContext = loadRuntimeContextModule();
    const result = await runtimeContext.resolveLaunchEnvironment({
      env,
      resolveSecretValue: () => "secret-from-store",
      inspectCodexDependency: async (options) => {
        receivedOptions.push({
          env: options?.env,
          installWhenMissing: options?.installWhenMissing
        });
        return {
          present: true,
          installAttempted: false,
          resolvedPath: "D:\\Canonical\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.source.codexCli, "settings");
    assert.equal(result.runtimeEnv.CODEX_CLI_EXE, "D:\\Canonical\\codex.cmd");
    assert.equal(receivedOptions.length, 1);
    assert.equal(receivedOptions[0]?.env?.CODEX_CLI_EXE, "D:\\Canonical\\codex.cmd");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLaunchEnvironment falls back to PATH detection when the stored Codex path is stale", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-runtime-context-fallback-"));
  const env = createSetupEnv(tempRoot, {
    CODEX_CLI_EXE: "D:\\Legacy\\codex.cmd"
  });
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();
  const receivedOptions: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];

  try {
    const storedSecret = await secretStoreModule.storeSetupSecret(
      {
        name: "feishu-app-secret",
        value: "secret-from-store"
      },
      {
        env,
        protectSecret: () => "dpapi-test-payload"
      }
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_runtime_app_id",
        feishuAppSecretRef: storedSecret.reference,
        codexCliPath: "D:\\Broken\\codex.cmd"
      },
      env
    );

    const runtimeContext = loadRuntimeContextModule();
    const result = await runtimeContext.resolveLaunchEnvironment({
      env,
      resolveSecretValue: () => "secret-from-store",
      inspectCodexDependency: async (options) => {
        receivedOptions.push({
          env: options?.env,
          installWhenMissing: options?.installWhenMissing
        });
        if (receivedOptions.length === 1) {
          return {
            present: false,
            installAttempted: false,
            loginDetected: false,
            failureCategory: "missing"
          };
        }
        return {
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.source.codexCli, "auto");
    assert.equal(result.runtimeEnv.CODEX_CLI_EXE, "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd");
    assert.equal(receivedOptions.length, 2);
    assert.equal(receivedOptions[0]?.env?.CODEX_CLI_EXE, "D:\\Broken\\codex.cmd");
    assert.equal(receivedOptions[1]?.env?.CODEX_CLI_EXE ?? "", "");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveLaunchEnvironment returns action-required when canonical Feishu config is incomplete", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-runtime-context-missing-"));
  const env = createSetupEnv(tempRoot);

  try {
    const runtimeContext = loadRuntimeContextModule();
    const result = await runtimeContext.resolveLaunchEnvironment({
      env,
      inspectCodexDependency: async () => ({
        present: true,
        installAttempted: false,
        resolvedPath: "C:\\fake-bin\\codex.cmd",
        version: "0.121.1",
        loginDetected: true,
        loginDetectionSource: "marker"
      }),
      resolveSecretValue: () => "unused-secret"
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureCategory, "configuration-missing");
    assert.match(result.message, /Feishu|App ID|App Secret/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
