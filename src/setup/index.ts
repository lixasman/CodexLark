import { runDoctorCommand } from "./commands/doctor";
import { runExportDiagnosticsCommand } from "./commands/export-diagnostics";
import { runFirstRunCommand } from "./commands/first-run";
import { runRepairCommand } from "./commands/repair";
import { runResolveLaunchEnvCommand } from "./commands/resolve-launch-env";
import { SetupSchemaVersion } from "./types";

export type SetupCliVerb = "first-run" | "repair" | "doctor" | "export-diagnostics" | "resolve-launch-env";
export type SetupCommandStatus = "not-implemented" | "ready" | "action-required";

export type SetupCommandContext = {
  env?: NodeJS.ProcessEnv;
};

export type SetupCommandResult<
  TVerb extends SetupCliVerb = SetupCliVerb,
  TExtra extends object = {}
> = {
  schemaVersion: typeof SetupSchemaVersion;
  verb: TVerb;
  ok: boolean;
  status: SetupCommandStatus;
  message: string;
  summaryPath: string;
} & TExtra;

export function isSetupCliVerb(value: string): value is SetupCliVerb {
  return value === "first-run"
    || value === "repair"
    || value === "doctor"
    || value === "export-diagnostics"
    || value === "resolve-launch-env";
}

export async function runSetupCommand(
  verb: SetupCliVerb,
  context: SetupCommandContext = {}
): Promise<SetupCommandResult> {
  switch (verb) {
    case "first-run":
      return runFirstRunCommand(context);
    case "repair":
      return runRepairCommand(context);
    case "doctor":
      return runDoctorCommand(context);
    case "export-diagnostics":
      return runExportDiagnosticsCommand(context);
    case "resolve-launch-env":
      return runResolveLaunchEnvCommand(context);
  }
}

export { runFirstRunCommand, runRepairCommand, runDoctorCommand, runExportDiagnosticsCommand, runResolveLaunchEnvCommand };
