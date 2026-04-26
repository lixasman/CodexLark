import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

type ProductFlowResult = {
  ok: boolean;
  status: string;
  message: string;
};

type ProductFlowIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt: (question: string) => Promise<string>;
  interactive?: boolean;
};

type ProductFlowModule = {
  runLaunchWorkflow: (options: {
    env?: NodeJS.ProcessEnv;
    io: ProductFlowIo;
    deps?: {
      runRepairCommand?: () => Promise<{ ok: boolean; status: string; message: string }>;
      inspectCodexDependency?: (options?: {
        env?: NodeJS.ProcessEnv;
        installWhenMissing?: boolean;
      }) => Promise<CodexDependencyResult>;
      inspectStoredConfiguration?: () => Promise<{
        feishuAppId?: string;
        feishuAppSecretConfigured: boolean;
      }> | {
        feishuAppId?: string;
        feishuAppSecretConfigured: boolean;
      };
      persistFeishuConfiguration?: (input: { feishuAppId: string; feishuAppSecret: string }) => Promise<void>;
      persistCodexCliPath?: (input: { codexCliPath?: string }) => Promise<void>;
      startLaunchBridge?: () => Promise<{
        stdoutPath: string;
        stderrPath: string;
        registryPath: string;
      }>;
      runCodexLogin?: (input: { command: string; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number }>;
    };
  }) => Promise<ProductFlowResult>;
  runRepairWorkflow: (options: {
    env?: NodeJS.ProcessEnv;
    io: ProductFlowIo;
    deps?: {
      runRepairCommand?: () => Promise<{ ok: boolean; status: string; message: string }>;
      inspectCodexDependency?: (options?: {
        env?: NodeJS.ProcessEnv;
        installWhenMissing?: boolean;
      }) => Promise<CodexDependencyResult>;
      inspectStoredConfiguration?: () => Promise<{
        feishuAppId?: string;
        feishuAppSecretConfigured: boolean;
      }> | {
        feishuAppId?: string;
        feishuAppSecretConfigured: boolean;
      };
      persistFeishuConfiguration?: (input: { feishuAppId: string; feishuAppSecret: string }) => Promise<void>;
      persistCodexCliPath?: (input: { codexCliPath?: string }) => Promise<void>;
      exportDiagnostics?: () => Promise<{ exportPath: string }> | { exportPath: string };
    };
  }) => Promise<ProductFlowResult>;
  runCodexLoginCommand: (input: { command: string; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number }>;
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

function productFlowModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "product-flow.js");
}

function configStoreModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "config-store.js");
}

function loadProductFlowModule(): ProductFlowModule {
  const modulePath = productFlowModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as ProductFlowModule;
}

function loadConfigStoreModule(): ConfigStoreModule {
  const modulePath = configStoreModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as ConfigStoreModule;
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

function writeRegistryWithLaunchTarget(root: string, state: Record<string, unknown> = {}): string {
  const registryPath = path.join(root, "logs", "communicate", "registry.json");
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      {
        nextTaskId: 1,
        sessions: {},
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: [],
        lastActiveFeishuThreadId: "feishu:chat-1",
        ...state
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return registryPath;
}

function createPromptIo(answers: string[], options: { interactive?: boolean } = {}) {
  let index = 0;
  let stdout = "";
  let stderr = "";
  const asked: string[] = [];
  const io: ProductFlowIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: async (question) => {
      asked.push(question);
      const answer = answers[index];
      index += 1;
      if (answer === undefined) {
        throw new Error(`No scripted answer available for: ${question}`);
      }
      return answer;
    },
    interactive: options.interactive ?? true
  };

  return {
    io,
    asked,
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

test("runLaunchWorkflow reuses stored config and auto-detected Codex without exposing CODEX_CLI_EXE prompts", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-"));
  const { io, asked, getStdout } = createPromptIo([]);
  let startCount = 0;

  try {
    const registryPath = writeRegistryWithLaunchTarget(tempRoot);
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "C:\\Users\\Admin\\AppData\\Local\\CodexLark\\logs\\feishu-longconn\\stdout.log",
            stderrPath: "C:\\Users\\Admin\\AppData\\Local\\CodexLark\\logs\\feishu-longconn\\stderr.log",
            registryPath
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(startCount, 1);
    assert.equal(asked.length, 0);
    assert.match(getStdout(), /步骤 1\/4|1\/4/);
    assert.match(getStdout(), /步骤 2\/4|2\/4/);
    assert.match(getStdout(), /步骤 3\/4|3\/4/);
    assert.match(getStdout(), /步骤 4\/4|4\/4/);
    assert.doesNotMatch(getStdout(), /CODEX_CLI_EXE/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow does not block non-interactive launch when no Feishu recipient is known", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-noninteractive-target-"));
  const { io, asked, getStdout } = createPromptIo([], { interactive: false });

  try {
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        startLaunchBridge: async () => ({
          stdoutPath: "stdout.log",
          stderrPath: "stderr.log",
          registryPath: path.join(tempRoot, "logs", "communicate", "registry.json")
        })
      }
    });

    assert.equal(result.ok, true);
    assert.equal(asked.length, 0);
    assert.match(getStdout(), /项目卡/);
    assert.match(getStdout(), /非交互|窗口未保持|手动/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow exits non-interactive launch when Feishu config is missing instead of prompting", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-noninteractive-feishu-"));
  const { io, asked } = createPromptIo([], { interactive: false });
  let startCount = 0;

  try {
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppSecretConfigured: false
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath: path.join(tempRoot, "logs", "communicate", "registry.json")
          };
        }
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "action-required");
    assert.equal(startCount, 0);
    assert.equal(asked.length, 0);
    assert.match(result.message, /Feishu|飞书/);
    assert.match(result.message, /非交互|无法输入/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow exits non-interactive launch when Codex CLI is missing instead of prompting", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-noninteractive-codex-"));
  const { io, asked } = createPromptIo([], { interactive: false });
  let startCount = 0;

  try {
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: false,
          installAttempted: false,
          loginDetected: false,
          failureCategory: "missing"
        }),
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath: path.join(tempRoot, "logs", "communicate", "registry.json")
          };
        }
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "action-required");
    assert.equal(startCount, 0);
    assert.equal(asked.length, 0);
    assert.match(result.message, /Codex CLI/);
    assert.match(result.message, /非交互|无法/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow exits non-interactive launch when Codex CLI is not logged in instead of prompting", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-noninteractive-login-"));
  const { io, asked } = createPromptIo([], { interactive: false });
  let loginCount = 0;
  let startCount = 0;

  try {
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: false,
          failureCategory: "login-missing"
        }),
        runCodexLogin: async () => {
          loginCount += 1;
          return { exitCode: 0 };
        },
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath: path.join(tempRoot, "logs", "communicate", "registry.json")
          };
        }
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "action-required");
    assert.equal(loginCount, 0);
    assert.equal(startCount, 0);
    assert.equal(asked.length, 0);
    assert.match(result.message, /Codex CLI/);
    assert.match(result.message, /未登录|非交互|无法/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow does not prompt when registry can derive a previous Feishu thread", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-derived-target-"));
  const { io, asked, getStdout } = createPromptIo([]);

  try {
    const registryPath = writeRegistryWithLaunchTarget(tempRoot, {
      lastActiveFeishuThreadId: undefined,
      sessions: {
        T1: {
          taskId: "T1",
          feishuThreadId: "feishu:chat-derived"
        }
      }
    });
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        startLaunchBridge: async () => ({
          stdoutPath: "stdout.log",
          stderrPath: "stderr.log",
          registryPath
        })
      }
    });

    assert.equal(result.ok, true);
    assert.equal(asked.length, 0);
    assert.doesNotMatch(getStdout(), /首次使用|项目卡/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow does not show first-message prompt when launch bridge fails", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-bridge-fail-"));
  const { io, asked, getStdout } = createPromptIo([""]);

  try {
    const module = loadProductFlowModule();
    await assert.rejects(
      async () =>
        await module.runLaunchWorkflow({
          env: createSetupEnv(tempRoot),
          io,
          deps: {
            runRepairCommand: async () => ({
              ok: true,
              status: "ready",
              message: "repair summary ok"
            }),
            inspectStoredConfiguration: () => ({
              feishuAppId: "cli_saved_app",
              feishuAppSecretConfigured: true
            }),
            inspectCodexDependency: async () => ({
              present: true,
              installAttempted: false,
              resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
              version: "0.121.1",
              loginDetected: true,
              loginDetectionSource: "marker"
            }),
            startLaunchBridge: async () => {
              throw new Error("bridge failed");
            }
          }
        }),
      /bridge failed/
    );

    assert.equal(asked.length, 0);
    assert.doesNotMatch(getStdout(), /首次使用|项目卡/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow keeps first launch window open with Feishu first-message guidance when no recipient is known", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-first-target-"));
  const { io, asked, getStdout } = createPromptIo([""]);
  let startCount = 0;

  try {
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath: path.join(tempRoot, "logs", "communicate", "registry.json")
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(startCount, 1);
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? "", /Enter|回车|关闭/);
    assert.match(getStdout(), /首次使用|第一次/);
    assert.match(getStdout(), /飞书/);
    assert.match(getStdout(), /项目卡/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow only falls back to manual Codex path after auto-detection fails", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-manual-"));
  const { io, asked, getStdout } = createPromptIo([
    "3",
    "D:\\Portable\\codex.cmd"
  ]);
  const persistedPaths: string[] = [];
  const inspectCalls: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];
  let inspectCount = 0;
  let startCount = 0;

  try {
    const registryPath = writeRegistryWithLaunchTarget(tempRoot);
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async (options) => {
          inspectCalls.push({
            env: options?.env,
            installWhenMissing: options?.installWhenMissing
          });
          inspectCount += 1;
          if (inspectCount === 1) {
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
            resolvedPath: "D:\\Portable\\codex.cmd",
            version: "0.121.1",
            loginDetected: true,
            loginDetectionSource: "marker"
          };
        },
        persistCodexCliPath: async ({ codexCliPath }) => {
          persistedPaths.push(String(codexCliPath));
        },
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(startCount, 1);
    assert.deepEqual(persistedPaths, ["D:\\Portable\\codex.cmd"]);
    assert.equal(inspectCalls.length, 2);
    assert.equal(inspectCalls[0]?.env?.CODEX_CLI_EXE ?? "", "");
    assert.equal(inspectCalls[1]?.env?.CODEX_CLI_EXE, "D:\\Portable\\codex.cmd");
    assert.match(asked.join("\n"), /Codex/i);
    assert.match(getStdout(), /手动指定|高级/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow falls back to PATH detection when the stored Codex path is stale", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-stale-"));
  const { io, asked } = createPromptIo([]);
  const inspectCalls: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];
  let startCount = 0;

  try {
    const registryPath = writeRegistryWithLaunchTarget(tempRoot);
    const configStoreModule = loadConfigStoreModule();
    configStoreModule.writeSetupSettings(
      {
        codexCliPath: "D:\\Broken\\codex.cmd"
      },
      createSetupEnv(tempRoot)
    );

    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot, {
        CODEX_CLI_EXE: "D:\\Legacy\\codex.cmd"
      }),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async (options) => {
          inspectCalls.push({
            env: options?.env,
            installWhenMissing: options?.installWhenMissing
          });
          if ((options?.env?.CODEX_CLI_EXE ?? "") === "D:\\Broken\\codex.cmd") {
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
        },
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(startCount, 1);
    assert.equal(asked.length, 0);
    assert.equal(inspectCalls.length, 2);
    assert.equal(inspectCalls[0]?.env?.CODEX_CLI_EXE, "D:\\Broken\\codex.cmd");
    assert.equal(inspectCalls[1]?.env?.CODEX_CLI_EXE ?? "", "");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runLaunchWorkflow only persists a manual Codex path after the probe succeeds", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-manual-persist-"));
  const { io } = createPromptIo([
    "3",
    "D:\\Broken\\codex.cmd",
    "3",
    "D:\\Portable\\codex.cmd"
  ]);
  const persistedPaths: string[] = [];
  const inspectCalls: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];
  let startCount = 0;

  try {
    const registryPath = writeRegistryWithLaunchTarget(tempRoot);
    const module = loadProductFlowModule();
    const result = await module.runLaunchWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async (options) => {
          inspectCalls.push({
            env: options?.env,
            installWhenMissing: options?.installWhenMissing
          });
          const codexCliExe = options?.env?.CODEX_CLI_EXE ?? "";
          if (!codexCliExe || codexCliExe === "D:\\Broken\\codex.cmd") {
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
            resolvedPath: "D:\\Portable\\codex.cmd",
            version: "0.121.1",
            loginDetected: true,
            loginDetectionSource: "marker"
          };
        },
        persistCodexCliPath: async ({ codexCliPath }) => {
          persistedPaths.push(String(codexCliPath));
        },
        startLaunchBridge: async () => {
          startCount += 1;
          return {
            stdoutPath: "stdout.log",
            stderrPath: "stderr.log",
            registryPath
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(startCount, 1);
    assert.deepEqual(persistedPaths, ["D:\\Portable\\codex.cmd"]);
    assert.equal(inspectCalls.length, 3);
    assert.equal(inspectCalls[0]?.env?.CODEX_CLI_EXE ?? "", "");
    assert.equal(inspectCalls[1]?.env?.CODEX_CLI_EXE, "D:\\Broken\\codex.cmd");
    assert.equal(inspectCalls[2]?.env?.CODEX_CLI_EXE, "D:\\Portable\\codex.cmd");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runCodexLoginCommand uses shell execution for Windows cmd launchers", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific Codex launcher behavior.");
    return;
  }

  const childProcessModule = require("node:child_process") as {
    spawn: (command: string, args: string[], options: Record<string, unknown>) => EventEmitter & { kill: () => void };
  };
  const originalSpawn = childProcessModule.spawn;
  const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];

  childProcessModule.spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => undefined;
    setImmediate(() => child.emit("close", 0));
    return child;
  }) as typeof childProcessModule.spawn;

  try {
    const module = loadProductFlowModule();
    const result = await module.runCodexLoginCommand({
      command: "D:\\Portable\\codex.cmd",
      env: createSetupEnv(path.join(os.tmpdir(), "codexlark-product-flow-login"))
    });

    assert.equal(result.exitCode, 0);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]?.command, "D:\\Portable\\codex.cmd");
    assert.deepEqual(spawnCalls[0]?.args, ["--login"]);
    assert.equal(spawnCalls[0]?.options.shell, true);
  } finally {
    childProcessModule.spawn = originalSpawn;
  }
});

test("runRepairWorkflow exports diagnostics through the shared setup layer instead of launching the service", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-repair-"));
  const { io, asked, getStdout } = createPromptIo([
    "",
    ""
  ]);
  let exportCount = 0;

  try {
    const module = loadProductFlowModule();
    const result = await module.runRepairWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        persistFeishuConfiguration: async () => {
          throw new Error("repair flow should not rewrite Feishu config when user keeps stored values");
        },
        exportDiagnostics: () => {
          exportCount += 1;
          return {
            exportPath: "C:\\Users\\Admin\\AppData\\Local\\CodexLark\\artifacts\\diagnostics\\setup-diagnostics.json"
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(exportCount, 1);
    assert.equal(asked.length, 2);
    assert.match(getStdout(), /导出诊断|diagnostics/i);
    assert.doesNotMatch(getStdout(), /正在启动飞书长连接|launch bridge/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runRepairWorkflow keeps complete Feishu config in non-interactive repair instead of prompting", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-product-flow-repair-noninteractive-"));
  const { io, asked, getStdout } = createPromptIo([], { interactive: false });
  let exportCount = 0;

  try {
    const module = loadProductFlowModule();
    const result = await module.runRepairWorkflow({
      env: createSetupEnv(tempRoot),
      io,
      deps: {
        runRepairCommand: async () => ({
          ok: true,
          status: "ready",
          message: "repair summary ok"
        }),
        inspectStoredConfiguration: () => ({
          feishuAppId: "cli_saved_app",
          feishuAppSecretConfigured: true
        }),
        inspectCodexDependency: async () => ({
          present: true,
          installAttempted: false,
          resolvedPath: "C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd",
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "marker"
        }),
        persistFeishuConfiguration: async () => {
          throw new Error("non-interactive repair should keep complete stored Feishu config");
        },
        exportDiagnostics: () => {
          exportCount += 1;
          return {
            exportPath: "C:\\Users\\Admin\\AppData\\Local\\CodexLark\\artifacts\\diagnostics\\setup-diagnostics.json"
          };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(exportCount, 1);
    assert.equal(asked.length, 0);
    assert.match(getStdout(), /已读取已保存的飞书配置/);
    assert.match(getStdout(), /非交互|保留/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
