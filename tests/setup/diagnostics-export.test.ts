import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type ExportDiagnosticsCommandResult = {
  schemaVersion: number;
  verb: "export-diagnostics";
  ok: boolean;
  status: string;
  message: string;
  summaryPath: string;
  exportPath: string;
};

type ExportDiagnosticsCommandModule = {
  runExportDiagnosticsCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<ExportDiagnosticsCommandResult>;
};

type ConfigStoreModule = {
  getSettingsPath: (env?: NodeJS.ProcessEnv) => string;
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
  getStoredSecretRecordPath: (reference: string, options?: { env?: NodeJS.ProcessEnv }) => string;
  storeSetupSecret: (
    input: { name: string; value: string },
    options?: { env?: NodeJS.ProcessEnv; protectSecret?: (secret: string) => Promise<string> | string }
  ) => Promise<{ reference: string }>;
};

function exportDiagnosticsCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "export-diagnostics.js");
}

function configStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "config-store.js");
}

function secretStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "secret-store.js");
}

function loadExportDiagnosticsCommandModule(): ExportDiagnosticsCommandModule {
  const modulePath = exportDiagnosticsCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as ExportDiagnosticsCommandModule;
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

test("runExportDiagnosticsCommand redacts FEISHU_APP_SECRET while exporting setup settings", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-diagnostics-export-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();
  const appId = "cli_test_app_id";
  const secretValue = "secret-task4-diagnostics";
  const secretPattern = new RegExp(escapeRegExp(secretValue));

  try {
    const storedSecret = await secretStoreModule.storeSetupSecret(
      { name: "feishu-app-secret", value: secretValue },
      { env, protectSecret: () => "dpapi-test-payload" }
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: appId,
        feishuAppSecretRef: storedSecret.reference
      },
      env
    );

    const commandModule = loadExportDiagnosticsCommandModule();
    const result = await commandModule.runExportDiagnosticsCommand?.({ env });
    const exportText = readFileSync(result!.exportPath, "utf8");
    const payload = JSON.parse(exportText) as {
      schemaVersion: number;
      generatedAt: string;
      settings: {
        feishuAppId?: string;
        feishuAppSecretConfigured: boolean;
      };
    };

    assert.equal(result?.ok, true);
    assert.equal(result?.status, "ready");
    assert.equal(payload.settings.feishuAppId, appId);
    assert.equal(payload.settings.feishuAppSecretConfigured, true);
    assert.doesNotMatch(exportText, secretPattern);
    assert.doesNotMatch(exportText, /protectedValue/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runExportDiagnosticsCommand only emits whitelist fields from settings and rejects invalid secret references", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-diagnostics-whitelist-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();
  const settingsPath = configStoreModule.getSettingsPath(env);

  try {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          feishuAppId: "cli_test_app_id",
          feishuAppSecretRef: "plain-text-secret-should-not-pass",
          unexpectedField: "should-not-export",
          nestedSecret: {
            raw: "should-not-export"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const commandModule = loadExportDiagnosticsCommandModule();
    const result = await commandModule.runExportDiagnosticsCommand?.({ env });
    const payload = JSON.parse(readFileSync(result!.exportPath, "utf8")) as {
      schemaVersion: number;
      generatedAt: string;
      paths: Record<string, string>;
      settings: Record<string, unknown>;
    };

    assert.deepEqual(Object.keys(payload).sort(), ["generatedAt", "paths", "schemaVersion", "settings"]);
    assert.deepEqual(Object.keys(payload.settings).sort(), ["feishuAppId", "feishuAppSecretConfigured"]);
    assert.equal(payload.settings.feishuAppId, "cli_test_app_id");
    assert.equal(payload.settings.feishuAppSecretConfigured, false);
    assert.deepEqual(Object.keys(payload.paths).sort(), ["artifactsRoot", "configRoot", "logsRoot", "stateRoot"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runExportDiagnosticsCommand does not mark missing secret records as configured", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-diagnostics-missing-secret-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();

  try {
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_test_app_id",
        feishuAppSecretRef: "secret://missing-feishu-app-secret"
      },
      env
    );

    const commandModule = loadExportDiagnosticsCommandModule();
    const result = await commandModule.runExportDiagnosticsCommand?.({ env });
    const payload = JSON.parse(readFileSync(result!.exportPath, "utf8")) as {
      settings: {
        feishuAppSecretConfigured: boolean;
      };
    };

    assert.equal(payload.settings.feishuAppSecretConfigured, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runExportDiagnosticsCommand treats blank secret references as unconfigured instead of throwing", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-diagnostics-blank-secret-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();

  try {
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_test_app_id",
        feishuAppSecretRef: "secret://   "
      },
      env
    );

    const commandModule = loadExportDiagnosticsCommandModule();
    const result = await commandModule.runExportDiagnosticsCommand?.({ env });
    const payload = JSON.parse(readFileSync(result!.exportPath, "utf8")) as {
      settings: {
        feishuAppSecretConfigured: boolean;
      };
    };

    assert.equal(payload.settings.feishuAppSecretConfigured, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runExportDiagnosticsCommand rejects malformed secret references even when a colliding record exists", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-diagnostics-malformed-secret-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();

  try {
    await secretStoreModule.storeSetupSecret(
      { name: "feishu-app-secret_extra", value: "secret-task4-diagnostics" },
      { env, protectSecret: () => "dpapi-test-payload" }
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_test_app_id",
        feishuAppSecretRef: "secret://feishu-app-secret/extra"
      },
      env
    );

    const commandModule = loadExportDiagnosticsCommandModule();
    const result = await commandModule.runExportDiagnosticsCommand?.({ env });
    const payload = JSON.parse(readFileSync(result!.exportPath, "utf8")) as {
      settings: {
        feishuAppSecretConfigured: boolean;
      };
    };

    assert.equal(payload.settings.feishuAppSecretConfigured, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runExportDiagnosticsCommand does not treat corrupt secret records as configured", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-diagnostics-corrupt-secret-"));
  const env = createSetupEnv(tempRoot);
  const configStoreModule = loadConfigStoreModule();
  const secretStoreModule = loadSecretStoreModule();
  const secretReference = "secret://feishu-app-secret";

  try {
    const recordPath = secretStoreModule.getStoredSecretRecordPath(secretReference, { env });
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          name: "feishu-app-secret",
          reference: secretReference,
          storage: "dpapi-user-scope"
        },
        null,
        2
      ),
      "utf8"
    );
    configStoreModule.writeSetupSettings(
      {
        feishuAppId: "cli_test_app_id",
        feishuAppSecretRef: secretReference
      },
      env
    );

    const commandModule = loadExportDiagnosticsCommandModule();
    const result = await commandModule.runExportDiagnosticsCommand?.({ env });
    const payload = JSON.parse(readFileSync(result!.exportPath, "utf8")) as {
      settings: {
        feishuAppSecretConfigured: boolean;
      };
    };

    assert.equal(payload.settings.feishuAppSecretConfigured, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
