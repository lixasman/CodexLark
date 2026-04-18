const fs = require('node:fs');
const path = require('node:path');

const { createFeishuService } = require('../../dist/communicate/channel/feishu-service.js');
const { createSessionRegistry } = require('../../dist/communicate/storage/session-registry.js');
const { createCodexAppSession } = require('../../dist/communicate/workers/codex/app-session.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const rootDir = path.join(repoRoot, 'artifacts', 'selftest', `feishu-assistant-offline-${Date.now()}`);
const registryPath = path.join(rootDir, 'registry.json');
const reportPath = path.join(rootDir, 'SELFTEST.log');
const codexExe = (process.env.CODEX_CLI_EXE ?? '').trim() || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const expectedAssistantCwd = (process.env.COMMUNICATE_ASSISTANT_CWD ?? '').trim() || process.cwd();
const threadId = 'feishu:chat:selftest:assistant';

fs.mkdirSync(rootDir, { recursive: true });
fs.writeFileSync(reportPath, `=== START ${new Date().toISOString()} ===\n`, 'utf8');

function write(entry) {
  const line =
    typeof entry === 'string'
      ? entry
      : JSON.stringify(entry, (_key, value) => {
          if (value instanceof Error) {
            return { message: value.message, stack: value.stack };
          }
          return value;
        });
  fs.appendFileSync(reportPath, `${line}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeoutMs = 180000, intervalMs = 500) {
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

function createRuntime() {
  const registry = createSessionRegistry({
    registryPath,
    warn: (message, error) => write({ kind: 'registry_warn', message, error: String(error ?? '') })
  });
  const sent = [];
  const sessions = [];
  let serviceRef = null;

  const service = createFeishuService({
    channel: {
      sendText: async (currentThreadId, text) => {
        sent.push({ threadId: currentThreadId, text, at: new Date().toISOString() });
        write({ kind: 'channel_send', threadId: currentThreadId, text });
      }
    },
    sessionRegistry: registry,
    sessionFactory: (options) => {
      write({ kind: 'session_factory', options });
      const session = createCodexAppSession({
        taskId: options.taskId,
        cwd: options.cwd,
        mode: options.mode,
        resumeThreadId: options.resumeThreadId,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        interruptedByRestart: options.interruptedByRestart,
        developerInstructions: options.developerInstructions,
        baseInstructions: options.baseInstructions,
        personality: options.personality,
        command: [codexExe],
        enableLogWindow: false,
        logRootDir: rootDir,
        onEvent: (event) => {
          write({ kind: 'worker_event', event });
          return serviceRef?.handleWorkerEvent(event);
        }
      });
      sessions.push(session);
      return session;
    }
  });
  serviceRef = service;

  return { service, registry, sent, sessions };
}

function getTask(service, taskId) {
  return service.getTask(taskId);
}

async function waitForTurnCompletion(service, taskId, previousCheckpoint) {
  return waitFor(`turn_completion_${taskId}`, () => {
    const task = getTask(service, taskId);
    if (!task) return null;
    if (task.lifecycle === 'FAILED') return task;
    if (task.lifecycle !== 'IDLE' && task.lifecycle !== 'WAITING_USER') return null;
    if (!task.checkpointOutput || task.checkpointOutput === previousCheckpoint) return null;
    return task;
  });
}

function summarizeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    lifecycle: task.lifecycle,
    sessionKind: task.sessionKind,
    cwd: task.cwd,
    checkpointOutput: task.checkpointOutput,
    waitKind: task.waitKind,
    codexThreadId: task.codexThreadId
  };
}

async function main() {
  write({ kind: 'selftest_root', rootDir, registryPath, codexExe, expectedAssistantCwd });
  const runtime = createRuntime();

  const prompts = [
    { prompt: '请严格只回复“第一轮已收到”。不要调用工具，不要执行命令，不要输出额外内容。', expected: '第一轮已收到' },
    { prompt: '请严格只回复“第二轮已收到”。不要调用工具，不要执行命令，不要输出额外内容。', expected: '第二轮已收到' },
    { prompt: '请严格只回复“第三轮已收到”。不要调用工具，不要执行命令，不要输出额外内容。', expected: '第三轮已收到' }
  ];

  let checkpoint = '';
  for (const { prompt, expected } of prompts) {
    await runtime.service.handleInboundMessage({ threadId, text: prompt });
    const task = await waitForTurnCompletion(runtime.service, 'T1', checkpoint);
    if (task.lifecycle === 'FAILED') {
      throw new Error(`Assistant turn failed for prompt "${prompt}": ${task.checkpointOutput ?? '(no output)'}`);
    }
    if (!String(task.checkpointOutput ?? '').includes(expected)) {
      throw new Error(`Assistant output did not contain expected token "${expected}": ${task.checkpointOutput ?? '(no output)'}`);
    }
    checkpoint = task.checkpointOutput ?? checkpoint;
    write({ kind: 'turn_result', prompt, task: summarizeTask(task) });
  }

  const createdTask = getTask(runtime.service, 'T1');
  if (!createdTask) {
    throw new Error('Assistant task T1 was not created.');
  }
  if (createdTask.sessionKind !== 'assistant') {
    throw new Error(`Expected assistant sessionKind, got ${createdTask.sessionKind}`);
  }
  if (createdTask.cwd !== expectedAssistantCwd) {
    throw new Error(`Expected assistant cwd ${expectedAssistantCwd}, got ${createdTask.cwd}`);
  }

  await runtime.service.handleInboundMessage({ threadId, text: '关闭T1。' });
  await waitFor('assistant_closed', () => {
    const task = getTask(runtime.service, 'T1');
    return task?.lifecycle === 'CLOSED' ? task : null;
  });

  const finalTask = getTask(runtime.service, 'T1');
  const finalRegistry = runtime.registry.load();
  const lastSent = runtime.sent.at(-1)?.text ?? '';
  const normalReplies = runtime.sent.slice(0, -1).map((entry) => entry.text);
  const summary = {
    finalTask: summarizeTask(finalTask),
    threadBinding: runtime.registry.getThreadBinding(threadId),
    sentCount: runtime.sent.length,
    normalReplies,
    lastSent
  };
  write({ kind: 'final_summary', summary, registry: finalRegistry });

  if (!/已关闭/.test(lastSent)) {
    throw new Error(`Expected close acknowledgement, got: ${lastSent}`);
  }
  if (runtime.sent.length !== 4) {
    throw new Error(`Expected 4 outbound messages (3 replies + 1 close ack), got ${runtime.sent.length}`);
  }
  if (JSON.stringify(normalReplies) !== JSON.stringify(['第一轮已收到', '第二轮已收到', '第三轮已收到'])) {
    throw new Error(`Unexpected assistant replies: ${JSON.stringify(normalReplies)}`);
  }
  if (runtime.registry.getThreadBinding(threadId)) {
    throw new Error('Assistant thread binding still exists after close.');
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
