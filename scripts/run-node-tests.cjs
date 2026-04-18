const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTransientTestBuildDir } = require('./test-build-artifacts.cjs');

function collectTests(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(full);
    }
  }
  return files.sort();
}

function parseFlags(argv) {
  return {
    buildOnly: argv.includes('--build-only')
  };
}

function compileTests(outDir) {
  const tscCli = require.resolve('typescript/bin/tsc');
  const result = spawnSync(
    process.execPath,
    [tscCli, '-p', path.join(process.cwd(), 'tsconfig.tests.json'), '--outDir', outDir],
    { stdio: 'inherit' }
  );
  return result.status ?? 1;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const workspaceRoot = process.cwd();
  const { runsRoot, outDir } = createTransientTestBuildDir(workspaceRoot);

  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const buildStatus = compileTests(outDir);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }

  if (flags.buildOnly) {
    console.log(path.relative(workspaceRoot, outDir));
    return;
  }

  const testRoot = path.join(outDir, 'tests');
  const testFiles = collectTests(testRoot);
  if (testFiles.length === 0) {
    console.error(`No compiled test files found under ${testRoot}`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...testFiles], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

main();
