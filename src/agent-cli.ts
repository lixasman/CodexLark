import fs from "node:fs";
import path from "node:path";
import { parseArgs, flagBoolean, flagString, type ArgValue } from "./util/args";
import { createFeishuLongConnectionRuntime } from "./communicate";

export function usage(): string {
  return [
    "用法：",
    "  node dist/agent-cli.js <command> [--flags]",
    "",
    "Commands:",
    "  --help",
    "  feishu-longconn [--feishuAppId cli_xxx] [--feishuAppSecretEnv FEISHU_APP_SECRET] [--codexExe codex] [--allowKnownBadCodexVersion]",
    "  feishu-webhook [--feishuAppId cli_xxx] [--feishuAppSecretEnv FEISHU_APP_SECRET] [--codexExe codex] [--allowKnownBadCodexVersion]",
    "",
    "说明：",
    "  feishu-webhook 当前为 feishu-longconn 的兼容别名。",
    "  配置文件读取自 configs/communicate/feishu.json。",
    "  --allowKnownBadCodexVersion 仅供临时诊断，允许已知不兼容版本继续启动；请尽快升级到最新版本。",
    "",
    "环境变量：",
    "  FEISHU_APP_ID",
    "  FEISHU_APP_SECRET",
    "  CODEX_CLI_EXE"
  ].join("\n");
}

function requireEnvValue(envName: string): string {
  const value = process.env[envName]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${envName}`);
  return value;
}

function resolveExecutable(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;
  if (path.isAbsolute(trimmed) || trimmed.includes("\\") || trimmed.includes("/")) {
    return trimmed;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const candidates = [
      appData ? path.join(appData, "npm", `${trimmed}.cmd`) : "",
      appData ? path.join(appData, "npm", `${trimmed}.exe`) : "",
      appData ? path.join(appData, "npm", trimmed) : ""
    ].filter(Boolean);
    const matched = candidates.find((candidate) => fs.existsSync(candidate));
    if (matched) return matched;
  }

  return trimmed;
}

function resolveFeishuConfigPath(): string {
  return path.resolve("configs", "communicate", "feishu.json");
}

function ensureFeishuInstanceTag(): string {
  const current = process.env.COMMUNICATE_FEISHU_INSTANCE_TAG?.trim();
  if (current) return current;
  const generated = `pid-${process.pid}`;
  process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = generated;
  return generated;
}

type ResolvedFeishuRuntimeOptions = {
  takeoverListLimit: number;
  assistantAppServerEnabled: boolean;
  codingAppServerEnabled: boolean;
  goalSummary?: {
    timeoutMs: number;
  };
};

function readFeishuConfigRecord(): Record<string, unknown> | undefined {
  const configPath = resolveFeishuConfigPath();
  if (!fs.existsSync(configPath)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  return raw as Record<string, unknown>;
}

function readPositiveIntegerConfig(
  raw: Record<string, unknown> | undefined,
  key: string,
  defaultValue: number
): number {
  const value = raw?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.floor(value);
}

function readBooleanConfig(raw: Record<string, unknown> | undefined, key: string, defaultValue: boolean): boolean {
  const value = raw?.[key];
  return typeof value === "boolean" ? value : defaultValue;
}

function resolveFeishuRuntimeOptions(): ResolvedFeishuRuntimeOptions {
  const raw = readFeishuConfigRecord();
  const takeoverListLimit = readPositiveIntegerConfig(raw, "takeoverListLimit", 5);
  const assistantAppServerEnabled = readBooleanConfig(raw, "assistantAppServerEnabled", true);
  const codingAppServerEnabled = readBooleanConfig(raw, "codingAppServerEnabled", true);
  const goalSummaryEnabled = readBooleanConfig(raw, "goalSummaryEnabled", false);
  const goalSummaryTimeoutMs = readPositiveIntegerConfig(raw, "goalSummaryTimeoutMs", 15_000);

  return {
    takeoverListLimit,
    assistantAppServerEnabled,
    codingAppServerEnabled,
    ...(goalSummaryEnabled
      ? {
          goalSummary: {
            timeoutMs: goalSummaryTimeoutMs
          }
        }
      : {})
  };
}

export type ResolvedFeishuRuntimeCliOptions = {
  allowKnownBadCodexVersion: boolean;
};

export function resolveFeishuRuntimeCliOptions(flags: Record<string, ArgValue>): ResolvedFeishuRuntimeCliOptions {
  return {
    allowKnownBadCodexVersion: flagBoolean(flags, "allowKnownBadCodexVersion") === true
  };
}

async function cmdFeishuLongconn(flags: Record<string, ArgValue>): Promise<void> {
  const feishuAppId = flagString(flags, "feishuAppId") ?? process.env.FEISHU_APP_ID ?? "";
  const feishuSecretEnv = flagString(flags, "feishuAppSecretEnv") ?? "FEISHU_APP_SECRET";
  const appSecret = requireEnvValue(feishuSecretEnv);
  const codexExe = resolveExecutable(flagString(flags, "codexExe") ?? process.env.CODEX_CLI_EXE ?? "codex");
  const instanceTag = ensureFeishuInstanceTag();
  const runtimeOptions = resolveFeishuRuntimeOptions();
  const cliOptions = resolveFeishuRuntimeCliOptions(flags);
  let stopping = false;
  let started = false;
  let leaseLostError: Error | null = null;
  const requestStop = (): void => {
    stopping = true;
  };
  if (!feishuAppId.trim()) {
    throw new Error("缺少飞书 App ID，请传 --feishuAppId 或设置 FEISHU_APP_ID");
  }

  const runtime = createFeishuLongConnectionRuntime({
    appId: feishuAppId,
    appSecret,
    codexCommand: [codexExe],
    takeoverListLimit: runtimeOptions.takeoverListLimit,
    assistantAppServerEnabled: runtimeOptions.assistantAppServerEnabled,
    codingAppServerEnabled: runtimeOptions.codingAppServerEnabled,
    allowKnownBadCodexVersion: cliOptions.allowKnownBadCodexVersion,
    goalSummary: runtimeOptions.goalSummary ? { ...runtimeOptions.goalSummary, codexCommand: [codexExe] } : undefined,
    onLeaseLost: (error) => {
      leaseLostError = error;
      console.error(error.message);
      requestStop();
    }
  });

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await runtime.start();
    started = true;
    console.log("feishu long connection ready");
    console.log(`codex command: ${codexExe}`);
    console.log(`instance tag: ${instanceTag}`);
    console.log("ensure Feishu event subscription is set to long connection and im.message.receive_v1 is enabled");
    console.log("press Ctrl+C to stop");

    while (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    if (started) {
      await runtime.stop();
    }
  }
  if (leaseLostError) {
    throw leaseLostError;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parseArgs(argv);
  if (!command || flags.help) {
    console.log(usage());
    return;
  }

  switch (command) {
    case "feishu-longconn":
      await cmdFeishuLongconn(flags);
      return;
    case "feishu-webhook":
      await cmdFeishuLongconn(flags);
      return;
    default:
      console.log(usage());
      throw new Error(`未知 command: ${command}`);
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  });
}
