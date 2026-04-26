import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

function innoScriptPath(): string {
  return path.join(process.cwd(), "packaging", "inno", "CodexLark.iss");
}

function packagingReadmePath(): string {
  return path.join(process.cwd(), "packaging", "inno", "README.md");
}

function buildInstallerScriptPath(): string {
  return path.join(process.cwd(), "scripts", "package", "build-installer.ps1");
}

function readRequiredText(filePath: string): string {
  assert.equal(existsSync(filePath), true, `expected file to exist: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

test("Inno Setup package includes bundled node.exe and dist payload", () => {
  const script = readRequiredText(innoScriptPath());

  assert.match(
    script,
    /Source:\s*"\{#StageDir\}\\node\.exe";\s*DestDir:\s*"\{app\}";\s*Flags:\s*ignoreversion/i
  );
  assert.match(
    script,
    /Source:\s*"\{#StageDir\}\\dist\\\*";\s*DestDir:\s*"\{app\}\\dist";\s*Flags:\s*ignoreversion recursesubdirs createallsubdirs/i
  );
});

test("Inno Setup package creates launch and repair shortcuts", () => {
  const script = readRequiredText(innoScriptPath());

  assert.match(script, /\[Icons\]/);
  assert.match(script, /Name:\s*"\{group\}\\Launch CodexLark";[\s\S]*Start-CodexLark\.ps1/i);
  assert.match(script, /Name:\s*"\{group\}\\Repair CodexLark";[\s\S]*Repair-CodexLark\.ps1/i);
});

test("Inno Setup package only syncs the launcher manifest during install", () => {
  const script = readRequiredText(innoScriptPath());

  assert.match(script, /\[Run\]/);
  assert.match(script, /ensureSourceRuntimeManifest/i);
  assert.match(script, /launcher\.ensureSourceRuntimeManifest/i);
  assert.doesNotMatch(script, /const\s*\{\s*ensureSourceRuntimeManifest\s*\}/i);
  assert.match(script, /runasoriginaluser/i);
  assert.match(script, /waituntilterminated/i);
  assert.doesNotMatch(script, /postinstall nowait skipifsilent/i);
  assert.doesNotMatch(script, /dist\\setup-cli\.js"" first-run/i);
});

test("installer packaging helper verifies iscc and stages the packaged runtime", () => {
  const script = readRequiredText(buildInstallerScriptPath());

  assert.match(script, /Get-Command iscc -ErrorAction Stop/);
  assert.match(script, /node\.exe/);
  assert.match(script, /process\.execPath/);
  assert.match(script, /function Resolve-BundledNodePath/);
  assert.match(script, /function Assert-SafePackagingPath/);
  assert.match(script, /Copy-StagedDirectory -RelativePath 'dist'/);
  assert.match(script, /Copy-StagedFile -RelativePath 'run-admin-task\.ps1'/);
  assert.match(script, /Copy-StagedFile -RelativePath 'Install-CodexLark-Autostart\.ps1'/);
  assert.match(script, /Copy-StagedFile -RelativePath 'Uninstall-CodexLark-Autostart\.ps1'/);
  assert.match(script, /Start-CodexLark\.ps1/);
  assert.match(script, /Repair-CodexLark\.ps1/);
  assert.match(script, /CodexLark\.iss/);
});

test("packaging helper generates launchers that route through the interactive setup product CLI and pause on failure", () => {
  const script = readRequiredText(buildInstallerScriptPath());

  assert.match(script, /dist\\setup-product-cli\.js/);
  assert.match(script, /launch'/i);
  assert.match(script, /repair'/i);
  assert.match(script, /Read-Host .*按 Enter 键关闭窗口/);
  assert.match(script, /Assert-CodexLarkSupportedHost/);
});

test("packaging README documents the Inno Setup prerequisite and build entrypoint", () => {
  const readme = readRequiredText(packagingReadmePath());

  assert.match(readme, /Get-Command iscc/);
  assert.match(readme, /scripts\\package\\build-installer\.ps1/);
  assert.match(readme, /node\.exe/i);
  assert.match(readme, /dist\//i);
});
