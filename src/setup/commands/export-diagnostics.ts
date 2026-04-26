import path from "node:path";

import { writeJson } from "../../util/fs";
import { exportSetupDiagnostics } from "../diagnostics";
import { resolveSetupPaths, type SetupPathEnvironment } from "../paths";
import { SetupSchemaVersion } from "../types";
import type { SetupCommandContext, SetupCommandResult } from "../index";

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

export type ExportDiagnosticsCommandResult = SetupCommandResult<"export-diagnostics", { exportPath: string }>;

function createResult(env: NodeJS.ProcessEnv | undefined): ExportDiagnosticsCommandResult {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const { exportPath } = exportSetupDiagnostics({ env });
  const summaryPath = path.win32.join(paths.artifactsRoot, "setup", "export-diagnostics-summary.json");
  const result: ExportDiagnosticsCommandResult = {
    schemaVersion: SetupSchemaVersion,
    verb: "export-diagnostics",
    ok: true,
    status: "ready",
    message: "Setup diagnostics exported with redaction.",
    summaryPath,
    exportPath
  };
  writeJson(summaryPath, result);
  return result;
}

export async function runExportDiagnosticsCommand(context: SetupCommandContext = {}): Promise<ExportDiagnosticsCommandResult> {
  return createResult(context.env);
}
