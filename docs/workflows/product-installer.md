# Product Installer Workflow

面向对象：

- 普通下载用户：双击 EXE 安装器，尽量不接触源码和 PowerShell 细节
- 源码 / 开发者用户：从仓库构建、调试、排障或维护发布流程

当前定位：

- EXE 安装器是面向普通下载用户的主路径
- 仓库内 PowerShell 安装脚本和手动命令仍然保留，但定位为源码 / 开发者路径

## 1. 下载用户路径

适合人群：

- 你只是想把 CodexLark 装到自己的 Windows 电脑上
- 你不想手动执行 `npm install`、`npm run build`
- 你接受安装器写入 `Program Files\CodexLark`

流程：

1. 下载发布页提供的 `CodexLark-Setup-<version>.exe`
2. 双击安装，按向导完成安装
3. 安装器写入产品文件、快捷方式和卸载入口
4. 安装结束后，安装器会先同步 runtime manifest
5. 然后安装器会回到原桌面用户上下文执行 `first-run`

首次启动向导负责：

- 检查 `codex` 是否存在
- 在需要时走受控安装 / 版本校验 / 登录态校验
- 写入普通配置和 secret reference
- 生成 `first-run` / `doctor` / `repair` 所需的本地状态

安装完成后，用户通常只需要看到：

- Launch CodexLark
- Repair CodexLark
- Uninstall CodexLark

## 2. 源码 / 开发者路径

适合人群：

- 你需要本地调试、二次开发或排障
- 你要验证 `dist/`、`setup-cli`、PowerShell bridge 脚本
- 你是发布维护者，需要打 EXE 安装包

常见入口：

```powershell
npm install
npm run build
node .\scripts\doctor.cjs
```

如果你需要源码态安装与启动入口，也可以使用仓库根目录脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-CodexLark.ps1
```

如果你是在维护发布流程，还需要先确认 `iscc` 可用，再运行：

```powershell
Get-Command iscc
powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1
```

预期结果：

- `dist/` 已生成
- `dist/setup-cli.js` 可执行 `first-run` / `repair` / `doctor` / `export-diagnostics`
- `artifacts\packaging\output\` 产出 EXE 安装器

## 3. Diagnostics 导出路径

当用户安装后遇到问题，优先不要让他手工翻散乱日志，而是走统一 diagnostics 导出。

对普通下载用户，优先使用安装目录里内置的 `node.exe`，而不是假设系统 PATH 里已经有 `node`。

命令入口：

```powershell
$installRoot = Join-Path $env:ProgramFiles 'CodexLark'
& (Join-Path $installRoot 'node.exe') (Join-Path $installRoot 'dist\setup-cli.js') export-diagnostics
```

预期结果：

- 生成 machine-readable summary：`%LocalAppData%\CodexLark\artifacts\setup\export-diagnostics-summary.json`
- 生成导出文件：`%LocalAppData%\CodexLark\artifacts\diagnostics\setup-diagnostics.json`

如果这一步在受限宿主里被拦截，例如 `AppLocker`、`WDAC`、`ExecutionPolicy`、`EDR` 或其他企业策略，不要直接把它判断为安装器本体损坏；请回到支持边界文档 [`docs/workflows/install-startup-support-matrix.md`](./install-startup-support-matrix.md) 对照当前机器环境。

如果你是源码 / 开发者路径，也可以在仓库根目录运行：

```powershell
node .\dist\setup-cli.js export-diagnostics
```

导出内容特点：

- 只导出白名单字段
- 保留必要的 `paths`、配置存在性和状态摘要
- 不导出原始 secret
- `settings.json` 里只保存普通配置，不直接保存 `FEISHU_APP_SECRET`

## 4. Repair 与回归思路

如果下载用户反馈“安装好了但不能跑”，优先顺序是：

1. 让用户运行 Repair CodexLark
2. 再按上面的安装目录命令运行 diagnostics 导出
3. 最后再根据 summary / diagnostics 判断是 `codex`、权限、旧残留，还是本地环境阻断

源码 / 开发者路径下，建议至少覆盖：

- `first-run`
- `repair`
- `doctor`
- `export-diagnostics`
- legacy migration
- canonical launcher
- Inno Setup 打包契约
