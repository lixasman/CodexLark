import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

type ProbeResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ReleaseDryRunSummary = {
  failed?: boolean;
  failureMessage?: string;
  preflight?: {
    status?: string;
    node?: string;
    npm?: string;
    iscc?: string;
    errorMessage?: string;
    failedCommand?: string;
    checks?: Array<{
      name?: string;
      status?: string;
      resolvedPath?: string;
      errorMessage?: string;
    }>;
  };
  steps?: Array<{
    key?: string;
    status?: string;
    timedOut?: boolean;
    exitCode?: number | null;
    durationMs?: number | null;
    stdoutPath?: string;
    stderrPath?: string;
    errorMessage?: string;
  }>;
  installer?: {
    path?: string;
    sha256?: string;
  };
  manualValidation?: string[];
};

function readRequiredText(filePath: string): string {
  assert.equal(existsSync(filePath), true, `expected file to exist: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function assertUtf8WithoutBom(filePath: string): void {
  assert.doesNotMatch(readRequiredText(filePath), /^\ufeff/, `expected ${filePath} to be written without a UTF-8 BOM`);
}

function dryRunDocPath(): string {
  return path.join(process.cwd(), "docs", "workflows", "product-installer-release-dry-run.md");
}

function releaseGatesDocPath(): string {
  return path.join(process.cwd(), "docs", "workflows", "product-installer-release-gates.md");
}

function dryRunScriptPath(): string {
  return path.join(process.cwd(), "scripts", "package", "run-product-installer-release-dry-run.ps1");
}

function processRunnerPath(): string {
  return path.join(process.cwd(), "scripts", "setup", "process-runner.ps1");
}

function createTempRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCmdScript(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\r\n")}\r\n`, "utf8");
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const fullPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(fullPath) ? fullPath : "powershell.exe";
}

function createReleaseDryRunFixture(): string {
  const root = createTempRoot("codexlark-release-dry-run-");

  mkdirSync(path.join(root, "scripts", "package"), { recursive: true });
  mkdirSync(path.join(root, "scripts", "setup"), { recursive: true });
  mkdirSync(path.join(root, "docs", "workflows"), { recursive: true });

  writeFileSync(path.join(root, "scripts", "package", "run-product-installer-release-dry-run.ps1"), readRequiredText(dryRunScriptPath()), "utf8");
  writeFileSync(path.join(root, "scripts", "setup", "process-runner.ps1"), readRequiredText(processRunnerPath()), "utf8");
  writeFileSync(path.join(root, "scripts", "package", "build-installer.ps1"), "# fixture placeholder\n", "utf8");
  writeFileSync(path.join(root, "docs", "workflows", "product-installer-release-dry-run.md"), "# fixture\n", "utf8");
  writeFileSync(path.join(root, "docs", "workflows", "product-installer-release-gates.md"), "# fixture\n", "utf8");
  writeFileSync(path.join(root, "docs", "workflows", "install-startup-support-matrix.md"), "# fixture\n", "utf8");

  return root;
}

function createFakeCommandBin(
  root: string,
  options?: {
    includeNpm?: boolean;
    includePowerShellShim?: boolean;
    npmExitCode?: number;
    includeNpmPs1?: boolean;
  }
): string {
  const binDir = path.join(root, "fake-bin");
  mkdirSync(binDir, { recursive: true });

  writeCmdScript(path.join(binDir, "node.cmd"), ["@echo off", "exit /b 0"]);
  writeCmdScript(path.join(binDir, "iscc.cmd"), ["@echo off", "exit /b 0"]);

  if (options?.includeNpm !== false) {
    const npmExitCode = options?.npmExitCode ?? 0;
    writeCmdScript(path.join(binDir, "npm.cmd"), ["@echo off", `exit /b ${npmExitCode}`]);
  }

  if (options?.includeNpmPs1) {
    writeFileSync(path.join(binDir, "npm.ps1"), "exit 0\r\n", "utf8");
  }

  if (options?.includePowerShellShim !== false) {
    writeCmdScript(path.join(binDir, "powershell.cmd"), [
      "@echo off",
      "setlocal",
      'set "OUT=%CD%\\artifacts\\packaging\\output"',
      'if not exist "%OUT%" mkdir "%OUT%"',
      '> "%OUT%\\CodexLark-Setup-9.9.9-test.exe" echo fake installer',
      "exit /b 0"
    ]);
  }

  return binDir;
}

function runReleaseDryRunFixture(
  fixtureRoot: string,
  envOverrides: NodeJS.ProcessEnv,
  releaseRootRelative: string
): ProbeResult {
  try {
    const stdout = execFileSync(
      windowsPowerShellPath(),
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(fixtureRoot, "scripts", "package", "run-product-installer-release-dry-run.ps1"),
        "-ReleaseRoot",
        releaseRootRelative
      ],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...envOverrides
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20000
      }
    );

    return {
      stdout,
      stderr: "",
      exitCode: 0
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
    };

    if (execError.code === "EPERM") {
      throw Object.assign(new Error("Node child_process cannot spawn powershell.exe in this environment."), {
        code: "EPERM"
      });
    }

    return {
      stdout: typeof execError.stdout === "string" ? execError.stdout : String(execError.stdout ?? ""),
      stderr: typeof execError.stderr === "string" ? execError.stderr : String(execError.stderr ?? ""),
      exitCode: execError.status ?? 1
    };
  }
}

function readSummary(fixtureRoot: string, releaseRootRelative: string): ReleaseDryRunSummary {
  const summaryPath = path.join(fixtureRoot, releaseRootRelative, "release-dry-run-summary.json");
  assertUtf8WithoutBom(summaryPath);
  return JSON.parse(stripUtf8Bom(readRequiredText(summaryPath))) as ReleaseDryRunSummary;
}

test("release dry-run workflow doc covers maintainer and clean-machine phases", () => {
  const doc = readRequiredText(dryRunDocPath());

  assert.match(doc, /维护者机器|阶段 A|Phase A/i);
  assert.match(doc, /干净 Windows|验证机|阶段 B|Phase B/i);
  assert.match(doc, /run-product-installer-release-dry-run\.ps1/);
  assert.match(doc, /Get-Command node/);
  assert.match(doc, /Get-Command npm/);
  assert.match(doc, /Get-Command iscc/);
  assert.match(doc, /Resolve-CodexLarkCommandSource|Application|命令来源|helper/i);
  assert.match(doc, /npm run build/);
  assert.match(doc, /scripts\\run-node-tests\.cjs/);
  assert.match(doc, /build-installer\.ps1/);
  assert.match(doc, /Repair CodexLark/);
  assert.match(doc, /export-diagnostics/);
  assert.match(doc, /setup-diagnostics\.json/);
  assert.match(doc, /脱敏|redaction|原始 secret/i);
  assert.match(doc, /SmartScreen|Defender|preview|未签名/i);
  assert.match(doc, /快照|snapshot|第二台|回滚/i);
  assert.match(doc, /快捷方式|shortcut|Launch CodexLark|Repair CodexLark/i);
  assert.match(doc, /Uninstall CodexLark/);
});

test("release gates doc links the dedicated dry-run workflow", () => {
  const doc = readRequiredText(releaseGatesDocPath());

  assert.match(doc, /product-installer-release-dry-run\.md/);
  assert.match(doc, /dry-run/i);
});

test("release dry-run helper script runs bounded build, test, and packaging steps", () => {
  const script = readRequiredText(dryRunScriptPath());

  assert.match(script, /process-runner\.ps1/);
  assert.match(script, /Invoke-CodexLarkCommand/);
  assert.match(script, /Resolve-ReleaseDryRunCommandSource/);
  assert.match(script, /artifacts\\release-dry-run/i);
  assert.match(script, /release-dry-run-summary\.json/i);
  assert.match(script, /-Name 'node'/);
  assert.match(script, /-Name 'npm'/);
  assert.match(script, /-Name 'iscc'/);
  assert.match(script, /npm[\s\S]*run[\s\S]*build/i);
  assert.match(script, /scripts\\run-node-tests\.cjs/);
  assert.match(script, /build-installer\.ps1/);
  assert.match(script, /TimeoutSec/);
  assert.match(script, /timedOut|TimedOut/);
  assert.match(script, /errorMessage/);
  assert.match(script, /status\s*=\s*'failed'|status\s*=\s*'passed'/i);
  assert.match(script, /Write-Host[\s\S]*下一步|Write-Host[\s\S]*manual/i);
  assert.match(script, /Program Files/i);
  assert.match(script, /Launch\/Repair shortcuts|Launch CodexLark|Repair CodexLark/i);
});

test("release dry-run helper executes successfully with fake command shims and writes a structured summary", (t) => {
  const fixtureRoot = createReleaseDryRunFixture();

  try {
    const fakeBin = createFakeCommandBin(fixtureRoot);
    const result = runReleaseDryRunFixture(
      fixtureRoot,
      {
        PATH: fakeBin
      },
      path.join("artifacts", "release-dry-run", "success-case")
    );

    assert.equal(result.exitCode, 0, `expected helper to succeed, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const summary = readSummary(fixtureRoot, path.join("artifacts", "release-dry-run", "success-case"));
    assert.equal(summary.failed, false);
    assert.equal(summary.preflight?.status, "passed");
    assert.match(summary.preflight?.node ?? "", /node\.cmd/i);
    assert.match(summary.preflight?.npm ?? "", /npm\.cmd/i);
    assert.match(summary.preflight?.iscc ?? "", /iscc\.cmd/i);
    assert.deepEqual(
      summary.preflight?.checks?.map((check) => check.name),
      ["node", "npm", "iscc"]
    );
    assert.deepEqual(
      summary.steps?.map((step) => step.key),
      ["01-build", "02-tests", "03-package"]
    );
    assert.ok(summary.steps?.every((step) => step.status === "passed"));
    assert.match(summary.installer?.path ?? "", /CodexLark-Setup-9\.9\.9-test\.exe/i);
    assert.match(summary.installer?.sha256 ?? "", /^[A-F0-9]{64}$/i);
    assert.ok(summary.manualValidation?.some((entry) => /redacted|preview/i.test(entry)));
    assert.ok(summary.manualValidation?.some((entry) => /Launch\/Repair shortcuts|Launch CodexLark|Repair CodexLark/i.test(entry)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Node child_process cannot spawn powershell.exe in this environment.");
      return;
    }
    throw error;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("release dry-run helper fails fast when npm is missing from preflight", (t) => {
  const fixtureRoot = createReleaseDryRunFixture();

  try {
    const fakeBin = createFakeCommandBin(fixtureRoot, { includeNpm: false });
    const result = runReleaseDryRunFixture(
      fixtureRoot,
      {
        PATH: fakeBin
      },
      path.join("artifacts", "release-dry-run", "missing-npm")
    );

    assert.notEqual(result.exitCode, 0);

    const summary = readSummary(fixtureRoot, path.join("artifacts", "release-dry-run", "missing-npm"));
    assert.equal(summary.failed, true);
    assert.equal(summary.preflight?.status, "failed");
    assert.equal(summary.preflight?.failedCommand, "npm");
    assert.match(summary.preflight?.errorMessage ?? "", /npm/i);
    assert.match(summary.failureMessage ?? "", /npm/i);
    assert.deepEqual(
      summary.preflight?.checks?.map((check) => [check.name, check.status]),
      [["node", "passed"], ["npm", "failed"]]
    );
    assert.equal(summary.steps?.length ?? 0, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Node child_process cannot spawn powershell.exe in this environment.");
      return;
    }
    throw error;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("release dry-run helper records a failed packaging step even when powershell resolution breaks", (t) => {
  const fixtureRoot = createReleaseDryRunFixture();

  try {
    const fakeBin = createFakeCommandBin(fixtureRoot, { includePowerShellShim: false });
    const result = runReleaseDryRunFixture(
      fixtureRoot,
      {
        PATH: fakeBin
      },
      path.join("artifacts", "release-dry-run", "missing-packager")
    );

    assert.notEqual(result.exitCode, 0);

    const summary = readSummary(fixtureRoot, path.join("artifacts", "release-dry-run", "missing-packager"));
    assert.equal(summary.failed, true);
    assert.equal(summary.steps?.at(-1)?.key, "03-package");
    assert.equal(summary.steps?.at(-1)?.status, "failed");
    const stderrPath = summary.steps?.at(-1)?.stderrPath ?? "";
    assert.equal(existsSync(stderrPath), true);
    assert.match(readRequiredText(stderrPath), /Unable to resolve command source|powershell/i);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Node child_process cannot spawn powershell.exe in this environment.");
      return;
    }
    throw error;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("release dry-run helper records only a failed step when a command exits non-zero", (t) => {
  const fixtureRoot = createReleaseDryRunFixture();

  try {
    const fakeBin = createFakeCommandBin(fixtureRoot, { npmExitCode: 23 });
    const result = runReleaseDryRunFixture(
      fixtureRoot,
      {
        PATH: fakeBin
      },
      path.join("artifacts", "release-dry-run", "build-nonzero")
    );

    assert.notEqual(result.exitCode, 0);

    const summary = readSummary(fixtureRoot, path.join("artifacts", "release-dry-run", "build-nonzero"));
    assert.equal(summary.failed, true);
    assert.equal(summary.steps?.length, 1);
    assert.equal(summary.steps?.[0]?.key, "01-build");
    assert.equal(summary.steps?.[0]?.status, "failed");
    assert.equal(summary.steps?.[0]?.exitCode, 23);
    assert.equal(typeof summary.steps?.[0]?.durationMs, "number");
    assert.equal(summary.steps?.[0]?.timedOut, false);
    assert.match(String(summary.steps?.[0]?.errorMessage ?? ""), /exited with code 23/i);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Node child_process cannot spawn powershell.exe in this environment.");
      return;
    }
    throw error;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("release dry-run helper preflight records the resolved npm command source that matches execution rules", (t) => {
  const fixtureRoot = createReleaseDryRunFixture();

  try {
    const fakeBin = createFakeCommandBin(fixtureRoot, { includeNpmPs1: true });
    const result = runReleaseDryRunFixture(
      fixtureRoot,
      {
        PATH: fakeBin
      },
      path.join("artifacts", "release-dry-run", "npm-resolution")
    );

    assert.equal(result.exitCode, 0);

    const summary = readSummary(fixtureRoot, path.join("artifacts", "release-dry-run", "npm-resolution"));
    assert.match(summary.preflight?.npm ?? "", /npm\.cmd/i);
    assert.equal(summary.preflight?.checks?.find((check) => check.name === "npm")?.status, "passed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Node child_process cannot spawn powershell.exe in this environment.");
      return;
    }
    throw error;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
