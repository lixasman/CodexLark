# 安装 / 启动支持矩阵

> 适用范围：`Install-CodexLark.ps1`、`run-admin-task.ps1`、`Install-CodexLark-Autostart.ps1`、`Uninstall-CodexLark-Autostart.ps1`

## 结论先看

- 正式支持：Windows 主机上的 Windows PowerShell 5.1 FullLanguage。
- 支持：Windows 主机上的 PowerShell 7 FullLanguage；自启动相关脚本会给出兼容性 warning，因为计划任务命令最终依赖 Windows 兼容层。
- 明确不支持：`ConstrainedLanguage`、`RestrictedLanguage`、非 Windows 主机、缺少 ScheduledTasks 支持的自启动场景。
- 当前 host contract 只会对可检测的前置条件统一 fail-fast，例如非 Windows、`ConstrainedLanguage` / `RestrictedLanguage`，以及自启动脚本缺少 ScheduledTasks 支持；AppLocker / WDAC / ExecutionPolicy / 杀毒 / 代理等阻断如果只在后续命令执行时显现，仍可能在对应操作点报原生错误，并附日志路径与手动 fallback 提示。

## Supported-host contract

| 场景 | 主机要求 | 结果 | 备注 |
| --- | --- | --- | --- |
| 安装器 `Install-CodexLark.ps1` | Windows + Windows PowerShell 5.1 FullLanguage | 正式支持 | 推荐首启路径 |
| 安装器 `Install-CodexLark.ps1` | Windows + PowerShell 7 FullLanguage | 支持 | 可正常运行；如果后续链路受企业策略拦截，可能在操作点报原生错误，必要时改走手动路径 |
| 启动脚本 `run-admin-task.ps1` | Windows + FullLanguage + 可提权 | 支持 | 飞书长连接仍要求管理员提权 |
| 自启动安装 / 卸载 | Windows + FullLanguage + ScheduledTasks 可用 | 支持 | PowerShell 7 会先给兼容性 warning |
| 任一入口脚本 | `ConstrainedLanguage` / `RestrictedLanguage` | 不支持 | 这是当前可检测的前置条件，会直接 fail-fast |
| 自启动安装 / 卸载 | 缺少 `Register-ScheduledTask` / `Get-ScheduledTask` | 不支持 | 这是自启动专属的可检测前置条件；安装器本身不会因此整体 fail-fast |

## 失败类别与日志

入口脚本统一使用 `unsupported-host` 作为不受支持环境的失败类别，并在对应日志目录里写入运行时检查结果：

- 安装器：`artifacts/setup/runtime-contract.json`
- 启动脚本：`artifacts/feishu-realtest/feishu-longconn-runtime-contract.json`
- 自启动安装：`artifacts/setup/autostart-install-runtime-contract.json`
- 自启动卸载：`artifacts/setup/autostart-uninstall-runtime-contract.json`

日志会统一记录：

- `psVersion`
- `psEdition`
- `languageMode`
- `isAdministrator`
- `supportsScheduledTasks`
- 失败摘要、支持文档路径、手动 fallback 提示

## 常见企业环境阻断

### 1. AppLocker / WDAC

常见现象：脚本可以打开，但在 `Start-Process`、`powershell.exe`、`node` 或 `npm install` 上被策略阻断。

处理建议：

- 先确认公司是否允许执行来自仓库目录的脚本与 Node 工具链。
- 如果不允许，直接改走 README 里的手动路径或在受信任目录重新部署。
- 不要指望安装器自动绕过 AppLocker / WDAC；当前版本也不会为所有这类策略做统一前置探测，阻断可能在具体操作点以原生错误暴露。

### 2. ExecutionPolicy / ConstrainedLanguage

常见现象：PowerShell 进入 `ConstrainedLanguage`，或必须在受限策略下运行脚本。

处理建议：

- 如果策略最终让 PowerShell 落到 `ConstrainedLanguage` / `RestrictedLanguage`，当前开源安装 / 启动入口会在 host contract 阶段直接 fail-fast。
- 如果策略没有改变 language mode、而是在后续脚本/命令执行时才拦截，则可能在对应操作点看到原生错误；不要反复重试安装器，直接改走 README 的“快速开始”手动路径，并确认企业策略是否允许必要命令。
- 如果企业允许，优先在 Windows PowerShell 5.1 FullLanguage 或 PowerShell 7 FullLanguage 中重新执行。

### 3. 计划任务被禁用

常见现象：`Register-ScheduledTask` / `Unregister-ScheduledTask` 不存在，或注册时被组策略拒绝。

处理建议：

- 这会影响 `Install-CodexLark-Autostart.ps1` 与 `Uninstall-CodexLark-Autostart.ps1`，但不影响安装器主体流程，也不影响手动启动 `run-admin-task.ps1`。
- 如果机器不允许计划任务，自启动属于明确不支持；请保留手动启动或使用你自己的企业批准机制。

### 4. 杀毒 / EDR / 代理

常见现象：`winget`、`npm install`、`codex --login` 或网络诊断被公司代理、杀毒、EDR 拦截。

处理建议：

- 安装器更适合个人开发机；在强企业管控环境里，手动路径通常更容易按步骤定位问题。
- 如果代理要求额外配置，请先按企业规范配置 `winget`、Node、npm、浏览器登录，再回到 README 的“快速开始”。

## 安装器 vs 手动路径

优先用安装器：

- 个人 Windows 电脑
- `winget`、网络访问、管理员提权可用
- PowerShell 为 FullLanguage
- 希望自动生成后续启动 / 修复入口

优先用手动路径：

- 企业设备上存在 AppLocker、ExecutionPolicy、`ConstrainedLanguage`、计划任务禁用、代理或杀毒阻断，且你更希望按步骤处理原生错误
- 你只想排障、做本地评估或二次开发
- 你明确不希望安装器修改用户环境变量或自动拉起安装步骤

手动路径入口见 README 的“快速开始”。
