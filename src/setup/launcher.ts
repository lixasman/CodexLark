import fs from "node:fs";
import path from "node:path";

import { readRuntimeManifest, writeRuntimeManifest, type RuntimeManifest } from "./runtime-manifest";
import { resolveSetupPaths, type SetupPathEnvironment } from "./paths";
import type { SetupVerb } from "./types";

export type CanonicalLauncherVerb = Extract<SetupVerb, "launch" | "repair" | "configure-autostart">;

export type LauncherRoute = {
  verb: CanonicalLauncherVerb;
  manifestPath: string;
  path: string;
  arguments: string[];
  runtimeManifest: RuntimeManifest;
};

export type LauncherDrift = {
  drifted: boolean;
  expectedPath: string;
  actualPath: string;
};

export type EnsuredLauncherManifest = {
  manifestPath: string;
  manifest: RuntimeManifest;
  updated: boolean;
};

function normalizeWindowsPath(candidatePath: string): string {
  return path.win32.normalize(candidatePath.trim());
}

function runtimeManifestEquals(left: RuntimeManifest, right: RuntimeManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function getCanonicalRuntimeManifestPath(env: SetupPathEnvironment = process.env): string {
  const paths = resolveSetupPaths(env);
  return path.win32.join(paths.stateRoot, "runtime-manifest.json");
}

export function buildSourceRuntimeManifest(
  installRoot: string,
  env: SetupPathEnvironment = process.env
): RuntimeManifest {
  const normalizedInstallRoot = normalizeWindowsPath(installRoot);
  const paths = resolveSetupPaths(env);

  return {
    schemaVersion: 1,
    installRoot: normalizedInstallRoot,
    stateRoot: paths.stateRoot,
    launcherPath: path.win32.join(normalizedInstallRoot, "Start-CodexLark.ps1"),
    bridgeScriptPaths: {
      runAdminTask: path.win32.join(normalizedInstallRoot, "run-admin-task.ps1"),
      installAutostart: path.win32.join(normalizedInstallRoot, "Install-CodexLark-Autostart.ps1"),
      uninstallAutostart: path.win32.join(normalizedInstallRoot, "Uninstall-CodexLark-Autostart.ps1")
    }
  };
}

export function ensureSourceRuntimeManifest(
  installRoot: string,
  env: SetupPathEnvironment = process.env
): EnsuredLauncherManifest {
  const manifestPath = getCanonicalRuntimeManifestPath(env);
  const manifest = buildSourceRuntimeManifest(installRoot, env);
  let updated = true;

  if (fs.existsSync(manifestPath)) {
    try {
      const current = readRuntimeManifest(manifestPath);
      updated = !runtimeManifestEquals(current, manifest);
    } catch {
      updated = true;
    }
  }

  if (updated) {
    writeRuntimeManifest(manifestPath, manifest);
  }

  return {
    manifestPath,
    manifest,
    updated
  };
}

function readCanonicalRuntimeManifest(env: SetupPathEnvironment = process.env): {
  manifestPath: string;
  runtimeManifest: RuntimeManifest;
} {
  const manifestPath = getCanonicalRuntimeManifestPath(env);
  return {
    manifestPath,
    runtimeManifest: readRuntimeManifest(manifestPath)
  };
}

export function resolveCanonicalLauncherRoute(
  verb: CanonicalLauncherVerb,
  env: SetupPathEnvironment = process.env
): LauncherRoute {
  const { manifestPath, runtimeManifest } = readCanonicalRuntimeManifest(env);

  switch (verb) {
    case "launch":
      return {
        verb,
        manifestPath,
        path: runtimeManifest.launcherPath,
        arguments: [],
        runtimeManifest
      };
    case "repair":
      return {
        verb,
        manifestPath,
        path: path.win32.join(runtimeManifest.installRoot, "Repair-CodexLark.ps1"),
        arguments: [],
        runtimeManifest
      };
    case "configure-autostart":
      return {
        verb,
        manifestPath,
        path: runtimeManifest.bridgeScriptPaths.installAutostart,
        arguments: [],
        runtimeManifest
      };
  }
}

export function classifyLauncherDrift(
  route: Pick<LauncherRoute, "verb" | "path" | "arguments">,
  observed: { path: string; arguments?: string[] }
): LauncherDrift {
  const expectedPath = normalizeWindowsPath(route.path);
  const actualPath = normalizeWindowsPath(observed.path);

  return {
    drifted: expectedPath.toLowerCase() !== actualPath.toLowerCase(),
    expectedPath,
    actualPath
  };
}
