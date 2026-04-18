import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { __testOnlyCodexAppSession, createCodexAppSession } from '../../src/communicate/workers/codex/app-session';

function createMockChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processEvents = new EventEmitter() as EventEmitter & {
    stdin: { writes: string[]; write: (chunk: string) => void };
    killCalls: number;
    kill: () => boolean;
    pid: number;
    unref?: () => void;
  };
  processEvents.stdin = {
    writes: [],
    write: (chunk: string) => {
      processEvents.stdin.writes.push(chunk);
    }
  };
  processEvents.killCalls = 0;
  processEvents.kill = () => {
    processEvents.killCalls += 1;
    return true;
  };
  processEvents.pid = 4321;
  return Object.assign(processEvents, { stdout, stderr });
}

class FakeWebSocket {
  readonly url: string;
  readonly sent: any[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  failSendForMethods = new Set<string>();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', {});
    });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((item) => item !== listener));
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    if (this.failSendForMethods.has(String(parsed.method))) {
      throw new Error('Synthetic send failure for ' + parsed.method);
    }
    this.sent.push(parsed);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  emitServerMessage(message: Record<string, unknown>): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  private dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class ControlledWebSocket {
  readonly url: string;
  readonly sent: any[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly setup: (socket: ControlledWebSocket) => void;
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';

  constructor(url: string, setup: (socket: ControlledWebSocket) => void) {
    this.url = url;
    this.setup = setup;
    queueMicrotask(() => {
      this.setup(this);
    });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((item) => item !== listener));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  emitError(event: any): void {
    this.readyState = 3;
    this.dispatch('error', event);
  }

  emitClose(event: any): void {
    this.readyState = 3;
    this.dispatch('close', event);
  }

  emitServerMessage(message: Record<string, unknown>): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  private dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for the expected condition.');
}

function createLogRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'communicate-app-session-'));
}

async function allocateTestPort(): Promise<number> {
  const server = createNetServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('Test websocket frame payload is too large.');
}

function tryDecodeWebSocketFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) {
    return null;
  }
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    const longLength = buffer.readBigUInt64BE(2);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Test websocket frame payload is too large.');
    }
    payloadLength = Number(longLength);
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) {
    return null;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    opcode,
    payload,
    rest: buffer.subarray(offset + payloadLength)
  };
}

async function startMockCodexWebSocketServer(port: number): Promise<{
  receivedMessages: any[];
  close: () => Promise<void>;
}> {
  const server = createHttpServer();
  const openSockets = new Set<Duplex>();
  const receivedMessages: any[] = [];

  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  server.on('upgrade', (request, socket) => {
    openSockets.add(socket);
    const websocketKey = request.headers['sec-websocket-key'];
    const acceptKey = createHash('sha1')
      .update(String(websocketKey) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        ''
      ].join('\r\n')
    );

    let pending = Buffer.alloc(0) as Buffer;
    socket.on('data', (chunk) => {
      pending = Buffer.from(Buffer.concat([pending, chunk]));
      while (true) {
        const frame = tryDecodeWebSocketFrame(pending);
        if (!frame) {
          return;
        }
        pending = Buffer.from(frame.rest);
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 0x1) {
          continue;
        }
        const message = JSON.parse(frame.payload.toString('utf8'));
        receivedMessages.push(message);
        if (message.method === 'initialize') {
          socket.write(
            encodeServerTextFrame(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { userAgent: 'test/0.111.0' }
              })
            )
          );
          continue;
        }
        if (message.method === 'thread/start') {
          socket.write(
            encodeServerTextFrame(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } }
              })
            )
          );
        }
      }
    });

    socket.on('close', () => {
      openSockets.delete(socket);
    });
    socket.on('error', () => {
      openSockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    receivedMessages,
    async close(): Promise<void> {
      for (const socket of openSockets) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLoggedEventEntries(logPath: string, eventName: string): Array<{ lineIndex: number; payload: Record<string, unknown> }> {
  const marker = `] ${eventName} `;
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .flatMap((line, lineIndex) => {
      const markerIndex = line.indexOf(marker);
      if (markerIndex < 0) return [];
      const payloadText = line.slice(markerIndex + marker.length).trim();
      try {
        const parsed = JSON.parse(payloadText);
        return isRecord(parsed) ? [{ lineIndex, payload: parsed }] : [];
      } catch {
        return [];
      }
    });
}

function readLoggedEventPayloads(logPath: string, eventName: string): Array<Record<string, unknown>> {
  return readLoggedEventEntries(logPath, eventName).map((entry) => entry.payload);
}

test('terminal notify provenance suppresses thread-read-only classification per turn even after later turns write observations', () => {
  const store = __testOnlyCodexAppSession.createTerminalNotificationObservationStore();

  __testOnlyCodexAppSession.recordTerminalNotificationObservation(store, {
    rawMethod: 'turn/completed',
    turnId: 'turn-1',
    status: 'interrupted',
    errorText: 'Turn 1 interrupted',
    socketGenerationAtReceive: 1,
    activeTurnId: 'turn-1',
    pendingRpcCount: 0,
    recoveryInFlight: false,
    observedAt: '2026-04-12T00:00:00.000Z',
    observedAtMs: 1
  });

  assert.equal(__testOnlyCodexAppSession.shouldLogInterruptedDiscoveredViaThreadReadOnly(store, 'turn-1'), false);
  assert.equal(__testOnlyCodexAppSession.shouldLogInterruptedDiscoveredViaThreadReadOnly(store, 'turn-2'), true);

  __testOnlyCodexAppSession.recordTerminalNotificationObservation(store, {
    rawMethod: 'turn/completed',
    turnId: 'turn-2',
    status: 'completed',
    errorText: null,
    socketGenerationAtReceive: 2,
    activeTurnId: 'turn-2',
    pendingRpcCount: 0,
    recoveryInFlight: false,
    observedAt: '2026-04-12T00:00:01.000Z',
    observedAtMs: 2
  });

  assert.equal(__testOnlyCodexAppSession.shouldLogInterruptedDiscoveredViaThreadReadOnly(store, 'turn-1'), false);
  assert.equal(__testOnlyCodexAppSession.shouldLogInterruptedDiscoveredViaThreadReadOnly(store, 'turn-2'), false);
  assert.equal(__testOnlyCodexAppSession.getRelevantTerminalNotificationObservation(store, 'turn-1')?.turnId, 'turn-1');
});
async function bootstrapSession(input?: {
  onEvent?: (event: Record<string, unknown>) => void;
  child?: ReturnType<typeof createMockChild>;
  threadReadPollDelayMs?: number;
  rpcLongPendingThresholdMs?: number;
  systemErrorReconcileDelayMs?: number;
  systemErrorReconcileRetryDelayMs?: number;
  systemErrorReconcileMaxAttempts?: number;
  systemErrorAutoContinueTimeoutMs?: number;
  killProcessTree?: (pid: number) => void;
  mode?: 'new' | 'resume';
  resumeThreadId?: string;
  approvalPolicy?: string;
  sandbox?: string;
  interruptedByRestart?: boolean;
  developerInstructions?: string;
  baseInstructions?: string;
  personality?: string;
  model?: string;
  ephemeral?: boolean;
  initializeResult?: Record<string, unknown>;
  expectStartupRequest?: boolean;
  startupResult?: Record<string, unknown>;
  startupResultModel?: string;
  startupError?: Record<string, unknown>;
}) {
  const child = input?.child ?? createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;
  const sockets: FakeWebSocket[] = [];
  let spawnCalls = 0;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => {
      spawnCalls += 1;
      return child;
    },
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as any;
    },
    onEvent: (event: any) => {
      input?.onEvent?.(event as unknown as Record<string, unknown>);
    },
    enableLogWindow: false,
    logRootDir,
    threadReadPollDelayMs: input?.threadReadPollDelayMs,
    ...(input?.rpcLongPendingThresholdMs !== undefined ? { rpcLongPendingThresholdMs: input.rpcLongPendingThresholdMs } : {}),
    ...(input?.systemErrorReconcileDelayMs !== undefined ? { systemErrorReconcileDelayMs: input.systemErrorReconcileDelayMs } : {}),
    ...(input?.systemErrorReconcileRetryDelayMs !== undefined ? { systemErrorReconcileRetryDelayMs: input.systemErrorReconcileRetryDelayMs } : {}),
    ...(input?.systemErrorReconcileMaxAttempts !== undefined ? { systemErrorReconcileMaxAttempts: input.systemErrorReconcileMaxAttempts } : {}),
    ...(input?.systemErrorAutoContinueTimeoutMs !== undefined ? { systemErrorAutoContinueTimeoutMs: input.systemErrorAutoContinueTimeoutMs } : {}),
    ...(input?.killProcessTree ? { killProcessTree: input.killProcessTree } : {}),
    ...(input?.mode ? { mode: input.mode } : {}),
    ...(input?.resumeThreadId ? { resumeThreadId: input.resumeThreadId } : {}),
    ...(input?.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input?.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input?.interruptedByRestart !== undefined ? { interruptedByRestart: input.interruptedByRestart } : {})
    ,
    ...(input?.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
    ...(input?.baseInstructions ? { baseInstructions: input.baseInstructions } : {}),
    ...(input?.personality ? { personality: input.personality } : {}),
    ...(input?.model ? { model: input.model } : {}),
    ...(input?.ephemeral ? { ephemeral: input.ephemeral } : {})
  } as any);

  session.start();
  await tick();
  const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
  assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: input?.initializeResult ?? { userAgent: 'test/0.111.0' } });
  await tick();
  if (input?.expectStartupRequest === false) {
    return {
      child,
      session,
      startupRequest: undefined,
      spawnCalls,
      get socket() {
        return socket!;
      },
      sockets,
      async cleanup() {
        try {
          await session.close();
        } catch {
          // ignore cleanup close failures in tests
        }
        rmSync(logRootDir, { recursive: true, force: true });
      }
    };
  }
  const startupMethod = input?.mode === 'resume' ? 'thread/resume' : 'thread/start';
  const startupThreadId = input?.resumeThreadId ?? 'thread-1';
  const startupRequest = socket?.sent.find((item) => item.method === startupMethod);
  assert.ok(startupRequest);
  if (input?.startupError) {
    socket?.emitServerMessage({ id: startupRequest.id, error: input.startupError });
  } else {
    socket?.emitServerMessage({
      id: startupRequest.id,
      result:
        input?.startupResult ??
        {
          thread: { id: startupThreadId, cliVersion: '0.111.0' },
          ...(input?.startupResultModel !== undefined ? { model: input.startupResultModel } : {})
        }
    });
  }
  await tick();

  return {
    child,
    session,
    startupRequest,
    spawnCalls,
    get socket() {
      return socket!;
    },
    sockets,
    async cleanup() {
      try {
        await session.close();
      } catch {
        // ignore cleanup close failures in tests
      }
      rmSync(logRootDir, { recursive: true, force: true });
    }
  };
}

async function completeRecoveryHandshake(socket: FakeWebSocket, threadId = 'thread-1'): Promise<void> {
  const recoveryInitializeRequest = socket.sent.find((item) => item.method === 'initialize');
  assert.ok(recoveryInitializeRequest);
  socket.emitServerMessage({ id: recoveryInitializeRequest.id, result: { userAgent: 'test/0.111.0' } });
  await tick();

  const threadResumeRequest = socket.sent.find((item) => item.method === 'thread/resume');
  assert.ok(threadResumeRequest);
  socket.emitServerMessage({ id: threadResumeRequest.id, result: { thread: { id: threadId, cliVersion: '0.111.0' } } });
  await tick();
}

test('app session becomes idle after thread starts without forcing a fake waiting state', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    const snapshot = context.session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'IDLE');
    assert.equal(snapshot.liveBuffer, '');
    assert.equal(seen.length, 0);
  } finally {
    await context.cleanup();
  }
});

test('app session keeps session log window hidden by default', () => {
  const previous = process.env.COMMUNICATE_CODEX_LOG_WINDOW;
  delete process.env.COMMUNICATE_CODEX_LOG_WINDOW;

  const logRootDir = createLogRoot();
  let openLogWindowCalls = 0;

  try {
    const session = createCodexAppSession({
      taskId: 'T1',
      cwd: 'D:\\Workspace\\Project',
      command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
      logRootDir,
      openLogWindow: () => {
        openLogWindowCalls += 1;
        return { pid: 778, close() {} };
      }
    });

    assert.equal(openLogWindowCalls, 0);
    assert.equal(session.getSnapshot().windowPid, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.COMMUNICATE_CODEX_LOG_WINDOW;
    } else {
      process.env.COMMUNICATE_CODEX_LOG_WINDOW = previous;
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session logs a runtime build fingerprint on session open', () => {
  const logRootDir = createLogRoot();

  try {
    const session = createCodexAppSession({
      taskId: 'T1',
      cwd: 'D:\\Workspace\\Project',
      command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
      logRootDir
    });

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.match(logContent, /BUILD_FINGERPRINT .*"runtimeArtifactPath":".*app-session\.js"/);
    assert.match(logContent, /BUILD_FINGERPRINT .*"runtimeArtifactMtimeMs":\d+/);
    assert.match(logContent, /BUILD_FINGERPRINT .*"runtimeArtifactSize":\d+/);
  } finally {
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session can route websocket traffic through the diagnostic tcp proxy', async () => {
  const previous = process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG;
  process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG = '1';

  const child = createMockChild();
  const logRootDir = createLogRoot();
  const upstreamPort = await allocateTestPort();
  const proxyPort = await allocateTestPort();
  const allocatedPorts = [upstreamPort, proxyPort];
  let allocateCalls = 0;
  let socket: FakeWebSocket | undefined;
  const spawnedListenUrls: string[] = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => {
      const port = allocatedPorts[allocateCalls];
      allocateCalls += 1;
      assert.notEqual(port, undefined);
      return port!;
    },
    spawnFactory: (_command: string, args: string[]) => {
      spawnedListenUrls.push(String(args.at(-1)));
      return child;
    },
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await waitForCondition(() => Boolean(socket?.sent.find((item) => item.method === 'initialize')), 2_000, 10);

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
    assert.equal(socket?.url, `ws://127.0.0.1:${proxyPort}`);
    assert.deepEqual(spawnedListenUrls, [`ws://127.0.0.1:${upstreamPort}`]);

    socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const startupRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(startupRequest);
    socket?.emitServerMessage({ id: startupRequest.id, result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } } });
    await tick();

    assert.equal(session.getSnapshot().lifecycle, 'IDLE');
    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.ok(logContent.includes(`"connectUrl":"ws://127.0.0.1:${proxyPort}"`));
    assert.ok(logContent.includes(`"upstreamUrl":"ws://127.0.0.1:${upstreamPort}"`));
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    if (previous === undefined) {
      delete process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG;
    } else {
      process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG = previous;
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session can complete startup through the diagnostic tcp proxy using a real websocket transport', async () => {
  const previous = process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG;
  process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG = '1';

  const child = createMockChild();
  const logRootDir = createLogRoot();
  const upstreamPort = await allocateTestPort();
  const proxyPort = await allocateTestPort();
  const mockServer = await startMockCodexWebSocketServer(upstreamPort);
  const allocatedPorts = [upstreamPort, proxyPort];
  let allocateCalls = 0;
  const spawnedListenUrls: string[] = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => {
      const port = allocatedPorts[allocateCalls];
      allocateCalls += 1;
      assert.notEqual(port, undefined);
      return port!;
    },
    spawnFactory: (_command: string, args: string[]) => {
      spawnedListenUrls.push(String(args.at(-1)));
      return child;
    },
    killProcessTree: () => {
      // Avoid touching the real process table in the transport integration test.
    },
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await waitForCondition(() => session.getSnapshot().lifecycle === 'IDLE');

    assert.deepEqual(spawnedListenUrls, [`ws://127.0.0.1:${upstreamPort}`]);
    assert.ok(mockServer.receivedMessages.some((message) => message.method === 'initialize'));
    assert.ok(mockServer.receivedMessages.some((message) => message.method === 'thread/start'));

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.ok(logContent.includes(`"connectUrl":"ws://127.0.0.1:${proxyPort}"`));
    assert.match(logContent, /TCP_PROXY_C2S /);
    assert.match(logContent, /TCP_PROXY_S2C /);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    await mockServer.close();
    if (previous === undefined) {
      delete process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG;
    } else {
      process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG = previous;
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session proxy cleanup does not append to the session log after close returns', async () => {
  const previous = process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG;
  process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG = '1';

  const child = createMockChild();
  const logRootDir = createLogRoot();
  const allocatedPorts = [8794, 8795];
  let allocateCalls = 0;
  let socket: FakeWebSocket | undefined;
  let cleaned = false;
  const originalConsoleError = console.error;
  const capturedErrors: string[] = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => {
      const port = allocatedPorts[allocateCalls];
      allocateCalls += 1;
      assert.notEqual(port, undefined);
      return port!;
    },
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir
  } as any);

  async function cleanupSession(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    if (previous === undefined) {
      delete process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG;
    } else {
      process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG = previous;
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };

    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const startupRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(startupRequest);
    socket?.emitServerMessage({ id: startupRequest.id, result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } } });
    await tick();

    await cleanupSession();
    await sleep(80);

    const appendErrors = capturedErrors.filter((line) => line.includes('[session-log] append failed'));
    assert.equal(appendErrors.length, 0, appendErrors.join('\n'));
  } finally {
    console.error = originalConsoleError;
    await cleanupSession();
  }
});

test('app session can re-enable the session log window through the debug env backdoor', () => {
  const previous = process.env.COMMUNICATE_CODEX_LOG_WINDOW;
  process.env.COMMUNICATE_CODEX_LOG_WINDOW = '1';

  const logRootDir = createLogRoot();
  let openLogWindowCalls = 0;

  try {
    const session = createCodexAppSession({
      taskId: 'T1',
      cwd: 'D:\\Workspace\\Project',
      command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
      logRootDir,
      openLogWindow: () => {
        openLogWindowCalls += 1;
        return { pid: 779, close() {} };
      }
    });

    assert.equal(openLogWindowCalls, 1);
    assert.equal(session.getSnapshot().windowPid, 779);
  } finally {
    if (previous === undefined) {
      delete process.env.COMMUNICATE_CODEX_LOG_WINDOW;
    } else {
      process.env.COMMUNICATE_CODEX_LOG_WINDOW = previous;
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session honors explicit log window disable even when the debug env backdoor is enabled', () => {
  const previous = process.env.COMMUNICATE_CODEX_LOG_WINDOW;
  process.env.COMMUNICATE_CODEX_LOG_WINDOW = '1';

  const logRootDir = createLogRoot();
  let openLogWindowCalls = 0;

  try {
    const session = createCodexAppSession({
      taskId: 'T1',
      cwd: 'D:\\Workspace\\Project',
      command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
      logRootDir,
      enableLogWindow: false,
      openLogWindow: () => {
        openLogWindowCalls += 1;
        return { pid: 780, close() {} };
      }
    });

    assert.equal(openLogWindowCalls, 0);
    assert.equal(session.getSnapshot().windowPid, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.COMMUNICATE_CODEX_LOG_WINDOW;
    } else {
      process.env.COMMUNICATE_CODEX_LOG_WINDOW = previous;
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session normalizes a PowerShell codex shim to the sibling cmd wrapper before spawn', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  const shimRoot = mkdtempSync(path.join(os.tmpdir(), 'communicate-app-codex-shim-'));
  const ps1Path = path.join(shimRoot, 'codex.ps1');
  const cmdPath = path.join(shimRoot, 'codex.cmd');
  writeFileSync(ps1Path, '# test shim', 'utf8');
  writeFileSync(cmdPath, '@echo off', 'utf8');

  let capturedCommand = '';
  let capturedShell: boolean | undefined;
  let socket: FakeWebSocket | undefined;
  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: [ps1Path, '--verbose'],
    allocatePort: async () => 8788,
    spawnFactory: (command: string, _args: string[], options: { cwd?: string; shell?: boolean }) => {
      capturedCommand = command;
      capturedShell = options.shell;
      return child;
    },
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir
  });

  try {
    session.start();
    await tick();
    assert.equal(capturedCommand, cmdPath);
    assert.equal(capturedShell, true);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    socket?.close();
    rmSync(shimRoot, { recursive: true, force: true });
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session turns approval request into waiting state and sends accept response', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        command: 'git status',
        cwd: 'D:\\Workspace\\Project'
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_waiting_user');
    assert.equal(seen[seen.length - 1]?.waitKind, 'confirm');
    assert.equal(seen[seen.length - 1]?.turnId, 'turn-1');
    assert.match(String(seen[seen.length - 1]?.output ?? ''), /git status/);

    context.session.sendReply({ action: 'confirm', value: 'allow' });
    await tick();

    const approvalResponse = context.socket.sent.find((item) => item.id === 99 && !item.method);
    assert.deepEqual(approvalResponse?.result, { decision: 'accept' });
  } finally {
    await context.cleanup();
  }
});

test('app session emits approval_denied interruption kind after an approval wait is denied and the turn is interrupted', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      id: 101,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        command: 'git push',
        cwd: 'D:\\Workspace\\Project'
      }
    });
    await tick();

    context.session.sendReply({ action: 'confirm', value: 'deny' });
    await tick();

    const approvalResponse = context.socket.sent.find((item) => item.id === 101 && !item.method);
    assert.deepEqual(approvalResponse?.result, { decision: 'decline' });

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted', error: null }
      }
    });
    await tick();

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.turnId, 'turn-1');
    assert.equal(failure?.interruptionKind, 'approval_denied');
    assert.match(String(failure?.output ?? ''), /Turn completed with status: interrupted/);
  } finally {
    await context.cleanup();
  }
});

test('app session emits local_comm interruption kind when the app-server exits unexpectedly', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.child.emit('exit', 1);
    await tick();

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'local_comm');
    assert.match(String(failure?.output ?? ''), /Codex app-server exited with code 1\./);
  } finally {
    await context.cleanup();
  }
});

test('app session emits upstream_execution interruption kind when turn/completed reports interrupted without stronger evidence', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Run upstream interruption case.' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);

    context.socket.emitServerMessage({
      id: turnStartRequest.id,
      result: { turn: { id: 'turn-1', status: 'inProgress', error: null } }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted', error: null }
      }
    });
    await tick();

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');
    assert.match(String(failure?.output ?? ''), /Turn completed with status: interrupted/);
  } finally {
    await context.cleanup();
  }
});

test('app session logs terminal interrupt notifications with socket generation context', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Trace interrupted terminal notification.' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);

    context.socket.emitServerMessage({
      id: turnStartRequest.id,
      result: { turn: { id: 'turn-1', status: 'inProgress', error: null } }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted', error: null }
      }
    });
    await tick();

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    const payloads = readLoggedEventPayloads(context.session.getLogPath(), 'TURN_TERMINAL_NOTIFY_OBSERVED');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.rawMethod, 'turn/completed');
    assert.equal(payloads[0]?.turnId, 'turn-1');
    assert.equal(payloads[0]?.status, 'interrupted');
    assert.equal(payloads[0]?.socketGenerationAtReceive, 1);
    assert.equal(payloads[0]?.activeTurnId, 'turn-1');
    assert.equal(payloads[0]?.pendingRpcCount, 0);
    assert.equal(payloads[0]?.recoveryInFlight, false);
  } finally {
    await context.cleanup();
  }
});

test('app session emits upstream_execution interruption kind when startup rpc returns an upstream error', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    startupError: { message: 'Unhandled upstream crash' }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');
    assert.match(String(failure?.output ?? ''), /Unhandled upstream crash/);
  } finally {
    await context.cleanup();
  }
});

test('app session turn/start upstream reject is classified as upstream_execution', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Trigger turn start upstream reject' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({
      id: turnStartRequest.id,
      error: { message: 'turn/start rejected by codex' }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');
    assert.match(String(failure?.output ?? ''), /turn\/start rejected by codex/i);
  } finally {
    await context.cleanup();
  }
});

test('app session turn/start method-not-found is classified as capability_missing', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Trigger missing turn start capability' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({
      id: turnStartRequest.id,
      error: { code: -32601, message: 'Method not found' }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /Method not found/i);
    assert.match(output, /missing capabilities: .*turn\/start/i);
  } finally {
    await context.cleanup();
  }
});

test('app session completes a turn, returns to idle, and can start another turn', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Say hello and stop.' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.equal(firstTurnStartRequest?.params?.input?.[0]?.text, 'Say hello and stop.');

    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const runningSnapshot = context.session.getSnapshot() as any;
    assert.equal(runningSnapshot.activeTurnId, 'turn-1');

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Hello from Codex.'
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.turnId, 'turn-1');
    assert.equal(seen[seen.length - 1]?.output, 'Hello from Codex.');

    const snapshotAfterFirstTurn = context.session.getSnapshot();
    assert.equal(snapshotAfterFirstTurn.lifecycle, 'IDLE');
    assert.equal(snapshotAfterFirstTurn.liveBuffer, '');
    assert.equal(snapshotAfterFirstTurn.checkpointOutput, 'Hello from Codex.');
    assert.equal((snapshotAfterFirstTurn as any).activeTurnId, undefined);

    context.session.sendReply({ action: 'input_text', text: 'Start second turn.' });
    await tick();
    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    assert.equal(turnStartRequests.length, 2);
    assert.equal(turnStartRequests[1]?.params?.input?.[0]?.text, 'Start second turn.');
  } finally {
    await context.cleanup();
  }
});

test('app session rejects a second bootstrap input instead of silently overwriting it', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir
  });

  try {
    session.start();
    session.sendReply({ action: 'input_text', text: 'Bootstrap prompt' });
    assert.throws(() => session.sendReply({ action: 'input_text', text: 'Overwritten prompt' }), /启动中|稍后/);
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadStartRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(threadStartRequest);
    socket?.emitServerMessage({ id: threadStartRequest.id, result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } } });
    await tick();

    const turnStartRequest = socket?.sent.find((item) => item.method === 'turn/start');
    assert.equal(turnStartRequest?.params?.input?.[0]?.text, 'Bootstrap prompt');
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session allows concurrent input while a turn is already running', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'First turn' });
    await tick();

    assert.doesNotThrow(() => {
      context.session.sendReply({ action: 'input_text', text: 'Second turn' });
    });

    await tick();
    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    assert.equal(turnStartRequests.length, 2);
  } finally {
    await context.cleanup();
  }
});

test('app session logs turn start requests with concurrent reply provenance', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'First turn' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.session.sendReply({ action: 'input_text', text: 'Second turn' });
    await tick();

    const payloads = readLoggedEventPayloads(context.session.getLogPath(), 'TURN_START_REQUESTED');
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0]?.source, 'user_reply');
    assert.equal(payloads[0]?.threadId, 'thread-1');
    assert.equal(payloads[0]?.turnRequestSerial, 1);
    assert.equal(payloads[1]?.source, 'concurrent_user_reply');
    assert.equal(payloads[1]?.threadId, 'thread-1');
    assert.equal(payloads[1]?.activeTurnId, 'turn-1');
    assert.equal(payloads[1]?.allowConcurrent, true);
    assert.equal(payloads[1]?.turnRequestSerial, 2);
  } finally {
    await context.cleanup();
  }
});

test('app session logs turn/start intent before the outbound rpc send', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'First turn' });
    await tick();

    const turnStartEntries = readLoggedEventEntries(context.session.getLogPath(), 'TURN_START_REQUESTED');
    const rpcSendEntries = readLoggedEventEntries(context.session.getLogPath(), 'RPC_SEND').filter(
      (entry) => entry.payload.method === 'turn/start'
    );

    assert.equal(turnStartEntries.length, 1);
    assert.equal(rpcSendEntries.length, 1);
    assert.ok(turnStartEntries[0].lineIndex < rpcSendEntries[0].lineIndex);
  } finally {
    await context.cleanup();
  }
});

test('app session logs thread status change diagnostics before idle reconciliation', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 60_000
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Watch idle status diagnostics.' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        status: { type: 'idle' }
      }
    });
    await tick();

    const payloads = readLoggedEventPayloads(context.session.getLogPath(), 'THREAD_STATUS_CHANGED');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.statusType, 'idle');
    assert.equal(payloads[0]?.action, 'poll_thread_read');
    assert.equal(payloads[0]?.threadId, 'thread-1');
    assert.equal(payloads[0]?.activeTurnId, 'turn-1');
    assert.equal(payloads[0]?.hasRunningTurn, true);
  } finally {
    await context.cleanup();
  }
});

test('app session tracks active command progress and clears it after command completion', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Run the test suite' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const beforeCommand = context.session.getSnapshot();
    assert.equal(beforeCommand.activeCommand, false);
    assert.equal(typeof beforeCommand.lastProgressAt, 'string');
    assert.equal(beforeCommand.lastCommandProgressAt, undefined);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/exec_command_begin',
      params: {
        msg: { command: 'npm test' }
      }
    });
    await tick();

    const started = context.session.getSnapshot();
    assert.equal(started.activeCommand, true);
    assert.equal(started.activeCommandCommand, 'npm test');
    assert.equal(typeof started.activeCommandStartedAt, 'string');
    assert.equal(typeof started.lastProgressAt, 'string');
    assert.equal(typeof started.lastCommandProgressAt, 'string');

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/commandExecution/outputDelta',
      params: {
        delta: 'running tests...\n'
      }
    });
    await tick();

    const afterOutput = context.session.getSnapshot();
    assert.equal(afterOutput.activeCommand, true);
    assert.equal(afterOutput.lastCommandProgressAt !== started.lastCommandProgressAt, true);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: {
          type: 'commandExecution'
        }
      }
    });
    await tick();

    const completed = context.session.getSnapshot();
    assert.equal(completed.activeCommand, false);
    assert.equal(completed.activeCommandCommand, undefined);
    assert.equal(completed.activeCommandStartedAt, undefined);
    assert.equal(completed.lastCommandProgressAt, undefined);
    assert.equal(typeof completed.lastProgressAt, 'string');
  } finally {
    await context.cleanup();
  }
});


test('app session close attempts turn interrupt before forcing transport shutdown', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const closePromise = context.session.close();
    await tick();

    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    assert.deepEqual(interruptRequest?.params, { threadId: 'thread-1', turnId: 'turn-1' });
    const interruptRequested = readLoggedEventPayloads(context.session.getLogPath(), 'TURN_INTERRUPT_REQUESTED');
    assert.equal(interruptRequested.length, 1);
    assert.equal(interruptRequested[0]?.source, 'close');
    assert.equal(interruptRequested[0]?.threadId, 'thread-1');
    assert.equal(interruptRequested[0]?.turnId, 'turn-1');

    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    const result = await closePromise;

    assert.equal(result.forced, false);
    assert.equal(context.session.getSnapshot().lifecycle, 'CLOSED');
    assert.equal(context.child.killCalls, 1);
    const cleanupRequested = readLoggedEventPayloads(context.session.getLogPath(), 'TRANSPORT_CLEANUP_REQUESTED');
    assert.equal(cleanupRequested.length, 1);
    assert.equal(cleanupRequested[0]?.source, 'close');
    assert.equal(cleanupRequested[0]?.threadId, 'thread-1');
    assert.equal(cleanupRequested[0]?.activeTurnId, 'turn-1');
    assert.equal(cleanupRequested[0]?.hadSocket, true);
    assert.equal(cleanupRequested[0]?.hadChild, true);
    assert.throws(() => context.session.sendReply({ action: 'input_text', text: 'After close' }), /已关闭|closed/i);
  } finally {
    await context.cleanup();
  }
});

test('app session logs turn interrupt requests before sending manual interrupt rpc', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const interruptPromise = context.session.interruptCurrentTurn();
    await tick();

    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    const payloads = readLoggedEventPayloads(context.session.getLogPath(), 'TURN_INTERRUPT_REQUESTED');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.source, 'manual_interrupt');
    assert.equal(payloads[0]?.threadId, 'thread-1');
    assert.equal(payloads[0]?.turnId, 'turn-1');
    assert.equal(payloads[0]?.lifecycle, 'RUNNING_TURN');

    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await interruptPromise;
  } finally {
    await context.cleanup();
  }
});

test('app session logs manual turn/interrupt intent before the outbound rpc send', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const interruptPromise = context.session.interruptCurrentTurn();
    await tick();

    const interruptEntries = readLoggedEventEntries(context.session.getLogPath(), 'TURN_INTERRUPT_REQUESTED');
    const rpcSendEntries = readLoggedEventEntries(context.session.getLogPath(), 'RPC_SEND').filter(
      (entry) => entry.payload.method === 'turn/interrupt'
    );

    assert.equal(interruptEntries.length, 1);
    assert.equal(rpcSendEntries.length, 1);
    assert.ok(interruptEntries[0].lineIndex < rpcSendEntries[0].lineIndex);

    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await interruptPromise;
  } finally {
    await context.cleanup();
  }
});

test('app session manual interrupt returns to idle and ignores the expected interrupted completion event', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/exec_command_begin',
      params: {
        msg: { command: 'npm test' }
      }
    });
    await tick();

    const interruptPromise = context.session.interruptCurrentTurn();
    await tick();

    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    assert.deepEqual(interruptRequest?.params, { threadId: 'thread-1', turnId: 'turn-1' });

    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await interruptPromise;

    const interrupted = context.session.getSnapshot();
    assert.equal(interrupted.lifecycle, 'IDLE');
    assert.equal(interrupted.activeCommand, false);
    assert.equal(interrupted.checkpointOutput, '当前运行已打断，等待下一步指令。');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'interrupted',
          error: { message: 'Turn interrupted by user' }
        }
      }
    });
    await tick();

    assert.equal(context.session.getSnapshot().lifecycle, 'IDLE');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
    assert.equal(readLoggedEventPayloads(context.session.getLogPath(), 'TURN_TERMINAL_NOTIFY_OBSERVED').length, 0);

    context.session.sendReply({ action: 'input_text', text: 'Please summarize current progress' });
    await tick();

    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    assert.equal(turnStartRequests.length, 2);
    assert.equal(turnStartRequests.at(-1)?.params?.input?.[0]?.text, 'Please summarize current progress');
  } finally {
    await context.cleanup();
  }
});

test('app session manual interrupt ignores the expected turn/aborted notification', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const interruptPromise = context.session.interruptCurrentTurn();
    await tick();

    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    assert.deepEqual(interruptRequest?.params, { threadId: 'thread-1', turnId: 'turn-1' });

    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await interruptPromise;

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/aborted',
      params: {
        turnId: 'turn-1',
        error: 'Turn interrupted by user'
      }
    });
    await tick();

    assert.equal(context.session.getSnapshot().lifecycle, 'IDLE');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
    assert.equal(readLoggedEventPayloads(context.session.getLogPath(), 'TURN_TERMINAL_NOTIFY_OBSERVED').length, 0);
  } finally {
    await context.cleanup();
  }
});

test('app session ignores late finalize events from an interrupted turn after a new turn starts', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const interruptPromise = context.session.interruptCurrentTurn();
    await tick();
    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await interruptPromise;

    context.session.sendReply({ action: 'input_text', text: 'Please summarize current progress' });
    await tick();
    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    assert.equal(turnStartRequests.length, 2);
    const secondTurnStart = turnStartRequests.at(-1);
    assert.ok(secondTurnStart);
    context.socket.emitServerMessage({ id: secondTurnStart.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/agent_message',
      params: {
        msg: {
          turn_id: 'turn-1',
          phase: 'final_answer',
          message: 'stale final answer from interrupted turn'
        }
      }
    });
    await tick();

    assert.equal(context.session.getSnapshot().lifecycle, 'RUNNING_TURN');
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/task_complete',
      params: {
        msg: {
          turn_id: 'turn-1',
          last_agent_message: 'stale task complete output'
        }
      }
    });
    await tick();

    assert.equal(context.session.getSnapshot().lifecycle, 'RUNNING_TURN');
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/agent_message',
      params: {
        msg: {
          turn_id: 'turn-2',
          phase: 'final_answer',
          message: 'fresh summary output'
        }
      }
    });
    await tick();

    const finishedEvents = seen.filter((event) => event.type === 'task_finished');
    assert.equal(finishedEvents.length, 1);
    assert.equal(finishedEvents[0]?.output, 'fresh summary output');
    assert.equal(context.session.getSnapshot().checkpointOutput, 'fresh summary output');
  } finally {
    await context.cleanup();
  }
});

test('app session ignores interrupted-turn thread/read final text while a new turn is still starting', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const interruptPromise = context.session.interruptCurrentTurn();
    await tick();
    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await interruptPromise;

    context.session.sendReply({ action: 'input_text', text: 'Please summarize current progress' });
    await tick();
    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    assert.equal(turnStartRequests.length, 2);
    const secondTurnStart = turnStartRequests.at(-1);
    assert.ok(secondTurnStart);

    await sleep(15);
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'interrupted',
              error: { message: 'Turn interrupted by user' },
              items: [
                {
                  id: 'item-stale',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'stale final answer from interrupted turn'
                }
              ]
            }
          ]
        }
      }
    });
    await tick();

    const pendingSnapshot = context.session.getSnapshot();
    assert.equal(pendingSnapshot.lifecycle, 'RUNNING_TURN');
    assert.equal(pendingSnapshot.liveBuffer, '');
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);

    context.socket.emitServerMessage({ id: secondTurnStart.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'completed', error: null }
      }
    });
    await tick();

    const finishedEvents = seen.filter((event) => event.type === 'task_finished');
    assert.equal(finishedEvents.length, 1);
    assert.equal(finishedEvents[0]?.output, '');
    assert.equal(context.session.getSnapshot().checkpointOutput, '');
  } finally {
    await context.cleanup();
  }
});


test('app session close can kill the full Windows process tree', async () => {
  const killed: number[] = [];
  const context = await bootstrapSession({
    killProcessTree: (pid) => {
      killed.push(pid);
    }
  });

  try {
    const result = await context.session.close();

    assert.equal(result.forced, false);
    assert.deepEqual(killed, [context.child.pid]);
    assert.equal(context.child.killCalls, 0);
    const payloads = readLoggedEventPayloads(context.session.getLogPath(), 'CHILD_KILL_REQUESTED');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.source, 'close');
    assert.equal(payloads[0]?.strategy, 'kill_process_tree');
    assert.equal(payloads[0]?.childPid, context.child.pid);
  } finally {
    await context.cleanup();
  }
});

test('app session retains per-turn terminal notify provenance for long-pending rpc diagnostics', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 80
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'First turn' });
    await tick();
    const firstTurnStart = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStart);
    context.socket.emitServerMessage({ id: firstTurnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();
    await sleep(30);

    await waitForCondition(
      () => context.socket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-1', status: 'completed', error: null }
      }
    });
    await tick();

    context.session.sendReply({ action: 'input_text', text: 'Second turn' });
    await tick();
    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    const secondTurnStart = turnStartRequests.at(-1);
    assert.ok(secondTurnStart);
    context.socket.emitServerMessage({ id: secondTurnStart.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-2', status: 'completed', error: null }
      }
    });
    await tick();

    await waitForCondition(
      () =>
        readLoggedEventPayloads(context.session.getLogPath(), 'RPC_LONG_PENDING').some(
          (payload) => payload.method === 'thread/read' && payload.turnIdAtSend === 'turn-1'
        ),
      2_000,
      10
    );

    const payload = readLoggedEventPayloads(context.session.getLogPath(), 'RPC_LONG_PENDING').find(
      (entry) => entry.method === 'thread/read' && entry.turnIdAtSend === 'turn-1'
    );
    assert.ok(payload);
    assert.equal(payload.lastTerminalNotificationMethod, 'turn/completed');
    assert.equal(payload.lastTerminalNotificationTurnId, 'turn-1');
    assert.equal(payload.lastTerminalNotificationStatus, 'completed');
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start includes assistant persona fields when provided', async () => {
  const context = await bootstrapSession({
    developerInstructions: '你是长期科研助理。',
    baseInstructions: '默认使用简体中文回答。',
    personality: 'pragmatic'
  });

  try {
    assert.equal(context.startupRequest?.method, 'thread/start');
    assert.deepEqual(context.startupRequest?.params, {
      cwd: 'D:\\Workspace\\Project',
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
      developerInstructions: '你是长期科研助理。',
      baseInstructions: '默认使用简体中文回答。',
      personality: 'pragmatic'
    });
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start includes ephemeral when requested', async () => {
  const context = await bootstrapSession({ ephemeral: true });

  try {
    assert.equal(context.startupRequest?.method, 'thread/start');
    assert.deepEqual(context.startupRequest?.params, {
      cwd: 'D:\\Workspace\\Project',
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
      ephemeral: true
    });
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start includes model when provided and snapshot adopts the resolved model', async () => {
  const context = await bootstrapSession({
    model: 'gpt-5.4',
    startupResultModel: 'gpt-5.4-codex'
  });

  try {
    assert.equal(context.startupRequest?.method, 'thread/start');
    assert.deepEqual(context.startupRequest?.params, {
      cwd: 'D:\\Workspace\\Project',
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
      model: 'gpt-5.4'
    });
    assert.equal((context.session.getSnapshot() as any).model, 'gpt-5.4-codex');
  } finally {
    await context.cleanup();
  }
});

test('app session start returns a promise that resolves after startup model is adopted', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir,
    model: 'gpt-5.4'
  } as any);

  try {
    const startResult = session.start() as Promise<void> | void;
    assert.equal(typeof (startResult as Promise<void> | undefined)?.then, 'function');

    await tick();
    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadStartRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(threadStartRequest);
    socket?.emitServerMessage({
      id: threadStartRequest.id,
      result: {
        model: 'gpt-5.4-resolved',
        thread: { id: 'thread-1', cliVersion: '0.111.0' }
      }
    });

    await startResult;
    assert.equal((session.getSnapshot() as any).model, 'gpt-5.4-resolved');
  } finally {
    await session.close();
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session close interrupts the user-started turn when an unrelated turn/started arrives', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Long running task' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-commentary', status: 'inProgress', error: null }
      }
    });
    await tick();

    const closePromise = context.session.close();
    await tick();

    const interruptRequest = context.socket.sent.find((item) => item.method === 'turn/interrupt');
    assert.ok(interruptRequest);
    assert.deepEqual(interruptRequest?.params, { threadId: 'thread-1', turnId: 'turn-1' });

    context.socket.emitServerMessage({ id: interruptRequest.id, result: {} });
    await closePromise;
  } finally {
    await context.cleanup();
  }
});

test('app session resume mode re-spawns transport, sends thread/resume, and can start a new turn', async () => {
  const context = await bootstrapSession({
    mode: 'resume',
    resumeThreadId: 'thread-resume-1',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    model: 'gpt-5.4',
    startupResultModel: 'gpt-5.4-resolved',
    developerInstructions: '你是长期科研助理。',
    baseInstructions: '默认使用简体中文回答。',
    personality: 'pragmatic',
    interruptedByRestart: true
  });

  try {
    assert.equal(context.spawnCalls, 1);
    assert.equal(context.sockets.length, 1);
    assert.equal(context.startupRequest?.method, 'thread/resume');
    assert.deepEqual(context.startupRequest?.params, {
      threadId: 'thread-resume-1',
      cwd: 'D:\\Workspace\\Project',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model: 'gpt-5.4',
      developerInstructions: '你是长期科研助理。',
      baseInstructions: '默认使用简体中文回答。',
      personality: 'pragmatic'
    });
    assert.equal(context.socket.sent.find((item) => item.method === 'thread/start'), undefined);

    const snapshot = context.session.getSnapshot() as any;
    assert.equal(snapshot.lifecycle, 'IDLE');
    assert.equal(snapshot.codexThreadId, 'thread-resume-1');
    assert.equal(snapshot.model, 'gpt-5.4-resolved');
    assert.equal(snapshot.interruptedByRestart, true);

    context.session.sendReply({ action: 'input_text', text: 'Continue after restart.' });
    await tick();

    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    assert.equal(turnStartRequest?.params?.threadId, 'thread-resume-1');
    assert.equal(turnStartRequest?.params?.input?.[0]?.text, 'Continue after restart.');
  } finally {
    await context.cleanup();
  }
});

test('app session resume bootstrap input is logged once before turn start', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir,
    mode: 'resume',
    resumeThreadId: 'thread-resume-1',
    interruptedByRestart: true,
    resumeContext: {
      sourceSessionLifecycle: 'RUNNING_TURN',
      sourceLastEventAt: '2026-04-03T12:37:22.581Z',
      sourceCreatedAt: '2026-04-01T12:37:00.156Z',
      sourceIdleMs: 1234,
      sourceAgeMs: 5678
    }
  } as any);

  try {
    session.start();
    session.sendReply({ action: 'input_text', text: 'Continue after restart.' });
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadResumeRequest = socket?.sent.find((item) => item.method === 'thread/resume');
    assert.ok(threadResumeRequest);
    socket?.emitServerMessage({ id: threadResumeRequest.id, result: { thread: { id: 'thread-resume-1', cliVersion: '0.111.0' } } });
    await tick();

    const turnStartRequest = socket?.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    assert.equal(turnStartRequest?.params?.input?.[0]?.text, 'Continue after restart.');

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.equal(countOccurrences(logContent, 'FEISHU IN Continue after restart.'), 1);
    assert.match(logContent, /RPC_SEND .*"method":"thread\/resume"/);
    assert.match(logContent, /RPC_RESOLVE .*"method":"thread\/resume"/);
    assert.match(logContent, /SESSION_RESUME_CONTEXT .*"sourceSessionLifecycle":"RUNNING_TURN"/);
    assert.match(logContent, /SESSION_RESUME_CONTEXT .*"sourceIdleMs":1234/);
    assert.match(logContent, /SESSION_RESUME_CONTEXT .*"sourceAgeMs":5678/);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session resume mode fails clearly when thread/resume is rejected', async () => {
  const context = await bootstrapSession({
    mode: 'resume',
    resumeThreadId: 'thread-resume-2',
    interruptedByRestart: true,
    startupError: { message: 'resume rejected by codex' }
  });

  try {
    assert.equal(context.startupRequest?.method, 'thread/resume');
    const snapshot = context.session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'FAILED');
    assert.match(snapshot.checkpointOutput ?? '', /resume rejected by codex/);
    assert.equal(context.socket.sent.find((item) => item.method === 'thread/start'), undefined);
  } finally {
    await context.cleanup();
  }
});
test('app session classifies a disconnected startup RPC as local_comm', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;
  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    onEvent: (event: any) => {
      seen.push(event as Record<string, unknown>);
    },
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    assert.ok(socket);
    socket.readyState = 3;
    await tick();

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'local_comm');
    assert.match(String(failure?.output ?? ''), /socket disconnected/i);
    assert.equal(socket.sent.find((item) => item.method === 'thread/start'), undefined);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});
test('app session finishes a turn from item completion plus idle thread status when turn/completed is absent', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Run a longer task' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Collecting notes...'
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'Market research is complete.',
          phase: 'final_answer'
        }
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'idle'
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Market research is complete.');

    const snapshot = context.session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'IDLE');
    assert.equal(snapshot.checkpointOutput, 'Market research is complete.');
  } finally {
    await context.cleanup();
  }
});

test('app session de-duplicates equivalent assistant delta notifications across app-server event families', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Check duplicate assistant deltas.' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/agent_message_content_delta',
      params: {
        id: 'turn-1',
        msg: {
          type: 'agent_message_content_delta',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item_id: 'item-1',
          delta: 'No duplicate output.'
        },
        conversationId: 'thread-1'
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'No duplicate output.'
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/agent_message_delta',
      params: {
        id: 'turn-1',
        msg: {
          type: 'agent_message_delta',
          delta: 'No duplicate output.'
        },
        conversationId: 'thread-1'
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'No duplicate output.');

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.equal(countOccurrences(logContent, 'No duplicate output.'), 1);
  } finally {
    await context.cleanup();
  }
});







test('app session reconnects after websocket close and recovers final output', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Run market research with reconnect' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    firstSocket.close();
    await sleep(20);

    assert.ok(context.sockets.length >= 2);
    assert.notEqual(context.socket, firstSocket);

    await completeRecoveryHandshake(context.socket);

    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Recovered final answer.' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Recovered final answer.');
  } finally {
    await context.cleanup();
  }
});

test('app session poisons a long-pending thread/read connection and recovers final output through thread/resume', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover a poisoned thread/read connection' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);
    assert.equal(firstSocket.readyState, 3);
    assert.notEqual(context.socket, firstSocket);

    await completeRecoveryHandshake(context.socket);

    await waitForCondition(
      () => context.socket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Recovered via poisoned connection.' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Recovered via poisoned connection.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session poisoned recovery thread/resume keeps and refreshes model metadata', async () => {
  const context = await bootstrapSession({
    model: 'gpt-5.4',
    startupResultModel: 'gpt-5.4-started',
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover model metadata' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);
    const recoverySocket = context.socket;
    const recoveryInitializeRequest = recoverySocket.sent.find((item) => item.method === 'initialize');
    assert.ok(recoveryInitializeRequest);
    recoverySocket.emitServerMessage({ id: recoveryInitializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadResumeRequest = recoverySocket.sent.find((item) => item.method === 'thread/resume');
    assert.ok(threadResumeRequest);
    assert.equal(threadResumeRequest?.params?.model, 'gpt-5.4-started');

    recoverySocket.emitServerMessage({
      id: threadResumeRequest.id,
      result: {
        model: 'gpt-5.4-recovered',
        thread: { id: 'thread-1', cliVersion: '0.111.0' }
      }
    });
    await tick();

    assert.equal((context.session.getSnapshot() as any).model, 'gpt-5.4-recovered');
  } finally {
    await context.cleanup();
  }
});

test('app session logs interrupted terminal state when recovery thread/read is the first observer', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Observe interrupted recovery provenance.' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);
    assert.equal(firstSocket.readyState, 3);
    assert.notEqual(context.socket, firstSocket);

    const recoveredSocket = context.socket;
    await completeRecoveryHandshake(recoveredSocket);

    await waitForCondition(
      () => recoveredSocket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );
    const recoveryThreadRead = recoveredSocket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(recoveryThreadRead);

    recoveredSocket.emitServerMessage({
      id: recoveryThreadRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'interrupted',
              error: { message: 'Recovered interrupted state.' },
              items: []
            }
          ]
        }
      }
    });
    await tick();

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');

    const payloads = readLoggedEventPayloads(context.session.getLogPath(), 'THREAD_READ_TERMINAL_TURN_OBSERVED');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.reason, 'socket/recovered');
    assert.equal(payloads[0]?.turnId, 'turn-1');
    assert.equal(payloads[0]?.turnStatus, 'interrupted');
    assert.equal(payloads[0]?.statusType, 'idle');
    assert.equal(payloads[0]?.socketGenerationAtSend, 2);
    assert.equal(payloads[0]?.lastTerminalNotificationMethod, null);
    const threadReadOnly = readLoggedEventPayloads(context.session.getLogPath(), 'INTERRUPTED_DISCOVERED_VIA_THREAD_READ_ONLY');
    assert.equal(threadReadOnly.length, 1);
    assert.equal(threadReadOnly[0]?.reason, 'socket/recovered');
    assert.equal(threadReadOnly[0]?.turnId, 'turn-1');
    assert.equal(threadReadOnly[0]?.statusType, 'idle');
    assert.equal(threadReadOnly[0]?.lastTerminalNotificationMethod, null);
  } finally {
    await context.cleanup();
  }
});

test('app session records fail-sourced transport cleanup after an upstream interrupted failure', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Fail and inspect cleanup source.' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-1', status: 'interrupted', error: { message: 'Interrupted upstream.' } }
      }
    });
    await tick();

    assert.equal(seen.at(-1)?.type, 'task_failed');
    await waitForCondition(
      () => readLoggedEventPayloads(context.session.getLogPath(), 'TRANSPORT_CLEANUP_REQUESTED').length > 0,
      2_000,
      10
    );
    const cleanupPayload = readLoggedEventPayloads(context.session.getLogPath(), 'TRANSPORT_CLEANUP_REQUESTED').at(-1);
    assert.equal(cleanupPayload?.source, 'fail');
    assert.equal(cleanupPayload?.hadSocket, true);
    assert.equal(cleanupPayload?.hadChild, true);
    assert.equal(cleanupPayload?.terminalLookupTurnId, 'turn-1');
    assert.equal(cleanupPayload?.lastTerminalNotificationMethod, 'turn/completed');
    assert.equal(cleanupPayload?.lastTerminalNotificationTurnId, 'turn-1');
    assert.equal(cleanupPayload?.lastTerminalNotificationStatus, 'interrupted');
  } finally {
    await context.cleanup();
  }
});

test('app session switches tracking to the recovery connection when the poisoned thread/read turn is still running', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Keep tracking after poisoned connection recovery' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);
    assert.equal(firstSocket.readyState, 3);
    assert.notEqual(context.socket, firstSocket);

    const recoveredSocket = context.socket;
    await completeRecoveryHandshake(recoveredSocket);

    await waitForCondition(
      () => recoveredSocket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );
    const threadReadRequest = recoveredSocket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    recoveredSocket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'active' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: []
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(context.session.getSnapshot().lifecycle, 'RUNNING_TURN');
    assert.equal(context.socket, recoveredSocket);
    assert.equal(seen.length, 0);

    recoveredSocket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: {
          id: 'item-final',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'Recovered tracking continues on the new socket.'
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Recovered tracking continues on the new socket.');
  } finally {
    await context.cleanup();
  }
});

test('app session logs and ignores late old-socket completion frames after poisoned recovery switches sockets', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Ignore late frames from the poisoned socket' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);
    const recoveredSocket = context.socket;
    assert.equal(firstSocket.readyState, 3);
    assert.notEqual(recoveredSocket, firstSocket);

    firstSocket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/commandExecution/outputDelta',
      params: {
        turnId: 'turn-1',
        delta: 'stale noise should stay unlogged'
      }
    });
    firstSocket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: {
          id: 'item-stale-final',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'Late old socket answer'
        }
      }
    });
    firstSocket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/task_complete',
      params: {
        msg: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'Late old socket task complete'
        }
      }
    });
    await tick();

    assert.equal(seen.length, 0);
    assert.equal(context.session.getSnapshot().lifecycle, 'RUNNING_TURN');
    const ignoredFrames = readLoggedEventPayloads(context.session.getLogPath(), 'IGNORED_SOCKET_FRAME_OBSERVED');
    assert.equal(ignoredFrames.length, 2);
    assert.deepEqual(
      ignoredFrames.map((payload) => payload.method),
      ['item/completed', 'codex/event/task_complete']
    );
    assert.ok(ignoredFrames.every((payload) => payload.reason === 'stale_socket'));
    assert.ok(ignoredFrames.every((payload) => payload.sourceSocketGeneration === 1));
    assert.ok(ignoredFrames.every((payload) => payload.activeSocketGeneration === 2));
    assert.ok(ignoredFrames.every((payload) => payload.sourceSocketReadyState === 3));

    await completeRecoveryHandshake(recoveredSocket);
    await waitForCondition(
      () => recoveredSocket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );
    const threadReadRequest = recoveredSocket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    recoveredSocket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Recovered answer wins.' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Recovered answer wins.');
  } finally {
    await context.cleanup();
  }
});

test('app session logs runtime child exit with active turn transport diagnostics', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Keep running until child exits' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.child.emit('exit', 23);
    await sleep(20);

    const childExitPayloads = readLoggedEventPayloads(context.session.getLogPath(), 'CHILD_EXIT');
    assert.ok(childExitPayloads.length >= 1);
    const childExit = childExitPayloads.at(-1) ?? {};
    assert.equal(childExit.code, 23);
    assert.equal(childExit.duringStartup, false);
    assert.equal(childExit.lifecycle, 'RUNNING_TURN');
    assert.equal(childExit.activeTurnId, 'turn-1');
    assert.equal(childExit.activeSocketGeneration, 1);
    assert.equal(childExit.lastSocketInboundMethod, 'turn/start');
    assert.equal(childExit.lastRpcSendMethod, 'turn/start');
    assert.equal(childExit.lastTerminalNotificationMethod, null);
  } finally {
    await context.cleanup();
  }
});

test('app session logs runtime child error with active turn transport diagnostics', async () => {
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Keep running until child errors' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.child.emit('error', new Error('synthetic runtime child error'));
    await sleep(20);

    const childErrorPayloads = readLoggedEventPayloads(context.session.getLogPath(), 'CHILD_ERROR');
    assert.ok(childErrorPayloads.length >= 1);
    const childError = childErrorPayloads.at(-1) ?? {};
    assert.match(String(childError.message ?? ''), /synthetic runtime child error/i);
    assert.equal(childError.duringStartup, false);
    assert.equal(childError.lifecycle, 'RUNNING_TURN');
    assert.equal(childError.activeTurnId, 'turn-1');
    assert.equal(childError.activeSocketGeneration, 1);
    assert.equal(childError.lastSocketInboundMethod, 'turn/start');
    assert.equal(childError.lastRpcSendMethod, 'turn/start');
    assert.equal(childError.lastTerminalNotificationMethod, null);
  } finally {
    await context.cleanup();
  }
});

test('app session polls thread/read to recover final output when completion notifications are missing', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Run market research' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await sleep(15);

    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'commentary', text: 'Collecting notes...' },
                { id: 'item-2', type: 'agentMessage', phase: 'final_answer', text: 'Final market summary from thread/read.' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Final market summary from thread/read.');
    assert.equal(context.session.getSnapshot().checkpointOutput, 'Final market summary from thread/read.');
  } finally {
    await context.cleanup();
  }
});

test('app session accepts string rpc response ids across startup and thread/read', async () => {
  const previousRaw = process.env.COMMUNICATE_DIAG_WS_RAW;
  process.env.COMMUNICATE_DIAG_WS_RAW = '1';
  const seen: Array<Record<string, unknown>> = [];
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    onEvent: (event: any) => {
      seen.push(event);
    },
    enableLogWindow: false,
    logRootDir,
    threadReadPollDelayMs: 1
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: String(initializeRequest.id), result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadStartRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(threadStartRequest);
    socket?.emitServerMessage({ id: String(threadStartRequest.id), result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } } });
    await tick();

    assert.equal(session.getSnapshot().lifecycle, 'IDLE');

    session.sendReply({ action: 'input_text', text: 'Run market research' });
    await tick();

    const turnStartRequest = socket?.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    socket?.emitServerMessage({ id: String(turnStartRequest.id), result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await sleep(15);

    const threadReadRequest = socket?.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    socket?.emitServerMessage({
      id: String(threadReadRequest.id),
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Recovered through string request id.' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Recovered through string request id.');
    assert.equal(session.getSnapshot().checkpointOutput, 'Recovered through string request id.');
    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.match(logContent, /WS_RAW_OUT .*"method":"thread\/read".*"rawId":\d+.*"rawIdType":"number"/);
    assert.match(logContent, /WS_RAW_IN .*"hasResult":true.*"rawId":"\d+".*"rawIdType":"string"/);
    assert.match(
      logContent,
      /RPC_RESPONSE_OBSERVED .*"rawId":"\d+".*"normalizedId":"\d+".*"matched":true.*"matchedMethod":"thread\/read"/
    );
    assert.match(
      logContent,
      /RPC_MATCH_DECISION .*"rawId":"\d+".*"normalizedId":"\d+".*"matched":true.*"method":"thread\/read".*"matchedDiagReqKey":"tr:thread-1:rpc:\d+:turn:null:serial:1:socket:\d+"/
    );
  } finally {
    if (previousRaw === undefined) {
      delete process.env.COMMUNICATE_DIAG_WS_RAW;
    } else {
      process.env.COMMUNICATE_DIAG_WS_RAW = previousRaw;
    }
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session disables raw websocket frame logging by default', async () => {
  const previousRaw = process.env.COMMUNICATE_DIAG_WS_RAW;
  delete process.env.COMMUNICATE_DIAG_WS_RAW;
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'No raw websocket logs by default' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await waitForCondition(
      () => context.socket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [{ id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Done without raw frames.' }]
            }
          ]
        }
      }
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.doesNotMatch(logContent, /WS_RAW_IN/);
    assert.doesNotMatch(logContent, /WS_RAW_OUT/);
  } finally {
    if (previousRaw !== undefined) {
      process.env.COMMUNICATE_DIAG_WS_RAW = previousRaw;
    }
    await context.cleanup();
  }
});

test('app session records structured stall diagnostics for suspected stalled turns', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Observe stall diagnostic state' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/exec_command_begin',
      params: {
        msg: { command: 'npm test' }
      }
    });
    await tick();
    await sleep(15);

    (context.session as any).recordStallDiagnostic({
      trigger: 'reply_status_suspected_stalled',
      threadId: 'feishu:chat-1',
      quietMs: 20 * 60_000,
      stallConfirmations: 2,
      replyStatusCardMessageId: 'om_card_2'
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /STALL_DIAGNOSTIC .*"trigger":"reply_status_suspected_stalled"/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"feishuThreadId":"feishu:chat-1"/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"replyStatusCardMessageId":"om_card_2"/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"activeTurnId":"turn-1"/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"codexThreadId":"thread-1"/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"activeCommand":true/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"activeCommandCommand":"npm test"/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"pendingRpcCount":1/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"pendingMethods":\["thread\/read"\]/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"threadReadInFlight":true/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"socketConnected":true/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"childPid":4321/);
  } finally {
    await context.cleanup();
  }
});

test('stall diagnostic prefers the pending thread/read request when multiple rpc calls overlap', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Prefer thread/read in diagnostics' });
    await tick();
    await sleep(15);

    (context.session as any).recordStallDiagnostic({
      trigger: 'reply_status_suspected_stalled',
      threadId: 'feishu:chat-1',
      quietMs: 20 * 60_000,
      stallConfirmations: 2,
      replyStatusCardMessageId: 'om_card_2'
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /STALL_DIAGNOSTIC .*"pendingMethods":\["turn\/start","thread\/read"\]/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"diagnosticRequestMethod":"thread\/read"/);
  } finally {
    await context.cleanup();
  }
});

test('app session logs rpc lifecycle and skipped thread/read polls while a read is still in flight', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Observe RPC diagnostics' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(15);
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Partial output'
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item_id: 'item-cmd-1',
          delta: 'tool output'
        },
        conversationId: 'thread-1'
      }
    });
    await sleep(15);

    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'Final diagnostic output.' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /RPC_SEND .*"method":"turn\/start"/);
    assert.match(logContent, /RPC_SEND .*"method":"thread\/read"/);
    assert.match(logContent, /RPC_RESOLVE .*"method":"thread\/read"/);
    assert.match(logContent, /THREAD_READ_SKIPPED_INFLIGHT/);
    assert.match(logContent, /SOCKET_NOTIFY_PENDING_RPC .*"method":"item\/agentMessage\/delta".*"pendingMethods":\["thread\/read"\]/);
    assert.match(logContent, /SOCKET_NOTIFY_PENDING_RPC .*"method":"codex\/event\/exec_command_output_delta".*"deltaLength":11/);
    assert.match(logContent, /SOCKET_NOTIFY_PENDING_RPC .*"method":"codex\/event\/exec_command_output_delta".*"msgType":"exec_command_output_delta"/);
  } finally {
    await context.cleanup();
  }
});

test('app session logs long-pending thread/read diagnostics and triggers poisoned connection recovery', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Observe long pending RPC diagnostics' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);
    assert.equal(firstSocket.readyState, 3);

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(
      logContent,
      /RPC_SEND_ATTEMPT .*"id":\d+.*"method":"thread\/read".*"diagReqKey":"tr:thread-1:rpc:\d+:turn:turn-1:serial:1:socket:\d+".*"socketReadyState":1.*"socketBufferedAmount":0/
    );
    assert.match(
      logContent,
      /RPC_SEND_SYNC_OK .*"id":\d+.*"method":"thread\/read".*"diagReqKey":"tr:thread-1:rpc:\d+:turn:turn-1:serial:1:socket:\d+".*"socketReadyState":1.*"socketBufferedAmount":0/
    );
    assert.match(logContent, /RPC_LONG_PENDING .*"method":"thread\/read"/);
    assert.match(logContent, /RPC_LONG_PENDING .*"diagnosticHint":"socket_open_but_no_inbound_after_request"/);
    assert.match(logContent, /RPC_LONG_PENDING .*"pendingRpcCount":1/);
    assert.match(logContent, /RPC_LONG_PENDING .*"threadReadInFlight":true/);
    assert.match(logContent, /RPC_LONG_PENDING .*"lastRpcSendMethod":"thread\/read"/);
    assert.match(logContent, /POISONED_THREAD_READ_RECOVERY_TRIGGER .*"method":"thread\/read"/);
  } finally {
    await context.cleanup();
  }
});

test('app session does not trigger poisoned recovery while turn/start is still pending', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1,
    rpcLongPendingThresholdMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Do not poison recovery before turn/start resolves' });
    await tick();

    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    await waitForCondition(
      () => context.socket.sent.some((item) => item.method === 'thread/read'),
      2_000,
      10
    );
    const threadReadRequest = context.socket.sent.find((item) => item.method === 'thread/read');
    assert.ok(threadReadRequest);

    await sleep(30);

    assert.equal(context.sockets.length, 1);
    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /RPC_LONG_PENDING .*"method":"thread\/read"/);
    assert.doesNotMatch(logContent, /POISONED_THREAD_READ_RECOVERY_TRIGGER/);
  } finally {
    await context.cleanup();
  }
});

test('app session logs thread/read send diagnostics when websocket send throws synchronously', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 5
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Trigger thread/read send failure diagnostics' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.failSendForMethods.add('thread/read');
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();
    await sleep(20);

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(
      logContent,
      /RPC_SEND_ATTEMPT .*"id":\d+.*"method":"thread\/read".*"diagReqKey":"tr:thread-1:rpc:\d+:turn:turn-1:serial:1:socket:\d+"/
    );
    assert.match(
      logContent,
      /RPC_SEND_SYNC_THROW .*"id":\d+.*"method":"thread\/read".*"diagReqKey":"tr:thread-1:rpc:\d+:turn:turn-1:serial:1:socket:\d+".*"error":"Synthetic send failure for thread\/read"/
    );
    assert.match(logContent, /THREAD_READ_FAILED .*Synthetic send failure for thread\/read/);
  } finally {
    await context.cleanup();
  }
});

test('app session can disable includeTurns in diagnostic thread/read polls', async () => {
  const previous = process.env.COMMUNICATE_DIAG_THREAD_READ_NO_TURNS;
  process.env.COMMUNICATE_DIAG_THREAD_READ_NO_TURNS = '1';
  const context = await bootstrapSession({
    threadReadPollDelayMs: 20
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Poll without turn snapshots' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(35);
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    assert.equal(threadReadRequest.params.includeTurns, false);
  } finally {
    if (previous === undefined) {
      delete process.env.COMMUNICATE_DIAG_THREAD_READ_NO_TURNS;
    } else {
      process.env.COMMUNICATE_DIAG_THREAD_READ_NO_TURNS = previous;
    }
    await context.cleanup();
  }
});

test('app session can skip raw output delta logging during diagnostics', async () => {
  const previousRaw = process.env.COMMUNICATE_DIAG_WS_RAW;
  const previous = process.env.COMMUNICATE_DIAG_SKIP_OUTPUT_DELTA_RAW_LOG;
  process.env.COMMUNICATE_DIAG_WS_RAW = '1';
  process.env.COMMUNICATE_DIAG_SKIP_OUTPUT_DELTA_RAW_LOG = '1';
  const context = await bootstrapSession();

  try {
    context.session.sendReply({ action: 'input_text', text: 'Skip raw output delta logging' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-cmd-1',
        delta: 'diagnostic output that should stay out of the raw log'
      }
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.doesNotMatch(logContent, /diagnostic output that should stay out of the raw log/);
    assert.match(logContent, /WS_RAW_IN .*"method":"item\/commandExecution\/outputDelta"/);
  } finally {
    if (previousRaw === undefined) {
      delete process.env.COMMUNICATE_DIAG_WS_RAW;
    } else {
      process.env.COMMUNICATE_DIAG_WS_RAW = previousRaw;
    }
    if (previous === undefined) {
      delete process.env.COMMUNICATE_DIAG_SKIP_OUTPUT_DELTA_RAW_LOG;
    } else {
      process.env.COMMUNICATE_DIAG_SKIP_OUTPUT_DELTA_RAW_LOG = previous;
    }
    await context.cleanup();
  }
});

test('app session logs orphan rpc responses so response-id mismatches remain diagnosable', async () => {
  const previousRaw = process.env.COMMUNICATE_DIAG_WS_RAW;
  process.env.COMMUNICATE_DIAG_WS_RAW = '1';
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Observe orphan RPC diagnostics' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(15);
    context.socket.emitServerMessage({
      id: 999,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'active' }
        }
      }
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /WS_RAW_IN .*"hasResult":true.*"rawId":999.*"rawIdType":"number"/);
    assert.match(
      logContent,
      /RPC_MATCH_DECISION .*"rawId":999.*"normalizedId":"999".*"matched":false.*"pendingRpcKeys":\["\d+"\]/
    );
    assert.match(logContent, /RPC_ORPHAN_RESPONSE .*"id":999/);
    assert.match(logContent, /RPC_ORPHAN_RESPONSE .*"resultKeys":\["thread"\]/);
    assert.match(logContent, /RPC_ORPHAN_RESPONSE .*"threadId":"thread-1"/);
  } finally {
    if (previousRaw === undefined) {
      delete process.env.COMMUNICATE_DIAG_WS_RAW;
    } else {
      process.env.COMMUNICATE_DIAG_WS_RAW = previousRaw;
    }
    await context.cleanup();
  }
});

test('app session clears pending rpc diagnostics when socket.send throws synchronously', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: FakeWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new FakeWebSocket(url);
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir,
    threadReadPollDelayMs: 20,
    rpcLongPendingThresholdMs: 5
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const startupRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(startupRequest);
    socket?.emitServerMessage({ id: startupRequest.id, result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } } });
    await tick();

    socket?.failSendForMethods.add('thread/read');
    session.sendReply({ action: 'input_text', text: 'Trigger a synchronous send failure' });
    await tick();
    const turnStartRequest = socket?.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(turnStartRequest);
    socket?.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(35);
    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.match(logContent, /THREAD_READ_FAILED .*Synthetic send failure for thread\/read/);
    assert.doesNotMatch(logContent, /RPC_LONG_PENDING .*"method":"thread\/read"/);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session allows a fresh thread/read while the previous turn read is still pending', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'First prompt' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(15);
    const firstThreadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstThreadReadRequest);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'First answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer']
    );

    context.session.sendReply({ action: 'input_text', text: 'Second prompt' });
    await tick();
    const secondTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(secondTurnStartRequest);

    await sleep(15);
    const threadReadRequests = context.socket.sent.filter((item) => item.method === 'thread/read');
    assert.ok(threadReadRequests.length >= 2);
    const secondThreadReadRequest = threadReadRequests.at(-1);
    assert.ok(secondThreadReadRequest);
    assert.notEqual(secondThreadReadRequest.id, firstThreadReadRequest.id);

    context.socket.emitServerMessage({
      id: firstThreadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'First answer' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer']
    );

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /THREAD_READ_STALE_RESPONSE .*"reason":"turn_request_serial_mismatch"/);

    context.socket.emitServerMessage({ id: secondTurnStartRequest.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Second answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer', 'Second answer']
    );
    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.turnId),
      ['turn-1', 'turn-2']
    );
  } finally {
    await context.cleanup();
  }
});

test('app session ignores stale thread/read completion for a newer turn when the old read resolves late', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'First prompt' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(15);
    const firstThreadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstThreadReadRequest);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'First answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    context.session.sendReply({ action: 'input_text', text: 'Second prompt' });
    await tick();
    const secondTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(secondTurnStartRequest);

    context.socket.emitServerMessage({
      id: firstThreadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'First answer' }
              ]
            },
            {
              id: 'turn-2',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-2',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Second answer from stale read'
                }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer']
    );

    context.socket.emitServerMessage({ id: secondTurnStartRequest.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Second answer final',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    context.session.sendReply({ action: 'input_text', text: 'Third prompt' });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.doesNotMatch(logContent, /TURN CONCURRENT_INPUT Third prompt/);
    assert.match(logContent, /THREAD_READ_STALE_RESPONSE .*"reason":"turn_request_serial_mismatch"/);
    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer', 'Second answer final']
    );
  } finally {
    await context.cleanup();
  }
});

test('app session ignores late socket frames after startup failure', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: ControlledWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8793,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new ControlledWebSocket(url, (nextSocket) => {
        nextSocket.emitOpen();
      });
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
  socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const startupRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(startupRequest);
    socket?.emitServerMessage({
      id: startupRequest.id,
      error: { message: 'thread start rejected for late-frame test' }
    });
    await sleep(20);

    assert.equal(session.getSnapshot().lifecycle, 'FAILED');

    socket?.emitServerMessage({ id: 999, result: { thread: { id: 'thread-late' } } });
    socket?.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { thread: { id: 'thread-late' } }
    });
    socket?.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { turn: { id: 'turn-late' } }
    });
    socket?.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-late',
        turnId: 'turn-late',
        item: {
          type: 'agentMessage',
          id: 'item-late',
          text: 'Late answer should be ignored',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    const snapshot = session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'FAILED');
    assert.equal(snapshot.codexThreadId, undefined);

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.doesNotMatch(logContent, /RPC_ORPHAN_RESPONSE .*"id":999/);
    assert.doesNotMatch(logContent, /TURN_STARTED_IGNORED/);
    assert.doesNotMatch(logContent, /ITEM_COMPLETED .*"turnId":"turn-late"/);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('stall diagnostic separates stale thread/read from the current turn blocker', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 20
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'First prompt' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(25);
    const firstThreadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstThreadReadRequest);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'First answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    context.session.sendReply({ action: 'input_text', text: 'Second prompt' });
    await tick();

    (context.session as any).recordStallDiagnostic({
      trigger: 'reply_status_suspected_stalled',
      threadId: 'feishu:chat-1',
      quietMs: 12 * 60_000,
      stallConfirmations: 2,
      replyStatusCardMessageId: 'om_card_stale_1'
    });
    await tick();

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /STALL_DIAGNOSTIC .*"threadReadInFlight":false/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"anyThreadReadPending":true/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"staleThreadReadPendingCount":1/);
    assert.match(logContent, /STALL_DIAGNOSTIC .*"diagnosticRequestMethod":"turn\/start"/);
  } finally {
    await context.cleanup();
  }
});

test('app session clears long-pending rpc timers after thread/read resolves', async () => {
  const context = await bootstrapSession({
    threadReadPollDelayMs: 1,
    rpcLongPendingThresholdMs: 100
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Resolve thread/read before timeout' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await sleep(5);
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Resolved before timeout'
                }
              ]
            }
          ]
        }
      }
    });
    await tick();

    await sleep(130);
    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.doesNotMatch(logContent, /RPC_LONG_PENDING .*"method":"thread\/read"/);
  } finally {
    await context.cleanup();
  }
});

test('app session treats a completed numbered follow-up prompt from thread/read as waiting for user choice', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: '请先给我一个决策问题' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'idle'
        }
      }
    });
    await tick();

    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text:
                    '一个关键问题需要你定一下：这里“有内容的可恢复对话”你希望按哪种标准筛？\n' +
                    '1. 推荐：lastCheckpointOutput 非空，或对应 Tn.log 里有非空正文，就算“有内容”\n' +
                    '2. 仅看 lastCheckpointOutput，不读日志\n' +
                    '3. 更严格：必须同时有 lastCheckpointOutput 和日志正文\n' +
                    '\n你回一个选项号就行，我据此给出最终设计并开始写测试。'
                }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_waiting_user');
    assert.equal(seen[seen.length - 1]?.waitKind, 'choice');
    assert.deepEqual(seen[seen.length - 1]?.waitOptions, [
      '推荐：lastCheckpointOutput 非空，或对应 Tn.log 里有非空正文，就算“有内容”',
      '仅看 lastCheckpointOutput，不读日志',
      '更严格：必须同时有 lastCheckpointOutput 和日志正文'
    ]);
    assert.equal(context.session.getSnapshot().lifecycle, 'WAITING_USER');
  } finally {
    await context.cleanup();
  }
});

test('app session ignores stale thread/read results from the previous completed turn while a new turn is starting', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'First prompt' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'First answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer']
    );

    context.session.sendReply({ action: 'input_text', text: 'Second prompt' });
    await tick();
    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    const secondTurnStartRequest = turnStartRequests.at(-1);
    assert.ok(secondTurnStartRequest);

    await sleep(15);
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'First answer' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer']
    );

    context.socket.emitServerMessage({ id: secondTurnStartRequest.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Second answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer', 'Second answer']
    );
  } finally {
    await context.cleanup();
  }
});

test('app session ignores thread/read results from older completed turns after a newer turn finishes', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'First prompt' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'First answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    context.session.sendReply({ action: 'input_text', text: 'Second prompt' });
    await tick();
    const secondTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(secondTurnStartRequest);
    context.socket.emitServerMessage({ id: secondTurnStartRequest.id, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Second answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer', 'Second answer']
    );

    context.session.sendReply({ action: 'input_text', text: 'Third prompt' });
    await tick();
    const thirdTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(thirdTurnStartRequest);

    await sleep(15);
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'First answer' }
              ]
            }
          ]
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer', 'Second answer']
    );

    context.socket.emitServerMessage({ id: thirdTurnStartRequest.id, result: { turn: { id: 'turn-3', status: 'inProgress', error: null } } });
    await tick();
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-3',
        item: {
          type: 'agentMessage',
          id: 'item-3',
          text: 'Third answer',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.deepEqual(
      seen.filter((event) => event.type === 'task_finished').map((event) => event.output),
      ['First answer', 'Second answer', 'Third answer']
    );
  } finally {
    await context.cleanup();
  }
});
test('app session finalizes immediately when codex/event/agent_message arrives with final_answer phase', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Summarize market trends' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/agent_message',
      params: {
        msg: {
          type: 'agent_message',
          message: 'Final market summary.',
          phase: 'final_answer'
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Final market summary.');
    assert.equal(context.session.getSnapshot().lifecycle, 'IDLE');
  } finally {
    await context.cleanup();
  }
});

test('app session finalizes when codex/event/task_complete arrives with last agent message', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Do a longer market survey' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/task_complete',
      params: {
        msg: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'Task complete summary.'
        }
      }
    });
    await tick();

    assert.equal(seen[seen.length - 1]?.type, 'task_finished');
    assert.equal(seen[seen.length - 1]?.output, 'Task complete summary.');
    assert.equal(context.session.getSnapshot().lifecycle, 'IDLE');
  } finally {
    await context.cleanup();
  }
});

test('app session reconciles a systemError notification with thread/read final output before failing the turn', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover after a late system error' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Recovered final answer after system error.'
                }
              ]
            }
          ]
        }
      }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.output, 'Recovered final answer after system error.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /SYSTEM_ERROR_RECONCILE_START/);
    assert.match(logContent, /SYSTEM_ERROR_RECONCILE_RECOVERED/);
  } finally {
    await context.cleanup();
  }
});

test('app session waits for an in-flight thread/read before spending systemError reconcile attempts', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Do not out-race the in-flight thread/read' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const inFlightThreadRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(inFlightThreadRead);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await sleep(30);
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);

    context.socket.emitServerMessage({
      id: inFlightThreadRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Recovered from the already in-flight thread/read.'
                }
              ]
            }
          ]
        }
      }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.output, 'Recovered from the already in-flight thread/read.');
  } finally {
    await context.cleanup();
  }
});

test('app session keeps the turn alive long enough for a late task_complete after systemError when live output already exists', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 10,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Preserve live output across system error' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Buffered answer survives.'
      }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'codex/event/task_complete',
      params: {
        msg: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: ''
        }
      }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.output, 'Buffered answer survives.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session classifies reconcile thread/read transport failures as local communication errors', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Classify reconcile transport failure correctly' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.failSendForMethods.add('thread/read');
    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'local_comm');
    assert.match(String(failure?.output ?? ''), /Synthetic send failure for thread\/read/);
    assert.doesNotMatch(String(failure?.output ?? ''), /可恢复|recoverable/i);
  } finally {
    await context.cleanup();
  }
});

test('app session preserves partial output when systemError auto-continue times out before rescue turn adoption', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 25
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Surface a recoverable system error' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const threadReadRequest = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(threadReadRequest);
    context.socket.emitServerMessage({
      id: threadReadRequest.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Partial summary from thread/read.'
                }
              ]
            }
          ]
        }
      }
    });
    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );
    const rescueTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(rescueTurnStartRequest);
    assert.equal(rescueTurnStartRequest.params?.input?.[0]?.text, '继续');
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.match(String(failure?.output ?? ''), /Partial summary from thread\/read\./);
    assert.match(String(failure?.output ?? ''), /没有确认新的 rescue turn/);
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);

    const logContent = readFileSync(context.session.getLogPath(), 'utf8');
    assert.match(logContent, /SYSTEM_ERROR_RECONCILE_RECOVERABLE_FAIL/);
    assert.match(logContent, /SYSTEM_ERROR_AUTO_CONTINUE_TIMEOUT/);
  } finally {
    await context.cleanup();
  }
});

test('app session reconciles when a polling thread/read first reports systemError', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 1,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover from thread/read systemError entrypoint' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const firstThreadRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstThreadRead);
    context.socket.emitServerMessage({
      id: firstThreadRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Polling saw a temporary system error.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 2,
      2_000,
      10
    );
    const secondThreadRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(secondThreadRead);
    context.socket.emitServerMessage({
      id: secondThreadRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-2',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Recovered through THREAD_READ_SYSTEM_ERROR.'
                }
              ]
            }
          ]
        }
      }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.output, 'Recovered through THREAD_READ_SYSTEM_ERROR.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session auto-continues a systemError turn and ignores late events from the retired source turn', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover by auto continue after system error' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const reconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(reconcileRead);
    context.socket.emitServerMessage({
      id: reconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Partial summary from the failed turn.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );
    const rescueTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(rescueTurnStartRequest);
    assert.equal(rescueTurnStartRequest.params?.input?.[0]?.text, '继续');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);

    context.socket.emitServerMessage({
      id: rescueTurnStartRequest.id,
      result: {
        turn: {
          id: 'turn-2',
          status: 'inProgress',
          error: null
        }
      }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'interrupted',
          error: { message: 'Old turn completed after rescue started.' }
        }
      }
    });
    await tick();
    assert.equal(readLoggedEventPayloads(context.session.getLogPath(), 'TURN_TERMINAL_NOTIFY_OBSERVED').length, 0);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Recovered after automatic continue.',
          phase: 'final_answer'
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.turnId, 'turn-2');
    assert.equal(seen.at(-1)?.output, 'Recovered after automatic continue.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session does not auto-continue before the first turn id is adopted', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 50
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Do not auto continue without an adopted source turn id' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const reconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(reconcileRead);
    context.socket.emitServerMessage({
      id: reconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'historic-turn',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Historical turn should not trigger auto continue.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    assert.equal(context.socket.sent.filter((item) => item.method === 'turn/start').length, 1);
    assert.equal(seen.at(-1)?.type, 'task_failed');
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session auto-continues once when systemError carries a 401 token invalidated upstream error', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 200
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover after token invalidation' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const reconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(reconcileRead);
    context.socket.emitServerMessage({
      id: reconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'failed',
              error: {
                message: '401 Unauthorized / authentication token has been invalidated'
              },
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Partial summary before token invalidation.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );
    const rescueTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(rescueTurnStartRequest);
    assert.equal(rescueTurnStartRequest.params?.input?.[0]?.text, '继续');

    context.socket.emitServerMessage({
      id: rescueTurnStartRequest.id,
      result: {
        turn: {
          id: 'turn-2',
          status: 'inProgress',
          error: null
        }
      }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Recovered after auto continue from 401.',
          phase: 'final_answer'
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.turnId, 'turn-2');
    assert.equal(seen.at(-1)?.output, 'Recovered after auto continue from 401.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session preserves source partial output and avoids duplicate rescue output when an adopted rescue turn fails', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 200
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Keep source partial output after rescue adoption' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const reconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(reconcileRead);
    context.socket.emitServerMessage({
      id: reconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'First partial summary.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );
    const rescueTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(rescueTurnStartRequest);
    context.socket.emitServerMessage({
      id: rescueTurnStartRequest.id,
      result: {
        turn: {
          id: 'turn-2',
          status: 'inProgress',
          error: null
        }
      }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: 'Rescue live output.',
          phase: 'commentary'
        }
      }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-2',
          status: 'interrupted',
          error: { message: 'Rescue turn interrupted.' }
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    const output = String(failure?.output ?? '');
    assert.equal(failure?.type, 'task_failed');
    assert.match(output, /First partial summary\./);
    assert.equal((output.match(/Rescue live output\./g) ?? []).length, 1);
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session auto-continues at most once for the same task after repeated systemError snapshots', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 200
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Auto continue only once' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const firstReconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstReconcileRead);
    context.socket.emitServerMessage({
      id: firstReconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'First partial summary.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );
    const rescueTurnStartRequest = context.socket.sent.filter((item) => item.method === 'turn/start').at(-1);
    assert.ok(rescueTurnStartRequest);
    context.socket.emitServerMessage({
      id: rescueTurnStartRequest.id,
      result: {
        turn: {
          id: 'turn-2',
          status: 'inProgress',
          error: null
        }
      }
    });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 2,
      2_000,
      10
    );
    const secondReconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(secondReconcileRead);
    context.socket.emitServerMessage({
      id: secondReconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-2',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-2',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Second partial summary.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const turnStartRequests = context.socket.sent.filter((item) => item.method === 'turn/start');
    assert.equal(turnStartRequests.length, 2);
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.match(String(failure?.output ?? ''), /First partial summary\./);
    assert.match(String(failure?.output ?? ''), /可恢复|recoverable/i);
    assert.equal(seen.some((event) => event.type === 'task_finished'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session can recover from thread/read when the rescue turn exists before any start ack arrives', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 60
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Recover even if rescue start ack is missing' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const firstReconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstReconcileRead);
    context.socket.emitServerMessage({
      id: firstReconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Partial summary before rescue turn becomes visible.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'idle'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 2,
      2_000,
      10
    );
    const recoveryRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(recoveryRead);
    context.socket.emitServerMessage({
      id: recoveryRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn-1',
              status: 'interrupted',
              error: { message: 'Source turn was retired.' },
              items: [
                {
                  id: 'item-old',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Old turn output should stay ignored.'
                }
              ]
            },
            {
              id: 'turn-2',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-2',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Recovered from thread/read rescue observation.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_finished'), 2_000, 10);
    await sleep(100);

    assert.equal(seen.at(-1)?.type, 'task_finished');
    assert.equal(seen.at(-1)?.turnId, 'turn-2');
    assert.equal(seen.at(-1)?.output, 'Recovered from thread/read rescue observation.');
    assert.equal(seen.some((event) => event.type === 'task_failed'), false);
  } finally {
    await context.cleanup();
  }
});

test('app session does not adopt a historical completed turn as the rescue turn before a new turn appears', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    threadReadPollDelayMs: 500,
    systemErrorReconcileDelayMs: 1,
    systemErrorReconcileRetryDelayMs: 1,
    systemErrorReconcileMaxAttempts: 1,
    systemErrorAutoContinueTimeoutMs: 40
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Do not adopt historical completed turns as rescue turns' });
    await tick();
    const firstTurnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(firstTurnStartRequest);
    context.socket.emitServerMessage({ id: firstTurnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'systemError'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 1,
      2_000,
      10
    );
    const firstReconcileRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(firstReconcileRead);
    context.socket.emitServerMessage({
      id: firstReconcileRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'systemError' },
          turns: [
            {
              id: 'turn-1',
              status: 'in_progress',
              error: null,
              items: [
                {
                  id: 'item-1',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Partial summary before rescue turn becomes visible.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'turn/start').length >= 2,
      2_000,
      10
    );

    context.socket.emitServerMessage({
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: {
          type: 'idle'
        }
      }
    });

    await waitForCondition(
      () => context.socket.sent.filter((item) => item.method === 'thread/read').length >= 2,
      2_000,
      10
    );
    const recoveryRead = context.socket.sent.filter((item) => item.method === 'thread/read').at(-1);
    assert.ok(recoveryRead);
    context.socket.emitServerMessage({
      id: recoveryRead.id,
      result: {
        thread: {
          id: 'thread-1',
          status: { type: 'idle' },
          turns: [
            {
              id: 'historic-turn',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'item-historic',
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: 'Historical completed turn.'
                }
              ]
            },
            {
              id: 'turn-1',
              status: 'interrupted',
              error: { message: 'Source turn was retired.' },
              items: [
                {
                  id: 'item-old',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'Old turn output should stay ignored.'
                }
              ]
            }
          ]
        }
      }
    });

    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    assert.equal(seen.some((event) => event.type === 'task_finished'), false);
    assert.doesNotMatch(String(seen.at(-1)?.output ?? ''), /Historical completed turn\./);
  } finally {
    await context.cleanup();
  }
});

test('app session skips blocked startup ports before spawning app-server', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  const allocatedPorts = [1723, 4190, 1731];
  let allocateCalls = 0;
  let socket: ControlledWebSocket | undefined;
  const spawnedListenUrls: string[] = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => {
      const port = allocatedPorts[allocateCalls];
      allocateCalls += 1;
      assert.notEqual(port, undefined);
      return port!;
    },
    spawnFactory: (_command: string, args: string[]) => {
      spawnedListenUrls.push(String(args.at(-1)));
      return child;
    },
    createWebSocket: (url: string) => {
      socket = new ControlledWebSocket(url, (nextSocket) => {
        nextSocket.emitOpen();
      });
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
    socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const startupRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(startupRequest);
    socket?.emitServerMessage({ id: startupRequest.id, result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } } });
    await tick();

    assert.equal(session.getSnapshot().lifecycle, 'IDLE');
    assert.equal(allocateCalls, 3);
    assert.deepEqual(spawnedListenUrls, ['ws://127.0.0.1:1731']);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session startup failure includes websocket error details and listen url', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: ControlledWebSocket | undefined;
  const seen: Array<Record<string, unknown>> = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new ControlledWebSocket(url, (nextSocket) => {
        nextSocket.emitError({ message: 'bad port', code: 'ERR_BAD_PORT' });
      });
      return socket as any;
    },
    socketRetryLimit: 2,
    socketRetryDelayMs: 1,
    enableLogWindow: false,
    logRootDir,
    onEvent: (event: any) => {
      seen.push(event as Record<string, unknown>);
    }
  } as any);

  try {
    session.start();
    await sleep(20);

    const snapshot = session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'FAILED');
    assert.match(snapshot.checkpointOutput ?? '', /bad port/i);
    assert.match(snapshot.checkpointOutput ?? '', /8788/);
    assert.match(snapshot.checkpointOutput ?? '', /startup phase: websocket\/open/i);
    assert.match(snapshot.checkpointOutput ?? '', /startup websocket attempts: 2\/2/i);
    assert.match(snapshot.checkpointOutput ?? '', /startup child pid: 4321/i);
    assert.ok(socket);
    assert.equal(seen.at(-1)?.type, 'task_failed');
    assert.equal(seen.at(-1)?.interruptionKind, 'local_comm');

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.match(logContent, /STARTUP_FAILURE .*"phase":"websocket\/open"/);
    assert.match(logContent, /STARTUP_FAILURE .*"attempts":2/);
    assert.match(logContent, /STARTUP_FAILURE .*"childPid":4321/);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session initialize unsupported method is classified as capability_missing', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: ControlledWebSocket | undefined;
  const seen: Array<Record<string, unknown>> = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8789,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new ControlledWebSocket(url, (nextSocket) => {
        nextSocket.emitOpen();
      });
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir,
    onEvent: (event: any) => {
      seen.push(event as Record<string, unknown>);
    }
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
    socket?.emitServerMessage({
      id: initializeRequest.id,
      error: { message: 'method not found: initialize' }
    });
    await sleep(20);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /method not found: initialize/i);
    assert.match(output, /startup phase: initialize/i);
    assert.match(output, /missing capabilities: initialize/i);
    assert.match(output, /missing metadata: initialize\.userAgent/i);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session initialize standard JSON-RPC method-not-found error is classified as capability_missing', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: ControlledWebSocket | undefined;
  const seen: Array<Record<string, unknown>> = [];

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8794,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new ControlledWebSocket(url, (nextSocket) => {
        nextSocket.emitOpen();
      });
      return socket as any;
    },
    enableLogWindow: false,
    logRootDir,
    onEvent: (event: any) => {
      seen.push(event as Record<string, unknown>);
    }
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
    socket?.emitServerMessage({
      id: initializeRequest.id,
      error: { code: -32601, message: 'Method not found' }
    });
    await sleep(20);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /Method not found/i);
    assert.match(output, /startup phase: initialize/i);
    assert.match(output, /missing capabilities: initialize/i);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session thread/start failure still includes startup diagnostics after transport is ready', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  let socket: ControlledWebSocket | undefined;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8790,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socket = new ControlledWebSocket(url, (nextSocket) => {
        nextSocket.emitOpen();
      });
      return socket as any;
    },
    socketRetryLimit: 2,
    socketRetryDelayMs: 1,
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await tick();

    const initializeRequest = socket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
    socket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadStartRequest = socket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(threadStartRequest);
    socket?.emitServerMessage({
      id: threadStartRequest.id,
      error: { message: 'thread start rejected for diagnostics test' }
    });
    await sleep(20);

    const snapshot = session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'FAILED');
    assert.match(snapshot.checkpointOutput ?? '', /thread start rejected for diagnostics test/i);
    assert.match(snapshot.checkpointOutput ?? '', /startup phase: thread\/start/i);
    assert.match(snapshot.checkpointOutput ?? '', /startup listen url: ws:\/\/127\.0\.0\.1:8790/i);
    assert.match(snapshot.checkpointOutput ?? '', /startup child pid: 4321/i);

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.match(logContent, /STARTUP_FAILURE .*"phase":"thread\/start"/);
    assert.match(logContent, /STARTUP_FAILURE .*"childPid":4321/);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session thread/start unsupported method is classified as capability_missing when initialize reports a compatible version', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      message: 'unsupported method: thread/start'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /unsupported method: thread\/start/i);
    assert.match(output, /current version: 0\.111\.0/i);
    assert.match(output, /missing capabilities: .*thread\/start/i);
    assert.match(output, /compatibility failure:/i);
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start standard JSON-RPC method-not-found error is classified as capability_missing', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      code: -32601,
      message: 'Method not found'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /Method not found/i);
    assert.match(output, /current version: 0\.111\.0/i);
    assert.match(output, /missing capabilities: .*thread\/start/i);
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start generic failure is still classified as version_incompatible when initialize already reports an older version', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.110.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      message: 'startup exploded before metadata arrived'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /startup exploded before metadata arrived/i);
    assert.match(output, /current version: 0\.110\.0/i);
    assert.match(output, /required minimum version: 0\.111\.0/i);
  } finally {
    await context.cleanup();
  }
});

test('app session startup generic failure still uses the app-server version when userAgent has an earlier unrelated semver', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'Windows 10.0.19045; communicate-feishu/0.110.0 (x86_64)'
    },
    startupError: {
      message: 'startup exploded before metadata arrived'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /current version: 0\.110\.0/i);
    assert.match(output, /required minimum version: 0\.111\.0/i);
  } finally {
    await context.cleanup();
  }
});

test('app session startup generic failure prefers the app-server version from non-slash Codex CLI text over earlier unrelated semver', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'Windows 10.0.19045; Codex CLI 0.110.0 (x86_64)'
    },
    startupError: {
      message: 'startup exploded before metadata arrived'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /current version: 0\.110\.0/i);
    assert.match(output, /required minimum version: 0\.111\.0/i);
  } finally {
    await context.cleanup();
  }
});

test('app session resume startup unsupported method is classified as version_incompatible when initialize reports an older version', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    mode: 'resume',
    resumeThreadId: 'thread-resume-unsupported',
    initializeResult: {
      userAgent: 'communicate-feishu/0.110.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      message: 'method not found: thread/resume'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /method not found: thread\/resume/i);
    assert.match(output, /current version: 0\.110\.0/i);
    assert.match(output, /required minimum version: 0\.111\.0/i);
    assert.match(output, /missing capabilities: .*thread\/resume/i);
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start request-level unsupported model error stays classified as upstream_execution', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      message: 'model not supported: gpt-5.4'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');
    assert.match(String(failure?.output ?? ''), /model not supported: gpt-5\.4/i);
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start method-prefixed unsupported model error stays classified as upstream_execution', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      message: 'thread/start: model not supported: gpt-5.4'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');
    assert.match(String(failure?.output ?? ''), /thread\/start: model not supported: gpt-5\.4/i);
  } finally {
    await context.cleanup();
  }
});

test('app session thread/start method-prefixed unsupported parameter error stays classified as upstream_execution', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupError: {
      message: 'thread/start is not supported with model gpt-5.4'
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'upstream_execution');
    assert.match(String(failure?.output ?? ''), /thread\/start is not supported with model gpt-5\.4/i);
  } finally {
    await context.cleanup();
  }
});

test('app session reconnect open failure remains classified as local_comm', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  const seen: Array<Record<string, unknown>> = [];
  const sockets: Array<FakeWebSocket | ControlledWebSocket> = [];
  let socketCreateCount = 0;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8788,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      socketCreateCount += 1;
      if (socketCreateCount === 1) {
        const nextSocket = new FakeWebSocket(url);
        sockets.push(nextSocket);
        return nextSocket as any;
      }
      const nextSocket = new ControlledWebSocket(url, (controlledSocket) => {
        controlledSocket.emitError({ message: 'reconnect port refused', code: 'ECONNREFUSED' });
      });
      sockets.push(nextSocket);
      return nextSocket as any;
    },
    socketRetryLimit: 1,
    socketRetryDelayMs: 1,
    threadReadPollDelayMs: 20,
    enableLogWindow: false,
    logRootDir,
    onEvent: (event: any) => {
      seen.push(event as Record<string, unknown>);
    }
  } as any);

  try {
    session.start();
    await tick();

    const startupSocket = sockets[0] as FakeWebSocket | undefined;
    const initializeRequest = startupSocket?.sent.find((item) => item.method === 'initialize');
    assert.ok(initializeRequest);
    startupSocket?.emitServerMessage({ id: initializeRequest.id, result: { userAgent: 'test/0.111.0' } });
    await tick();

    const threadStartRequest = startupSocket?.sent.find((item) => item.method === 'thread/start');
    assert.ok(threadStartRequest);
    startupSocket?.emitServerMessage({
      id: threadStartRequest.id,
      result: { thread: { id: 'thread-1', cliVersion: '0.111.0' } }
    });
    await tick();

    session.sendReply({ action: 'input_text', text: 'Trigger reconnect failure' });
    await tick();
    const turnStartRequest = startupSocket?.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    startupSocket?.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    startupSocket?.close();
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'local_comm');
    const output = String(failure?.output ?? '');
    assert.match(output, /socket disconnected and reconnect failed/i);
    assert.match(output, /reconnect port refused/i);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session recovery thread/resume unsupported method is classified as capability_missing', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Trigger recovery compatibility failure' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    firstSocket.close();
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);

    const recoverySocket = context.socket;
    await waitForCondition(() => recoverySocket.sent.some((item) => item.method === 'initialize'), 2_000, 10);
    const recoveryInitializeRequest = recoverySocket.sent.find((item) => item.method === 'initialize');
    assert.ok(recoveryInitializeRequest);
    recoverySocket.emitServerMessage({
      id: recoveryInitializeRequest.id,
      result: {
        userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
      }
    });
    await tick();

    await waitForCondition(() => recoverySocket.sent.some((item) => item.method === 'thread/resume'), 2_000, 10);
    const threadResumeRequest = recoverySocket.sent.find((item) => item.method === 'thread/resume');
    assert.ok(threadResumeRequest);
    recoverySocket.emitServerMessage({
      id: threadResumeRequest.id,
      error: { message: 'method not found: thread/resume' }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /method not found: thread\/resume/i);
    assert.match(output, /current version: 0\.111\.0/i);
    assert.match(output, /missing capabilities: .*thread\/resume/i);
  } finally {
    await context.cleanup();
  }
});

test('app session recovery thread/resume standard JSON-RPC method-not-found error is classified as capability_missing', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    }
  });

  try {
    context.session.sendReply({ action: 'input_text', text: 'Trigger recovery JSON-RPC compatibility failure' });
    await tick();
    const turnStartRequest = context.socket.sent.find((item) => item.method === 'turn/start');
    assert.ok(turnStartRequest);
    context.socket.emitServerMessage({ id: turnStartRequest.id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } });
    await tick();

    const firstSocket = context.socket;
    firstSocket.close();
    await waitForCondition(() => context.sockets.length >= 2, 2_000, 10);

    const recoverySocket = context.socket;
    await waitForCondition(() => recoverySocket.sent.some((item) => item.method === 'initialize'), 2_000, 10);
    const recoveryInitializeRequest = recoverySocket.sent.find((item) => item.method === 'initialize');
    assert.ok(recoveryInitializeRequest);
    recoverySocket.emitServerMessage({
      id: recoveryInitializeRequest.id,
      result: {
        userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
      }
    });
    await tick();

    await waitForCondition(() => recoverySocket.sent.some((item) => item.method === 'thread/resume'), 2_000, 10);
    const threadResumeRequest = recoverySocket.sent.find((item) => item.method === 'thread/resume');
    assert.ok(threadResumeRequest);
    recoverySocket.emitServerMessage({
      id: threadResumeRequest.id,
      error: { code: -32601, message: 'Method not found' }
    });
    await waitForCondition(() => seen.some((event) => event.type === 'task_failed'), 2_000, 10);

    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /Method not found/i);
    assert.match(output, /current version: 0\.111\.0/i);
    assert.match(output, /missing capabilities: .*thread\/resume/i);
  } finally {
    await context.cleanup();
  }
});

test('app session records observed and version-gated app-server capabilities after compatible startup', async () => {
  const context = await bootstrapSession({
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-1',
        cliVersion: '0.111.0'
      },
      model: 'gpt-5.4'
    }
  });

  try {
    const snapshot = context.session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'IDLE');

    const compatibility = readLoggedEventPayloads(context.session.getLogPath(), 'APP_SERVER_COMPATIBILITY').at(-1);
    assert.ok(compatibility);
    assert.equal(compatibility.compatible, true);
    assert.equal(compatibility.version, '0.111.0');
    assert.equal(compatibility.versionSource, 'thread.cliVersion');
    assert.deepEqual(compatibility.missingCapabilities, []);
    assert.deepEqual(compatibility.observedCapabilities, ['initialize', 'thread/start']);
    assert.deepEqual(compatibility.versionGatedCapabilities, [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'thread/resume',
      'turn/start',
      'turn/started'
    ]);
    assert.deepEqual(compatibility.missingMetadata, []);
  } finally {
    await context.cleanup();
  }
});

test('app session fails with version_incompatible when app-server version is below the supported minimum', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.110.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-1',
        cliVersion: '0.110.0'
      }
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /0\.110\.0/);
    assert.match(output, /0\.111\.0/);
    assert.match(output, /turn\/start/);
    assert.match(output, /item\/tool\/requestUserInput/);
    assert.match(output, /建议动作/);
  } finally {
    await context.cleanup();
  }
});

test('app session fails with version_incompatible when app-server version matches a known-bad release', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.120.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-1',
        cliVersion: '0.120.0'
      }
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /current version: 0\.120\.0/i);
    assert.match(output, /不兼容|known bad|upgrade/i);
  } finally {
    await context.cleanup();
  }
});

test('app session fails with capability_missing when initialize omits the required userAgent metadata', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {},
    expectStartupRequest: false
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /initialize/i);
    assert.match(output, /userAgent/i);
    assert.match(output, /current version: unknown/i);
    assert.match(output, /missing capabilities:/i);
    assert.equal(context.socket.sent.find((item) => item.method === 'thread/start'), undefined);
  } finally {
    await context.cleanup();
  }
});

test('app session fails with capability_missing when startup metadata omits thread cliVersion even if userAgent has a parseable version', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-1'
      }
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'capability_missing');
    const output = String(failure?.output ?? '');
    assert.match(output, /thread\/start/i);
    assert.match(output, /thread\.cliVersion/i);
    assert.match(output, /current version: 0\.111\.0/i);
    assert.match(output, /missing metadata:/i);
  } finally {
    await context.cleanup();
  }
});

test('app session falls back to userAgent version when thread cliVersion is present but not parseable', async () => {
  const context = await bootstrapSession({
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-1',
        cliVersion: 'codex-vNext'
      }
    }
  });

  try {
    const snapshot = context.session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'IDLE');
    const compatibility = readLoggedEventPayloads(context.session.getLogPath(), 'APP_SERVER_COMPATIBILITY').at(-1);
    assert.ok(compatibility);
    assert.equal(compatibility.version, '0.111.0');
    assert.equal(compatibility.versionSource, 'userAgent');
    assert.deepEqual(compatibility.versionWarnings, ['thread.cliVersion is present but not parseable: codex-vNext']);
  } finally {
    await context.cleanup();
  }
});

test('app session resume mode fails with version_incompatible when the resumed app-server version is too old', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    mode: 'resume',
    resumeThreadId: 'thread-resume-compat',
    initializeResult: {
      userAgent: 'communicate-feishu/0.110.0 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-resume-compat',
        cliVersion: '0.110.0'
      }
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /thread\/resume/i);
    assert.match(output, /current version: 0\.110\.0/i);
    assert.match(output, /0\.111\.0/i);
    assert.match(output, /missing capabilities:/i);
  } finally {
    await context.cleanup();
  }
});

test('app session treats prerelease app-server versions below the stable minimum as version_incompatible', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const context = await bootstrapSession({
    onEvent: (event: any) => {
      seen.push(event);
    },
    initializeResult: {
      userAgent: 'communicate-feishu/0.111.0-rc.1 (Windows 10.0.19045; x86_64) unknown (communicate-feishu; 0.1.0)'
    },
    startupResult: {
      thread: {
        id: 'thread-1',
        cliVersion: '0.111.0-rc.1'
      }
    }
  });

  try {
    const failure = seen.at(-1);
    assert.equal(failure?.type, 'task_failed');
    assert.equal(failure?.interruptionKind, 'version_incompatible');
    const output = String(failure?.output ?? '');
    assert.match(output, /0\.111\.0-rc\.1/);
    assert.match(output, /required minimum version: 0\.111\.0/i);
  } finally {
    await context.cleanup();
  }
});

test('app session logs startup child exit diagnostics before websocket transport is ready', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8791,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      return new ControlledWebSocket(url, () => {
        setTimeout(() => {
          child.emit('exit', 23);
        }, 0);
      }) as any;
    },
    socketOpenTimeoutMs: 50,
    socketRetryLimit: 2,
    socketRetryDelayMs: 1,
    enableLogWindow: false,
    logRootDir
  } as any);

  try {
    session.start();
    await sleep(30);

    const snapshot = session.getSnapshot();
    assert.equal(snapshot.lifecycle, 'FAILED');
    assert.match(snapshot.checkpointOutput ?? '', /exited with code 23/i);

    const logContent = readFileSync(session.getLogPath(), 'utf8');
    assert.match(logContent, /CHILD_EXIT .*"code":23/);
    assert.match(logContent, /CHILD_EXIT .*"duringStartup":true/);
  } finally {
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }
});

test('app session startup child exit does not leak late log appends after cleanup', async () => {
  const child = createMockChild();
  const logRootDir = createLogRoot();
  const originalConsoleError = console.error;
  const capturedErrors: string[] = [];
  let cleaned = false;

  const session = createCodexAppSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    allocatePort: async () => 8792,
    spawnFactory: () => child,
    createWebSocket: (url: string) => {
      return new ControlledWebSocket(url, () => {
        setTimeout(() => {
          child.emit('exit', 23);
        }, 0);
      }) as any;
    },
    socketOpenTimeoutMs: 50,
    socketRetryLimit: 2,
    socketRetryDelayMs: 1,
    enableLogWindow: false,
    logRootDir
  } as any);

  async function cleanupSession(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    try {
      await session.close();
    } catch {
      // ignore cleanup close failures in tests
    }
    rmSync(logRootDir, { recursive: true, force: true });
  }

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };

    session.start();
    await sleep(30);
    assert.equal(session.getSnapshot().lifecycle, 'FAILED');

    await cleanupSession();
    await sleep(80);

    const appendErrors = capturedErrors.filter((line) => line.includes('[session-log] append failed'));
    assert.equal(appendErrors.length, 0, appendErrors.join('\n'));
  } finally {
    console.error = originalConsoleError;
    await cleanupSession();
  }
});
