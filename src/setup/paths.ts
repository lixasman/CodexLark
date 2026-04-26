import path from "node:path";

const PRODUCT_NAME = "CodexLark";

export type SetupPathEnvironment = {
  ProgramW6432?: string;
  ProgramFiles?: string;
  LocalAppData?: string;
  USERPROFILE?: string;
};

export type SetupPaths = {
  productRoot: string;
  configRoot: string;
  logsRoot: string;
  stateRoot: string;
  artifactsRoot: string;
};

function resolveWindowsPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function resolveSetupPaths(env: SetupPathEnvironment = process.env): SetupPaths {
  const programFilesRoot = resolveWindowsPath(
    env.ProgramW6432,
    resolveWindowsPath(env.ProgramFiles, "C:\\Program Files")
  );
  const localAppDataRoot = resolveWindowsPath(
    env.LocalAppData,
    path.win32.join(resolveWindowsPath(env.USERPROFILE, "C:\\Users\\Default"), "AppData", "Local")
  );
  const productRoot = path.win32.join(programFilesRoot, PRODUCT_NAME);
  const dataRoot = path.win32.join(localAppDataRoot, PRODUCT_NAME);

  return {
    productRoot,
    configRoot: path.win32.join(dataRoot, "config"),
    logsRoot: path.win32.join(dataRoot, "logs"),
    stateRoot: path.win32.join(dataRoot, "state"),
    artifactsRoot: path.win32.join(dataRoot, "artifacts")
  };
}
