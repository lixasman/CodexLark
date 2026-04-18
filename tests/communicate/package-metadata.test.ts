import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type PackageJson = {
  description?: string;
  dependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: {
    ''?: {
      license?: string;
    };
  };
};

function loadPackageJson(): PackageJson {
  const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw) as PackageJson;
}

function loadPackageLock(): PackageLock {
  const raw = readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8');
  return JSON.parse(raw) as PackageLock;
}

test('package metadata describes the Feishu Codex control project without browser automation deps', () => {
  const pkg = loadPackageJson();
  const description = pkg.description ?? '';
  const dependencies = pkg.dependencies ?? {};

  assert.match(description, /Feishu/i);
  assert.match(description, /Codex/i);
  assert.equal('playwright-core' in dependencies, false);
  assert.equal('turndown' in dependencies, false);
  assert.equal('turndown-plugin-gfm' in dependencies, false);
});

test('package-lock metadata stays aligned with the published MIT license', () => {
  const lock = loadPackageLock();
  assert.equal(lock.packages?.['']?.license, 'MIT');
});
