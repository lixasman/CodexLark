import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_LOGIN_MARKER_FILENAMES = ["auth.json", "credentials.json"] as const;

export type CodexLoginState = {
  loginDetected: boolean;
  codexHome: string;
  loginMarkerPath?: string;
  detectionSource?: "openai_api_key" | "marker";
};

export type CodexLoginStateOptions = {
  env?: NodeJS.ProcessEnv;
  pathExists?: (filePath: string) => boolean;
};

function readEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const communicateCodexHome = readEnvValue("COMMUNICATE_CODEX_HOME", env);
  if (communicateCodexHome) return communicateCodexHome;

  const codexHome = readEnvValue("CODEX_HOME", env);
  if (codexHome) return codexHome;

  const userProfile = readEnvValue("USERPROFILE", env);
  if (userProfile) return path.join(userProfile, ".codex");

  return path.join(os.homedir(), ".codex");
}

export function listCodexLoginMarkerPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const codexHome = resolveCodexHome(env);
  return CODEX_LOGIN_MARKER_FILENAMES.map((fileName) => path.join(codexHome, fileName));
}

export function detectCodexLoginState(options: CodexLoginStateOptions = {}): CodexLoginState {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? ((filePath: string) => fs.existsSync(filePath));
  const codexHome = resolveCodexHome(env);

  if (readEnvValue("OPENAI_API_KEY", env)) {
    return {
      loginDetected: true,
      codexHome,
      detectionSource: "openai_api_key"
    };
  }

  for (const markerPath of listCodexLoginMarkerPaths(env)) {
    if (pathExists(markerPath)) {
      return {
        loginDetected: true,
        codexHome,
        loginMarkerPath: markerPath,
        detectionSource: "marker"
      };
    }
  }

  return {
    loginDetected: false,
    codexHome
  };
}
