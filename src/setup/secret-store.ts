import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { safeFilename, writeJson } from "../util/fs";
import { resolveSetupPaths, type SetupPathEnvironment } from "./paths";
import { SetupSchemaVersion } from "./types";

const TRUSTED_WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\Windows$/i;
const DPAPI_SECRET_ENV_NAME = "CODEXLARK_SETUP_SECRET_VALUE";
const DPAPI_PROTECTED_SECRET_ENV_NAME = "CODEXLARK_SETUP_PROTECTED_SECRET";

export type StoredSecretRecord = {
  schemaVersion: typeof SetupSchemaVersion;
  name: string;
  reference: string;
  storage: "dpapi-user-scope";
  protectedValue: string;
  updatedAt: string;
};

export type StoreSetupSecretOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  protectSecret?: (secret: string) => Promise<string> | string;
};

export type ResolveSetupSecretOptions = {
  env?: NodeJS.ProcessEnv;
  unprotectSecret?: (protectedValue: string) => Promise<string> | string;
};

function resolveCommandEnv(env: NodeJS.ProcessEnv = process.env): SetupPathEnvironment {
  return {
    ProgramW6432: env.ProgramW6432 ?? env.PROGRAMW6432,
    ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES,
    LocalAppData: env.LocalAppData ?? env.LOCALAPPDATA,
    USERPROFILE: env.USERPROFILE
  };
}

function resolveTrustedWindowsRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const directRoots = [env.SystemRoot, env.WINDIR]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => TRUSTED_WINDOWS_ROOT_PATTERN.test(value));
  const systemDrive = typeof env.SystemDrive === "string" ? env.SystemDrive.trim() : "";
  const systemDriveRoot = /^[A-Za-z]:$/i.test(systemDrive) ? `${systemDrive}\\Windows` : "";
  return [...new Set([...directRoots, systemDriveRoot, "C:\\Windows"].filter(Boolean))];
}

function resolveWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const roots = resolveTrustedWindowsRoots(env);
  for (const root of roots) {
    const candidate = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return path.win32.join(roots[0] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildSecretReference(name: string): string {
  return `secret://${safeFilename(name)}`;
}

export function isSetupSecretReference(reference: string | null | undefined): reference is string {
  if (typeof reference !== "string") return false;
  const trimmed = reference.trim();
  if (!trimmed.startsWith("secret://")) return false;
  const secretName = trimmed.slice("secret://".length).trim();
  return secretName.length > 0 && safeFilename(secretName) === secretName;
}

function parseSecretReference(reference: string): string {
  const trimmed = reference.trim();
  if (!isSetupSecretReference(trimmed)) {
    throw new Error(`Unsupported setup secret reference: ${reference}`);
  }
  const name = trimmed.slice("secret://".length).trim();
  if (!name) {
    throw new Error("Setup secret reference is missing a secret name.");
  }
  return safeFilename(name);
}

function getSecretsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveSetupPaths(resolveCommandEnv(env));
  return path.win32.join(paths.stateRoot, "secrets");
}

export function getStoredSecretRecordPath(reference: string, options: { env?: NodeJS.ProcessEnv } = {}): string {
  return path.win32.join(getSecretsRoot(options.env), `${parseSecretReference(reference)}.json`);
}

export function hasStoredSecretRecord(reference: string | null | undefined, options: { env?: NodeJS.ProcessEnv } = {}): boolean {
  if (!isSetupSecretReference(reference)) return false;
  try {
    readStoredSecretRecord(reference, options);
    return true;
  } catch {
    return false;
  }
}

export function readStoredSecretRecord(
  reference: string,
  options: { env?: NodeJS.ProcessEnv } = {}
): StoredSecretRecord {
  const recordPath = getStoredSecretRecordPath(reference, options);
  const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  const name = typeof parsed.name === "string" ? parsed.name : parseSecretReference(reference);
  const protectedValue = typeof parsed.protectedValue === "string" ? parsed.protectedValue : "";
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
  if (!protectedValue) {
    throw new Error(`Stored secret record is missing protectedValue: ${recordPath}`);
  }
  return {
    schemaVersion: SetupSchemaVersion,
    name,
    reference: typeof parsed.reference === "string" ? parsed.reference : reference,
    storage: "dpapi-user-scope",
    protectedValue,
    updatedAt
  };
}

function protectSecretWithDpapi(secret: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") {
    throw new Error("DPAPI-backed setup secret storage currently only supports Windows.");
  }

  const protectedValue = execFileSync(
    resolveWindowsPowerShellPath(env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -AssemblyName System.Security; " +
        "$secretBytes = [System.Text.Encoding]::Unicode.GetBytes($env:CODEXLARK_SETUP_SECRET_VALUE); " +
        "$protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($secretBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
        "-join ($protectedBytes | ForEach-Object { $_.ToString('x2') })"
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        [DPAPI_SECRET_ENV_NAME]: secret
      },
      timeout: 5000,
      windowsHide: true
    }
  ).trim();

  if (!protectedValue) {
    throw new Error("DPAPI secret protection returned an empty value.");
  }

  return protectedValue;
}

function unprotectSecretWithDpapi(protectedValue: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") {
    throw new Error("DPAPI-backed setup secret storage currently only supports Windows.");
  }

  const resolvedSecret = execFileSync(
    resolveWindowsPowerShellPath(env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -AssemblyName System.Security; " +
        "$protectedValue = $env:CODEXLARK_SETUP_PROTECTED_SECRET; " +
        "if ($protectedValue.Length % 2 -ne 0 -or $protectedValue -notmatch '^[0-9A-Fa-f]+$') { throw 'Invalid DPAPI payload.' }; " +
        "$byteCount = [int]($protectedValue.Length / 2); " +
        "$protectedBytes = New-Object byte[] $byteCount; " +
        "for ($index = 0; $index -lt $byteCount; $index++) { $protectedBytes[$index] = [Convert]::ToByte($protectedValue.Substring($index * 2, 2), 16) }; " +
        "$secretBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
        "[System.Text.Encoding]::Unicode.GetString($secretBytes)"
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        [DPAPI_PROTECTED_SECRET_ENV_NAME]: protectedValue
      },
      timeout: 5000,
      windowsHide: true
    }
  ).replace(/(?:\r?\n)+$/u, "");

  if (!resolvedSecret) {
    throw new Error("DPAPI secret unprotection returned an empty value.");
  }

  return resolvedSecret;
}

export async function storeSetupSecret(
  input: {
    name: string;
    value: string;
  },
  options: StoreSetupSecretOptions = {}
): Promise<{ reference: string; recordPath: string }> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const normalizedName = safeFilename(input.name);
  const reference = buildSecretReference(normalizedName);
  const recordPath = getStoredSecretRecordPath(reference, { env });
  const protectSecret = options.protectSecret ?? ((secret: string) => protectSecretWithDpapi(secret, env));
  const protectedValue = String(await protectSecret(input.value));

  if (!protectedValue.trim()) {
    throw new Error(`Setup secret protection produced an empty value for ${normalizedName}.`);
  }

  writeJson(recordPath, {
    schemaVersion: SetupSchemaVersion,
    name: normalizedName,
    reference,
    storage: "dpapi-user-scope",
    protectedValue,
    updatedAt: now().toISOString()
  } satisfies StoredSecretRecord);

  return { reference, recordPath };
}

export async function resolveSetupSecretValue(
  reference: string,
  options: ResolveSetupSecretOptions = {}
): Promise<string> {
  const env = options.env ?? process.env;
  const record = readStoredSecretRecord(reference, { env });
  const unprotectSecret = options.unprotectSecret ?? ((value: string) => unprotectSecretWithDpapi(value, env));
  const resolvedSecret = String(await unprotectSecret(record.protectedValue));

  if (!resolvedSecret) {
    throw new Error(`Resolved setup secret is empty for ${record.reference}.`);
  }

  return resolvedSecret;
}
