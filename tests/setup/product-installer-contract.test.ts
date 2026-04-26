import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SetupSchemaVersion, type SetupVerb } from "../../src/setup/types";
import { resolveSetupPaths } from "../../src/setup/paths";
import { readRuntimeManifest, writeRuntimeManifest, type RuntimeManifest } from "../../src/setup/runtime-manifest";
import { createInstallManifest } from "../../src/setup/install-manifest";

test("setup contracts target Program Files and LocalAppData roots", () => {
  const verb: SetupVerb = "configure-autostart";
  const paths = resolveSetupPaths({
    ProgramFiles: "C:\\Program Files",
    LocalAppData: "C:\\Users\\Tester\\AppData\\Local"
  });

  assert.equal(verb, "configure-autostart");
  assert.equal(paths.productRoot, path.win32.join("C:\\Program Files", "CodexLark"));

  const expectedDataRoot = path.win32.join("C:\\Users\\Tester\\AppData\\Local", "CodexLark");
  assert.equal(paths.configRoot, path.win32.join(expectedDataRoot, "config"));
  assert.equal(paths.logsRoot, path.win32.join(expectedDataRoot, "logs"));
  assert.equal(paths.stateRoot, path.win32.join(expectedDataRoot, "state"));
  assert.equal(paths.artifactsRoot, path.win32.join(expectedDataRoot, "artifacts"));
});

test("setup contracts prefer ProgramW6432 over redirected ProgramFiles values", () => {
  const paths = resolveSetupPaths({
    ProgramW6432: "C:\\Program Files",
    ProgramFiles: "C:\\Program Files (x86)",
    LocalAppData: "C:\\Users\\Tester\\AppData\\Local"
  });

  assert.equal(paths.productRoot, path.win32.join("C:\\Program Files", "CodexLark"));
});

test("runtime manifest is schema-aware and round-trips through disk helpers", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-runtime-manifest-"));

  try {
    const manifestPath = path.join(tempRoot, "runtime-manifest.json");
    const manifest: RuntimeManifest = {
      schemaVersion: SetupSchemaVersion,
      installRoot: "C:\\Program Files\\CodexLark",
      stateRoot: "C:\\Users\\Tester\\AppData\\Local\\CodexLark\\state",
      launcherPath: "C:\\Program Files\\CodexLark\\app\\CodexLark.exe",
      bridgeScriptPaths: {
        runAdminTask: "C:\\Program Files\\CodexLark\\app\\powershell\\run-admin-task.ps1",
        installAutostart: "C:\\Program Files\\CodexLark\\app\\powershell\\Install-CodexLark-Autostart.ps1",
        uninstallAutostart: "C:\\Program Files\\CodexLark\\app\\powershell\\Uninstall-CodexLark-Autostart.ps1"
      }
    };

    writeRuntimeManifest(manifestPath, manifest);
    const stored = readRuntimeManifest(manifestPath);

    assert.equal(stored.schemaVersion, SetupSchemaVersion);
    assert.equal(stored.launcherPath, manifest.launcherPath);
    assert.deepEqual(stored.bridgeScriptPaths, manifest.bridgeScriptPaths);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("install manifest enumerates managed product and mutable-data resources", () => {
  const paths = resolveSetupPaths({
    ProgramFiles: "C:\\Program Files",
    LocalAppData: "C:\\Users\\Tester\\AppData\\Local"
  });

  const manifest = createInstallManifest(paths);

  assert.equal(manifest.schemaVersion, SetupSchemaVersion);
  assert.deepEqual(
    manifest.managedResources.map((resource) => resource.id),
    ["product-root", "config-root", "logs-root", "state-root", "artifacts-root"]
  );

  const productRoot = manifest.managedResources[0];
  const configRoot = manifest.managedResources[1];
  const artifactsRoot = manifest.managedResources[4];

  assert.equal(productRoot?.scope, "machine");
  assert.equal(productRoot?.path, paths.productRoot);

  const expectedDataRootTemplate = "%LocalAppData%\\CodexLark";
  assert.equal(configRoot?.scope, "per-user");
  assert.equal(configRoot?.pathTemplate, path.win32.join(expectedDataRootTemplate, "config"));
  assert.equal(configRoot?.relativePath, "config");

  assert.equal(artifactsRoot?.scope, "per-user");
  assert.equal(artifactsRoot?.pathTemplate, path.win32.join(expectedDataRootTemplate, "artifacts"));
  assert.equal(artifactsRoot?.relativePath, "artifacts");
});
