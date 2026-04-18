import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

type PackageJson = {
  scripts?: Record<string, string>;
};

type TestBuildArtifactsModule = {
  createTransientTestBuildDir: (
    workspaceRoot: string,
    options?: {
      timestamp?: string;
      pid?: number;
      random?: string;
    }
  ) => {
    runsRoot: string;
    outDir: string;
  };
};

function loadPackageJson(): PackageJson {
  const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw) as PackageJson;
}

function loadRunnerSource(): string {
  return readFileSync(path.join(process.cwd(), 'scripts', 'run-node-tests.cjs'), 'utf8');
}

function loadTestBuildArtifactsModule(): TestBuildArtifactsModule {
  return require(path.join(process.cwd(), 'scripts', 'test-build-artifacts.cjs')) as TestBuildArtifactsModule;
}

test('test build artifacts helper allocates unique run directories under .test-dist-runs', () => {
  const { createTransientTestBuildDir } = loadTestBuildArtifactsModule();
  const workspaceRoot = process.cwd();

  const first = createTransientTestBuildDir(workspaceRoot, {
    timestamp: '20260331T190000Z',
    pid: 101,
    random: 'alpha1'
  });
  const second = createTransientTestBuildDir(workspaceRoot, {
    timestamp: '20260331T190000Z',
    pid: 101,
    random: 'beta22'
  });

  assert.equal(first.runsRoot, path.join(workspaceRoot, '.test-dist-runs'));
  assert.equal(path.dirname(first.outDir), first.runsRoot);
  assert.equal(path.dirname(second.outDir), second.runsRoot);
  assert.notEqual(first.outDir, second.outDir);
  assert.notEqual(path.basename(first.outDir), '.test-dist');
});

test('npm test delegates test compilation and execution to the node runner script', () => {
  const pkg = loadPackageJson();

  assert.equal(pkg.scripts?.['build:test'], 'node ./scripts/run-node-tests.cjs --build-only');
  assert.equal(pkg.scripts?.test, 'node ./scripts/run-node-tests.cjs');
});

test('node test runner does not prune sibling transient runs during a normal test invocation', () => {
  const source = loadRunnerSource();

  assert.doesNotMatch(source, /pruneTransientTestBuildDirs\s*\(/);
});
