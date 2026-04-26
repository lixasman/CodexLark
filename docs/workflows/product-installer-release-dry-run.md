# Product Installer Release Dry-Run

这个 runbook 面向发布维护者：目标不是“本机能打包就算完”，而是把 EXE 安装器在发布前按固定顺序走完一轮构建、打包、干净机器验证，并留下可追溯的日志与摘要。

## 1. 适用范围

适合场景：

- 你准备给普通下载用户发布 `CodexLark-Setup-<version>.exe`
- 你希望先在维护者机器上完成一次有日志的 dry-run
- 你还要在一台干净 Windows 个人电脑上确认安装、repair、diagnostics、卸载和覆盖安装都正常

不适合场景：

- 只想做源码调试或单独跑某个测试
- 当前机器没有 `node`、`npm` 或 `iscc`
- 你还没先完成仓库里的功能改动与常规回归

## 2. 阶段 A：维护者机器打包 dry-run

### 2.1 先确认前置

在仓库根目录运行：

```powershell
Get-Command node
Get-Command npm
Get-Command iscc
```

预期结果：

- PowerShell 能解析出可用的 `node` 命令来源
- PowerShell 能解析出可用的 `npm` 命令来源
- PowerShell 能解析出可用的 `iscc` 命令来源

说明：

- 这里的 `Get-Command ...` 只是给维护者做人工粗检，帮助你先确认机器上大致有这些命令。
- 真正决定 helper 会执行哪个文件的，不是裸 `Get-Command` 结果，而是脚本内部复用的 `Resolve-CodexLarkCommandSource` 解析规则；例如 Windows PowerShell 里 `npm` 可能先显示成 `npm.ps1`，但 helper 仍会优先选择可执行的 `Application`（如 `npm.cmd`）。

### 2.2 运行发布 dry-run 脚本

在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package\run-product-installer-release-dry-run.ps1
```

这个脚本会按固定顺序执行：

1. `npm run build`
2. `node .\scripts\run-node-tests.cjs`
3. `powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1`
4. 计算 EXE 的 `SHA256`
5. 在 `artifacts\release-dry-run\<timestamp>\` 下写出分步骤日志和 `release-dry-run-summary.json`

脚本会先做 preflight：`node`、`npm`、`iscc` 缺任何一个都直接失败，不会先给你“前置通过”的错觉再在第 1 步才爆掉。

如果你需要显式指定要打包进 EXE 的 `node.exe`，可以改用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package\run-product-installer-release-dry-run.ps1 `
  -BundledNodePath 'C:\Program Files\nodejs\node.exe'
```

### 2.3 阶段 A 通过标准

至少确认以下结果：

- `artifacts\packaging\output\CodexLark-Setup-<version>.exe` 已生成
- `artifacts\release-dry-run\<timestamp>\release-dry-run-summary.json` 存在
- 同目录下能看到 `01-build.out.log`、`02-tests.out.log`、`03-package.out.log` 与对应 `.err.log`
- summary 里记录了：
  - 维护者机器解析到的 `node` / `npm` / `iscc` 命令来源
  - 如果 preflight 失败，会记录 `failedCommand`、每个检查项的状态，以及错误信息
  - 每个步骤的退出码、日志路径和耗时
  - 最终安装包路径
  - `SHA256`

如果阶段 A 失败，不要直接手工重试多遍；先打开 summary 和对应 step log，确认到底是 preflight 缺命令、构建失败、测试失败，还是 `iscc` / 打包阶段失败。helper 会尽量把 preflight 失败信息、失败步骤和日志路径都写回 summary。

## 3. 阶段 B：干净 Windows 验证机

建议准备一台普通个人 Windows 10/11 电脑，避免沿用长期开发机；至少不要复用你的主开发仓库目录。

### 3.1 Fresh install 验证

1. 把阶段 A 生成的 `CodexLark-Setup-<version>.exe` 拷到验证机
2. 双击运行安装器，按向导完成安装
3. 安装完成后，确认开始菜单或桌面入口里至少能看到：
   - `Launch CodexLark`
   - `Repair CodexLark`
   - `Uninstall CodexLark`
4. 首次启动完成后，确认没有立刻爆红退出；如果有错误，先记录错误文案和本地 artifacts 路径

预期结果：

- 产品目录写入 `Program Files\CodexLark`
- 首次启动向导能继续执行，而不是刚安装完就立刻崩掉
- repair / uninstall 入口都已生成

### 3.2 新版覆盖安装验证

如果这次发布涉及“用户重新下载安装新版覆盖安装”，不要直接接着 3.1 在同一台已被 fresh install 污染过的机器上继续测；请先回滚到干净快照、重置验证机，或换第二台机器后再走下面这轮：

1. 先安装上一版 EXE，并至少启动一次
2. 再运行本次新 EXE，直接覆盖安装
3. 安装结束后再次检查：
   - `Launch CodexLark`
   - `Repair CodexLark`
   - `Uninstall CodexLark`
4. 确认新版安装后仍能正常进入 `first-run` / 正常启动，而不是残留旧快捷方式、旧脚本或旧 runtime manifest

预期结果：

- 覆盖安装不会因为旧 staging、旧 launcher 或旧 runtime manifest 留下漂移
- repair 入口仍指向当前版本的安装目录

### 3.3 Repair 与 diagnostics 验证

在验证机上至少执行一次 Repair，然后导出 diagnostics：

```powershell
$installRoot = Join-Path $env:ProgramFiles 'CodexLark'
& (Join-Path $installRoot 'node.exe') (Join-Path $installRoot 'dist\setup-cli.js') export-diagnostics
```

预期结果：

- Repair CodexLark 能启动并完成，而不是直接闪退
- `%LocalAppData%\CodexLark\artifacts\setup\export-diagnostics-summary.json` 存在
- `%LocalAppData%\CodexLark\artifacts\diagnostics\setup-diagnostics.json` 存在
- 导出的 diagnostics 已做脱敏（redaction），不包含原始 secret
- 维护者需要实际打开 `setup-diagnostics.json` 或做关键字检查，确认没有把原始 secret 明文带出去

### 3.4 卸载验证

最后运行 `Uninstall CodexLark`。

预期结果：

- 卸载向导能正常完成
- `Program Files\CodexLark` 不再残留主程序文件
- 旧的启动/修复快捷方式不会继续指向已卸载位置

## 4. 发布前必须记录的内容

建议把下面这些信息贴到 release 记录、发布说明草稿或 issue 中：

- 安装包完整路径
- 安装包 `SHA256`
- `artifacts\release-dry-run\<timestamp>\release-dry-run-summary.json`
- 阶段 B 使用的 Windows 版本
- fresh install / 覆盖安装 / repair / diagnostics / uninstall 是否全部通过
- diagnostics redaction 是否人工复核通过
- 当前安装包是否已完成 Authenticode 签名
- Defender / SmartScreen / 下载告警结果
- 如果尚未签名，发布说明里是否明确标注为 `preview`
- 如果仍有支持边界，明确引用 [`install-startup-support-matrix.md`](./install-startup-support-matrix.md)

## 5. 失败时的排障顺序

推荐按这个顺序排：

1. 先看 `release-dry-run-summary.json`
2. 再看对应步骤的 `*.err.log`
3. 如果打包成功但验证机失败，优先导出 `setup-diagnostics.json`
4. 如果问题和企业宿主策略相关，回到 [`product-installer-release-gates.md`](./product-installer-release-gates.md) 与 [`install-startup-support-matrix.md`](./install-startup-support-matrix.md) 对照，不要把所有原生报错都误判成安装器实现缺陷
