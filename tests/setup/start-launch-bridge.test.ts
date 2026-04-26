import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type StartLaunchBridgeModule = {
  startLaunchBridge: (options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{
    stdoutPath: string;
    stderrPath: string;
    registryPath: string;
  }>;
};

function startLaunchBridgeModulePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "setup", "start-launch-bridge.js");
}

function loadStartLaunchBridgeModule(): StartLaunchBridgeModule {
  const modulePath = startLaunchBridgeModulePath();
  delete require.cache[modulePath];
  return require(modulePath) as StartLaunchBridgeModule;
}

function createSetupEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCALAPPDATA: root,
    LocalAppData: root,
    USERPROFILE: root,
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    ...extra
  };
}

test("startLaunchBridge surfaces launch-status diagnostics when the PowerShell bridge exits non-zero", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexlark-launch-bridge-"));
  const env = createSetupEnv(tempRoot);
  const childProcessModule = require("node:child_process") as {
    spawn: (command: string, args: string[], options: Record<string, unknown>) => EventEmitter & { kill: () => void };
  };
  const originalSpawn = childProcessModule.spawn;

  childProcessModule.spawn = ((_command: string, _args: string[], _options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => undefined;

    const logDir = path.win32.join(tempRoot, "CodexLark", "logs", "feishu-longconn");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      path.win32.join(logDir, "launch-status.json"),
      JSON.stringify({
        status: "failed",
        message: "已取消管理员授权，本次未启动飞书长连接。",
        bootstrapLogPath: path.win32.join(logDir, "feishu-longconn-bootstrap.err.log"),
        stderrPath: path.win32.join(logDir, "feishu-longconn.err.log"),
        registryPath: path.win32.join(tempRoot, "CodexLark", "logs", "communicate", "registry.json")
      }),
      "utf8"
    );
    setImmediate(() => child.emit("close", 1));
    return child;
  }) as typeof childProcessModule.spawn;

  try {
    const module = loadStartLaunchBridgeModule();

    await assert.rejects(
      async () => await module.startLaunchBridge({ env, timeoutMs: 2_000 }),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        assert.match(message, /已取消管理员授权/);
        assert.match(message, /Diagnostics ->/);
        assert.match(message, /feishu-longconn-bootstrap\.err\.log/i);
        assert.match(message, /launch-status\.json/i);
        return true;
      }
    );
  } finally {
    childProcessModule.spawn = originalSpawn;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
