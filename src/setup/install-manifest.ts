import path from "node:path";

import type { SetupPaths } from "./paths";
import { SetupSchemaVersion } from "./types";

export type InstallManagedResourceId =
  | "product-root"
  | "config-root"
  | "logs-root"
  | "state-root"
  | "artifacts-root";

export type MachineInstallManagedResource = {
  id: "product-root";
  kind: "directory";
  scope: "machine";
  path: string;
};

export type PerUserInstallManagedResource = {
  id: Exclude<InstallManagedResourceId, "product-root">;
  kind: "directory";
  scope: "per-user";
  relativePath: string;
  pathTemplate: string;
};

export type InstallManagedResource = MachineInstallManagedResource | PerUserInstallManagedResource;

export type InstallManifest = {
  schemaVersion: typeof SetupSchemaVersion;
  installRoot: string;
  managedResources: InstallManagedResource[];
};

const LOCAL_APP_DATA_TOKEN = "%LocalAppData%";
const PRODUCT_NAME = "CodexLark";

function createPerUserManagedResource(
  id: PerUserInstallManagedResource["id"],
  relativePath: string
): PerUserInstallManagedResource {
  return {
    id,
    kind: "directory",
    scope: "per-user",
    relativePath,
    pathTemplate: path.win32.join(LOCAL_APP_DATA_TOKEN, PRODUCT_NAME, relativePath)
  };
}

export function createInstallManifest(paths: SetupPaths): InstallManifest {
  return {
    schemaVersion: SetupSchemaVersion,
    installRoot: paths.productRoot,
    managedResources: [
      {
        id: "product-root",
        kind: "directory",
        scope: "machine",
        path: paths.productRoot
      },
      createPerUserManagedResource("config-root", "config"),
      createPerUserManagedResource("logs-root", "logs"),
      createPerUserManagedResource("state-root", "state"),
      createPerUserManagedResource("artifacts-root", "artifacts")
    ]
  };
}
