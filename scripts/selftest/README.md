# Manual Validation Scripts

这些脚本用于手工验证飞书长连接与 Codex 会话链路，不属于 `npm test` 的自动化测试范围。

## 约定

- 先执行 `npm run build`
- 如需指定 Codex CLI，可设置 `CODEX_CLI_EXE`
- 运行产物统一写入 `artifacts/selftest/`
- 普通助手默认目录可通过 `COMMUNICATE_ASSISTANT_CWD` 覆盖
- 飞书图片落盘目录可通过 `COMMUNICATE_FEISHU_IMAGE_DIR` 覆盖

## 脚本

- `codex-app-session-selftest.cjs`
  手工验证 Codex App Session 在连接中断后的恢复表现
- `feishu-service-recovery-selftest.cjs`
  手工验证飞书服务重启后任务恢复与热会话拉起
- `feishu-assistant-offline-selftest.cjs`
  手工验证普通助手模式的连续对话与关闭流程
- `codex-appserver-concurrent-input-probe.js`
  手工验证 Codex app-server 是否支持并发输入
- `codex-app-server-probe/`
  低层 JSON-RPC 探针与 app-server 启动脚本
