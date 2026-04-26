import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

function readRequiredText(filePath: string): string {
  assert.equal(existsSync(filePath), true, `expected file to exist: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

function readmePath(): string {
  return path.join(process.cwd(), "README.md");
}

function productInstallerDocPath(): string {
  return path.join(process.cwd(), "docs", "workflows", "product-installer.md");
}

function releaseGatesDocPath(): string {
  return path.join(process.cwd(), "docs", "workflows", "product-installer-release-gates.md");
}

test("README separates download users from source developers and links product installer docs", () => {
  const readme = readRequiredText(readmePath());

  assert.match(readme, /普通下载用户|下载用户/);
  assert.match(readme, /源码|开发者|手动路径/);
  assert.match(readme, /如果你走 EXE 安装器|普通下载用户可以跳过本节|仅适用于源码|手动路径环境要求/);
  assert.match(readme, /源码路径下的仓库安装器|源码仓库的安装器|源码路径/);
  assert.match(readme, /npm run build[\s\S]*build-installer\.ps1/);
  assert.match(readme, /product-installer\.md/);
  assert.match(readme, /product-installer-release-gates\.md/);
  assert.doesNotMatch(readme, /如果你是第一次接触这个项目，建议优先使用仓库根目录的 `Install-CodexLark\.ps1`/);
  assert.doesNotMatch(readme, /建议优先阅读后面的“推荐首启安装器”与“初次评估路径”/);
});

test("product installer workflow doc covers download, source, and diagnostics flows", () => {
  const doc = readRequiredText(productInstallerDocPath());

  assert.match(doc, /下载用户路径|下载流程/);
  assert.match(doc, /源码|开发者路径|source\/developer/i);
  assert.match(doc, /export-diagnostics/);
  assert.match(doc, /setup-diagnostics\.json/);
  assert.match(doc, /\$installRoot = Join-Path \$env:ProgramFiles 'CodexLark'[\s\S]*node\.exe[\s\S]*dist\\setup-cli\.js[\s\S]*export-diagnostics/);
  assert.match(doc, /node \.\\dist\\setup-cli\.js export-diagnostics/);
  assert.match(doc, /install-startup-support-matrix\.md|支持矩阵/);
  assert.match(doc, /AppLocker|WDAC|ExecutionPolicy|EDR/);
  assert.match(doc, /first-run/);
  assert.match(doc, /repair/);
});

test("release gates doc includes dependency, permission, migration, secret, diagnostics, and signing gates", () => {
  const doc = readRequiredText(releaseGatesDocPath());

  assert.match(doc, /codex.*受控外部依赖|Controlled External Dependency/i);
  assert.match(doc, /统一权限模型|permission model/i);
  assert.match(doc, /legacy migration gate|迁移闸门|迁移 gate/i);
  assert.match(doc, /secret/i);
  assert.match(doc, /diagnostics/i);
  assert.match(doc, /Authenticode|code signing|签名/i);
  assert.match(doc, /SHA256/i);
  assert.match(doc, /release gate checklist|发布门槛清单|发布检查清单/i);
  assert.match(doc, /npm run build/);
  assert.match(doc, /fresh build|最新构建产物|陈旧.*dist|stale artifact/i);
  assert.match(doc, /旧 staging|禁止复用旧 staging|旧产物/);
  assert.match(doc, /install-startup-support-matrix\.md|支持矩阵/);
  assert.match(doc, /ConstrainedLanguage/);
  assert.match(doc, /AppLocker/);
  assert.match(doc, /ExecutionPolicy/);
  assert.match(doc, /export-diagnostics/);
  assert.match(doc, /node\.exe/);
  assert.match(doc, /干净验证机|验证机|安装刚打出来的 EXE|新打出来的 EXE|fresh install/i);
});
