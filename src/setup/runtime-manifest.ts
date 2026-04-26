import fs from "node:fs";

import { writeJson } from "../util/fs";
import { SetupSchemaVersion } from "./types";

export type RuntimeBridgeScriptPaths = {
  runAdminTask: string;
  installAutostart: string;
  uninstallAutostart: string;
};

export type RuntimeManifest = {
  schemaVersion: typeof SetupSchemaVersion;
  installRoot: string;
  stateRoot: string;
  launcherPath: string;
  bridgeScriptPaths: RuntimeBridgeScriptPaths;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Runtime manifest is missing ${key}.`);
  }
  return value;
}

function parseBridgeScriptPaths(value: unknown): RuntimeBridgeScriptPaths {
  if (!isRecord(value)) {
    throw new Error("Runtime manifest is missing bridgeScriptPaths.");
  }

  return {
    runAdminTask: readRequiredString(value, "runAdminTask"),
    installAutostart: readRequiredString(value, "installAutostart"),
    uninstallAutostart: readRequiredString(value, "uninstallAutostart")
  };
}

export function readRuntimeManifest(manifestPath: string): RuntimeManifest {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Runtime manifest must be a JSON object.");
  }
  if (parsed.schemaVersion !== SetupSchemaVersion) {
    throw new Error(`Unsupported runtime manifest schema version: ${String(parsed.schemaVersion)}`);
  }

  return {
    schemaVersion: SetupSchemaVersion,
    installRoot: readRequiredString(parsed, "installRoot"),
    stateRoot: readRequiredString(parsed, "stateRoot"),
    launcherPath: readRequiredString(parsed, "launcherPath"),
    bridgeScriptPaths: parseBridgeScriptPaths(parsed.bridgeScriptPaths)
  };
}

export function writeRuntimeManifest(manifestPath: string, manifest: RuntimeManifest): void {
  writeJson(manifestPath, manifest);
}
