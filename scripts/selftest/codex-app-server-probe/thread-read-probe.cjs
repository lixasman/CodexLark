const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const probeRoot = path.join(repoRoot, 'artifacts', 'selftest', 'codex-app-server-probe');
const logPath = path.join(probeRoot, 'thread-read-probe.log');
const listenUrl = (process.env.CODEX_APP_SERVER_THREAD_READ_LISTEN ?? '').trim() || 'ws://127.0.0.1:8791';
const targetCwd = (process.env.CODEX_SELFTEST_CWD ?? '').trim() || repoRoot;

fs.mkdirSync(probeRoot, { recursive: true });

function log(value) {
  const line = typeof value === 'string' ? value : JSON.stringify(value);
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  fs.writeFileSync(logPath, `=== START ${new Date().toISOString()} ===\n`, 'utf8');
  const ws = new WebSocket(listenUrl);
  const pending = new Map();
  let nextId = 1;
  let threadId = null;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    log(msg);
    if (msg.method === 'thread/started') {
      const nextThreadId = msg?.params?.thread?.id;
      if (typeof nextThreadId === 'string' && nextThreadId) threadId = nextThreadId;
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  function request(method, params) {
    const id = nextId++;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  }
  await request('initialize', { clientInfo: { name: 'thread-read-probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  const startResp = await request('thread/start', { cwd: targetCwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  log({ kind: 'thread_start_result', result: startResp?.result });
  threadId = threadId ?? startResp?.result?.thread?.id ?? null;
  if (!threadId) throw new Error('No threadId');
  const prompt = '请先简短确认，再执行一个 shell 命令 `echo probe-ok`，最后给出最终总结。';
  const turnResp = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
  log({ kind: 'turn_start_result', result: turnResp?.result });
  for (let i = 0; i < 24; i += 1) {
    await sleep(2500);
    const readResp = await request('thread/read', { threadId, includeTurns: true });
    const thread = readResp?.result?.thread;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const lastTurn = turns.at(-1) ?? null;
    const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
    const agentMessages = items.filter((item) => item?.type === 'agentMessage');
    log({
      kind: 'thread_read_snapshot',
      index: i,
      status: thread?.status,
      turnStatus: lastTurn?.status,
      itemCount: items.length,
      agentMessages: agentMessages.map((item) => ({ id: item.id, phase: item.phase ?? null, text: item.text }))
    });
    const hasFinal = agentMessages.some((item) => item?.phase === 'final_answer' && typeof item?.text === 'string' && item.text.length > 0);
    const isIdle = thread?.status?.type === 'idle';
    if (hasFinal || isIdle) {
      break;
    }
  }
  ws.close();
})().catch((error) => {
  log({ kind: 'error', error: String(error), stack: error?.stack });
  process.exit(1);
});
