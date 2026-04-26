import path from "node:path";

import { writeJson } from "../util/fs";
import { readSetupSettings } from "./config-store";
import { resolveSetupPaths, type SetupPathEnvironment } from "./paths";
import { hasStoredSecretRecord } from "./secret-store";
import { SetupSchemaVersion } from "./types";

export type SetupDiagnosticsExport = {
  schemaVersion: typeof SetupSchemaVersion;
  generatedAt: string;
  paths: {
    configRoot: string;
    stateRoot: string;
    logsRoot: string;
    artifactsRoot: string;
  };
  settings: {
    feishuAppId?: string;
    feishuAppSecretConfigured: boolean;
  };
};

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

export function getSetupDiagnosticsPath(env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  return path.win32.join(paths.artifactsRoot, "diagnostics", "setup-diagnostics.json");
}

export function exportSetupDiagnostics(
  options: { env?: NodeJS.ProcessEnv; now?: () => Date } = {}
): { exportPath: string; payload: SetupDiagnosticsExport } {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const settings = readSetupSettings(env);
  const payload: SetupDiagnosticsExport = {
    schemaVersion: SetupSchemaVersion,
    generatedAt: now().toISOString(),
    paths: {
      configRoot: paths.configRoot,
      stateRoot: paths.stateRoot,
      logsRoot: paths.logsRoot,
      artifactsRoot: paths.artifactsRoot
    },
    settings: {
      feishuAppId: settings.feishuAppId,
      feishuAppSecretConfigured: hasStoredSecretRecord(settings.feishuAppSecretRef, { env })
    }
  };
  const exportPath = getSetupDiagnosticsPath(env);
  writeJson(exportPath, payload);
  return { exportPath, payload };
}
