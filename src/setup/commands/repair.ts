import path from "node:path";

import { writeJson } from "../../util/fs";
import {
  ensureSourceRuntimeManifest,
  resolveCanonicalLauncherRoute,
  type EnsuredLauncherManifest
} from "../launcher";
import { hasBlockingLegacyWarnings } from "../legacy-scan";
import { runLegacyMigration, type LegacyMigrationResult } from "../legacy-migration";
import { resolveSetupPaths, type SetupPathEnvironment } from "../paths";
import { redactSetupSecretsForOutput } from "../redaction";
import { SetupSchemaVersion } from "../types";
import type { SetupCommandContext, SetupCommandResult } from "../index";

export type RepairCommandResult = SetupCommandResult<"repair", {
  legacyMigration: LegacyMigrationResult;
  launcher: {
    manifestPath: string;
    manifestUpdated: boolean;
    routes: {
      launch: { path: string };
      repair: { path: string };
      configureAutostart: { path: string };
    };
  };
}>;

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

function hasBlockingLegacyArtifacts(legacyMigration: LegacyMigrationResult): boolean {
  return legacyMigration.retainedLegacyArtifacts.some((entry) =>
    entry.startsWith("script:") || entry.startsWith("shortcut:") || entry.startsWith("task:")
  );
}

function isRepairReady(legacyMigration: LegacyMigrationResult): boolean {
  return !hasBlockingLegacyArtifacts(legacyMigration) && !hasBlockingLegacyWarnings(legacyMigration.scan.warnings);
}

function formatRepairMessage(legacyMigration: LegacyMigrationResult): string {
  if (hasBlockingLegacyArtifacts(legacyMigration)) {
    return "Legacy CodexLark artifacts detected. Review the repair summary before continuing.";
  }

  if (legacyMigration.scan.warnings.length > 0) {
    if (!hasBlockingLegacyWarnings(legacyMigration.scan.warnings)) {
      return "No blocking legacy CodexLark artifacts detected. Some legacy scheduled tasks could not be inspected.";
    }
    return "Legacy CodexLark scanning could not complete. Review the repair summary before continuing.";
  }

  return isRepairReady(legacyMigration)
    ? "No legacy CodexLark artifacts detected."
    : "Legacy CodexLark artifacts detected. Review the repair summary before continuing.";
}

async function createResult(env: NodeJS.ProcessEnv | undefined): Promise<RepairCommandResult> {
  const effectiveEnv = env ?? process.env;
  const launcherManifest = ensureSourceRuntimeManifest(process.cwd(), effectiveEnv);
  const legacyMigration = await runLegacyMigration({
    env: effectiveEnv,
    scanOptions: {
      repoRoots: [process.cwd()]
    }
  });
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const summaryPath = path.win32.join(paths.artifactsRoot, "setup", "repair-summary.json");
  const result: RepairCommandResult = {
    schemaVersion: SetupSchemaVersion,
    verb: "repair",
    ok: isRepairReady(legacyMigration),
    status: isRepairReady(legacyMigration) ? "ready" : "action-required",
    message: formatRepairMessage(legacyMigration),
    summaryPath,
    legacyMigration,
    launcher: createLauncherSummary(launcherManifest, effectiveEnv)
  };
  const safeResult = redactSetupSecretsForOutput(result);
  writeJson(summaryPath, safeResult);
  return safeResult;
}

function createLauncherSummary(
  launcherManifest: EnsuredLauncherManifest,
  env: NodeJS.ProcessEnv
): RepairCommandResult["launcher"] {
  return {
    manifestPath: launcherManifest.manifestPath,
    manifestUpdated: launcherManifest.updated,
    routes: {
      launch: {
        path: resolveCanonicalLauncherRoute("launch", env).path
      },
      repair: {
        path: resolveCanonicalLauncherRoute("repair", env).path
      },
      configureAutostart: {
        path: resolveCanonicalLauncherRoute("configure-autostart", env).path
      }
    }
  };
}

export async function runRepairCommand(context: SetupCommandContext = {}): Promise<RepairCommandResult> {
  return await createResult(context.env);
}
