import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type SetupPathEnvironment } from "./paths";

const TRUSTED_WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\Windows$/i;
const LEGACY_SCRIPT_NAMES = [
  "Start-CodexLark.ps1",
  "Repair-CodexLark.ps1",
  "Install-CodexLark-Autostart.ps1",
  "Uninstall-CodexLark-Autostart.ps1"
] as const;
const LEGACY_REPO_MARKER_NAMES = [...LEGACY_SCRIPT_NAMES, "run-admin-task.ps1"] as const;
const LEGACY_TARGET_SCRIPT_NAME_PATTERN = /^(Start-CodexLark\.ps1|Repair-CodexLark\.ps1|Install-CodexLark-Autostart\.ps1|Uninstall-CodexLark-Autostart\.ps1|run-admin-task\.ps1|Install-CodexLark\.ps1)$/i;
const LEGACY_TARGET_SCRIPT_PATH_PATTERN =
  /[A-Za-z]:\\[^"\r\n]*(?:Start-CodexLark\.ps1|Repair-CodexLark\.ps1|Install-CodexLark-Autostart\.ps1|Uninstall-CodexLark-Autostart\.ps1|run-admin-task\.ps1|Install-CodexLark\.ps1)/giu;
const DEFAULT_REPO_SEARCH_DEPTH = 4;
const REPO_SEARCH_SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "out",
  "coverage",
  ".next",
  "bin",
  "obj",
  "AppData",
  ".worktrees"
]);

export const LEGACY_ENV_VAR_NAMES = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "CODEX_CLI_EXE",
  "COMMUNICATE_FEISHU_DEBUG"
] as const;

export type LegacyEnvVarName = (typeof LEGACY_ENV_VAR_NAMES)[number];
export type LegacyStateRootKind = "artifacts" | "logs" | "registry" | "state";

export type LegacyEnvVarArtifact = {
  name: LegacyEnvVarName;
  value: string;
};

export type LegacyScriptArtifact = {
  name: (typeof LEGACY_SCRIPT_NAMES)[number];
  path: string;
  repoRoot: string;
};

export type LegacyShortcutRecord = {
  path: string;
  targetPath?: string;
  arguments?: string;
};

export type LegacyTaskRecord = {
  taskName: string;
  taskPath?: string;
  execute?: string;
  arguments?: string;
};

export type LegacyStateRootArtifact = {
  kind: LegacyStateRootKind;
  path: string;
  repoRoot: string;
};

export type LegacyScanResult = {
  envVars: LegacyEnvVarArtifact[];
  scripts: LegacyScriptArtifact[];
  shortcuts: LegacyShortcutRecord[];
  tasks: LegacyTaskRecord[];
  stateRoots: LegacyStateRootArtifact[];
  warnings: string[];
  repoRoots: string[];
  hasLegacyArtifacts: boolean;
};

export type LegacyTaskScanProbe = {
  items: LegacyTaskRecord[];
  warnings: string[];
};

export type LegacyScanOptions = {
  env?: NodeJS.ProcessEnv;
  repoRoots?: string[];
  searchRoots?: string[];
  maxSearchDepth?: number;
  listShortcuts?: (env?: NodeJS.ProcessEnv) => LegacyShortcutRecord[];
  listScheduledTasks?: (env?: NodeJS.ProcessEnv) => LegacyTaskRecord[] | LegacyTaskScanProbe;
  pathExists?: (candidatePath: string, kind: "file" | "directory") => boolean;
};

const NON_BLOCKING_LEGACY_WARNING_PATTERNS = [/^Legacy scheduled task scan was partial:/i];

function readEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function shouldTrackLegacyEnvVar(name: LegacyEnvVarName, value: string): boolean {
  if (!value) return false;
  if (name === "CODEX_CLI_EXE") {
    const normalized = value.toLowerCase();
    return normalized !== "codex" && normalized !== "codex.cmd";
  }
  if (name === "COMMUNICATE_FEISHU_DEBUG") {
    return value === "1";
  }
  return true;
}

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

function resolveTrustedWindowsRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const directRoots = [readEnvValue("SystemRoot", env), readEnvValue("WINDIR", env)].filter((value) =>
    TRUSTED_WINDOWS_ROOT_PATTERN.test(value)
  );
  const systemDrive = readEnvValue("SystemDrive", env);
  const systemDriveRoot = /^[A-Za-z]:$/i.test(systemDrive) ? `${systemDrive}\\Windows` : "";
  return [...new Set([...directRoots, systemDriveRoot, "C:\\Windows"].filter(Boolean))];
}

function resolveWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const roots = resolveTrustedWindowsRoots(env);
  for (const root of roots) {
    const candidate = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (isExistingPath(candidate, "file")) {
      return candidate;
    }
  }
  return path.win32.join(roots[0] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function isExistingPath(candidatePath: string, kind: "file" | "directory"): boolean {
  try {
    const stats = fs.statSync(candidatePath);
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
}

function parsePowerShellJsonArray<T>(raw: string): T[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as T[];
  }
  return [parsed as T];
}

function normalizeLegacyTaskScanProbe(result: LegacyTaskRecord[] | LegacyTaskScanProbe): LegacyTaskScanProbe {
  if (Array.isArray(result)) {
    return {
      items: result,
      warnings: []
    };
  }

  return {
    items: Array.isArray(result.items) ? result.items : [],
    warnings: Array.isArray(result.warnings)
      ? result.warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
      : []
  };
}

export function normalizeWindowsPath(candidatePath: string): string {
  return path.win32.normalize(candidatePath.trim());
}

export function isBlockingLegacyWarning(warning: string): boolean {
  const normalized = warning.trim();
  if (!normalized) {
    return false;
  }

  return !NON_BLOCKING_LEGACY_WARNING_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasBlockingLegacyWarnings(warnings: string[]): boolean {
  return warnings.some((warning) => isBlockingLegacyWarning(warning));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function shouldSkipRepoSearchDirectory(directoryName: string): boolean {
  return REPO_SEARCH_SKIP_DIR_NAMES.has(directoryName) || directoryName.startsWith(".");
}

export function extractLegacyScriptPaths(...segments: Array<string | undefined>): string[] {
  const collected: string[] = [];

  for (const segment of segments) {
    const trimmed = typeof segment === "string" ? segment.trim() : "";
    if (!trimmed) continue;

    if (LEGACY_TARGET_SCRIPT_NAME_PATTERN.test(path.win32.basename(trimmed))) {
      collected.push(normalizeWindowsPath(trimmed));
    }

    const matches = trimmed.match(LEGACY_TARGET_SCRIPT_PATH_PATTERN);
    if (matches) {
      for (const match of matches) {
        collected.push(normalizeWindowsPath(match));
      }
    }
  }

  return uniqueStrings(collected);
}

function resolveDesktopRoots(env: NodeJS.ProcessEnv): string[] {
  const userProfile = resolveCommandEnv(env).USERPROFILE?.trim() || path.win32.join("C:\\Users", "Default");
  const appData = readEnvValue("APPDATA", env) || path.win32.join(userProfile, "AppData", "Roaming");
  const publicProfile = readEnvValue("PUBLIC", env) || path.win32.join("C:\\Users", "Public");
  const programData = readEnvValue("ProgramData", env) || "C:\\ProgramData";

  return uniqueStrings([
    path.win32.join(userProfile, "Desktop"),
    path.win32.join(publicProfile, "Desktop"),
    path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.win32.join(programData, "Microsoft", "Windows", "Start Menu", "Programs")
  ]);
}

function resolveDefaultSearchRoots(env: NodeJS.ProcessEnv): string[] {
  const userProfile = resolveCommandEnv(env).USERPROFILE?.trim() ?? "";
  const roots = uniqueStrings([
    process.cwd(),
    userProfile,
    userProfile ? path.win32.join(userProfile, "Desktop") : "",
    userProfile ? path.win32.join(userProfile, "Documents") : "",
    userProfile ? path.win32.join(userProfile, "Downloads") : "",
    userProfile ? path.win32.join(userProfile, "source") : ""
  ]);

  return roots.filter((entry) => isExistingPath(entry, "directory"));
}

export function buildWindowsShortcutScanCommand(shortcutRoots: string[]): string {
  const rootLiteral = shortcutRoots.map((entry) => `'${escapePowerShellSingleQuoted(entry)}'`).join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$roots = @(${rootLiteral}) | Where-Object { Test-Path -LiteralPath $_ }`,
    "if ($roots.Count -eq 0) { Write-Output '[]'; exit 0 }",
    "$shell = New-Object -ComObject WScript.Shell",
    "$items = foreach ($root in $roots) {",
    "  Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {",
    "    $shortcut = $shell.CreateShortcut($_.FullName)",
    "    [pscustomobject]@{",
    "      path = $_.FullName",
    "      targetPath = [string]$shortcut.TargetPath",
    "      arguments = [string]$shortcut.Arguments",
    "    }",
    "  }",
    "}",
    "@($items) | ConvertTo-Json -Compress -Depth 4"
  ].join("\r\n");
}

function listWindowsShortcuts(env: NodeJS.ProcessEnv = process.env): LegacyShortcutRecord[] {
  if (process.platform !== "win32") {
    return [];
  }

  const shortcutRoots = resolveDesktopRoots(env);
  if (shortcutRoots.length === 0) {
    return [];
  }

  const command = buildWindowsShortcutScanCommand(shortcutRoots);

  const output = execFileSync(
    resolveWindowsPowerShellPath(env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      env,
      timeout: 15000,
      windowsHide: true
    }
  );

  return parsePowerShellJsonArray<LegacyShortcutRecord>(output).map((entry) => ({
    path: normalizeWindowsPath(String(entry.path ?? "")),
    targetPath: typeof entry.targetPath === "string" ? normalizeWindowsPath(entry.targetPath) : undefined,
    arguments: typeof entry.arguments === "string" ? entry.arguments.trim() : undefined
  }));
}

export function buildWindowsScheduledTaskScanCommand(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$taskErrors = @()",
    "$items = Get-ScheduledTask -ErrorAction SilentlyContinue -ErrorVariable taskErrors | ForEach-Object {",
    "  $task = $_",
    "  foreach ($action in @($task.Actions)) {",
    "    [pscustomobject]@{",
    "      taskName = [string]$task.TaskName",
    "      taskPath = [string]$task.TaskPath",
    "      execute = [string]$action.Execute",
    "      arguments = [string]$action.Arguments",
    "    }",
    "  }",
    "}",
    "$unexpectedErrors = @($taskErrors | Where-Object {",
    "  $message = [string]$_.Exception.Message",
    "  -not ($message -match '0x80041003' -or $message -match 'access.+denied' -or $message -match '拒绝访问' -or $message -match '权限')",
    "})",
    "if ($unexpectedErrors.Count -gt 0) {",
    "  throw $unexpectedErrors[0]",
    "}",
    "$warnings = @()",
    "if ($taskErrors.Count -gt 0) {",
    "  $warnings += 'Legacy scheduled task scan was partial: access denied while enumerating one or more scheduled tasks.'",
    "}",
    "[pscustomobject]@{",
    "  items = @($items)",
    "  warnings = @($warnings)",
    "} | ConvertTo-Json -Compress -Depth 5"
  ].join("\r\n");
}

function listWindowsScheduledTasks(env: NodeJS.ProcessEnv = process.env): LegacyTaskScanProbe {
  if (process.platform !== "win32") {
    return {
      items: [],
      warnings: []
    };
  }

  const command = buildWindowsScheduledTaskScanCommand();

  const output = execFileSync(
    resolveWindowsPowerShellPath(env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      env,
      timeout: 15000,
      windowsHide: true
    }
  );

  const trimmed = output.trim();
  const payload = normalizeLegacyTaskScanProbe(
    trimmed ? (JSON.parse(trimmed) as LegacyTaskRecord[] | LegacyTaskScanProbe) : ([] as LegacyTaskRecord[])
  );

  return {
    items: payload.items.map((entry) => ({
      taskName: String(entry.taskName ?? "").trim(),
      taskPath: typeof entry.taskPath === "string" ? entry.taskPath.trim() : undefined,
      execute: typeof entry.execute === "string" ? entry.execute.trim() : undefined,
      arguments: typeof entry.arguments === "string" ? entry.arguments.trim() : undefined
    })),
    warnings: payload.warnings
  };
}

function filterLegacyShortcutTargets(records: LegacyShortcutRecord[]): LegacyShortcutRecord[] {
  return records.filter((entry) => extractLegacyScriptPaths(entry.targetPath, entry.arguments).length > 0);
}

function filterLegacyTaskTargets(records: LegacyTaskRecord[]): LegacyTaskRecord[] {
  return records.filter((entry) => extractLegacyScriptPaths(entry.execute, entry.arguments).length > 0);
}

function hasLegacyRepoMarkers(
  repoRoot: string,
  pathExists: (candidatePath: string, kind: "file" | "directory") => boolean
): boolean {
  return LEGACY_REPO_MARKER_NAMES.some((fileName) => pathExists(path.win32.join(repoRoot, fileName), "file"));
}

function discoverLegacyRepoRoots(
  searchRoots: string[],
  maxDepth: number,
  pathExists: (candidatePath: string, kind: "file" | "directory") => boolean
): string[] {
  const discovered = new Set<string>();
  const visited = new Set<string>();
  const queue = searchRoots
    .map((entry) => normalizeWindowsPath(entry))
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ path: entry, depth: 0 }));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (visited.has(current.path)) continue;
    visited.add(current.path);

    if (!pathExists(current.path, "directory")) {
      continue;
    }

    if (hasLegacyRepoMarkers(current.path, pathExists)) {
      discovered.add(current.path);
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipRepoSearchDirectory(entry.name)) continue;
      queue.push({
        path: path.win32.join(current.path, entry.name),
        depth: current.depth + 1
      });
    }
  }

  return [...discovered];
}

function collectLegacyRepoRoots(
  explicitRepoRoots: string[],
  discoveredRepoRoots: string[],
  shortcuts: LegacyShortcutRecord[],
  tasks: LegacyTaskRecord[]
): string[] {
  const derivedRepoRoots = [
    ...explicitRepoRoots,
    ...discoveredRepoRoots,
    ...shortcuts.flatMap((entry) => extractLegacyScriptPaths(entry.targetPath, entry.arguments).map((filePath) => path.win32.dirname(filePath))),
    ...tasks.flatMap((entry) => extractLegacyScriptPaths(entry.execute, entry.arguments).map((filePath) => path.win32.dirname(filePath)))
  ].map((entry) => normalizeWindowsPath(entry));

  return uniqueStrings(derivedRepoRoots);
}

function detectLegacyScripts(
  repoRoots: string[],
  pathExists: (candidatePath: string, kind: "file" | "directory") => boolean
): LegacyScriptArtifact[] {
  const scripts: LegacyScriptArtifact[] = [];

  for (const repoRoot of repoRoots) {
    for (const scriptName of LEGACY_SCRIPT_NAMES) {
      const scriptPath = path.win32.join(repoRoot, scriptName);
      if (pathExists(scriptPath, "file")) {
        scripts.push({
          name: scriptName,
          path: scriptPath,
          repoRoot
        });
      }
    }
  }

  return scripts;
}

function detectLegacyStateRoots(
  repoRoots: string[],
  pathExists: (candidatePath: string, kind: "file" | "directory") => boolean
): LegacyStateRootArtifact[] {
  const stateRoots: LegacyStateRootArtifact[] = [];

  for (const repoRoot of repoRoots) {
    const candidates: Array<{ kind: LegacyStateRootKind; path: string }> = [
      {
        kind: "artifacts",
        path: path.win32.join(repoRoot, "artifacts")
      },
      {
        kind: "logs",
        path: path.win32.join(repoRoot, "logs")
      },
      {
        kind: "registry",
        path: path.win32.join(repoRoot, "logs", "communicate", "registry.json")
      },
      {
        kind: "state",
        path: path.win32.join(repoRoot, "state")
      }
    ];

    for (const candidate of candidates) {
      const expectedKind = candidate.kind === "registry" ? "file" : "directory";
      if (pathExists(candidate.path, expectedKind)) {
        stateRoots.push({
          kind: candidate.kind,
          path: candidate.path,
          repoRoot
        });
      }
    }
  }

  return stateRoots;
}

export function scanLegacyArtifacts(options: LegacyScanOptions = {}): LegacyScanResult {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const pathExists = options.pathExists ?? isExistingPath;
  let shortcuts: LegacyShortcutRecord[] = [];
  let tasks: LegacyTaskRecord[] = [];
  const discoveredRepoRoots = discoverLegacyRepoRoots(
    options.searchRoots ?? resolveDefaultSearchRoots(env),
    options.maxSearchDepth ?? DEFAULT_REPO_SEARCH_DEPTH,
    pathExists
  );

  try {
    const listShortcuts = options.listShortcuts ?? listWindowsShortcuts;
    shortcuts = filterLegacyShortcutTargets(listShortcuts(env));
  } catch (error) {
    warnings.push(`Legacy shortcut scan failed: ${(error as Error).message}`);
  }

  try {
    const listScheduledTasks = options.listScheduledTasks ?? listWindowsScheduledTasks;
    const taskProbe = normalizeLegacyTaskScanProbe(listScheduledTasks(env) as LegacyTaskRecord[] | LegacyTaskScanProbe);
    tasks = filterLegacyTaskTargets(taskProbe.items);
    warnings.push(...taskProbe.warnings);
  } catch (error) {
    warnings.push(`Legacy scheduled task scan failed: ${(error as Error).message}`);
  }

  const repoRoots = collectLegacyRepoRoots(options.repoRoots ?? [], discoveredRepoRoots, shortcuts, tasks);
  const scripts = detectLegacyScripts(repoRoots, pathExists);
  const stateRoots = detectLegacyStateRoots(repoRoots, pathExists);
  const envVars = LEGACY_ENV_VAR_NAMES.flatMap((name) => {
    const value = readEnvValue(name, env);
    return shouldTrackLegacyEnvVar(name, value) ? [{ name, value }] : [];
  });

  return {
    envVars,
    scripts,
    shortcuts,
    tasks,
    stateRoots,
    warnings,
    repoRoots,
    hasLegacyArtifacts:
      envVars.length > 0 ||
      scripts.length > 0 ||
      shortcuts.length > 0 ||
      tasks.length > 0 ||
      stateRoots.length > 0
  };
}
