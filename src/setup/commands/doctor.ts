import path from "node:path";

import { writeJson } from "../../util/fs";
import { inspectCodexCliDependency, type CodexDependencyResult } from "../codex-dependency";
import { resolveSetupPaths, type SetupPathEnvironment } from "../paths";
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

export type DoctorCommandResult = SetupCommandResult<"doctor", {
  codex: CodexDependencyResult;
}>;

function isCodexDependencyReady(codex: CodexDependencyResult): boolean {
  return codex.present && Boolean(codex.version) && codex.loginDetected && codex.failureCategory == null;
}

function resolveDoctorStatus(codex: CodexDependencyResult): SetupCommandStatus {
  return isCodexDependencyReady(codex) ? "ready" : "action-required";
}

function formatDoctorMessage(codex: CodexDependencyResult): string {
  switch (codex.failureCategory) {
    case "missing":
      return "Codex CLI could not be resolved.";
    case "install-failed":
      return "Codex CLI install state is unhealthy.";
    case "unsupported-version":
      return codex.version
        ? `Codex CLI version ${codex.version} is blocked by the current version policy.`
        : "Codex CLI version could not be verified.";
    case "login-missing":
      return "Codex CLI is present, but no login marker was detected.";
    default:
      return "Codex CLI dependency is healthy.";
  }
}

async function createResult(env: NodeJS.ProcessEnv | undefined): Promise<DoctorCommandResult> {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const codex = await inspectCodexCliDependency({
    env,
    installWhenMissing: false
  });
  const summaryPath = path.win32.join(paths.artifactsRoot, "setup", "doctor-summary.json");
  const result: DoctorCommandResult = {
    schemaVersion: SetupSchemaVersion,
    verb: "doctor",
    ok: isCodexDependencyReady(codex),
    status: resolveDoctorStatus(codex),
    message: formatDoctorMessage(codex),
    summaryPath,
    codex
  };
  writeJson(summaryPath, result);
  return result;
}

export async function runDoctorCommand(context: SetupCommandContext = {}): Promise<DoctorCommandResult> {
  return await createResult(context.env);
}
