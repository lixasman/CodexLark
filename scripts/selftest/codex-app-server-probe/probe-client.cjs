const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const probeRoot = path.join(repoRoot, 'artifacts', 'selftest', 'codex-app-server-probe');
const logFile = path.join(probeRoot, 'client.log');
const listenUrl = (process.env.CODEX_APP_SERVER_LISTEN ?? '').trim() || 'ws://127.0.0.1:8788';
const targetCwd = (process.env.CODEX_SELFTEST_CWD ?? '').trim() || repoRoot;

fs.mkdirSync(probeRoot, { recursive: true });

function log(obj) {
  fs.appendFileSync(logFile, `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  fs.writeFileSync(logFile, `=== START ${new Date().toISOString()} ===\n`, 'utf8');
  const ws = new WebSocket(listenUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    log(msg);
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
  const init = await request('initialize', { clientInfo: { name: 'probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  log({ kind: 'init_result', init });
  const threadStart = await request('thread/start', { cwd: targetCwd, approvalPolicy: 'on-request', sandbox: 'danger-full-access' });
  log({ kind: 'thread_start_result', threadStart });
  const threadId = threadStart?.result?.thread?.id ?? threadStart?.result?.id ?? threadStart?.result?.threadId;
  if (!threadId) throw new Error('No threadId returned');
  const turnStart = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Say hello and stop.' }] });
  log({ kind: 'turn_start_result', turnStart });
  await sleep(8000);
  ws.close();
})().catch((error) => {
  log({ kind: 'error', error: String(error), stack: error?.stack });
  process.exit(1);
});
