import fs from "node:fs";
import path from "node:path";

import { writeJson } from "../util/fs";
import { readSetupSettings, writeSetupSettings } from "./config-store";
import { resolveCanonicalLauncherRoute } from "./launcher";
import { readRuntimeManifest, type RuntimeManifest } from "./runtime-manifest";
import {
  LEGACY_ENV_VAR_NAMES,
  scanLegacyArtifacts,
  type LegacyEnvVarName,
  extractLegacyScriptPaths,
  normalizeWindowsPath,
  type LegacyScanOptions,
  type LegacyScanResult
} from "./legacy-scan";
import { resolveSetupPaths, type SetupPathEnvironment } from "./paths";
import { redactSetupSecretsForOutput } from "./redaction";
import { hasStoredSecretRecord, storeSetupSecret } from "./secret-store";
import { SetupSchemaVersion } from "./types";

export type LegacyMigrationFailureCategory = "secret-store-failed";

export type LegacyMigrationState = {
  schemaVersion: typeof SetupSchemaVersion;
  handledEnvNames: LegacyEnvVarName[];
  completedAt?: string;
};

export type LegacyMigrationResult = {
  importedConfig: string[];
  disabledLegacyArtifacts: string[];
  retainedLegacyArtifacts: string[];
  warnings: string[];
  statePath: string;
  state: LegacyMigrationState;
  scan: LegacyScanResult;
  failureCategory?: LegacyMigrationFailureCategory;
};

export type LegacyMigrationOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  scanOptions?: Omit<LegacyScanOptions, "env">;
  readSettings?: typeof readSetupSettings;
  writeSettings?: typeof writeSetupSettings;
  storeSecret?: typeof storeSetupSecret;
  hasStoredSecretRecord?: typeof hasStoredSecretRecord;
};

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

function createDefaultMigrationState(): LegacyMigrationState {
  return {
    schemaVersion: SetupSchemaVersion,
    handledEnvNames: []
  };
}

function uniqueEnvNames(values: string[]): LegacyEnvVarName[] {
  return [...new Set(values)]
    .filter((value): value is LegacyEnvVarName =>
      LEGACY_ENV_VAR_NAMES.includes(value as LegacyEnvVarName)
    )
    .sort();
}

function legacyEnvArtifactId(name: string): string {
  return `env:${name}`;
}

function markHandledLegacyEnvArtifact(
  artifacts: string[],
  name: LegacyEnvVarName,
  detail: string
): void {
  artifacts.push(`${legacyEnvArtifactId(name)} (${detail})`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function getLegacyMigrationStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  return path.win32.join(paths.stateRoot, "legacy-migration.json");
}

export function readLegacyMigrationState(env: NodeJS.ProcessEnv = process.env): LegacyMigrationState {
  const statePath = getLegacyMigrationStatePath(env);
  if (!fs.existsSync(statePath)) {
    return createDefaultMigrationState();
  }

  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  return {
    schemaVersion: SetupSchemaVersion,
    handledEnvNames: isStringArray(parsed.handledEnvNames) ? uniqueEnvNames(parsed.handledEnvNames) : [],
    completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined
  };
}

function loadLegacyMigrationState(env: NodeJS.ProcessEnv): {
  state: LegacyMigrationState;
  warnings: string[];
} {
  try {
    return {
      state: readLegacyMigrationState(env),
      warnings: []
    };
  } catch (error) {
    return {
      state: createDefaultMigrationState(),
      warnings: [`Legacy migration state could not be read and was reset: ${(error as Error).message}`]
    };
  }
}


type CanonicalLauncherAllowlist = {
  scriptPaths: Set<string>;
  launcherRoutePaths: Set<string>;
  taskScriptPaths: Set<string>;
  existingScriptPaths: Set<string>;
};

function normalizePathKey(candidatePath: string | undefined): string {
  return candidatePath ? normalizeWindowsPath(candidatePath).toLowerCase() : "";
}

function tryLoadCanonicalLauncherAllowlist(env: NodeJS.ProcessEnv): CanonicalLauncherAllowlist | undefined {
  try {
    const launch = resolveCanonicalLauncherRoute("launch", env);
    const repair = resolveCanonicalLauncherRoute("repair", env);
    const configureAutostart = resolveCanonicalLauncherRoute("configure-autostart", env);
    const manifest = readRuntimeManifest(launch.manifestPath);
    const installRoot = normalizeWindowsPath(manifest.installRoot);
    const manifestScriptPaths = [
      manifest.launcherPath,
      manifest.bridgeScriptPaths.installAutostart,
      manifest.bridgeScriptPaths.uninstallAutostart
    ];
    const repairScriptPath = path.win32.join(installRoot, "Repair-CodexLark.ps1");
    const scriptPathCandidates = [
      ...manifestScriptPaths,
      launch.path,
      repair.path,
      configureAutostart.path,
      repairScriptPath
    ];
    const scriptPaths = new Set(scriptPathCandidates.map(normalizePathKey));
    const launcherRoutePaths = new Set([launch.path, repair.path].map(normalizePathKey));
    const taskScriptPaths = new Set(
      [manifest.bridgeScriptPaths.installAutostart, manifest.bridgeScriptPaths.uninstallAutostart].map(normalizePathKey)
    );
    const existingScriptPaths = new Set(
      scriptPathCandidates.filter((scriptPath) => fs.existsSync(scriptPath)).map(normalizePathKey)
    );

    return { scriptPaths, launcherRoutePaths, taskScriptPaths, existingScriptPaths };
  } catch {
    return undefined;
  }
}

function isCanonicalScriptArtifact(
  artifact: LegacyScanResult["scripts"][number],
  allowlist: CanonicalLauncherAllowlist | undefined
): boolean {
  return Boolean(allowlist?.scriptPaths.has(normalizePathKey(artifact.path)));
}

function isCanonicalShortcutArtifact(
  artifact: LegacyScanResult["shortcuts"][number],
  allowlist: CanonicalLauncherAllowlist | undefined
): boolean {
  if (!allowlist) return false;
  const targetPathKey = normalizePathKey(artifact.targetPath);
  if (targetPathKey && allowlist.launcherRoutePaths.has(targetPathKey) && allowlist.existingScriptPaths.has(targetPathKey)) {
    return true;
  }

  const scriptPathKeys = extractLegacyScriptPaths(artifact.targetPath, artifact.arguments).map(normalizePathKey);
  return (
    scriptPathKeys.length > 0 &&
    scriptPathKeys.every(
      (scriptPathKey) => allowlist.launcherRoutePaths.has(scriptPathKey) && allowlist.existingScriptPaths.has(scriptPathKey)
    )
  );
}

function isCanonicalTaskArtifact(
  artifact: LegacyScanResult["tasks"][number],
  allowlist: CanonicalLauncherAllowlist | undefined
): boolean {
  if (!allowlist) return false;
  const scriptPathKeys = extractLegacyScriptPaths(artifact.execute, artifact.arguments).map(normalizePathKey);
  return (
    scriptPathKeys.length > 0 &&
    scriptPathKeys.every(
      (scriptPathKey) => allowlist.taskScriptPaths.has(scriptPathKey) && allowlist.existingScriptPaths.has(scriptPathKey)
    )
  );
}
function buildTaskArtifactId(task: LegacyScanResult["tasks"][number]): string {
  const taskScope = task.taskPath?.trim() || "\\";
  return `task:${taskScope}${task.taskName}`;
}

export async function runLegacyMigration(options: LegacyMigrationOptions = {}): Promise<LegacyMigrationResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const readSettingsImpl = options.readSettings ?? readSetupSettings;
  const writeSettingsImpl = options.writeSettings ?? writeSetupSettings;
  const storeSecretImpl = options.storeSecret ?? storeSetupSecret;
  const hasStoredSecretRecordImpl = options.hasStoredSecretRecord ?? hasStoredSecretRecord;
  const scan = scanLegacyArtifacts({
    env,
    ...(options.scanOptions ?? {})
  });
  const loadedState = loadLegacyMigrationState(env);
  const warnings = [...loadedState.warnings, ...scan.warnings];
  const canonicalAllowlist = tryLoadCanonicalLauncherAllowlist(env);
  const importedConfig: string[] = [];
  const disabledLegacyArtifacts: string[] = [];
  const retainedLegacyArtifacts: string[] = [
    ...scan.scripts.filter((entry) => !isCanonicalScriptArtifact(entry, canonicalAllowlist)).map((entry) => `script:${entry.path}`),
    ...scan.shortcuts.filter((entry) => !isCanonicalShortcutArtifact(entry, canonicalAllowlist)).map((entry) => `shortcut:${entry.path}`),
    ...scan.tasks.filter((entry) => !isCanonicalTaskArtifact(entry, canonicalAllowlist)).map((entry) => buildTaskArtifactId(entry)),
    ...scan.stateRoots.map((entry) => `state-root:${entry.path}`)
  ];
  const handledEnvNames = new Set<LegacyEnvVarName>(loadedState.state.handledEnvNames);
  let failureCategory: LegacyMigrationFailureCategory | undefined;
  let settings = readSettingsImpl(env);

  const legacyAppId = scan.envVars.find((entry) => entry.name === "FEISHU_APP_ID");
  if (legacyAppId) {
    if (handledEnvNames.has("FEISHU_APP_ID")) {
      warnings.push("Legacy FEISHU_APP_ID is still set, but canonical setup settings now take precedence and the value is ignored.");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "FEISHU_APP_ID", "ignored because canonical settings take precedence");
    } else if (settings.feishuAppId) {
      handledEnvNames.add("FEISHU_APP_ID");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "FEISHU_APP_ID", "canonical settings already exist");
    } else {
      settings = writeSettingsImpl(
        {
          feishuAppId: legacyAppId.value
        },
        env
      );
      handledEnvNames.add("FEISHU_APP_ID");
      importedConfig.push("feishuAppId");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "FEISHU_APP_ID", "imported into canonical settings");
    }
  }

  const legacySecret = scan.envVars.find((entry) => entry.name === "FEISHU_APP_SECRET");
  if (legacySecret) {
    const hasCanonicalSecret = hasStoredSecretRecordImpl(settings.feishuAppSecretRef, { env });

    if (handledEnvNames.has("FEISHU_APP_SECRET")) {
      warnings.push("Legacy FEISHU_APP_SECRET is still set, but secure canonical storage already takes precedence and the value is ignored.");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "FEISHU_APP_SECRET", "ignored because secure canonical storage takes precedence");
    } else if (hasCanonicalSecret) {
      handledEnvNames.add("FEISHU_APP_SECRET");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "FEISHU_APP_SECRET", "secure canonical secret already exists");
    } else {
      try {
        const storedSecret = await storeSecretImpl(
          {
            name: "feishu-app-secret",
            value: legacySecret.value
          },
          { env }
        );
        settings = writeSettingsImpl(
          {
            feishuAppSecretRef: storedSecret.reference
          },
          env
        );
        handledEnvNames.add("FEISHU_APP_SECRET");
        importedConfig.push("feishuAppSecret");
        markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "FEISHU_APP_SECRET", "imported into secure canonical storage");
      } catch (error) {
        failureCategory = "secret-store-failed";
        warnings.push(`Legacy FEISHU_APP_SECRET could not be imported into secure storage: ${(error as Error).message}`);
        retainedLegacyArtifacts.push(legacyEnvArtifactId("FEISHU_APP_SECRET"));
      }
    }
  }

  for (const envArtifact of scan.envVars) {
    if (envArtifact.name === "FEISHU_APP_ID" || envArtifact.name === "FEISHU_APP_SECRET") {
      continue;
    }

    if (envArtifact.name === "CODEX_CLI_EXE") {
      if (handledEnvNames.has("CODEX_CLI_EXE")) {
        warnings.push("Legacy CODEX_CLI_EXE is still set, but canonical Codex CLI settings now take precedence and the env value is ignored.");
        markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "CODEX_CLI_EXE", "ignored because canonical Codex CLI settings take precedence");
        continue;
      }

      if (settings.codexCliPath) {
        handledEnvNames.add("CODEX_CLI_EXE");
        markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "CODEX_CLI_EXE", "canonical Codex CLI path already exists");
        continue;
      }

      settings = writeSettingsImpl(
        {
          codexCliPath: envArtifact.value
        },
        env
      );
      handledEnvNames.add("CODEX_CLI_EXE");
      importedConfig.push("codexCliPath");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "CODEX_CLI_EXE", "imported into canonical Codex CLI settings");
      continue;
    }

    if (envArtifact.name === "COMMUNICATE_FEISHU_DEBUG") {
      handledEnvNames.add("COMMUNICATE_FEISHU_DEBUG");
      warnings.push("Legacy COMMUNICATE_FEISHU_DEBUG remains set, but the product flow no longer depends on this env var.");
      markHandledLegacyEnvArtifact(disabledLegacyArtifacts, "COMMUNICATE_FEISHU_DEBUG", "left in env but treated as informational only");
      continue;
    }

    warnings.push(`Legacy ${envArtifact.name} is still env-backed and requires manual cleanup until canonical setup storage lands for it.`);
    retainedLegacyArtifacts.push(legacyEnvArtifactId(envArtifact.name));
  }

  const nextState: LegacyMigrationState = {
    schemaVersion: SetupSchemaVersion,
    handledEnvNames: uniqueEnvNames([...handledEnvNames]),
    completedAt: now().toISOString()
  };
  const statePath = getLegacyMigrationStatePath(env);
  writeJson(statePath, nextState);

  const result: LegacyMigrationResult = {
    importedConfig,
    disabledLegacyArtifacts,
    retainedLegacyArtifacts: [...new Set(retainedLegacyArtifacts)],
    warnings,
    statePath,
    state: nextState,
    scan
  };
  if (failureCategory) {
    result.failureCategory = failureCategory;
  }

  return redactSetupSecretsForOutput(result);
}
