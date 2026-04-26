import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type CodexDependencyFailureCategory = "missing" | "install-failed" | "unsupported-version" | "login-missing";

type CodexDependencyResult = {
  present: boolean;
  installAttempted: boolean;
  resolvedPath?: string;
  version?: string;
  loginDetected: boolean;
  loginMarkerPath?: string;
  loginDetectionSource?: "marker" | "openai_api_key";
  failureCategory?: CodexDependencyFailureCategory;
};

type ResolveCommand = (command: string, env?: NodeJS.ProcessEnv) => string | undefined;

type CommandRunnerInput = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type CommandRunnerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resolvedPath?: string;
};

type CommandRunner = (input: CommandRunnerInput) => Promise<CommandRunnerResult> | CommandRunnerResult;

type DestroyableEmitter = EventEmitter & {
  destroy: () => void;
  destroyCalls: number;
};

type SpawnedProcessLike = {
  pid?: number;
  stdout: DestroyableEmitter;
  stderr: DestroyableEmitter;
  kill: () => void;
  unref?: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

type CodexDependencyModule = {
  createCommandRunner: (options?: {
    spawnProcess?: (input: { command: string; args: string[]; env?: NodeJS.ProcessEnv; shell: boolean }) => SpawnedProcessLike;
    terminateProcessTree?: (pid: number) => Promise<void> | void;
  }) => CommandRunner;
  detectCodexCli: (options?: {
    env?: NodeJS.ProcessEnv;
    resolveCommand?: ResolveCommand;
    runCommand?: CommandRunner;
  }) => Promise<CodexDependencyResult>;
  inspectCodexCliDependency: (options?: {
    env?: NodeJS.ProcessEnv;
    installWhenMissing?: boolean;
    resolveCommand?: ResolveCommand;
    runCommand?: CommandRunner;
    pathExists?: (filePath: string) => boolean;
  }) => Promise<CodexDependencyResult>;
  installCodexCli: (options?: {
    env?: NodeJS.ProcessEnv;
    resolveCommand?: ResolveCommand;
    runCommand?: CommandRunner;
  }) => Promise<CodexDependencyResult>;
  verifyCodexVersion: (result: CodexDependencyResult) => CodexDependencyResult;
  verifyCodexLoginState: (
    result: CodexDependencyResult,
    options?: {
      env?: NodeJS.ProcessEnv;
      pathExists?: (filePath: string) => boolean;
    }
  ) => CodexDependencyResult;
  terminateProcessTreeWithTaskkill?: (
    pid: number,
    options?: {
      taskkillPath?: string;
      spawnTaskkill?: (command: string, args: string[]) => EventEmitter;
    }
  ) => Promise<void>;
};

type SetupCommandResult = {
  schemaVersion: number;
  verb: string;
  ok: boolean;
  status: string;
  message: string;
  summaryPath: string;
  codex: CodexDependencyResult;
};

type SetupCommandModule = {
  runFirstRunCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<SetupCommandResult>;
  runDoctorCommand?: (context?: { env?: NodeJS.ProcessEnv }) => Promise<SetupCommandResult>;
};

type LegacyMigrationModule = {
  runLegacyMigration: (options?: { env?: NodeJS.ProcessEnv }) => Promise<{
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
  }>;
};

function codexDependencyModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "codex-dependency.js");
}

function firstRunCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "first-run.js");
}

function doctorCommandModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "commands", "doctor.js");
}

function legacyMigrationModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "legacy-migration.js");
}

function loadCodexDependencyModule(): CodexDependencyModule {
  const modulePath = codexDependencyModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as CodexDependencyModule;
}

function loadFirstRunCommandModule(): SetupCommandModule {
  const modulePath = firstRunCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as SetupCommandModule;
}

function loadDoctorCommandModule(): SetupCommandModule {
  const modulePath = doctorCommandModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as SetupCommandModule;
}

function loadLegacyMigrationModule(): LegacyMigrationModule {
  const modulePath = legacyMigrationModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as LegacyMigrationModule;
}

function createTempRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
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

function createRunner(
  handler: (input: CommandRunnerInput) => CommandRunnerResult | Promise<CommandRunnerResult>
): CommandRunner {
  return async (input) => await handler(input);
}

function createFakeDestroyableEmitter(): DestroyableEmitter {
  const emitter = new EventEmitter() as DestroyableEmitter;
  emitter.destroyCalls = 0;
  emitter.destroy = () => {
    emitter.destroyCalls += 1;
  };
  return emitter;
}

function createFakeProcess(pid = 4242): SpawnedProcessLike & EventEmitter & { killCalls: number; unrefCalls: number } {
  const processEmitter = new EventEmitter() as SpawnedProcessLike & EventEmitter & { killCalls: number; unrefCalls: number };
  processEmitter.pid = pid;
  processEmitter.stdout = createFakeDestroyableEmitter();
  processEmitter.stderr = createFakeDestroyableEmitter();
  processEmitter.killCalls = 0;
  processEmitter.unrefCalls = 0;
  processEmitter.kill = () => {
    processEmitter.killCalls += 1;
  };
  processEmitter.unref = () => {
    processEmitter.unrefCalls += 1;
  };
  return processEmitter;
}

function writeExecutableShim(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "@echo off\r\n", "utf8");
}

function expectedDefaultTaskkillPath(): string {
  const candidateRoots = [
    process.env.SystemRoot?.trim(),
    process.env.WINDIR?.trim(),
    "C:\\Windows"
  ].filter(Boolean) as string[];
  for (const root of candidateRoots) {
    const candidate = path.win32.join(root, "System32", "taskkill.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return path.win32.join(candidateRoots[0] ?? "C:\\Windows", "System32", "taskkill.exe");
}

async function withPatchedProcessPlatform<T>(platform: NodeJS.Platform, callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });

  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
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
  delete require.cache[doctorCommandModulePath()];

  try {
    return await callback();
  } finally {
    dependencyModule.inspectCodexCliDependency = original;
    delete require.cache[dependencyModulePath];
    delete require.cache[firstRunCommandModulePath()];
    delete require.cache[doctorCommandModulePath()];
  }
}

async function withPatchedLegacyMigrationClean<T>(envRoot: string, callback: () => Promise<T>): Promise<T> {
  const migrationModulePath = legacyMigrationModulePath();
  const migrationModule = loadLegacyMigrationModule();
  const original = migrationModule.runLegacyMigration;
  migrationModule.runLegacyMigration = async () => ({
    importedConfig: [],
    disabledLegacyArtifacts: [],
    retainedLegacyArtifacts: [],
    warnings: [],
    statePath: path.join(envRoot, "CodexLark", "state", "legacy-migration.json"),
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
  delete require.cache[firstRunCommandModulePath()];

  try {
    return await callback();
  } finally {
    migrationModule.runLegacyMigration = original;
    delete require.cache[migrationModulePath];
    delete require.cache[firstRunCommandModulePath()];
  }
}

async function withPatchedProcessEnv<T>(updates: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("detectCodexCli resolves an existing codex executable and captures its version", async () => {
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");
  const calls: CommandRunnerInput[] = [];
  const module = loadCodexDependencyModule();

  const result = await module.detectCodexCli({
    resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
    runCommand: createRunner((input) => {
      calls.push(input);
      assert.equal(input.command, codexPath);
      assert.deepEqual(input.args, ["--version"]);
      return {
        exitCode: 0,
        stdout: "codex 0.121.0\n",
        stderr: "",
        resolvedPath: codexPath
      };
    })
  });

  assert.equal(result.present, true);
  assert.equal(result.installAttempted, false);
  assert.equal(result.resolvedPath, codexPath);
  assert.equal(result.version, "0.121.0");
  assert.equal(result.failureCategory, undefined);
  assert.equal(calls.length, 1);
});

test("detectCodexCli accepts OpenAI Codex parenthesized version output", async () => {
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");
  const module = loadCodexDependencyModule();

  const result = await module.detectCodexCli({
    resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
    runCommand: createRunner(() => ({
      exitCode: 0,
      stdout: "OpenAI Codex (v0.63.0)\n",
      stderr: "",
      resolvedPath: codexPath
    }))
  });

  assert.equal(result.present, true);
  assert.equal(result.resolvedPath, codexPath);
  assert.equal(result.version, "0.63.0");
  assert.equal(result.failureCategory, undefined);
});

test("detectCodexCli rejects a version probe that exits non-zero even if output looks versioned", async () => {
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");
  const module = loadCodexDependencyModule();

  const result = await module.detectCodexCli({
    resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
    runCommand: createRunner(() => ({
      exitCode: 1,
      stdout: "codex 0.121.0\n",
      stderr: "probe failed",
      resolvedPath: codexPath
    }))
  });

  assert.equal(result.present, true);
  assert.equal(result.resolvedPath, codexPath);
  assert.equal(result.version, undefined);
  assert.equal(result.failureCategory, "install-failed");
});

test("detectCodexCli classifies runner throw or reject during version probe as install-failed", async () => {
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");
  const module = loadCodexDependencyModule();

  const result = await module.detectCodexCli({
    resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
    runCommand: createRunner(() => {
      throw new Error("probe crashed");
    })
  });

  assert.equal(result.present, true);
  assert.equal(result.resolvedPath, codexPath);
  assert.equal(result.version, undefined);
  assert.equal(result.failureCategory, "install-failed");
});

test("detectCodexCli classifies a missing codex dependency", async () => {
  const module = loadCodexDependencyModule();
  const result = await module.detectCodexCli({
    resolveCommand: () => undefined,
    runCommand: createRunner(() => {
      throw new Error("version probe should not run when codex is missing");
    })
  });

  assert.equal(result.present, false);
  assert.equal(result.installAttempted, false);
  assert.equal(result.loginDetected, false);
  assert.equal(result.failureCategory, "missing");
});

test("detectCodexCli ignores PATH directory entries named codex", async () => {
  const tempRoot = createTempRoot("codexlark-codex-path-directory-entry-");
  const module = loadCodexDependencyModule();

  try {
    mkdirSync(path.join(tempRoot, "bin", "codex"), { recursive: true });

    const result = await module.detectCodexCli({
      env: {
        ...process.env,
        APPDATA: "",
        AppData: "",
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner(() => {
        throw new Error("version probe should not run when only a directory matches codex");
      })
    });

    assert.equal(result.present, false);
    assert.equal(result.installAttempted, false);
    assert.equal(result.failureCategory, "missing");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("detectCodexCli ignores explicit CODEX_CLI_EXE directories", async () => {
  const tempRoot = createTempRoot("codexlark-codex-explicit-directory-entry-");
  const module = loadCodexDependencyModule();
  const codexDirectory = path.join(tempRoot, "tools", "codex");

  try {
    mkdirSync(codexDirectory, { recursive: true });

    const result = await module.detectCodexCli({
      env: {
        ...process.env,
        CODEX_CLI_EXE: codexDirectory,
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner(() => {
        throw new Error("version probe should not run when CODEX_CLI_EXE points to a directory");
      })
    });

    assert.equal(result.present, false);
    assert.equal(result.installAttempted, false);
    assert.equal(result.failureCategory, "missing");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("detectCodexCli prefers PATH entries over APPDATA npm shims", async () => {
  const tempRoot = createTempRoot("codexlark-codex-path-priority-");
  const module = loadCodexDependencyModule();
  const pathCodexShimPath = path.join(tempRoot, "bin", "codex");
  const pathCodexPath = path.join(tempRoot, "bin", "codex.cmd");
  const appDataCodexShimPath = path.join(tempRoot, "AppData", "Roaming", "npm", "codex");
  const appDataCodexPath = path.join(tempRoot, "AppData", "Roaming", "npm", "codex.cmd");
  let commandUsed = "";

  try {
    writeExecutableShim(pathCodexShimPath);
    writeExecutableShim(pathCodexPath);
    writeExecutableShim(appDataCodexShimPath);
    writeExecutableShim(appDataCodexPath);

    const result = await module.detectCodexCli({
      env: {
        ...process.env,
        APPDATA: path.join(tempRoot, "AppData", "Roaming"),
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner((input) => {
        commandUsed = input.command;
        return {
          exitCode: 0,
          stdout: "codex 0.121.1\n",
          stderr: "",
          resolvedPath: input.command
        };
      })
    });

    assert.equal(commandUsed.toLowerCase(), pathCodexPath.toLowerCase());
    assert.equal(result.resolvedPath?.toLowerCase(), pathCodexPath.toLowerCase());
    assert.notEqual(result.resolvedPath?.toLowerCase(), pathCodexShimPath.toLowerCase());
    assert.notEqual(result.resolvedPath?.toLowerCase(), appDataCodexPath.toLowerCase());
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("detectCodexCli falls back to APPDATA npm shims when PATH does not contain codex", async () => {
  const tempRoot = createTempRoot("codexlark-codex-appdata-fallback-");
  const module = loadCodexDependencyModule();
  const appDataCodexShimPath = path.join(tempRoot, "AppData", "Roaming", "npm", "codex");
  const appDataCodexPath = path.join(tempRoot, "AppData", "Roaming", "npm", "codex.cmd");
  let commandUsed = "";

  try {
    writeExecutableShim(appDataCodexShimPath);
    writeExecutableShim(appDataCodexPath);

    const result = await module.detectCodexCli({
      env: {
        ...process.env,
        APPDATA: path.join(tempRoot, "AppData", "Roaming"),
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner((input) => {
        commandUsed = input.command;
        return {
          exitCode: 0,
          stdout: "codex 0.121.1\n",
          stderr: "",
          resolvedPath: input.command
        };
      })
    });

    assert.equal(commandUsed.toLowerCase(), appDataCodexPath.toLowerCase());
    assert.equal(result.resolvedPath?.toLowerCase(), appDataCodexPath.toLowerCase());
    assert.notEqual(result.resolvedPath?.toLowerCase(), appDataCodexShimPath.toLowerCase());
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("detectCodexCli falls back to AppData casing variants when PATH does not contain codex", async () => {
  const tempRoot = createTempRoot("codexlark-codex-appdata-case-fallback-");
  const module = loadCodexDependencyModule();
  const appDataCodexPath = path.join(tempRoot, "AppData", "Roaming", "npm", "codex.cmd");
  let commandUsed = "";

  try {
    writeExecutableShim(appDataCodexPath);

    const result = await module.detectCodexCli({
      env: {
        ...process.env,
        APPDATA: "",
        AppData: path.join(tempRoot, "AppData", "Roaming"),
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner((input) => {
        commandUsed = input.command;
        return {
          exitCode: 0,
          stdout: "codex 0.121.1\n",
          stderr: "",
          resolvedPath: input.command
        };
      })
    });

    assert.equal(commandUsed.toLowerCase(), appDataCodexPath.toLowerCase());
    assert.equal(result.resolvedPath?.toLowerCase(), appDataCodexPath.toLowerCase());
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspectCodexCliDependency rejects unrelated semver output even when login is detected", async () => {
  const tempRoot = createTempRoot("codexlark-codex-fake-version-output-");
  const module = loadCodexDependencyModule();
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");

  try {
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(path.join(tempRoot, "auth.json"), "{}\n", "utf8");

    const result = await module.inspectCodexCliDependency({
      env: {
        ...process.env,
        COMMUNICATE_CODEX_HOME: tempRoot
      },
      resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
      runCommand: createRunner(() => ({
        exitCode: 0,
        stdout: "npm 10.8.1\n",
        stderr: "",
        resolvedPath: codexPath
      }))
    });

    assert.equal(result.present, true);
    assert.equal(result.resolvedPath, codexPath);
    assert.equal(result.version, undefined);
    assert.equal(result.failureCategory, "unsupported-version");
    assert.equal(result.loginDetected, true);
    assert.equal(result.loginDetectionSource, "marker");
    assert.equal(result.loginMarkerPath, path.join(tempRoot, "auth.json"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspectCodexCliDependency rejects wrapper text that only mentions a Codex version fragment", async () => {
  const tempRoot = createTempRoot("codexlark-codex-wrapper-version-output-");
  const module = loadCodexDependencyModule();
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");

  try {
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(path.join(tempRoot, "auth.json"), "{}\n", "utf8");

    const result = await module.inspectCodexCliDependency({
      env: {
        ...process.env,
        COMMUNICATE_CODEX_HOME: tempRoot
      },
      resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
      runCommand: createRunner(() => ({
        exitCode: 0,
        stdout: "wrapper help: set CODEX_VERSION=codex-cli 0.121.0 before retrying\n",
        stderr: "",
        resolvedPath: codexPath
      }))
    });

    assert.equal(result.present, true);
    assert.equal(result.resolvedPath, codexPath);
    assert.equal(result.version, undefined);
    assert.equal(result.failureCategory, "unsupported-version");
    assert.equal(result.loginDetected, true);
    assert.equal(result.loginDetectionSource, "marker");
    assert.equal(result.loginMarkerPath, path.join(tempRoot, "auth.json"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("inspectCodexCliDependency rejects slash-style wrapper version output", async () => {
  const tempRoot = createTempRoot("codexlark-codex-wrapper-slash-output-");
  const module = loadCodexDependencyModule();
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");

  try {
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(path.join(tempRoot, "auth.json"), "{}\n", "utf8");

    const result = await module.inspectCodexCliDependency({
      env: {
        ...process.env,
        COMMUNICATE_CODEX_HOME: tempRoot
      },
      resolveCommand: (command) => (command === "codex" ? codexPath : undefined),
      runCommand: createRunner(() => ({
        exitCode: 0,
        stdout: "codex-wrapper/0.121.1\n",
        stderr: "",
        resolvedPath: codexPath
      }))
    });

    assert.equal(result.present, true);
    assert.equal(result.resolvedPath, codexPath);
    assert.equal(result.version, undefined);
    assert.equal(result.failureCategory, "unsupported-version");
    assert.equal(result.loginDetected, true);
    assert.equal(result.loginDetectionSource, "marker");
    assert.equal(result.loginMarkerPath, path.join(tempRoot, "auth.json"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("detectCodexCli resolves explicit CODEX_CLI_EXE paths through PATHEXT on Windows", async () => {
  const tempRoot = createTempRoot("codexlark-codex-explicit-override-");
  const module = loadCodexDependencyModule();
  const codexBasePath = path.join(tempRoot, "tools", "codex");
  const codexCmdPath = `${codexBasePath}.cmd`;
  let commandUsed = "";

  try {
    writeExecutableShim(codexCmdPath);

    const result = await module.detectCodexCli({
      env: {
        ...process.env,
        CODEX_CLI_EXE: codexBasePath,
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner((input) => {
        commandUsed = input.command;
        return {
          exitCode: 0,
          stdout: "codex-cli 0.121.1\n",
          stderr: "",
          resolvedPath: input.command
        };
      })
    });

    assert.equal(commandUsed.toLowerCase(), codexCmdPath.toLowerCase());
    assert.equal(result.resolvedPath?.toLowerCase(), codexCmdPath.toLowerCase());
    assert.equal(result.version, "0.121.1");
    assert.equal(result.failureCategory, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installCodexCli installs codex through the controlled runner and redetects it", async () => {
  let installed = false;
  const npmPath = path.win32.join("C:\\", "fake-bin", "npm.cmd");
  const codexPath = path.win32.join("C:\\", "fake-bin", "codex.cmd");
  const calls: CommandRunnerInput[] = [];
  const module = loadCodexDependencyModule();

  const result = await module.installCodexCli({
    resolveCommand: (command) => {
      if (command === "npm") return npmPath;
      if (command === "codex" && installed) return codexPath;
      return undefined;
    },
    runCommand: createRunner((input) => {
      calls.push(input);
      if (input.command === npmPath) {
        installed = true;
        return {
          exitCode: 0,
          stdout: "installed",
          stderr: "",
          resolvedPath: npmPath
        };
      }

      if (input.command === codexPath) {
        return {
          exitCode: 0,
          stdout: "codex 0.121.0\n",
          stderr: "",
          resolvedPath: codexPath
        };
      }

      throw new Error(`unexpected command: ${input.command}`);
    })
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, npmPath);
  assert.deepEqual(calls[0]?.args, ["install", "-g", "@openai/codex"]);
  assert.equal(calls[1]?.command, codexPath);
  assert.deepEqual(calls[1]?.args, ["--version"]);
  assert.equal(result.present, true);
  assert.equal(result.installAttempted, true);
  assert.equal(result.resolvedPath, codexPath);
  assert.equal(result.version, "0.121.0");
  assert.equal(result.failureCategory, undefined);
});

test("installCodexCli redetects codex from npm prefix output when custom global prefix is not on PATH", async () => {
  const tempRoot = createTempRoot("codexlark-codex-npm-prefix-redetect-");
  let installed = false;
  const module = loadCodexDependencyModule();
  const npmPath = path.join(tempRoot, "tools", "npm.cmd");
  const globalPrefix = path.join(tempRoot, "custom-prefix");
  const codexCmdPath = path.join(globalPrefix, "codex.cmd");
  const calls: CommandRunnerInput[] = [];

  try {
    writeExecutableShim(npmPath);

    const result = await module.installCodexCli({
      env: {
        ...process.env,
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      resolveCommand: (command, env) => {
        if (command === "npm") return npmPath;
        return undefined;
      },
      runCommand: createRunner((input) => {
        calls.push(input);
        if (input.command.toLowerCase() === npmPath.toLowerCase()
          && input.args.join(" ") === "install -g @openai/codex") {
          installed = true;
          writeExecutableShim(codexCmdPath);
          return {
            exitCode: 0,
            stdout: "installed",
            stderr: "",
            resolvedPath: input.command
          };
        }

        if (input.command.toLowerCase() === npmPath.toLowerCase()
          && input.args.join(" ") === "prefix -g") {
          assert.equal(installed, true);
          return {
            exitCode: 0,
            stdout: `${globalPrefix}\n`,
            stderr: "",
            resolvedPath: input.command
          };
        }

        if (input.command.toLowerCase() === codexCmdPath.toLowerCase()) {
          return {
            exitCode: 0,
            stdout: "codex-cli 0.121.1\n",
            stderr: "",
            resolvedPath: input.command
          };
        }

        throw new Error(`unexpected command: ${input.command} ${input.args.join(" ")}`);
      })
    });

    assert.deepEqual(
      calls.map((call) => `${call.command.toLowerCase()} ${call.args.join(" ")}`),
      [
        `${npmPath.toLowerCase()} install -g @openai/codex`,
        `${npmPath.toLowerCase()} prefix -g`,
        `${codexCmdPath.toLowerCase()} --version`
      ]
    );
    assert.equal(result.present, true);
    assert.equal(result.installAttempted, true);
    assert.equal(result.resolvedPath?.toLowerCase(), codexCmdPath.toLowerCase());
    assert.equal(result.version, "0.121.1");
    assert.equal(result.failureCategory, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installCodexCli resolves explicit NPM_CLI_EXE and CODEX_CLI_EXE paths through PATHEXT on Windows", async () => {
  const tempRoot = createTempRoot("codexlark-npm-explicit-override-");
  let installed = false;
  const module = loadCodexDependencyModule();
  const npmBasePath = path.join(tempRoot, "tools", "npm");
  const npmCmdPath = `${npmBasePath}.cmd`;
  const codexBasePath = path.join(tempRoot, "tools", "codex");
  const codexCmdPath = `${codexBasePath}.cmd`;
  const calls: CommandRunnerInput[] = [];

  try {
    writeExecutableShim(npmCmdPath);

    const result = await module.installCodexCli({
      env: {
        ...process.env,
        NPM_CLI_EXE: npmBasePath,
        CODEX_CLI_EXE: codexBasePath,
        PATH: path.join(tempRoot, "bin"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD"
      },
      runCommand: createRunner((input) => {
        calls.push(input);
        if (input.command.toLowerCase() === npmCmdPath.toLowerCase()) {
          installed = true;
          writeExecutableShim(codexCmdPath);
          return {
            exitCode: 0,
            stdout: "installed",
            stderr: "",
            resolvedPath: input.command
          };
        }

        if (input.command.toLowerCase() === codexCmdPath.toLowerCase() && installed) {
          return {
            exitCode: 0,
            stdout: "codex-cli 0.121.1\n",
            stderr: "",
            resolvedPath: input.command
          };
        }

        throw new Error(`unexpected command: ${input.command}`);
      })
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.command.toLowerCase(), npmCmdPath.toLowerCase());
    assert.equal(calls[1]?.command.toLowerCase(), codexCmdPath.toLowerCase());
    assert.equal(result.present, true);
    assert.equal(result.installAttempted, true);
    assert.equal(result.resolvedPath?.toLowerCase(), codexCmdPath.toLowerCase());
    assert.equal(result.version, "0.121.1");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("installCodexCli fails closed when npm executable cannot be resolved", async () => {
  const module = loadCodexDependencyModule();
  const result = await module.installCodexCli({
    resolveCommand: () => undefined,
    runCommand: createRunner(() => {
      throw new Error("runCommand should not run when npm is missing");
    })
  });

  assert.equal(result.present, false);
  assert.equal(result.installAttempted, true);
  assert.equal(result.failureCategory, "install-failed");
});

test("installCodexCli fails closed when npm install exits non-zero", async () => {
  const npmPath = path.win32.join("C:\\", "fake-bin", "npm.cmd");
  const module = loadCodexDependencyModule();

  const result = await module.installCodexCli({
    resolveCommand: (command) => (command === "npm" ? npmPath : undefined),
    runCommand: createRunner((input) => {
      assert.equal(input.command, npmPath);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "install failed",
        resolvedPath: input.command
      };
    })
  });

  assert.equal(result.present, false);
  assert.equal(result.installAttempted, true);
  assert.equal(result.failureCategory, "install-failed");
});

test("installCodexCli fails closed when codex is still missing after install", async () => {
  const npmPath = path.win32.join("C:\\", "fake-bin", "npm.cmd");
  const module = loadCodexDependencyModule();
  let npmCalls = 0;

  const result = await module.installCodexCli({
    resolveCommand: (command) => (command === "npm" ? npmPath : undefined),
    runCommand: createRunner((input) => {
      assert.equal(input.command, npmPath);
      npmCalls += 1;
      return {
        exitCode: 0,
        stdout: input.args.join(" ") === "prefix -g" ? "C:\\custom-prefix\n" : "installed",
        stderr: "",
        resolvedPath: input.command
      };
    })
  });

  assert.equal(npmCalls, 2);
  assert.equal(result.present, false);
  assert.equal(result.installAttempted, true);
  assert.equal(result.failureCategory, "install-failed");
});

test("verifyCodexVersion rejects versions blocked by version policy", () => {
  const module = loadCodexDependencyModule();
  const result = module.verifyCodexVersion({
    present: true,
    installAttempted: false,
    resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
    version: "0.120.0",
    loginDetected: false
  });

  assert.equal(result.present, true);
  assert.equal(result.version, "0.120.0");
  assert.equal(result.failureCategory, "unsupported-version");
});

test("verifyCodexVersion rejects versions below the minimum supported Codex version", () => {
  const module = loadCodexDependencyModule();
  const result = module.verifyCodexVersion({
    present: true,
    installAttempted: false,
    resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
    version: "0.63.0",
    loginDetected: false
  });

  assert.equal(result.present, true);
  assert.equal(result.version, "0.63.0");
  assert.equal(result.failureCategory, "unsupported-version");
});

test("verifyCodexLoginState preserves unsupported-version while still reporting detected login", () => {
  const tempRoot = createTempRoot("codexlark-codex-unsupported-login-");
  const module = loadCodexDependencyModule();

  try {
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(path.join(tempRoot, "auth.json"), "{}\n", "utf8");

    const result = module.verifyCodexLoginState(
      {
        present: true,
        installAttempted: false,
        resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
        version: "0.120.0",
        loginDetected: false,
        failureCategory: "unsupported-version"
      },
      {
        env: {
          COMMUNICATE_CODEX_HOME: tempRoot
        }
      }
    );

    assert.equal(result.failureCategory, "unsupported-version");
    assert.equal(result.loginDetected, true);
    assert.equal(result.loginDetectionSource, "marker");
    assert.equal(result.loginMarkerPath, path.join(tempRoot, "auth.json"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("verifyCodexLoginState fails when no login marker exists after install", () => {
  const tempRoot = createTempRoot("codexlark-codex-login-missing-");
  const module = loadCodexDependencyModule();

  try {
    const result = module.verifyCodexLoginState(
      {
        present: true,
        installAttempted: true,
        resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
        version: "0.121.0",
        loginDetected: false
      },
      {
        env: {
          COMMUNICATE_CODEX_HOME: tempRoot
        }
      }
    );

    assert.equal(result.present, true);
    assert.equal(result.loginDetected, false);
    assert.equal(result.failureCategory, "login-missing");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("verifyCodexLoginState detects an auth marker under COMMUNICATE_CODEX_HOME", () => {
  const tempRoot = createTempRoot("codexlark-codex-login-present-");
  const module = loadCodexDependencyModule();

  try {
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(path.join(tempRoot, "auth.json"), "{}\n", "utf8");

    const result = module.verifyCodexLoginState(
      {
        present: true,
        installAttempted: false,
        resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
        version: "0.121.1",
        loginDetected: false
      },
      {
        env: {
          COMMUNICATE_CODEX_HOME: tempRoot
        }
      }
    );

    assert.equal(result.loginDetected, true);
    assert.equal(result.failureCategory, undefined);
    assert.equal(result.loginDetectionSource, "marker");
    assert.equal(result.loginMarkerPath, path.join(tempRoot, "auth.json"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("verifyCodexLoginState accepts OPENAI_API_KEY without leaking the secret value", () => {
  const secretValue = "openai-api-key-fixture-value";
  const module = loadCodexDependencyModule();
  const result = module.verifyCodexLoginState(
    {
      present: true,
      installAttempted: false,
      resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
      version: "0.121.1",
      loginDetected: false
    },
    {
      env: {
        OPENAI_API_KEY: secretValue
      }
    }
  );

  assert.equal(result.loginDetected, true);
  assert.equal(result.failureCategory, undefined);
  assert.equal(result.loginDetectionSource, "openai_api_key");
  assert.equal(result.loginMarkerPath, undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runFirstRunCommand writes a machine-readable ready summary for marker-based auth", async () => {
  const tempRoot = createTempRoot("codexlark-first-run-marker-contract-");

  try {
    const result = await withPatchedLegacyMigrationClean(
      tempRoot,
      async () =>
        await withPatchedInspectCodexCliDependency(
          async () => ({
            present: true,
            installAttempted: true,
            resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
            version: "0.121.1",
            loginDetected: true,
            loginMarkerPath: path.join(tempRoot, ".codex", "auth.json"),
            loginDetectionSource: "marker"
          }),
          async () => {
            const commandModule = loadFirstRunCommandModule();
            return await commandModule.runFirstRunCommand?.({
              env: createSetupEnv(tempRoot)
            }) as SetupCommandResult;
          }
        )
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.message, "Codex CLI dependency is ready for first-run.");
    assert.equal(result.codex.loginDetected, true);
    assert.equal(result.codex.loginDetectionSource, "marker");
    assert.deepEqual(readJsonFile<SetupCommandResult>(result.summaryPath), result);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand keeps installWhenMissing false so installer checks stay non-invasive", async () => {
  const tempRoot = createTempRoot("codexlark-first-run-install-option-");
  const receivedOptions: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];

  try {
    await withPatchedLegacyMigrationClean(
      tempRoot,
      async () =>
        await withPatchedInspectCodexCliDependency(
          async (options) => {
            receivedOptions.push({
              env: options?.env,
              installWhenMissing: options?.installWhenMissing
            });
            return {
              present: true,
              installAttempted: false,
              resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
              version: "0.121.1",
              loginDetected: true,
              loginDetectionSource: "marker"
            };
          },
          async () => {
            const commandModule = loadFirstRunCommandModule();
            await commandModule.runFirstRunCommand?.({
              env: createSetupEnv(tempRoot)
            });
          }
        )
    );

    assert.equal(receivedOptions.length, 1);
    assert.equal(receivedOptions[0]?.installWhenMissing, false);
    assert.equal(receivedOptions[0]?.env?.LOCALAPPDATA, tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runFirstRunCommand writes a machine-readable login-missing summary", async () => {
  const tempRoot = createTempRoot("codexlark-first-run-contract-");

  try {
    const result = await withPatchedLegacyMigrationClean(
      tempRoot,
      async () =>
        await withPatchedInspectCodexCliDependency(
          async () => ({
            present: true,
            installAttempted: true,
            resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
            version: "0.121.1",
            loginDetected: false,
            failureCategory: "login-missing"
          }),
          async () => {
            const commandModule = loadFirstRunCommandModule();
            return await commandModule.runFirstRunCommand?.({
              env: createSetupEnv(tempRoot)
            }) as SetupCommandResult;
          }
        )
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, "action-required");
    assert.equal(result.message, "Codex CLI is installed, but no login marker was detected.");
    assert.equal(result.codex.failureCategory, "login-missing");
    assert.equal(result.codex.installAttempted, true);
    assert.deepEqual(readJsonFile<SetupCommandResult>(result.summaryPath), result);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runDoctorCommand writes a machine-readable healthy summary without leaking OPENAI_API_KEY", async () => {
  const tempRoot = createTempRoot("codexlark-doctor-contract-");
  const secretValue = "openai-api-key-test-secret";

  try {
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
        const commandModule = loadDoctorCommandModule();
        return await commandModule.runDoctorCommand?.({
          env: createSetupEnv(tempRoot, {
            OPENAI_API_KEY: secretValue
          })
        }) as SetupCommandResult;
      }
    );

    const summaryText = readFileSync(result.summaryPath, "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.message, "Codex CLI dependency is healthy.");
    assert.equal(result.codex.failureCategory, undefined);
    assert.equal(result.codex.loginDetected, true);
    assert.equal(result.codex.loginDetectionSource, "openai_api_key");
    assert.deepEqual(readJsonFile<SetupCommandResult>(result.summaryPath), result);
    assert.doesNotMatch(summaryText, new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runDoctorCommand passes installWhenMissing false to inspectCodexCliDependency", async () => {
  const tempRoot = createTempRoot("codexlark-doctor-install-option-");
  const receivedOptions: Array<{ env?: NodeJS.ProcessEnv; installWhenMissing?: boolean }> = [];

  try {
    await withPatchedInspectCodexCliDependency(
      async (options) => {
        receivedOptions.push({
          env: options?.env,
          installWhenMissing: options?.installWhenMissing
        });
        return {
          present: true,
          installAttempted: false,
          resolvedPath: path.win32.join("C:\\", "fake-bin", "codex.cmd"),
          version: "0.121.1",
          loginDetected: true,
          loginDetectionSource: "openai_api_key"
        };
      },
      async () => {
        const commandModule = loadDoctorCommandModule();
        await commandModule.runDoctorCommand?.({
          env: createSetupEnv(tempRoot)
        });
      }
    );

    assert.equal(receivedOptions.length, 1);
    assert.equal(receivedOptions[0]?.installWhenMissing, false);
    assert.equal(receivedOptions[0]?.env?.LOCALAPPDATA, tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("createCommandRunner launches PowerShell scripts through powershell.exe on Windows", async () => {
  const fakeProcess = createFakeProcess(9393);
  const module = loadCodexDependencyModule();
  let receivedInput:
    | {
        command: string;
        args: string[];
        env?: NodeJS.ProcessEnv;
        shell: boolean;
      }
    | undefined;

  const runner = module.createCommandRunner({
    spawnProcess: (input) => {
      receivedInput = input;
      setImmediate(() => {
        fakeProcess.emit("close", 0);
      });
      return fakeProcess;
    }
  });

  const result = await runner({
    command: path.win32.join("C:\\", "fake-bin", "npm.ps1"),
    args: ["install", "-g", "@openai/codex"]
  });

  assert.equal(result.exitCode, 0);
  assert.ok(receivedInput);
  assert.match(receivedInput!.command.toLowerCase(), /powershell\.exe$/);
  assert.deepEqual(receivedInput!.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.win32.join("C:\\", "fake-bin", "npm.ps1"),
    "install",
    "-g",
    "@openai/codex"
  ]);
  assert.equal(receivedInput!.shell, false);
});

test("createCommandRunner passes cmd shim path and args as separate cmd.exe call argv without shell true", async () =>
  await withPatchedProcessPlatform("win32", async () => {
    const fakeProcess = createFakeProcess(9495);
    const module = loadCodexDependencyModule();
    let receivedInput:
      | {
          command: string;
          args: string[];
          env?: NodeJS.ProcessEnv;
          shell: boolean;
        }
      | undefined;

    const runner = module.createCommandRunner({
      spawnProcess: (input) => {
        receivedInput = input;
        setImmediate(() => {
          fakeProcess.emit("close", 0);
        });
        return fakeProcess;
      }
    });

    const command = path.win32.join("C:\\", "Users", "23611", "AppData", "Roaming", "npm", "codex.CMD");
    const result = await runner({
      command,
      args: ["--version"]
    });

    assert.equal(result.exitCode, 0);
    assert.ok(receivedInput);
    assert.match(receivedInput!.command.toLowerCase(), /cmd\.exe$/);
    assert.deepEqual(receivedInput!.args, ["/d", "/s", "/c", "call", command, "--version"]);
    assert.equal(receivedInput!.shell, false);
  })
);

test("createCommandRunner keeps cmd shim paths and spaced arguments split across argv", async () =>
  await withPatchedProcessPlatform("win32", async () => {
    const fakeProcess = createFakeProcess(9496);
    const module = loadCodexDependencyModule();
    let receivedInput:
      | {
          command: string;
          args: string[];
          env?: NodeJS.ProcessEnv;
          shell: boolean;
        }
      | undefined;

    const runner = module.createCommandRunner({
      spawnProcess: (input) => {
        receivedInput = input;
        setImmediate(() => {
          fakeProcess.emit("close", 0);
        });
        return fakeProcess;
      }
    });

    const command = path.win32.join("C:\\", "Program Files", "Codex Lark", "bin", "codex shim.bat");
    const args = ["--workspace", "D:\\Repos\\Codex Lark", "--prompt", "hello world"];
    const result = await runner({
      command,
      args
    });

    assert.equal(result.exitCode, 0);
    assert.ok(receivedInput);
    assert.match(receivedInput!.command.toLowerCase(), /cmd\.exe$/);
    assert.deepEqual(receivedInput!.args, ["/d", "/s", "/c", "call", command, ...args]);
    assert.equal(receivedInput!.args.some((arg) => arg !== command && arg.includes(command)), false);
    assert.equal(receivedInput!.shell, false);
  })
);

test("createCommandRunner ignores untrusted SystemRoot when resolving powershell.exe", async () => {
  const tempRoot = createTempRoot("codexlark-powershell-root-");
  const fakeProcess = createFakeProcess(9494);
  const module = loadCodexDependencyModule();
  const fakeWindowsRoot = path.join(tempRoot, "Users", "Alice", "Windows");
  const fakePowerShellPath = path.join(fakeWindowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let receivedInput:
    | {
        command: string;
        args: string[];
        env?: NodeJS.ProcessEnv;
        shell: boolean;
      }
    | undefined;

  try {
    writeExecutableShim(fakePowerShellPath);

    await withPatchedProcessEnv(
      {
        SystemRoot: fakeWindowsRoot,
        WINDIR: fakeWindowsRoot
      },
      async () => {
        const runner = module.createCommandRunner({
          spawnProcess: (input) => {
            receivedInput = input;
            setImmediate(() => {
              fakeProcess.emit("close", 0);
            });
            return fakeProcess;
          }
        });

        await runner({
          command: path.win32.join("C:\\", "fake-bin", "npm.ps1"),
          args: ["install"]
        });
      }
    );

    assert.ok(receivedInput);
    assert.notEqual(receivedInput!.command.toLowerCase(), fakePowerShellPath.toLowerCase());
    assert.match(receivedInput!.command.toLowerCase(), /powershell\.exe$/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("createCommandRunner uses process-tree cleanup on timeout before returning", async () => {
  const terminatedPids: number[] = [];
  const fakeProcess = createFakeProcess(9191);
  const module = loadCodexDependencyModule();
  const runner = module.createCommandRunner({
    spawnProcess: () => fakeProcess,
    terminateProcessTree: async (pid) => {
      terminatedPids.push(pid);
      fakeProcess.stdout.emit("data", "late output");
      setImmediate(() => {
        fakeProcess.emit("close", null);
      });
    }
  });

  const result = await runner({
    command: path.win32.join("C:\\", "fake-bin", "npm.cmd"),
    args: ["install"],
    timeoutMs: 5
  });

  assert.deepEqual(terminatedPids, [9191]);
  assert.equal(fakeProcess.killCalls, process.platform === "win32" ? 0 : 1);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, "late output");
  assert.match(result.stderr, /Timed out after 5ms\./);
});

test("terminateProcessTreeWithTaskkill uses the system taskkill.exe and rejects non-zero exit codes", async () => {
  const module = loadCodexDependencyModule();
  let commandUsed = "";
  let argsUsed: string[] = [];

  await assert.rejects(
    async () =>
      await (module.terminateProcessTreeWithTaskkill?.(9191, {
        spawnTaskkill: (command, args) => {
          commandUsed = command;
          argsUsed = args;
          const killer = new EventEmitter();
          setImmediate(() => {
            killer.emit("close", 128);
          });
          return killer;
        }
      }) ?? Promise.reject(new Error("terminateProcessTreeWithTaskkill is unavailable"))),
    /taskkill\.exe exited with code 128/i
  );

  assert.equal(commandUsed, expectedDefaultTaskkillPath());
  assert.deepEqual(argsUsed, ["/PID", "9191", "/T", "/F"]);
});

test("terminateProcessTreeWithTaskkill ignores untrusted SystemRoot when resolving taskkill.exe", async () => {
  const tempRoot = createTempRoot("codexlark-taskkill-root-");
  const module = loadCodexDependencyModule();
  const fakeWindowsRoot = path.join(tempRoot, "Users", "Alice", "Windows");
  const fakeTaskkillPath = path.join(fakeWindowsRoot, "System32", "taskkill.exe");
  let commandUsed = "";

  try {
    writeExecutableShim(fakeTaskkillPath);

    await withPatchedProcessEnv(
      {
        SystemRoot: fakeWindowsRoot,
        WINDIR: fakeWindowsRoot
      },
      async () => {
        await (module.terminateProcessTreeWithTaskkill?.(9292, {
          spawnTaskkill: (command) => {
            commandUsed = command;
            const killer = new EventEmitter();
            setImmediate(() => {
              killer.emit("close", 0);
            });
            return killer;
          }
        }) ?? Promise.reject(new Error("terminateProcessTreeWithTaskkill is unavailable")));
      }
    );

    assert.notEqual(commandUsed.toLowerCase(), fakeTaskkillPath.toLowerCase());
    assert.match(commandUsed.toLowerCase(), /taskkill\.exe$/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("createCommandRunner reports taskkill cleanup failures and falls back to child.kill on timeout", async () => {
  const fakeProcess = createFakeProcess(8181);
  const module = loadCodexDependencyModule();
  fakeProcess.kill = () => {
    fakeProcess.killCalls += 1;
    setImmediate(() => {
      fakeProcess.emit("close", null);
    });
  };

  const runner = module.createCommandRunner({
    spawnProcess: () => fakeProcess,
    terminateProcessTree: async (pid) =>
      await (module.terminateProcessTreeWithTaskkill?.(pid, {
        taskkillPath: path.win32.join("C:\\Windows", "System32", "taskkill.exe"),
        spawnTaskkill: () => {
          const killer = new EventEmitter();
          setImmediate(() => {
            killer.emit("close", 5);
          });
          return killer;
        }
      }) ?? Promise.reject(new Error("terminateProcessTreeWithTaskkill is unavailable")))
  });

  const result = await runner({
    command: path.win32.join("C:\\", "fake-bin", "npm.cmd"),
    args: ["install"],
    timeoutMs: 5
  });

  assert.equal(fakeProcess.killCalls, 1);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /taskkill\.exe exited with code 5/i);
  assert.match(result.stderr, /Timed out after 5ms\./);
});

test("createCommandRunner still returns in bounded time when tree cleanup never settles", async () => {
  const fakeProcess = createFakeProcess(7171);
  const module = loadCodexDependencyModule();
  fakeProcess.kill = () => {
    fakeProcess.killCalls += 1;
    setImmediate(() => {
      fakeProcess.emit("close", null);
    });
  };

  const runner = module.createCommandRunner({
    spawnProcess: () => fakeProcess,
    terminateProcessTree: async () => {
      await new Promise(() => {});
    }
  });

  const timedOutSentinel = Symbol("runner timed out");
  const result = await Promise.race([
    runner({
      command: path.win32.join("C:\\", "fake-bin", "npm.cmd"),
      args: ["install"],
      timeoutMs: 5
    }),
    new Promise<symbol>((resolve) => {
      setTimeout(() => {
        resolve(timedOutSentinel);
      }, 700);
    })
  ]);

  if (result === timedOutSentinel) {
    assert.fail("runner should not hang when process-tree cleanup never settles");
  }
  const runnerResult = result as CommandRunnerResult;
  assert.equal(fakeProcess.killCalls, 1);
  assert.equal(runnerResult.exitCode, null);
  assert.match(runnerResult.stderr, /process-tree cleanup timed out after 250ms\./i);
  assert.match(runnerResult.stderr, /Timed out after 5ms\./);
});

test("createCommandRunner still returns when tree cleanup succeeds but child never closes", async () => {
  const fakeProcess = createFakeProcess(6262);
  const module = loadCodexDependencyModule();
  const runner = module.createCommandRunner({
    spawnProcess: () => fakeProcess,
    terminateProcessTree: async () => {
      await Promise.resolve();
    }
  });

  const timedOutSentinel = Symbol("runner timed out");
  const result = await Promise.race([
    runner({
      command: path.win32.join("C:\\", "fake-bin", "npm.cmd"),
      args: ["install"],
      timeoutMs: 5
    }),
    new Promise<symbol>((resolve) => {
      setTimeout(() => {
        resolve(timedOutSentinel);
      }, 700);
    })
  ]);

  if (result === timedOutSentinel) {
    assert.fail("runner should not hang when child never closes after successful tree cleanup");
  }
  const runnerResult = result as CommandRunnerResult;
  assert.equal(fakeProcess.killCalls, 0);
  assert.equal(runnerResult.exitCode, null);
  assert.doesNotMatch(runnerResult.stderr, /process-tree cleanup timed out/i);
  assert.match(runnerResult.stderr, /Timed out after 5ms\./);
});

test("createCommandRunner detaches timed-out child handles when cleanup never produces close", async () => {
  const fakeProcess = createFakeProcess(5151);
  const module = loadCodexDependencyModule();
  const runner = module.createCommandRunner({
    spawnProcess: () => fakeProcess,
    terminateProcessTree: async () => {
      await Promise.resolve();
    }
  });

  const result = await runner({
    command: path.win32.join("C:\\", "fake-bin", "npm.cmd"),
    args: ["install"],
    timeoutMs: 5
  });

  assert.equal(result.exitCode, null);
  assert.equal(fakeProcess.killCalls, 0);
  assert.equal(fakeProcess.unrefCalls, 1);
  assert.equal(fakeProcess.stdout.destroyCalls, 1);
  assert.equal(fakeProcess.stderr.destroyCalls, 1);
});
