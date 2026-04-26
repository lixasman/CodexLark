import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

import { inspectCodexCliDependency, type CodexDependencyOptions, type CodexDependencyResult } from "./codex-dependency";
import { writeSetupSettings } from "./config-store";
import { exportSetupDiagnostics } from "./diagnostics";
import { runRepairCommand } from "./commands/repair";
import { inspectStoredCodexCliDependency } from "./runtime-context";
import { hasStoredSecretRecord, storeSetupSecret } from "./secret-store";
import { readSetupSettings } from "./config-store";
import { startLaunchBridge, type LaunchBridgeResult } from "./start-launch-bridge";

export type ProductFlowResult = {
  ok: boolean;
  status: "ready" | "action-required";
  message: string;
};

export type ProductFlowIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt: (question: string) => Promise<string>;
  interactive?: boolean;
};

type StoredConfiguration = {
  feishuAppId?: string;
  feishuAppSecretConfigured: boolean;
};

type ProductFlowDeps = {
  runRepairCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; status: string; message: string }>;
  inspectCodexDependency?: (options?: CodexDependencyOptions) => Promise<CodexDependencyResult>;
  inspectStoredConfiguration?: (env?: NodeJS.ProcessEnv) => Promise<StoredConfiguration> | StoredConfiguration;
  persistFeishuConfiguration?: (input: { feishuAppId: string; feishuAppSecret: string }) => Promise<void>;
  persistCodexCliPath?: (input: { codexCliPath?: string }) => Promise<void>;
  startLaunchBridge?: () => Promise<LaunchBridgeResult>;
  runCodexLogin?: (input: { command: string; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number }>;
  exportDiagnostics?: () => Promise<{ exportPath: string }> | { exportPath: string };
};

function writeLine(io: ProductFlowIo, line = ""): void {
  io.stdout(`${line}\n`);
}

function formatStep(current: number, total: number, title: string): string {
  return `步骤 ${current}/${total}：${title}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasKnownFeishuDeliveryTarget(registryPath: string): boolean {
  const trimmedPath = registryPath.trim();
  if (!trimmedPath) return false;

  try {
    if (!fs.existsSync(trimmedPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(trimmedPath, "utf8")) as {
      lastActiveFeishuThreadId?: unknown;
      lastActiveFeishuUserOpenId?: unknown;
      sessions?: Record<string, { feishuThreadId?: unknown }>;
      threadBindings?: Record<string, { feishuThreadId?: unknown }>;
      threadUiStates?: Record<string, { feishuThreadId?: unknown }>;
    };

    if (isNonEmptyString(parsed.lastActiveFeishuUserOpenId) || isNonEmptyString(parsed.lastActiveFeishuThreadId)) {
      return true;
    }

    const hasThreadInRecord = (record: { feishuThreadId?: unknown } | undefined): boolean =>
      isNonEmptyString(record?.feishuThreadId);
    const hasThreadValueInMap = (records: Record<string, { feishuThreadId?: unknown }> | undefined): boolean => {
      if (!records) return false;
      return Object.values(records).some((record) => hasThreadInRecord(record));
    };
    const hasThreadKeyOrValueInMap = (records: Record<string, { feishuThreadId?: unknown }> | undefined): boolean => {
      if (!records) return false;
      return Object.entries(records).some(([key, record]) => isNonEmptyString(key) || hasThreadInRecord(record));
    };

    return (
      hasThreadValueInMap(parsed.sessions) ||
      hasThreadKeyOrValueInMap(parsed.threadBindings) ||
      hasThreadKeyOrValueInMap(parsed.threadUiStates)
    );
  } catch {
    return false;
  }
}

async function maybePromptForFirstFeishuMessage(io: ProductFlowIo, launchResult: LaunchBridgeResult): Promise<void> {
  if (hasKnownFeishuDeliveryTarget(launchResult.registryPath)) {
    return;
  }

  writeLine(io);
  writeLine(io, "首次使用提示：飞书长连接已启动，但本机还不知道要把项目卡发送给谁。");
  writeLine(io, "请现在在飞书里给机器人发送一条消息，例如：项目卡");
  writeLine(io, "机器人收到消息后会记录会话目标；后续启动将不再显示这个提示。");
  if (io.interactive === false) {
    writeLine(io, "当前是非交互启动，窗口未保持；请手动在飞书里发送“项目卡”完成首次绑定。");
    return;
  }
  await depsPrompt(io, "发送后按 Enter 关闭窗口");
}

function readStoredConfiguration(env: NodeJS.ProcessEnv = process.env): StoredConfiguration {
  const settings = readSetupSettings(env);
  return {
    feishuAppId: settings.feishuAppId,
    feishuAppSecretConfigured: hasStoredSecretRecord(settings.feishuAppSecretRef, { env })
  };
}

async function persistFeishuConfigurationImpl(
  input: { feishuAppId: string; feishuAppSecret: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const storedSecret = await storeSetupSecret(
    {
      name: "feishu-app-secret",
      value: input.feishuAppSecret
    },
    {
      env
    }
  );
  writeSetupSettings(
    {
      feishuAppId: input.feishuAppId,
      feishuAppSecretRef: storedSecret.reference
    },
    env
  );
}

async function persistCodexCliPathImpl(
  input: { codexCliPath?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  writeSetupSettings(
    {
      codexCliPath: input.codexCliPath
    },
    env
  );
}

function requiresShellExecution(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

export async function runCodexLoginCommand(input: { command: string; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number }> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(input.command, ["--login"], {
      env: input.env,
      stdio: "inherit",
      windowsHide: false,
      shell: requiresShellExecution(input.command)
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("codex --login timed out after 900000ms."));
    }, 900_000);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  return { exitCode };
}

function codexReady(result: CodexDependencyResult): boolean {
  return result.present && result.loginDetected && !result.failureCategory;
}

function codexStatusMessage(result: CodexDependencyResult): string {
  switch (result.failureCategory) {
    case "missing":
      return "未检测到 Codex CLI。";
    case "install-failed":
      return "Codex CLI 安装或探测失败。";
    case "unsupported-version":
      return result.version
        ? `Codex CLI 版本 ${result.version} 不受当前策略支持。`
        : "Codex CLI 版本不可用。";
    case "login-missing":
      return "已检测到 Codex CLI，但当前未登录。";
    default:
      return "Codex CLI 已就绪。";
  }
}

async function ensureFeishuConfiguration(
  io: ProductFlowIo,
  env: NodeJS.ProcessEnv,
  mode: "launch" | "repair",
  deps: ProductFlowDeps
): Promise<{ ok: boolean; message?: string }> {
  const inspectStoredConfiguration = deps.inspectStoredConfiguration ?? readStoredConfiguration;
  const persistFeishuConfiguration = deps.persistFeishuConfiguration ?? (async (input) => await persistFeishuConfigurationImpl(input, env));
  const stored = await inspectStoredConfiguration(env);

  if (stored.feishuAppId && stored.feishuAppSecretConfigured && (mode === "launch" || io.interactive === false)) {
    writeLine(io, `- 已读取已保存的飞书配置：${stored.feishuAppId}`);
    if (mode === "repair" && io.interactive === false) {
      writeLine(io, "- 非交互运行：已保留现有飞书 App Secret。");
    }
    return { ok: true };
  }

  if (io.interactive === false) {
    const message = "Feishu 配置未完成，当前是非交互运行，无法输入 App ID / App Secret。";
    writeLine(io, `- ${message}`);
    return {
      ok: false,
      message
    };
  }

  const appIdPrompt =
    mode === "repair" && stored.feishuAppId
      ? `请输入 Feishu App ID（直接回车保留当前值：${stored.feishuAppId}）`
      : "请输入 Feishu App ID";
  const appSecretPrompt =
    mode === "repair" && stored.feishuAppSecretConfigured
      ? "请输入 Feishu App Secret（直接回车保留当前值）"
      : "请输入 Feishu App Secret";

  const enteredAppId = (await depsPrompt(io, appIdPrompt)).trim();
  const enteredSecret = await depsPrompt(io, appSecretPrompt);

  const nextAppId = enteredAppId || stored.feishuAppId || "";
  const nextSecret = enteredSecret || (mode === "repair" && stored.feishuAppSecretConfigured ? "__KEEP_EXISTING__" : "");

  if (!nextAppId || !nextSecret) {
    return {
      ok: false,
      message: "Feishu App ID / App Secret 仍未配置完整。"
    };
  }

  if (nextSecret !== "__KEEP_EXISTING__") {
    await persistFeishuConfiguration({
      feishuAppId: nextAppId,
      feishuAppSecret: nextSecret
    });
    writeLine(io, "- 已保存飞书配置到 canonical config / secret store。");
    return { ok: true };
  }

  if (enteredAppId && enteredAppId !== stored.feishuAppId) {
    writeSetupSettings(
      {
        feishuAppId: nextAppId
      },
      env
    );
  }
  writeLine(io, "- 已保留现有飞书 App Secret。");
  return { ok: true };
}

async function depsPrompt(io: ProductFlowIo, question: string): Promise<string> {
  return await io.prompt(`${question}: `);
}

async function ensureCodexReady(
  io: ProductFlowIo,
  env: NodeJS.ProcessEnv,
  deps: ProductFlowDeps
): Promise<{ ok: boolean; message?: string }> {
  const inspectCodexDependency = deps.inspectCodexDependency ?? inspectCodexCliDependency;
  const persistCodexCliPath = deps.persistCodexCliPath ?? (async (input) => await persistCodexCliPathImpl(input, env));
  const runCodexLogin = deps.runCodexLogin ?? runCodexLoginCommand;

  let manualCodexCliPath: string | undefined;
  const inspect = async (installWhenMissing = false) =>
    manualCodexCliPath
      ? await inspectCodexDependency({
          env: {
            ...env,
            CODEX_CLI_EXE: manualCodexCliPath
          },
          installWhenMissing
        })
      : (
          await inspectStoredCodexCliDependency({
            env,
            inspectCodexDependency,
            installWhenMissing
          })
        ).codex;

  let codex = await inspect(false);
  while (!codexReady(codex)) {
    writeLine(io, `- ${codexStatusMessage(codex)}`);

    if (io.interactive === false) {
      const statusMessage = codexStatusMessage(codex);
      const nextAction = "当前是非交互运行，无法在这里完成 Codex CLI 安装、路径指定或登录。";
      const message = `${statusMessage} ${nextAction}`;
      writeLine(io, `- ${nextAction}`);
      return {
        ok: false,
        message
      };
    }

    if (codex.failureCategory === "missing") {
      writeLine(io, "  1) 现在安装 Codex CLI");
      writeLine(io, "  2) 稍后处理并退出");
      writeLine(io, "  3) 高级：手动指定 Codex CLI 路径");
      const choice = (await depsPrompt(io, "请选择 Codex CLI 操作")).trim() || "2";

      if (choice === "1") {
        codex = await inspect(true);
        continue;
      }
      if (choice === "3") {
        const manualPath = (await depsPrompt(io, "请输入 Codex CLI 可执行文件路径")).trim();
        if (!manualPath) {
          return {
            ok: false,
            message: "未提供有效的 Codex CLI 路径。"
          };
        }
        const manualProbe = await inspectCodexDependency({
          env: {
            ...env,
            CODEX_CLI_EXE: manualPath
          },
          installWhenMissing: false
        });
        if (!manualProbe.present || manualProbe.failureCategory === "missing" || manualProbe.failureCategory === "install-failed") {
          writeLine(io, "- 手动指定的 Codex CLI 路径不可用，未写入设置。");
          codex = manualProbe;
          continue;
        }
        manualCodexCliPath = manualPath;
        await persistCodexCliPath({ codexCliPath: manualPath });
        codex = manualProbe;
        continue;
      }
      return {
        ok: false,
        message: "Codex CLI 尚未就绪，本次先退出。"
      };
    }

    if (codex.failureCategory === "login-missing") {
      writeLine(io, "  1) 现在登录 Codex CLI");
      writeLine(io, "  2) 稍后处理并退出");
      const choice = (await depsPrompt(io, "请选择 Codex 登录操作")).trim() || "2";
      if (choice !== "1") {
        return {
          ok: false,
          message: "Codex CLI 尚未登录，本次先退出。"
        };
      }

      const loginCommand = codex.resolvedPath ?? manualCodexCliPath;
      if (!loginCommand) {
        return {
          ok: false,
          message: "无法确定 Codex CLI 登录命令。"
        };
      }

      const loginResult = await runCodexLogin({
        command: loginCommand,
        env: manualCodexCliPath
          ? {
              ...env,
              CODEX_CLI_EXE: manualCodexCliPath
            }
          : (
              await inspectStoredCodexCliDependency({
                env,
                inspectCodexDependency,
                installWhenMissing: false
              })
            ).env
      });
      if (loginResult.exitCode !== 0) {
        return {
          ok: false,
          message: `Codex CLI 登录流程退出码为 ${loginResult.exitCode}。`
        };
      }
      codex = await inspect(false);
      continue;
    }

    return {
      ok: false,
      message: codexStatusMessage(codex)
    };
  }

  writeLine(io, `- Codex CLI 已就绪：${codex.resolvedPath ?? "codex"}${codex.version ? ` (${codex.version})` : ""}`);
  return { ok: true };
}

async function runSharedPreparation(
  io: ProductFlowIo,
  env: NodeJS.ProcessEnv,
  deps: ProductFlowDeps
): Promise<{ ok: boolean; message: string }> {
  const repairSummary = deps.runRepairCommand
    ? await deps.runRepairCommand({ env })
    : await runRepairCommand({ env });
  writeLine(io, `- ${repairSummary.message}`);
  return {
    ok: repairSummary.ok,
    message: repairSummary.message
  };
}

export async function runLaunchWorkflow(options: {
  env?: NodeJS.ProcessEnv;
  io: ProductFlowIo;
  deps?: ProductFlowDeps;
}): Promise<ProductFlowResult> {
  const env = options.env ?? process.env;
  const io = options.io;
  const deps = options.deps ?? {};

  writeLine(io, "CodexLark 启动流程");
  writeLine(io, formatStep(1, 4, "检查环境"));
  const environment = await runSharedPreparation(io, env, deps);
  if (!environment.ok) {
    return {
      ok: false,
      status: "action-required",
      message: environment.message
    };
  }

  writeLine(io, formatStep(2, 4, "配置飞书"));
  const feishu = await ensureFeishuConfiguration(io, env, "launch", deps);
  if (!feishu.ok) {
    return {
      ok: false,
      status: "action-required",
      message: feishu.message ?? "Feishu 配置未完成。"
    };
  }

  writeLine(io, formatStep(3, 4, "检查 Codex CLI"));
  const codex = await ensureCodexReady(io, env, deps);
  if (!codex.ok) {
    return {
      ok: false,
      status: "action-required",
      message: codex.message ?? "Codex CLI 未就绪。"
    };
  }

  writeLine(io, formatStep(4, 4, "启动 CodexLark"));
  const launchBridge = deps.startLaunchBridge ?? startLaunchBridge;
  const launchResult = await launchBridge();
  writeLine(io, "- 已启动飞书长连接。");
  writeLine(io, `- stdout: ${launchResult.stdoutPath}`);
  writeLine(io, `- stderr: ${launchResult.stderrPath}`);
  writeLine(io, `- registry: ${launchResult.registryPath}`);
  await maybePromptForFirstFeishuMessage(io, launchResult);

  return {
    ok: true,
    status: "ready",
    message: "CodexLark launch flow completed."
  };
}

export async function runRepairWorkflow(options: {
  env?: NodeJS.ProcessEnv;
  io: ProductFlowIo;
  deps?: ProductFlowDeps;
}): Promise<ProductFlowResult> {
  const env = options.env ?? process.env;
  const io = options.io;
  const deps = options.deps ?? {};

  writeLine(io, "CodexLark Repair 流程");
  writeLine(io, formatStep(1, 4, "检查环境"));
  const environment = await runSharedPreparation(io, env, deps);

  writeLine(io, formatStep(2, 4, "配置飞书"));
  const feishu = await ensureFeishuConfiguration(io, env, "repair", deps);
  if (!feishu.ok) {
    return {
      ok: false,
      status: "action-required",
      message: feishu.message ?? "Feishu 配置未完成。"
    };
  }

  writeLine(io, formatStep(3, 4, "检查 Codex CLI"));
  const codex = await ensureCodexReady(io, env, deps);
  if (!codex.ok) {
    return {
      ok: false,
      status: "action-required",
      message: codex.message ?? "Codex CLI 未就绪。"
    };
  }

  writeLine(io, formatStep(4, 4, "导出诊断"));
  const diagnostics = await (deps.exportDiagnostics ?? exportSetupDiagnostics)();
  writeLine(io, `- 已导出诊断：${diagnostics.exportPath}`);

  return {
    ok: environment.ok,
    status: environment.ok ? "ready" : "action-required",
    message: environment.ok ? "Repair flow completed." : environment.message
  };
}
