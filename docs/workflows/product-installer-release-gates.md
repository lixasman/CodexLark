# Product Installer Release Gates

这个文档描述 CodexLark 面向普通下载用户发布 EXE 安装器前，必须满足的 release gate checklist。

如果下列关键项还没落地，对外发布时应明确标记为 developer preview，而不是“小白一键安装”。

## 1. 关键 Gate

### 1.1 `codex` 受控外部依赖

必须满足：

- `codex` 被视为 controlled external dependency，而不是让用户自己开终端处理
- `first-run` 能检测是否存在可执行 `codex`
- 缺失时由 setup core 统一触发安装
- 安装后继续验证：
  - 可执行
  - 版本在支持范围内
  - 登录态可检测
- 失败时必须给出 failure category、日志路径和明确 fallback

### 1.2 统一权限模型

必须满足：

- 安装器写 `Program Files` 时走管理员权限
- `first-run` 写 `%LocalAppData%\CodexLark` 时回到原桌面用户
- 日常使用默认普通用户
- 只有长连接启动 / 自启动注册等 Windows bridge 才走管理员边界
- 不允许静默切换到 SYSTEM 或其他账号上下文

### 1.3 Legacy Migration Gate

必须满足：

- 首次运行先扫描旧环境，而不是跳过旧残留直接启动
- 扫描范围至少覆盖：
  - 旧环境变量
  - 旧 repo-local launcher
  - 旧快捷方式
  - 旧计划任务
  - 旧日志 / registry / state 根目录
- 导入只允许一次性迁移，不允许旧配置长期高优先级覆盖新 state

### 1.4 Secret Storage / Diagnostics / Signing

必须满足：

- `FEISHU_APP_SECRET` 不再直接写入用户环境变量
- secret 只存 reference，真正 secret 走受保护存储
- diagnostics 默认白名单导出并强制 redaction
- `export-diagnostics` 生成的 `setup-diagnostics.json` 不含原始 secret
- 已安装形态下能从安装目录使用内置 `node.exe` + `dist\setup-cli.js export-diagnostics` 成功导出 diagnostics
- 发布链路必须明确：
  - Authenticode code signing
  - SHA256 校验值
  - Defender / SmartScreen / 下载失败分类

### 1.5 Supported Host / Runtime Contract

必须满足：

- runtime contract 的 fail-fast 行为已验证
- `docs/workflows/install-startup-support-matrix.md` 已与当前实现保持一致
- 对以下常见阻断有清晰边界或 fallback：
  - `ConstrainedLanguage`
  - `AppLocker` / `WDAC`
  - `ExecutionPolicy`
  - 企业代理、杀毒、EDR 导致的原生失败

### 1.6 Build Freshness

必须满足：

- 发布安装包前必须基于最新构建产物重新执行 `npm run build`
- 不允许拿陈旧 `dist/`、陈旧 runtime manifest 或历史 staging 目录直接重新打包
- 打包出来的 EXE 必须对应当前源码和当前测试结果，而不是 stale artifact

## 2. 发布门槛清单

发布前逐项确认：

- [ ] install manifest / runtime manifest 已落地且 schema-aware
- [ ] canonical launcher 已落地，启动 / repair / autostart 不再各自漂移
- [ ] `codex` controlled dependency 全链路可用
- [ ] 统一 permission model 已验证
- [ ] legacy migration gate 已验证
- [ ] secret storage 与 diagnostics redaction 已验证
- [ ] runtime contract / support matrix 已验证，unsupported host 行为清晰
- [ ] fresh build 已完成，确认不是基于陈旧 `dist/` 或旧 staging 产物打包
- [ ] 覆盖安装、repair、卸载验证通过
- [ ] Inno Setup 打包契约验证通过
- [ ] 签名、SHA256、发布说明已准备好

## 3. 维护者验证入口

建议维护者在发布前至少跑一轮下面这些检查：

```powershell
Get-Command node
Get-Command npm
Get-Command iscc
npm run build
node .\scripts\run-node-tests.cjs
powershell -ExecutionPolicy Bypass -File .\scripts\package\build-installer.ps1
```

注意：上面这一段只覆盖维护者机器的构建 / 测试 / 打包。下面这个“已安装形态下的 diagnostics gate”必须发生在干净验证机上，并且前提是你已经安装了刚打出来的新 EXE，而不是复用旧的本机安装目录。

```powershell
$installRoot = Join-Path $env:ProgramFiles 'CodexLark'
& (Join-Path $installRoot 'node.exe') (Join-Path $installRoot 'dist\setup-cli.js') export-diagnostics
```

这里的 `npm run build` 不是可选步骤；它的作用就是确保 EXE 使用的是最新构建产物，而不是陈旧 `dist/` 或历史 staging 内容。

如果当前环境里直接跑 Node test 会遇到宿主限制，也可以采用仓库现有的“先编译后跑 JS”方式做 product-installer 回归切片。

如果你需要一份可直接照着执行的发布顺序，而不是自己手工拼命令，优先看 [`docs/workflows/product-installer-release-dry-run.md`](./product-installer-release-dry-run.md) 并运行其中的 dry-run helper：`scripts\package\run-product-installer-release-dry-run.ps1`。

## 4. 发布物随附信息

每次对普通下载用户发版时，发布页至少应附带：

- 安装包版本号
- SHA256
- 已知支持边界
- diagnostics 导出方式
- repair 入口说明
- 若尚未完成签名，必须明确写明是 preview，不应宣称为稳定一键安装
