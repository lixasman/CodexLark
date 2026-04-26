import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { verifySupportedCodexVersion } from "../communicate/workers/codex/version-policy";
import { detectCodexLoginState } from "./codex-login-state";

const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 15 * 1000;
const PROCESS_TREE_CLEANUP_WAIT_MS = 250;
const TRUSTED_WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\Windows$/i;

export const CodexDependencyFailureCategory = {
  Missing: "missing",
  InstallFailed: "install-failed",
  UnsupportedVersion: "unsupported-version",
  LoginMissing: "login-missing"
} as const;

export type CodexDependencyFailureCategory =
  (typeof CodexDependencyFailureCategory)[keyof typeof CodexDependencyFailureCategory];

export type CodexDependencyResult = {
  present: boolean;
  installAttempted: boolean;
  resolvedPath?: string;
  version?: string;
  loginDetected: boolean;
  loginMarkerPath?: string;
  loginDetectionSource?: "marker" | "openai_api_key";
  failureCategory?: CodexDependencyFailureCategory;
};

export type ResolveCommand = (command: string, env?: NodeJS.ProcessEnv) => string | undefined;

export type CommandRunnerInput = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type CommandRunnerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resolvedPath?: string;
};

export type CommandRunner = (input: CommandRunnerInput) => Promise<CommandRunnerResult> | CommandRunnerResult;

export type SpawnProcessInput = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell: boolean;
};

export type SpawnedProcessLike = {
  pid?: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: () => void | boolean;
  unref?: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type SpawnProcess = (input: SpawnProcessInput) => SpawnedProcessLike;
export type TerminateProcessTree = (pid: number) => Promise<void> | void;
export type SpawnTaskkillProcessLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};
export type SpawnTaskkillProcess = (command: string, args: string[]) => SpawnTaskkillProcessLike;
export type TerminateProcessTreeWithTaskkillOptions = {
  taskkillPath?: string;
  spawnTaskkill?: SpawnTaskkillProcess;
};

export type CreateCommandRunnerOptions = {
  spawnProcess?: SpawnProcess;
  terminateProcessTree?: TerminateProcessTree;
};

export type CodexDependencyOptions = {
  env?: NodeJS.ProcessEnv;
  resolveCommand?: ResolveCommand;
  runCommand?: CommandRunner;
  pathExists?: (filePath: string) => boolean;
  installWhenMissing?: boolean;
};

function readEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readFirstEnvValue(names: string[], env: NodeJS.ProcessEnv = process.env): string {
  for (const name of names) {
    const value = readEnvValue(name, env);
    if (value) return value;
  }
  return "";
}

function resolveCodexCommand(env: NodeJS.ProcessEnv): string {
  return readEnvValue("CODEX_CLI_EXE", env) || "codex";
}

function resolveNpmCommand(env: NodeJS.ProcessEnv): string {
  return readEnvValue("NPM_CLI_EXE", env) || "npm";
}

function createMissingResult(): CodexDependencyResult {
  return {
    present: false,
    installAttempted: false,
    loginDetected: false,
    failureCategory: CodexDependencyFailureCategory.Missing
  };
}

function normalizeVersionText(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function extractCodexVersion(input: string): string | undefined {
  const patterns = [
    /^codex(?:\s+cli|-cli)?\s+(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i,
    /^codex(?:-cli)?\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i,
    /^openai codex\s+\((v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)$/i
  ];
  const lines = input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) return normalizeVersionText(match[1]);
    }
  }
  return undefined;
}

function combineCommandOutput(result: CommandRunnerResult): string {
  return [result.stdout, result.stderr].filter((value) => value.trim().length > 0).join("\n");
}

function resolveTrustedWindowsRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const directRoots = [readEnvValue("SystemRoot", env), readEnvValue("WINDIR", env)].filter((value) =>
    TRUSTED_WINDOWS_ROOT_PATTERN.test(value)
  );
  const systemDrive = readEnvValue("SystemDrive", env);
  const systemDriveRoot = /^[A-Za-z]:$/i.test(systemDrive) ? `${systemDrive}\\Windows` : "";
  return [...new Set([...directRoots, systemDriveRoot, "C:\\Windows"].filter(Boolean))];
}

function resolveWindowsPowerShellPath(): string {
  const candidateRoots = resolveTrustedWindowsRoots(process.env);
  for (const root of candidateRoots) {
    const candidate = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }
  return path.win32.join(candidateRoots[0] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function resolveWindowsCmdPath(): string {
  return path.win32.join(resolveTrustedWindowsRoots()[0] ?? "C:\\Windows", "System32", "cmd.exe");
}

function prepareSpawnInvocation(input: CommandRunnerInput): Pick<SpawnProcessInput, "command" | "args" | "shell"> {
  if (process.platform === "win32") {
    const extension = path.extname(input.command).toLowerCase();
    if (extension === ".ps1") {
      return {
        command: resolveWindowsPowerShellPath(),
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", input.command, ...input.args],
        shell: false
      };
    }
    if (extension === ".cmd" || extension === ".bat") {
      return {
        command: resolveWindowsCmdPath(),
        args: ["/d", "/s", "/c", "call", input.command, ...input.args],
        shell: false
      };
    }
  }

  return {
    command: input.command,
    args: input.args,
    shell: false
  };
}

function buildWindowsCommandCandidates(basePath: string, env: NodeJS.ProcessEnv): string[] {
  const extensions = (readEnvValue("PATHEXT", env) || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([...extensions.map((ext) => `${basePath}${ext}`), basePath])];
}

function resolveCommandBaseName(command: string): string {
  const baseName = path.win32.basename(command.trim());
  const extension = path.win32.extname(baseName);
  return extension ? baseName.slice(0, -extension.length) : baseName;
}

function resolveCommandFromDirectories(command: string, directories: string[], env: NodeJS.ProcessEnv): string | undefined {
  const baseName = resolveCommandBaseName(command);
  if (!baseName) return undefined;

  for (const directory of directories) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) continue;

    const basePath = path.join(trimmedDirectory, baseName);
    const candidates = process.platform === "win32" ? buildWindowsCommandCandidates(basePath, env) : [basePath];
    for (const candidate of candidates) {
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  if (path.isAbsolute(trimmed) || trimmed.includes("\\") || trimmed.includes("/")) {
    if (isExistingFile(trimmed)) {
      return trimmed;
    }

    if (process.platform === "win32" && !path.extname(trimmed)) {
      const explicitCandidate = buildWindowsCommandCandidates(trimmed, env).find((candidate) => isExistingFile(candidate));
      if (explicitCandidate) return explicitCandidate;
    }

    return undefined;
  }

  const pathEntries = readEnvValue("PATH", env)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const basePath = path.join(entry, trimmed);
      const candidates =
      process.platform === "win32"
        ? buildWindowsCommandCandidates(basePath, env)
        : [basePath];
    for (const candidate of candidates) {
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  if (process.platform === "win32") {
    const appData = readFirstEnvValue(["APPDATA", "AppData"], env);
    const appDataCandidates = appData ? buildWindowsCommandCandidates(path.join(appData, "npm", trimmed), env) : [];
    const appDataMatch = appDataCandidates.find((candidate) => isExistingFile(candidate));
    if (appDataMatch) return appDataMatch;
  }

  return undefined;
}

function spawnCommandProcess(input: SpawnProcessInput): SpawnedProcessLike {
  return spawn(input.command, input.args, {
    env: input.env,
    shell: input.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function formatProcessError(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function detachTimedOutChild(child: SpawnedProcessLike): void {
  try {
    child.unref?.();
  } catch {
    // Best-effort detach only.
  }

  const destroyStream = (stream: NodeJS.ReadableStream) => {
    try {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    } catch {
      // Best-effort detach only.
    }
  };

  destroyStream(child.stdout);
  destroyStream(child.stderr);
}

function extractLastNonEmptyLine(input: string): string | undefined {
  const lines = input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1);
}

function resolveTaskkillPath(options: TerminateProcessTreeWithTaskkillOptions = {}): string {
  const explicitPath = options.taskkillPath?.trim();
  if (explicitPath) {
    if (!path.win32.isAbsolute(explicitPath) || path.win32.basename(explicitPath).toLowerCase() !== "taskkill.exe") {
      throw new Error("taskkillPath must be an absolute path to taskkill.exe.");
    }
    return explicitPath;
  }

  const candidateRoots = resolveTrustedWindowsRoots(process.env);
  for (const root of candidateRoots) {
    const candidate = path.win32.join(root, "System32", "taskkill.exe");
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return path.win32.join(candidateRoots[0] ?? "C:\\Windows", "System32", "taskkill.exe");
}

function spawnTaskkillProcess(command: string, args: string[]): SpawnTaskkillProcessLike {
  return spawn(command, args, {
    stdio: "ignore",
    windowsHide: true
  });
}

async function waitForCleanupWithin(promise: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function terminateProcessTreeWithTaskkill(
  pid: number,
  options: TerminateProcessTreeWithTaskkillOptions = {}
): Promise<void> {
  const taskkillPath = resolveTaskkillPath(options);
  const spawnTaskkill = options.spawnTaskkill ?? spawnTaskkillProcess;

  await new Promise<void>((resolve, reject) => {
    const killer = spawnTaskkill(taskkillPath, ["/PID", String(pid), "/T", "/F"]);
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rejectOnce = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    killer.on("error", (error) => {
      rejectOnce(`taskkill.exe failed: ${formatProcessError(error)}`);
    });
    killer.on("close", (code) => {
      if (code === 0) {
        resolveOnce();
        return;
      }
      rejectOnce(`taskkill.exe exited with code ${String(code)}.`);
    });
  });
}

export function createCommandRunner(options: CreateCommandRunnerOptions = {}): CommandRunner {
  const spawnProcess = options.spawnProcess ?? spawnCommandProcess;
  const terminateProcessTree = options.terminateProcessTree ?? terminateProcessTreeWithTaskkill;

  return async (input: CommandRunnerInput): Promise<CommandRunnerResult> =>
    await new Promise((runnerResolve) => {
      const preparedInvocation = prepareSpawnInvocation(input);
      const child = spawnProcess({
        command: preparedInvocation.command,
        args: preparedInvocation.args,
        env: input.env,
        shell: preparedInvocation.shell
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timeoutCleanupError = "";
      let fallbackFinalizeTimer: NodeJS.Timeout | undefined;
      const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      const appendTimeoutCleanupError = (error: unknown) => {
        const message = formatProcessError(error);
        timeoutCleanupError = [timeoutCleanupError, message]
          .filter((value) => value.trim().length > 0)
          .join("\n");
      };
      const finalize = (result: CommandRunnerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fallbackFinalizeTimer) {
          clearTimeout(fallbackFinalizeTimer);
        }
        runnerResolve(result);
      };
      const finalizeTimedOut = () => {
        finalize({
          exitCode: null,
          stdout,
          stderr: [stderr, timeoutCleanupError, `Timed out after ${timeoutMs}ms.`]
            .filter((value) => value.trim().length > 0)
            .join("\n")
        });
      };
      const timer = setTimeout(() => {
        if (settled || timedOut) return;
        timedOut = true;
        void (async () => {
          try {
            if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
              await waitForCleanupWithin(
                Promise.resolve(terminateProcessTree(child.pid)),
                PROCESS_TREE_CLEANUP_WAIT_MS,
                "Process-tree cleanup"
              );
            } else {
              child.kill();
            }
          } catch (error) {
            appendTimeoutCleanupError(error);
            try {
              child.kill();
            } catch (fallbackError) {
              appendTimeoutCleanupError(fallbackError);
            }
          }
          detachTimedOutChild(child);
          fallbackFinalizeTimer = setTimeout(() => {
            finalizeTimedOut();
          }, PROCESS_TREE_CLEANUP_WAIT_MS);
          fallbackFinalizeTimer.unref?.();
        })();
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (timedOut) {
          appendTimeoutCleanupError(error);
          return;
        }
        finalize({
          exitCode: null,
          stdout,
          stderr: [stderr, String((error as Error)?.message ?? error)]
            .filter((value) => value.trim().length > 0)
            .join("\n")
        });
      });
      child.on("close", (code) => {
        if (timedOut) {
          finalizeTimedOut();
          return;
        }
        finalize({
          exitCode: typeof code === "number" ? code : null,
          stdout,
          stderr
        });
      });
    });
}

const defaultCommandRunner = createCommandRunner();

async function probeCodexCliPath(
  resolvedPath: string,
  env: NodeJS.ProcessEnv,
  runCommand: CommandRunner
): Promise<CodexDependencyResult> {
  try {
    const probe = await runCommand({
      command: resolvedPath,
      args: ["--version"],
      env,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS
    });
    if (probe.exitCode !== 0) {
      return {
        present: true,
        installAttempted: false,
        resolvedPath,
        loginDetected: false,
        failureCategory: CodexDependencyFailureCategory.InstallFailed
      };
    }

    return {
      present: true,
      installAttempted: false,
      resolvedPath,
      version: extractCodexVersion(combineCommandOutput(probe)),
      loginDetected: false
    };
  } catch {
    return {
      present: true,
      installAttempted: false,
      resolvedPath,
      loginDetected: false,
      failureCategory: CodexDependencyFailureCategory.InstallFailed
    };
  }
}

async function resolveInstalledCodexFromNpmPrefix(
  env: NodeJS.ProcessEnv,
  npmCommand: string,
  codexCommand: string,
  runCommand: CommandRunner
): Promise<string | undefined> {
  try {
    const prefixResult = await runCommand({
      command: npmCommand,
      args: ["prefix", "-g"],
      env,
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS
    });
    if (prefixResult.exitCode !== 0) {
      return undefined;
    }

    const prefix = extractLastNonEmptyLine(prefixResult.stdout);
    if (!prefix) {
      return undefined;
    }

    return resolveCommandFromDirectories(codexCommand, [prefix, path.join(prefix, "bin")], env);
  } catch {
    return undefined;
  }
}

export async function detectCodexCli(options: CodexDependencyOptions = {}): Promise<CodexDependencyResult> {
  const env = options.env ?? process.env;
  const resolveCommand = options.resolveCommand ?? resolveCommandPath;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const resolvedPath = resolveCommand(resolveCodexCommand(env), env);

  if (!resolvedPath) {
    return createMissingResult();
  }
  return await probeCodexCliPath(resolvedPath, env, runCommand);
}

export async function installCodexCli(options: CodexDependencyOptions = {}): Promise<CodexDependencyResult> {
  const env = options.env ?? process.env;
  const resolveCommand = options.resolveCommand ?? resolveCommandPath;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const existing = await detectCodexCli(options);
  if (existing.present) {
    return existing;
  }

  const npmCommand = resolveCommand(resolveNpmCommand(env), env);
  if (!npmCommand) {
    return {
      present: false,
      installAttempted: true,
      loginDetected: false,
      failureCategory: CodexDependencyFailureCategory.InstallFailed
    };
  }

  try {
    const installResult = await runCommand({
      command: npmCommand,
      args: ["install", "-g", "@openai/codex"],
      env,
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS
    });
    if (installResult.exitCode !== 0) {
      return {
        present: false,
        installAttempted: true,
        loginDetected: false,
        failureCategory: CodexDependencyFailureCategory.InstallFailed
      };
    }
  } catch {
    return {
      present: false,
      installAttempted: true,
      loginDetected: false,
      failureCategory: CodexDependencyFailureCategory.InstallFailed
    };
  }

  const detected = await detectCodexCli({
    ...options,
    env,
    resolveCommand,
    runCommand
  });
  if (detected.present) {
    return {
      ...detected,
      installAttempted: true
    };
  }

  const installedCodexPath = await resolveInstalledCodexFromNpmPrefix(
    env,
    npmCommand,
    resolveCodexCommand(env),
    runCommand
  );
  if (installedCodexPath) {
    const probed = await probeCodexCliPath(installedCodexPath, env, runCommand);
    return {
      ...probed,
      installAttempted: true,
      failureCategory: probed.present ? probed.failureCategory : CodexDependencyFailureCategory.InstallFailed
    };
  }

  return {
    ...detected,
    installAttempted: true,
    failureCategory: CodexDependencyFailureCategory.InstallFailed
  };
}

export function verifyCodexVersion(result: CodexDependencyResult): CodexDependencyResult {
  if (result.failureCategory === CodexDependencyFailureCategory.InstallFailed) {
    return result;
  }
  if (!result.present) {
    return {
      ...result,
      failureCategory: result.failureCategory ?? CodexDependencyFailureCategory.Missing
    };
  }

  const versionCheck = verifySupportedCodexVersion(result.version);
  if (!versionCheck.supported) {
    return {
      ...result,
      failureCategory: CodexDependencyFailureCategory.UnsupportedVersion
    };
  }

  return {
    ...result,
    version: versionCheck.version,
    failureCategory:
      result.failureCategory === CodexDependencyFailureCategory.UnsupportedVersion ? undefined : result.failureCategory
  };
}

export function verifyCodexLoginState(
  result: CodexDependencyResult,
  options: Pick<CodexDependencyOptions, "env" | "pathExists"> = {}
): CodexDependencyResult {
  const loginState = detectCodexLoginState({
    env: options.env,
    pathExists: options.pathExists
  });
  if (loginState.loginDetected) {
    return {
      ...result,
      loginDetected: true,
      loginMarkerPath: loginState.loginMarkerPath,
      loginDetectionSource: loginState.detectionSource,
      failureCategory:
        result.failureCategory === CodexDependencyFailureCategory.LoginMissing ? undefined : result.failureCategory
    };
  }

  return {
    ...result,
    loginDetected: false,
    loginMarkerPath: undefined,
    loginDetectionSource: undefined,
    failureCategory: result.failureCategory ?? CodexDependencyFailureCategory.LoginMissing
  };
}

export async function inspectCodexCliDependency(options: CodexDependencyOptions = {}): Promise<CodexDependencyResult> {
  const installWhenMissing = options.installWhenMissing === true;
  let result = await detectCodexCli(options);
  if (!result.present && installWhenMissing) {
    result = await installCodexCli(options);
  }
  result = verifyCodexVersion(result);
  return verifyCodexLoginState(result, options);
}
