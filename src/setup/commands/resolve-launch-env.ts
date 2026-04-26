import path from "node:path";

import { writeJson } from "../../util/fs";
import { resolveSetupPaths, type SetupPathEnvironment } from "../paths";
import { redactSetupSecretsForOutput } from "../redaction";
import { resolveLaunchEnvironment } from "../runtime-context";
import { SetupSchemaVersion } from "../types";
import type { SetupCommandContext, SetupCommandResult } from "../index";

export type ResolveLaunchEnvCommandResult = SetupCommandResult<
  "resolve-launch-env",
  {
    failureCategory?: string;
    runtimeEnv?: {
      FEISHU_APP_ID: string;
      CODEX_CLI_EXE: string;
    };
    feishuAppSecretConfigured?: boolean;
  }
>;

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

async function createResult(env: NodeJS.ProcessEnv | undefined): Promise<ResolveLaunchEnvCommandResult> {
  const effectiveEnv = env ?? process.env;
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  const launchEnvironment = await resolveLaunchEnvironment({
    env: effectiveEnv,
    // This command emits safe metadata for PowerShell. The elevated bridge
    // decrypts the secret locally so setup-cli stdout never carries it.
    resolveSecretValue: () => "__configured__"
  });
  const summaryPath = path.win32.join(paths.artifactsRoot, "setup", "launch-env-summary.json");
  const result: ResolveLaunchEnvCommandResult = launchEnvironment.ok
    ? {
        schemaVersion: SetupSchemaVersion,
        verb: "resolve-launch-env",
        ok: true,
        status: "ready",
        message: "Launch environment resolved from canonical setup state.",
        summaryPath,
        runtimeEnv: {
          FEISHU_APP_ID: launchEnvironment.runtimeEnv.FEISHU_APP_ID,
          CODEX_CLI_EXE: launchEnvironment.runtimeEnv.CODEX_CLI_EXE
        },
        feishuAppSecretConfigured: true
      }
    : {
        schemaVersion: SetupSchemaVersion,
        verb: "resolve-launch-env",
        ok: false,
        status: "action-required",
        message: launchEnvironment.message,
        summaryPath,
        failureCategory: launchEnvironment.failureCategory
      };

  const safeResult = redactSetupSecretsForOutput(result);
  writeJson(summaryPath, safeResult);
  return safeResult;
}

export async function runResolveLaunchEnvCommand(
  context: SetupCommandContext = {}
): Promise<ResolveLaunchEnvCommandResult> {
  return await createResult(context.env);
}
