import path from "node:path";

import { writeJson } from "../../util/fs";
import { inspectCodexCliDependency, type CodexDependencyResult } from "../codex-dependency";
import { readSetupSettings } from "../config-store";
import { ensureSourceRuntimeManifest } from "../launcher";
import { hasBlockingLegacyWarnings } from "../legacy-scan";
import { runLegacyMigration, type LegacyMigrationResult } from "../legacy-migration";
import { resolveSetupPaths, type SetupPathEnvironment } from "../paths";
import { redactSetupSecretsForOutput } from "../redaction";
import { hasStoredSecretRecord } from "../secret-store";
import { SetupSchemaVersion } from "../types";
import type { SetupCommandContext, SetupCommandResult, SetupCommandStatus } from "../index";

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

export type FirstRunCommandResult = SetupCommandResult<"first-run", {
  codex: CodexDependencyResult;
  configuration: {
    feishuAppIdConfigured: boolean;
    feishuAppSecretStored: boolean;
    failureCategory?: "secret-store-failed";
  };
  legacyMigration: LegacyMigrationResult;
}>;

function isCodexDependencyReady(codex: CodexDependencyResult): boolean {
  return codex.present && Boolean(codex.version) && codex.loginDetected && codex.failureCategory == null;
}

function isFirstRunReady(
  codex: CodexDependencyResult,
  configuration: FirstRunCommandResult["configuration"],
  legacyMigration: LegacyMigrationResult
): boolean {
  return (
    isCodexDependencyReady(codex) &&
    configuration.failureCategory == null &&
    !hasBlockingLegacyArtifacts(legacyMigration) &&
    !hasBlockingLegacyScanWarnings(legacyMigration)
  );
}

function resolveFirstRunStatus(
  codex: CodexDependencyResult,
  configuration: FirstRunCommandResult["configuration"],
  legacyMigration: LegacyMigrationResult
): SetupCommandStatus {
  return isFirstRunReady(codex, configuration, legacyMigration) ? "ready" : "action-required";
}

function hasBlockingLegacyArtifacts(legacyMigration: LegacyMigrationResult): boolean {
  return legacyMigration.retainedLegacyArtifacts.some((entry) =>
    entry.startsWith("script:") || entry.startsWith("shortcut:") || entry.startsWith("task:")
  );
}

function hasBlockingLegacyScanWarnings(legacyMigration: LegacyMigrationResult): boolean {
  return hasBlockingLegacyWarnings(legacyMigration.scan.warnings);
}

function hasOnlyNonBlockingLegacyScanWarnings(legacyMigration: LegacyMigrationResult): boolean {
  return legacyMigration.scan.warnings.length > 0 && !hasBlockingLegacyScanWarnings(legacyMigration);
}

function formatFirstRunMessage(
  codex: CodexDependencyResult,
  configuration: FirstRunCommandResult["configuration"],
  legacyMigration: LegacyMigrationResult
): string {
  if (configuration.failureCategory === "secret-store-failed") {
    return "Feishu App Secret could not be stored securely.";
  }
  switch (codex.failureCategory) {
    case "install-failed":
      return "Codex CLI is installed but unhealthy. Launch CodexLark will guide the operator to repair it.";
    case "unsupported-version":
      return codex.version
        ? `Codex CLI version ${codex.version} is blocked by the current version policy.`
        : "Codex CLI version could not be verified.";
    case "login-missing":
      return "Codex CLI is installed, but no login marker was detected.";
    case "missing":
      return "Codex CLI is missing. Launch CodexLark will guide the operator to install or configure it.";
    default:
      if (hasBlockingLegacyArtifacts(legacyMigration)) {
        return "Legacy CodexLark launchers or scheduled tasks were detected. Review the migration summary before continuing.";
      }
      if (hasBlockingLegacyScanWarnings(legacyMigration)) {
        return "Legacy CodexLark scanning could not complete. Review the migration summary before continuing.";
      }
      if (hasOnlyNonBlockingLegacyScanWarnings(legacyMigration)) {
        return "Codex CLI dependency is ready. Some legacy scheduled tasks could not be inspected, but setup can continue.";
      }
      return "Codex CLI dependency is ready for first-run.";
  }
}

function inspectConfiguredFeishuCredentials(
  env: NodeJS.ProcessEnv = process.env
): FirstRunCommandResult["configuration"] {
  const settings = readSetupSettings(env);
  const result: FirstRunCommandResult["configuration"] = {
    feishuAppIdConfigured: Boolean(settings.feishuAppId),
    feishuAppSecretStored: hasStoredSecretRecord(settings.feishuAppSecretRef, { env })
  };

  return result;
}

async function createResult(env: NodeJS.ProcessEnv | undefined): Promise<FirstRunCommandResult> {
  const effectiveEnv = env ?? process.env;
  ensureSourceRuntimeManifest(process.cwd(), effectiveEnv);
  const legacyMigration = await runLegacyMigration({
    env: effectiveEnv,
    scanOptions: {
      repoRoots: [process.cwd()]
    }
  });
  const configuration = inspectConfiguredFeishuCredentials(effectiveEnv);
  if (legacyMigration.failureCategory === "secret-store-failed") {
    configuration.failureCategory = "secret-store-failed";
  }
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const codex = await inspectCodexCliDependency({
    env,
    installWhenMissing: false
  });
  const summaryPath = path.win32.join(paths.artifactsRoot, "setup", "first-run-summary.json");
  const result: FirstRunCommandResult = {
    schemaVersion: SetupSchemaVersion,
    verb: "first-run",
    ok: isFirstRunReady(codex, configuration, legacyMigration),
    status: resolveFirstRunStatus(codex, configuration, legacyMigration),
    message: formatFirstRunMessage(codex, configuration, legacyMigration),
    summaryPath,
    codex,
    configuration,
    legacyMigration
  };
  const safeResult = redactSetupSecretsForOutput(result);
  writeJson(summaryPath, safeResult);
  return safeResult;
}

export async function runFirstRunCommand(context: SetupCommandContext = {}): Promise<FirstRunCommandResult> {
  return await createResult(context.env);
}
