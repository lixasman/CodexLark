# CodexLark

> 飞书里的本机 Codex 稳定入口。

CodexLark 是一个面向 Windows + PowerShell 的个人工作流产品，让你在飞书里稳定地启动、恢复、控制和接管本地 Codex 会话。

它把高频但容易打断节奏的动作收拢到同一个地方：恢复上下文、继续已有任务、切换当前模式、查看状态、接管任务。

English summary: [README.en.md](./README.en.md)

## 安装提示

当前 Release 上传的 `.exe` 安装包由于没有软件签名，可能会被 Windows / 浏览器 / Microsoft Defender SmartScreen 拦截。为了避免安装时被风控卡住，建议大家直接下载源码版并按部署视频安装。

- 源码版安装：在 GitHub 页面点击 `Code` -> `Download ZIP`，解压后运行仓库安装器
- 详细部署视频（包含飞书开放平台配置与源码版安装）：[B 站视频教程](https://www.bilibili.com/video/BV1bsoCB5EsF/)

## 为什么要用

- 重启之后还能找回上下文和任务入口
- 当前模式、当前任务、常用操作都在状态卡里可见
- 已有任务可以继续、接管、管理，不必靠回忆命令或翻本地终端
- 飞书不是临时消息通道，而是本机 Codex 的长期控制面

## 日常可用，靠这 3 件事

### 会话恢复

本地会话注册表让线程上下文和任务入口可以跨重启延续，不用每天重新找回昨天做到哪。

### 状态卡控制

统一状态卡把模式、任务和常用操作放到可见位置，比纯文本命令流更适合长期使用，也更不容易误操作。

### 任务接管

已有任务可以在飞书里继续和接管，不必回到一堆本地终端里重新找入口。

## 适合谁

- 你希望从飞书里远程启动或继续本机 Codex 任务
- 你主要在 Windows 机器上工作，并接受 PowerShell 作为默认环境
- 你需要会话恢复、状态卡控制、任务接管这类工作流能力
- 你更在意“每天都能稳定使用”，而不是“接入越多平台越好”

## 不适合谁

- 追求跨平台一键部署的团队服务
- 需要浏览器自动化、多站点采集或历史旧功能的用户
- 不接受管理员权限启动飞书长连接进程的环境
- 只想找一个通用聊天接线层，而不关心本地 Windows 工作流的人

## 典型工作流

1. 登录 Windows 机器后，启动飞书长连接服务
2. 在飞书线程里用状态卡或启动入口恢复已有任务，或启动新任务
3. 继续输入、切换模式、查询状态或关闭任务
4. 需要时直接接管已有任务
5. 在同一个线程里把本机工作持续推进

如果你是第一次接触这个项目，建议先看后面的“推荐安装方式”和部署视频；当前普通使用优先下载源码版，不建议把未签名 `.exe` 作为主安装路径。

## 飞书常用操作：项目卡

当聊天消息变多、主状态卡被刷到上面以后，可以直接在同一个飞书线程里发送且仅发送 `项目卡`，把当前这张主状态卡重新拉回聊天底部。

适用场景：

- 你想快速切换项目或新建项目，但不想一直上翻历史消息找状态卡
- 你正在某个线程里持续聊天，想把当前控制入口重新拉回手边
- 你当前看到的是 launcher、status 或带错误提示的状态卡，希望原样召回当前视图

使用说明：

- 关键词固定为 `项目卡`
- 只接受精确匹配；前后空格可以有，但不能多字、少字或带别的内容
- 发送后不会把它当成普通聊天消息，也不会转发给当前 Coding 任务
- 它不会强制切换成启动卡，而是按当前线程的实际状态，重发你此刻正在使用的那张主状态卡

可以把它理解成“把当前状态卡重新发到底部”的快捷口令。

## 源码 / 手动路径环境要求

当前建议直接下载源码版并运行仓库安装器；下面这些前置条件适用于源码版安装、手动排障和开发者路径。

- Windows
- PowerShell
- Node.js 24 或更新版本
- 可执行的 `codex` CLI，或通过 `CODEX_CLI_EXE` 指向实际路径
- 已配置长连接能力的飞书应用

## 飞书开放平台最小配置

源码路径下的仓库安装器可以帮你装 Node.js、Codex CLI 和本地依赖，但不会替你自动完成飞书开放平台里的应用配置。完整飞书配置和源码版安装流程可以参考：[B 站部署视频](https://www.bilibili.com/video/BV1bsoCB5EsF/)。

如果你是第一次接触飞书开放平台，至少先完成下面这些前置项，再回来执行安装器或手动启动：

- 创建一个企业自建应用，并记录 `App ID` / `App Secret`
- 给应用添加“机器人”能力
- 在权限管理里至少开通：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:resource`、`im:message:update`
- 在“事件与回调”中选择“使用长连接接收事件”，并订阅 `im.message.receive_v1`
- 如果你要使用状态卡按钮交互，还需要完成卡片回调相关配置；代码侧当前按 `card.action.trigger` 处理，这一项属于卡片回调配置，不是普通消息事件订阅
- 在“版本管理与发布”里创建并发布版本；很多权限和事件在发布前不会真正生效
- 在“可用范围”里加入你自己和测试对象；如果你要在群里验证，还需要把机器人拉进测试群

如果飞书后台的中文菜单名和本文不完全一致，优先按权限 code / 事件 code 搜索，而不是只靠中文名称硬找。

## 推荐安装方式

### 产品安装方向

- 当前 Release 上传的 `.exe` 安装包还没有软件签名，可能会被系统风控拦截。
- 现阶段推荐大家直接下载源码版，并使用仓库里的 PowerShell 安装脚本完成安装。
- `.exe` 安装包会继续保留为预发布测试包；后续如果完成代码签名，再切换为普通用户主安装入口。

推荐先按身份看文档：

- 普通下载用户：优先看本 README 的“源码版安装（推荐）”和 [B 站部署视频](https://www.bilibili.com/video/BV1bsoCB5EsF/)
- 源码 / 开发者 / 发布维护者：继续看本节、下方“快速开始”和 [`docs/workflows/product-installer-release-gates.md`](./docs/workflows/product-installer-release-gates.md)

### 源码版安装（推荐）

如果你不熟悉 Git，可以直接下载源码压缩包：

1. 打开 GitHub 项目页面
2. 点击 `Code`
3. 点击 `Download ZIP`
4. 解压源码压缩包
5. 在解压后的目录里打开 PowerShell
6. 运行仓库安装器：

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-CodexLark.ps1
```

安装器会检查或安装 Node.js / Codex CLI、引导 Codex 登录、收集飞书配置、安装依赖、构建项目，并生成后续启动与修复入口：

- `Start-CodexLark.ps1`：日常启动飞书长连接
- `Repair-CodexLark.ps1`：重新检查配置、导出诊断或修复迁移状态

完整演示见：[B 站部署视频](https://www.bilibili.com/video/BV1bsoCB5EsF/)。

### EXE 预发布测试包说明

Release 里的 `CodexLark-Setup-<version>.exe` 目前暂未做代码签名，Windows / 浏览器 / Microsoft Defender SmartScreen 可能会提示“通常不会下载”或“无法识别的应用”。这不等同于已检测到病毒，但表示该安装包尚未建立发布者/文件信誉。

如果你不了解这些风险，请直接下载源码版；如果你只是参与测试，请先校验 Release 里的 SHA256，再决定是否安装。

EXE 安装后常用入口：

- `Launch CodexLark`：启动飞书长连接与日常使用入口
- `Repair CodexLark`：重新检查配置、导出诊断或修复迁移状态
- `Uninstall CodexLark`：卸载程序

EXE 安装形态默认把产品文件放在 `Program Files\CodexLark`，把运行状态、日志、diagnostics 和 secret 引用放在 `%LocalAppData%\CodexLark` 下；普通用户不需要接触仓库里的 `dist\`、`node_modules\` 或构建产物。

### 发布维护者：构建 EXE

如果你是在维护发布流程、准备给普通用户打 EXE 安装包，请先完成本地构建并确认 `Get-Command npm`、`Get-Command node`、`Get-Command iscc` 都可用，然后运行：

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1
```

如果你想按固定顺序做一轮“构建 + 测试 + 打包 + 干净机器验证”的发布 dry-run，可以直接看 [`docs/workflows/product-installer-release-dry-run.md`](./docs/workflows/product-installer-release-dry-run.md) 并运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package\run-product-installer-release-dry-run.ps1
```

预期结果：

- 在 `artifacts\packaging\output\` 生成 `CodexLark-Setup-<version>.exe`
- 安装包内置 `node.exe`、预编译 `dist\`、启动/修复入口与 PowerShell bridge 脚本
- 安装完成后会先同步 runtime manifest，再以原桌面用户身份触发 `first-run`

打包说明：

- `scripts\package\build-installer.ps1` 会把 staging/output 目录限制在 `artifacts\packaging\` 下，避免误删其他目录
- 默认会通过当前 Node 的真实 `process.execPath` 解析要内置的 `node.exe`
- 如果你的开发机用了 Volta / nvs / 其他 shim 管理器，且你想显式指定打包进去的 Node，可传 `-BundledNodePath <node.exe 全路径>`

### 源码 / 开发者：仓库安装器

如果你是从源码仓库开始评估、调试或维护这个项目，可以使用仓库根目录的 `Install-CodexLark.ps1`，而不是直接手动逐步配置。

适用范围：

- 普通个人 Windows 10/11 电脑
- 可联网
- 已安装 `winget`
- PowerShell 主机为 Windows PowerShell 5.1 或 PowerShell 7，且语言模式为 `FullLanguage`
- 允许管理员提权
- 已按你的飞书开放平台配置流程准备好 App ID / App Secret

运行方式：

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-CodexLark.ps1
```

预期结果：

- 自动检查 `winget`、Node.js、Codex CLI、本地环境变量与构建前置
- 自动安装缺失的 Node.js / Codex CLI
- 引导你完成一次 Codex 登录
- 自动执行 `npm install`、`npm run build` 与 `node .\scripts\doctor.cjs`
- 让你自己选择是否启用开机自启动
- 生成后续可直接使用的启动/修复入口

说明：

- 如果机器缺少 `winget`，安装器会直接告警退出；首版不提供无 `winget` 兜底
- 当前 host contract 只会对可检测的主机前置条件统一 fail-fast，例如非 Windows、`ConstrainedLanguage` / `RestrictedLanguage`，以及自启动脚本缺少 ScheduledTasks 支持；AppLocker / WDAC / ExecutionPolicy / 杀毒 / 代理等阻断如果只在后续命令里显现，仍可能在具体操作点报原生错误，届时请根据日志路径改走手动 fallback
- 安装完成后，是否立即启动飞书长连接由你自己确认
- 详细支持边界、受支持 PowerShell 版本与常见企业阻断见 [`docs/workflows/install-startup-support-matrix.md`](./docs/workflows/install-startup-support-matrix.md)
- 下方“快速开始”仍然保留，适合手动安装、排障或二次开发场景

### 安装器 / 手动路径怎么选

优先使用安装器的情况：

- 你在个人 Windows 10/11 电脑上，允许管理员提权
- 当前 PowerShell 是 `FullLanguage`，并且 `winget`、网络访问未被企业策略封锁；如果你还打算启用计划任务自启动，再额外确认 ScheduledTasks 没被禁用
- 你希望一次性完成 Node.js、Codex CLI、构建、doctor 和后续启动入口的准备

优先走手动路径（见下方“快速开始”）的情况：

- 当前机器没有 `winget`，或公司代理 / 杀毒 / EDR 会拦截 `winget`、`npm install`、`Start-Process`
- 当前 PowerShell 是 `ConstrainedLanguage`，或者你预期 ExecutionPolicy / AppLocker / WDAC / 杀毒 / 代理 会在后续命令阶段拦截安装步骤
- 你只想做本地评估、排障或二次开发，不希望安装器修改本机环境

## 初次评估路径

如果你只是想判断这个项目是否值得继续配置真实飞书环境，建议先走一遍本地评估路径：

```powershell
npm install
npm run build
node .\scripts\doctor.cjs
npm test
```

预期结果：

- `npm run build` 通过，生成 `dist/agent-cli.js`
- `node .\scripts\doctor.cjs` 输出一组 `PASS / FAIL / INFO` 检查项，明确告诉你当前还缺什么
- `npm test` 跑完自动化回归，不依赖固定 `.test-dist` 目录

如果你需要的是跨平台、无管理员权限、团队共享部署的方案，到这里就可以先停止评估；这个仓库当前并不主打那条路线。

## 快速开始（手动路径 / 高级用户 / 排障）

### 1. 安装依赖

```powershell
npm install
```

预期结果：安装 `typescript` 与类型依赖，生成可用的 `node_modules/`。

### 2. 配置环境变量

根目录提供了 `.env.example` 作为变量参考模板。注意：项目本身不会自动加载 `.env` 文件，你需要手动在当前 PowerShell 会话、用户环境变量或启动脚本中设置这些值。

```powershell
$env:FEISHU_APP_ID = 'cli_xxx'
$env:FEISHU_APP_SECRET = 'replace_me'
$env:CODEX_CLI_EXE = 'codex'
$env:COMMUNICATE_ASSISTANT_CWD = $PWD.Path
$env:COMMUNICATE_FEISHU_IMAGE_DIR = '.\Communicate'
```

预期结果：当前 PowerShell 会话中已经有可用的飞书应用凭证与默认工作目录配置。

### 3. 构建项目

```powershell
npm run build
```

预期结果：生成 `dist/agent-cli.js` 及相关编译产物，命令退出码为 0。

### 4. 运行本地预检

```powershell
node .\scripts\doctor.cjs
```

预期结果：脚本会输出本地检查结果，覆盖 Windows 平台、Node.js 版本、`codex` CLI、飞书凭证、构建产物和管理员启动提示。启动真实飞书链路前，建议先把 `FAIL` 项清零。

如需机器可读结果：

```powershell
node .\scripts\doctor.cjs --json
```

### 5. 启动飞书长连接

推荐使用仓库自带的管理员脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-admin-task.ps1
```

预期结果：脚本会自提权并启动飞书长连接进程，日志默认写入 `artifacts/feishu-realtest/`。

如果你已经在管理员 PowerShell 中，也可以直接运行：

```powershell
node .\dist\agent-cli.js feishu-longconn --feishuAppId $env:FEISHU_APP_ID
```

兼容别名：

```powershell
node .\dist\agent-cli.js feishu-webhook --feishuAppId $env:FEISHU_APP_ID
```

### 6. 在飞书里发送消息验证链路

预期现象：

- 飞书消息能进入本地服务
- 本地创建或恢复对应任务
- 状态卡与回复能继续更新
- 日志与会话注册表落到本地目录

## 开机自启动（计划任务）

如果你希望这条飞书长连接启用开机自启动，可以使用仓库根目录的新脚本注册计划任务。

注意：

- 任务仍然复用现有 `run-admin-task.ps1` 管理日志、PID 和管理员启动链路
- 安装/卸载脚本会请求管理员授权，请先自行阅读脚本内容再执行
- 自启动安装/卸载脚本会在检测到缺少 ScheduledTasks 支持或受限语言模式时尽早退出；如果企业策略是在 `Register-ScheduledTask` 或后续提权/启动阶段才拦截，仍可能在对应操作点报原生错误。安装器本身不会因为计划任务缺失而整体 fail-fast；请先看支持矩阵，再决定是否改走手动路径

安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-CodexLark-Autostart.ps1
```

预期结果：

- 注册名为 `\CodexLark-FeishuLongConn` 的计划任务
- 目标脚本为仓库内的 `run-admin-task.ps1`

关闭：

```powershell
powershell -ExecutionPolicy Bypass -File .\Uninstall-CodexLark-Autostart.ps1
```

预期结果：对应计划任务被删除，后续登录不再自动启动飞书长连接。

## 安全与权限提醒

在公开使用或二次开发前，请先理解以下风险：

- 飞书长连接进程当前必须以管理员权限启动，否则本地 Codex 拉起可能出现 `spawn EPERM`
- 项目会代表当前机器用户启动本地 Codex CLI；请只在你信任的机器、目录和飞书应用配置下使用
- 默认工作模式会让 Codex 任务运行在较高权限的本机环境中，请仔细评估本地文件访问与命令执行风险
- 运行过程中会在本地写入日志、任务注册表和图片文件，敏感信息可能出现在这些产物中
- 请不要将真实的飞书凭证、日志、截图或会话注册表提交到公开仓库

更详细的安全提交流程与使用建议见 `SECURITY.md`。

## 整体架构

```text
+-------------------+         +----------------------------------+
| Feishu            |         | Local Windows Workstation        |
| - text message    |         |                                  |
| - image message   | ----->  |  +----------------------------+  |
| - card action     |         |  | Feishu Long Connection     |  |
+-------------------+         |  | Runtime                    |  |
                              |  +-------------+--------------+  |
                              |                |                 |
                              |                v                 |
                              |  +----------------------------+  |
                              |  | Service / Router / Storage |  |
                              |  | - task routing             |  |
                              |  | - session recovery         |  |
                              |  | - status card state        |  |
                              |  +------+------+--------------+  |
                              |         |      |                 |
                              |         |      +----------------------------+
                              |         |                                   |
                              |         v                                   v
                              |  +-------------------+         +---------------------------+
                              |  | Codex CLI /       |         | Local Persistent Outputs  |
                              |  | App Session       |         | - logs/communicate/       |
                              |  | - start/resume    |         | - artifacts/              |
                              |  | - input/reply     |         | - Communicate/ images     |
                              |  +---------+---------+         +---------------------------+
                              |            |
                              |            v
                              |  +----------------------------+
                              |  | Feishu Reply / Status Card |
                              |  | - text reply               |
                              |  | - launcher/status card     |
                              |  +----------------------------+
                              +----------------------------------+
```

- 飞书负责提供外部输入入口，包括文本、图片和卡片动作
- 长连接 Runtime 负责建立连接、接收事件、确认回包，并把事件送入本地服务层
- Service / Router / Storage 负责把输入路由成任务、维护会话恢复状态、同步状态卡与持久化注册表
- Codex CLI / App Session 负责真正执行本地 Codex 会话，包括创建、恢复、继续输入与中断关闭
- 本地产物层负责保存日志、调试输出、PID/脚本产物和飞书图片，便于恢复、排障和手工验证

## 配置说明

### 环境变量

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用密钥；可通过 `--feishuAppSecretEnv` 指向其它变量名 |
| `CODEX_CLI_EXE` | 否 | Codex CLI 可执行文件路径或命令名，默认 `codex` |
| `COMMUNICATE_ASSISTANT_CWD` | 否 | 普通助手模式的默认工作目录，默认当前工作目录 |
| `COMMUNICATE_FEISHU_IMAGE_DIR` | 否 | 飞书图片落盘目录，默认 `.\Communicate` |
| `COMMUNICATE_SESSION_REGISTRY_PATH` | 否 | 会话注册表 JSON 路径，默认 `logs\communicate\registry.json` |
| `COMMUNICATE_CODEX_HOME` | 否 | 覆盖 Codex Home 目录；未设置时回退到 `CODEX_HOME` 或用户目录下的 `.codex` |
| `COMMUNICATE_FEISHU_DEBUG` | 否 | 设为 `1` 时启用飞书长连接调试日志 |
| `COMMUNICATE_CODEX_LOG_WINDOW` | 否 | 设为 `1` 时为每个 Codex 会话打开 PowerShell 日志窗口；默认关闭，供调试排障时临时启用 |
| `COMMUNICATE_FEISHU_DEBUG_LOG_PATH` | 否 | 调试日志路径 |
| `COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH` | 否 | 原始事件落盘路径，仅在调试时建议开启 |
| `COMMUNICATE_FEISHU_INSTANCE_TAG` | 否 | 手动指定长连接实例标识，便于排查多实例问题 |

### `configs/communicate/feishu.json`

| 配置项 | 说明 |
| --- | --- |
| `assistantAppServerEnabled` | 是否允许普通助手模式使用 app-server 能力 |
| `codingAppServerEnabled` | 是否允许 coding 模式使用 app-server 能力 |
| `takeoverListLimit` | 接管列表最多展示的任务数量 |
| `goalSummaryEnabled` | 是否启用任务目标摘要 |
| `goalSummaryTimeoutMs` | 任务目标摘要超时时间 |

## 日志与本地产物

默认情况下，项目会把运行数据写到以下位置：

- `logs/communicate/`：任务日志、飞书调试日志、会话注册表
- `artifacts/feishu-realtest/`：管理员启动脚本管理的标准输出、错误输出、PID、清理日志，以及隐藏启动失败时的 `feishu-longconn-bootstrap.err.log`
- `Communicate/`：飞书图片默认落盘目录
- `artifacts/selftest/`：手工验证脚本输出目录（按脚本运行情况生成）

如果你计划公开演示、录屏或提交 issue，请先检查这些目录，确认没有携带敏感信息。

## 测试与验证

自动化验证：

```powershell
npm test
```

预期结果：Node 测试全部通过，输出 `pass` 数量大于 0，`fail` 为 0。

手工验证脚本说明见 `scripts/selftest/README.md`。当改动涉及飞书长连接恢复、会话恢复或状态卡行为时，建议补跑对应脚本并保存产物到 `artifacts/selftest/`。

## 仓库结构

- `src/agent-cli.ts`：飞书专用 CLI 入口
- `src/communicate/`：飞书消息通道、控制层、状态卡、存储与 Codex worker
- `src/util/`：参数解析与最小文件工具
- `tests/communicate/`：围绕飞书与 Codex 会话控制的自动化测试
- `configs/communicate/feishu.json`：飞书运行时配置
- `scripts/doctor.cjs`：本地预检脚本，用来检查 Node、`codex` CLI、环境变量与构建产物
- `scripts/selftest/`：手工验证脚本
- `docs/`：设计、计划与研究资料索引

## 当前限制

- 当前仅正式支持 Windows + PowerShell
- 当前不承诺多用户共享部署、容器化部署或无管理员权限启动
- 当前未提供官方 npm 包发布与版本化发行流程
- 当前仓库以中文文档为主，并提供 `README.en.md` 作为英文概览

## 常见问题（FAQ）

### 是否支持 Linux 或 macOS？

当前不正式支持。仓库中的启动方式、脚本与部分进程控制行为都围绕 Windows + PowerShell 设计，CI 也只验证 Windows 环境。

### 为什么飞书长连接需要管理员权限？

当前实现下，如果不以管理员权限启动飞书长连接进程，本地 Codex 拉起可能出现 `spawn EPERM`。因此仓库默认提供了 `run-admin-task.ps1` 来处理提权启动。

### `.env.example` 能直接生效吗？

不能。`.env.example` 只是公开模板，用来说明有哪些变量；项目本身不会自动加载 `.env` 文件。你需要手动把变量写入当前 PowerShell 会话、用户环境变量或你自己的启动脚本。

### 不接飞书，能先做哪些本地验证？

可以。即使没有真实飞书凭证，你仍然可以先运行：

```powershell
node .\scripts\doctor.cjs
npm run build
npm test
```

预期结果：`doctor` 会告诉你当前还缺哪些本地条件；编译和自动化测试通过后，你至少可以先验证文档、解析逻辑、状态管理和回归测试链路。

### 这个项目适合直接部署成团队共享服务吗？

当前不建议。这个仓库目前更偏“个人 Windows 工作站上的本地控制桥接层”，还没有把多用户隔离、权限边界、服务化部署和长期运维作为正式目标。

## 已知问题与注意事项

- 真实飞书联调仍然依赖管理员 PowerShell、飞书长连接配置和本地 Codex CLI 环境，自动化测试不能替代真实联调
- 当前 CI 只覆盖 `build + test`，不会在 GitHub Actions 中执行真实飞书链路验证
- 默认日志、会话注册表和图片文件都会写入本地目录，公开演示前必须自行检查与脱敏
- 仓库刚完成主线收敛，文档与功能边界已经明显清晰，但仍不应把当前状态理解为“长期稳定 API”承诺
- 如果你修改的是提权、进程管理、状态卡或会话恢复逻辑，建议除了 `npm test` 之外，再补跑 `scripts/selftest/` 下的相关脚本

## 演示建议

如果你准备公开录屏、直播演示或给团队内部试用，建议先做一遍下面的准备：

1. 使用专门的演示工作目录，不要直接在真实生产仓库或含敏感文件的目录里演示
2. 使用专门的飞书测试应用或测试群，避免把真实业务消息混入演示链路
3. 提前设置好环境变量并完成一次 `npm run build`，减少现场配置时间
4. 演示前清理或检查 `logs/communicate/`、`artifacts/feishu-realtest/`、`artifacts/selftest/` 与 `Communicate/`
5. 如非排障需要，不要在公开演示时开启原始事件落盘；如果开启，结束后请及时检查并删除敏感日志
6. 先做一次完整彩排：启动服务、发送消息、查看状态卡、恢复任务、关闭任务，确认链路稳定后再正式演示

## 贡献

欢迎 issue、文档修正、测试补充和小步可审阅的 PR。开始贡献前请先阅读 `CONTRIBUTING.md`。

如果你要报告安全问题，请不要直接公开披露细节，先参考 `SECURITY.md`。

## 文档索引

- `docs/README.md`：公开补充文档入口与阅读路径
- `SECURITY.md`：安全说明与漏洞提交流程
- `CONTRIBUTING.md`：贡献流程与本地验证要求
- `CODE_OF_CONDUCT.md`：社区行为准则

## License

MIT，详见 `LICENSE`。
