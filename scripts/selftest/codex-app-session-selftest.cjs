const fs = require('node:fs');
const path = require('node:path');
const { createCodexAppSession } = require('../../dist/communicate/workers/codex/app-session.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const runRoot = path.join(repoRoot, 'artifacts', 'selftest', `codex-app-session-${Date.now()}`);
const outputPath = path.join(runRoot, 'report.log');
const workerLogRoot = path.join(runRoot, 'worker-logs');
const codexExe = (process.env.CODEX_CLI_EXE ?? '').trim() || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const sessionCwd = (process.env.CODEX_SELFTEST_CWD ?? '').trim() || repoRoot;

fs.mkdirSync(runRoot, { recursive: true });
fs.writeFileSync(outputPath, `=== START ${new Date().toISOString()} ===\n`, 'utf8');

const log = (value) => fs.appendFileSync(outputPath, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`, 'utf8');

let socketCount = 0;
let forcedCloseDone = false;

function createWrappedWebSocket(url) {
  const ws = new WebSocket(url);
  socketCount += 1;
  const currentIndex = socketCount;
  log({ kind: 'socket_created', currentIndex, url });
  ws.addEventListener('open', () => {
    log({ kind: 'socket_open', currentIndex });
    if (currentIndex === 1 && !forcedCloseDone) {
      setTimeout(() => {
        if (ws.readyState === 1 && !forcedCloseDone) {
          forcedCloseDone = true;
          log({ kind: 'socket_force_close', currentIndex });
          ws.close();
        }
      }, 4000);
    }
  });
  ws.addEventListener('close', () => log({ kind: 'socket_close', currentIndex }));
  ws.addEventListener('error', (error) => log({ kind: 'socket_error', currentIndex, error: String(error?.message ?? error) }));
  return ws;
}

async function main() {
  const session = createCodexAppSession({
    taskId: 'SELFTEST',
    cwd: sessionCwd,
    command: [codexExe],
    createWebSocket: createWrappedWebSocket,
    enableLogWindow: false,
    logRootDir: workerLogRoot,
    onEvent: (event) => {
      log({ kind: 'worker_event', event });
      if (event?.type === 'task_finished' || event?.type === 'task_failed' || event?.type === 'task_waiting_user') {
        done(event);
      }
    }
  });

  let settled = false;
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function done(value) {
    if (settled) return;
    settled = true;
    resolveDone(value);
  }

  session.start();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  log({ kind: 'snapshot_after_start', snapshot: session.getSnapshot() });
  session.sendReply({ action: 'input_text', text: '请先简短确认，然后执行命令 `echo selftest-ok`，最后只输出一句最终总结。' });
  log({ kind: 'prompt_sent' });

  const result = await Promise.race([
    donePromise,
    new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout', snapshot: session.getSnapshot() }), 120000))
  ]);

  log({ kind: 'final_result', result, snapshot: session.getSnapshot() });
  try {
    await session.close();
  } catch (error) {
    log({ kind: 'close_error', error: String(error) });
  }
}

main().catch((error) => {
  log({ kind: 'fatal', error: String(error), stack: error?.stack });
  process.exitCode = 1;
});
