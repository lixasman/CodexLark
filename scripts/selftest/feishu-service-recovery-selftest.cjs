const fs = require('node:fs');
const path = require('node:path');

const { createFeishuService } = require('../../dist/communicate/channel/feishu-service.js');
const { createSessionRegistry } = require('../../dist/communicate/storage/session-registry.js');
const { createCodexAppSession } = require('../../dist/communicate/workers/codex/app-session.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const rootDir = path.join(repoRoot, 'artifacts', 'selftest', `feishu-service-recovery-${Date.now()}`);
const registryPath = path.join(rootDir, 'registry.json');
const reportPath = path.join(rootDir, 'SELFTEST.log');
const codexExe = (process.env.CODEX_CLI_EXE ?? '').trim() || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const targetProjectCwd = (process.env.CODEX_SELFTEST_CWD ?? '').trim() || repoRoot;
const threadId = 'feishu:chat:selftest';

fs.mkdirSync(rootDir, { recursive: true });
fs.writeFileSync(reportPath, `=== START ${new Date().toISOString()} ===\n`, 'utf8');

function write(entry) {
  const line =
    typeof entry === 'string'
      ? entry
      : JSON.stringify(entry, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value));
  fs.appendFileSync(reportPath, `${line}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 120000, intervalMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      write({ kind: 'wait_satisfied', label, elapsedMs: Date.now() - startedAt });
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function createRuntime(label) {
  const registry = createSessionRegistry({
    registryPath,
    warn: (message, error) => write({ kind: 'registry_warn', label, message, error: String(error ?? '') })
  });
  const sent = [];
  const sessions = [];
  let sessionFactoryCalls = 0;
  let serviceRef = null;

  const service = createFeishuService({
    channel: {
      sendText: async (currentThreadId, text) => {
        sent.push({ threadId: currentThreadId, text, at: new Date().toISOString() });
        write({ kind: 'channel_send', label, threadId: currentThreadId, text });
      }
    },
    sessionRegistry: registry,
    sessionFactory: (options) => {
      sessionFactoryCalls += 1;
      write({ kind: 'session_factory', label, options });
      const session = createCodexAppSession({
        taskId: options.taskId,
        cwd: options.cwd,
        mode: options.mode,
        resumeThreadId: options.resumeThreadId,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        interruptedByRestart: options.interruptedByRestart,
        command: [codexExe],
        enableLogWindow: false,
        logRootDir: rootDir,
        onEvent: (event) => {
          write({ kind: 'worker_event', label, event });
          return serviceRef?.handleWorkerEvent(event);
        }
      });
      sessions.push(session);
      return session;
    }
  });
  serviceRef = service;

  return {
    label,
    registry,
    service,
    sent,
    sessions,
    get sessionFactoryCalls() {
      return sessionFactoryCalls;
    }
  };
}

function latestTask(service, taskId) {
  return service.getTask(taskId);
}

function collectLogFiles(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectLogFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.log')) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanAnomalies() {
  const anomalyPatterns = [/TURN FAILED/, /SESSION FORCE_CLOSED/, /Codex app session failed/i, /resume rejected/i, /systemError/i];
  const anomalies = [];
  for (const logFile of collectLogFiles(rootDir)) {
    const content = fs.readFileSync(logFile, 'utf8');
    for (const pattern of anomalyPatterns) {
      if (pattern.test(content)) {
        anomalies.push({ logFile, pattern: String(pattern) });
      }
    }
  }
  write({ kind: 'anomaly_scan', anomalies });
  return anomalies;
}

async function main() {
  write({ kind: 'selftest_root', rootDir, registryPath, codexExe, targetProjectCwd });

  const runtime1 = createRuntime('svc1');
  await runtime1.service.handleInboundMessage({
    threadId,
    text: `帮我在 ${targetProjectCwd} 下开一个 codex 窗口`
  });

  const taskId = 'T1';
  await waitFor('task_created', () => latestTask(runtime1.service, taskId));
  await waitFor('first_session_ready', () => {
    const session = runtime1.sessions[0];
    if (!session) return null;
    const snapshot = session.getSnapshot();
    return snapshot.lifecycle === 'IDLE' || snapshot.lifecycle === 'WAITING_USER' || snapshot.lifecycle === 'FAILED'
      ? snapshot
      : null;
  });
  write({
    kind: 'after_start',
    task: latestTask(runtime1.service, taskId),
    sessionSnapshot: runtime1.sessions[0]?.getSnapshot(),
    registry: runtime1.registry.load()
  });

  await runtime1.service.handleInboundMessage({
    threadId,
    text: '对 T1 输入: 请只回复“第一轮已收到”，不要调用任何工具，也不要执行命令。'
  });
  await waitFor('first_turn_done', () => {
    const task = latestTask(runtime1.service, taskId);
    return task && (task.lifecycle === 'IDLE' || task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED') && task.checkpointOutput
      ? task
      : null;
  });
  write({ kind: 'after_first_turn', task: latestTask(runtime1.service, taskId) });

  await runtime1.service.handleInboundMessage({ threadId, text: '查询 T1 状态' });
  write({ kind: 'after_first_query', lastMessage: runtime1.sent.at(-1) });

  if (runtime1.sessions[0]) {
    write({ kind: 'simulate_restart_close_old_session' });
    await runtime1.sessions[0].close();
  }

  const runtime2 = createRuntime('svc2');
  write({ kind: 'after_restart_registry_load', task: latestTask(runtime2.service, taskId), registry: runtime2.registry.load() });

  const queryFactoryCallsBefore = runtime2.sessionFactoryCalls;
  await runtime2.service.handleInboundMessage({ threadId, text: '查询 T1 状态' });
  const queryFactoryCallsAfter = runtime2.sessionFactoryCalls;
  write({
    kind: 'after_restart_query',
    factoryCallsBefore: queryFactoryCallsBefore,
    factoryCallsAfter: queryFactoryCallsAfter,
    lastMessage: runtime2.sent.at(-1)
  });
  if (queryFactoryCallsBefore !== queryFactoryCallsAfter) {
    throw new Error('Status query unexpectedly triggered sessionFactory on cold task.');
  }

  await runtime2.service.handleInboundMessage({
    threadId,
    text: '对 T1 输入: 请只回复“重启后第二轮已收到”，不要调用任何工具，也不要执行命令。'
  });
  await waitFor('second_turn_done', () => {
    const task = latestTask(runtime2.service, taskId);
    return task && (task.lifecycle === 'IDLE' || task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED') && task.checkpointOutput
      ? task
      : null;
  });
  write({
    kind: 'after_second_turn',
    task: latestTask(runtime2.service, taskId),
    sentTail: runtime2.sent.slice(-3)
  });

  await runtime2.service.handleInboundMessage({ threadId, text: '查询 T1 状态' });
  write({ kind: 'after_second_query', lastMessage: runtime2.sent.at(-1) });

  await runtime2.service.handleInboundMessage({ threadId, text: '关闭T1。' });
  write({ kind: 'after_close', task: latestTask(runtime2.service, taskId), registry: runtime2.registry.load() });

  await runtime2.service.handleInboundMessage({ threadId, text: '对 T1 输入: 关闭后再次输入' });
  write({ kind: 'after_reply_closed', lastMessage: runtime2.sent.at(-1) });

  const anomalies = scanAnomalies();
  const sessionLogPath = path.join(rootDir, 'T1.log');
  const finalSummary = {
    task: latestTask(runtime2.service, taskId),
    registry: runtime2.registry.load(),
    sessionLogExists: fs.existsSync(sessionLogPath),
    sessionLogPath,
    anomalies
  };
  write({ kind: 'final_summary', finalSummary });

  for (const session of runtime2.sessions) {
    try {
      await session.close();
    } catch (error) {
      write({ kind: 'cleanup_close_error', error: String(error) });
    }
  }

  if (anomalies.length > 0) {
    throw new Error(`Detected ${anomalies.length} anomaly pattern(s) in selftest logs.`);
  }
}

main()
  .then(() => {
    write({ kind: 'selftest_complete', ok: true, finishedAt: new Date().toISOString() });
  })
  .catch((error) => {
    write({ kind: 'selftest_complete', ok: false, error: String(error), stack: error?.stack, finishedAt: new Date().toISOString() });
    process.exitCode = 1;
  });
