import fs from "node:fs";
import path from "node:path";

import { writeJson } from "../util/fs";
import { resolveSetupPaths, type SetupPathEnvironment } from "./paths";
import { isSetupSecretReference } from "./secret-store";
import { SetupSchemaVersion } from "./types";

export type SetupSettings = {
  schemaVersion: typeof SetupSchemaVersion;
  feishuAppId?: string;
  feishuAppSecretRef?: string;
  codexCliPath?: string;
};

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function getSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  return path.win32.join(paths.configRoot, "settings.json");
}

export function readSetupSettings(env: NodeJS.ProcessEnv = process.env): SetupSettings {
  const settingsPath = getSettingsPath(env);
  if (!fs.existsSync(settingsPath)) {
    return {
      schemaVersion: SetupSchemaVersion
    };
  }

  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  return {
    schemaVersion: SetupSchemaVersion,
    feishuAppId: normalizeOptionalString(parsed.feishuAppId),
    feishuAppSecretRef: (() => {
      const reference = normalizeOptionalString(parsed.feishuAppSecretRef);
      return reference && isSetupSecretReference(reference) ? reference : undefined;
    })(),
    codexCliPath: normalizeOptionalString(parsed.codexCliPath)
  };
}

export function writeSetupSettings(
  input: {
    feishuAppId?: string;
    feishuAppSecretRef?: string;
    codexCliPath?: string;
  },
  env: NodeJS.ProcessEnv = process.env
): SetupSettings {
  const next: SetupSettings = {
    ...readSetupSettings(env),
    schemaVersion: SetupSchemaVersion
  };

  if (input.feishuAppId !== undefined) {
    next.feishuAppId = normalizeOptionalString(input.feishuAppId);
  }
  if (input.feishuAppSecretRef !== undefined) {
    next.feishuAppSecretRef = normalizeOptionalString(input.feishuAppSecretRef);
  }
  if (input.codexCliPath !== undefined) {
    next.codexCliPath = normalizeOptionalString(input.codexCliPath);
  }

  writeJson(getSettingsPath(env), next);
  return next;
}
