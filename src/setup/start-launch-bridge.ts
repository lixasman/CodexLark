import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveSetupPaths, type SetupPathEnvironment } from "./paths";

const DEFAULT_BRIDGE_TIMEOUT_MS = 60_000;

export type LaunchBridgeResult = {
  stdoutPath: string;
  stderrPath: string;
  registryPath: string;
};

type LaunchStatusPayload = {
  status?: string;
  stdoutPath?: string;
  stderrPath?: string;
  registryPath?: string;
  bootstrapLogPath?: string;
  message?: string;
};

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

function resolveWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function getLaunchArtifacts(env: NodeJS.ProcessEnv = process.env): {
  statusPath: string;
  stdoutPath: string;
  stderrPath: string;
  registryPath: string;
  bootstrapLogPath: string;
} {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const logDir = path.win32.join(paths.logsRoot, "feishu-longconn");
  return {
    statusPath: path.win32.join(logDir, "launch-status.json"),
    stdoutPath: path.win32.join(logDir, "feishu-longconn.out.log"),
    stderrPath: path.win32.join(logDir, "feishu-longconn.err.log"),
    registryPath: path.win32.join(paths.logsRoot, "communicate", "registry.json"),
    bootstrapLogPath: path.win32.join(logDir, "feishu-longconn-bootstrap.err.log")
  };
}

async function waitForLaunchStatus(
  statusPath: string,
  timeoutMs: number
): Promise<LaunchStatusPayload> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(statusPath)) {
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as LaunchStatusPayload;
      if (parsed.status === "ready" || parsed.status === "failed") {
        return parsed;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for launch status at ${statusPath}.`);
}

async function tryWaitForLaunchStatus(statusPath: string, timeoutMs: number): Promise<LaunchStatusPayload | undefined> {
  try {
    return await waitForLaunchStatus(statusPath, timeoutMs);
  } catch {
    return undefined;
  }
}

function formatLaunchBridgeFailure(input: {
  exitCode?: number;
  status?: LaunchStatusPayload;
  artifacts: ReturnType<typeof getLaunchArtifacts>;
}): Error {
  const message =
    input.status?.message
    || (input.exitCode !== undefined ? `run-admin-task.ps1 exited with code ${input.exitCode}.` : "CodexLark launch bridge failed.");
  const hints = [
    `status: ${input.artifacts.statusPath}`,
    `bootstrap: ${input.status?.bootstrapLogPath || input.artifacts.bootstrapLogPath}`,
    `stderr: ${input.status?.stderrPath || input.artifacts.stderrPath}`,
    `registry: ${input.status?.registryPath || input.artifacts.registryPath}`
  ];
  return new Error(`${message} Diagnostics -> ${hints.join(" | ")}`);
}

async function runPowerShellBridge(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<number> {
  const scriptPath = path.win32.join(process.cwd(), "run-admin-task.ps1");
  const powershellPath = resolveWindowsPowerShellPath(env);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      powershellPath,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
        windowsHide: false
      }
    );
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`run-admin-task.ps1 timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
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
}

export async function startLaunchBridge(options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<LaunchBridgeResult> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const artifacts = getLaunchArtifacts(env);

  try {
    fs.rmSync(artifacts.statusPath, { force: true });
  } catch {
    // Best effort cleanup only.
  }

  const exitCode = await runPowerShellBridge(env, timeoutMs);
  if (exitCode !== 0) {
    const status = await tryWaitForLaunchStatus(artifacts.statusPath, Math.min(timeoutMs, 2_000));
    throw formatLaunchBridgeFailure({
      exitCode,
      status,
      artifacts
    });
  }

  const status = await waitForLaunchStatus(artifacts.statusPath, timeoutMs);
  if (status.status !== "ready") {
    throw formatLaunchBridgeFailure({
      status,
      artifacts
    });
  }

  return {
    stdoutPath: status.stdoutPath || artifacts.stdoutPath,
    stderrPath: status.stderrPath || artifacts.stderrPath,
    registryPath: status.registryPath || artifacts.registryPath
  };
}
