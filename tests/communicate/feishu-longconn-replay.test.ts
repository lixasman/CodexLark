import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = 'arraybuffer';

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
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

  send(data: BufferSource): void {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  emitMessage(data: Uint8Array): void {
    const start = data.byteOffset;
    const end = start + data.byteLength;
    const arrayBuffer = data.buffer.slice(start, end);
    this.dispatch('message', { data: arrayBuffer });
  }

  private dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

type SessionRegistryModule = {
  createSessionRegistry: (input: {
    registryPath: string;
    warn?: (message: string, error?: unknown) => void;
  }) => {
    load: () => {
      inboundMessages: Record<string, unknown>;
    };
    getInboundMessages: () => Record<string, number>;
    markInboundMessage: (messageId: string, seenAt: number) => void;
    pruneInboundMessages: (cutoffMs: number) => void;
    getThreadUiState: (feishuThreadId: string) => {
      feishuThreadId: string;
      displayMode: 'assistant' | 'coding';
      lastAcceptedTextCreateTimeMs?: number;
    } | undefined;
    upsertThreadUiState: (record: {
      feishuThreadId: string;
      displayMode: 'assistant' | 'coding';
      lastAcceptedTextCreateTimeMs?: number;
    }) => {
      feishuThreadId: string;
      displayMode: 'assistant' | 'coding';
      lastAcceptedTextCreateTimeMs?: number;
    };
    getLastActiveFeishuThreadId: () => string | undefined;
    getLastActiveFeishuUserOpenId: () => string | undefined;
  };
};

function loadSessionRegistryModule(): SessionRegistryModule {
  return require(path.resolve(__dirname, '../../src/communicate/storage/session-registry.js')) as SessionRegistryModule;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function shortDelay(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('persistent feishu inbound deduper suppresses replayed messages after restart', () => {
  const { createPersistentFeishuInboundDeduper } = require('../../src/communicate/channel/feishu-runtime') as {
    createPersistentFeishuInboundDeduper: (sessionRegistry: ReturnType<SessionRegistryModule['createSessionRegistry']>) => {
      isDuplicate: (messageId: string) => boolean;
      markDone: (messageId: string) => void;
    };
  };

  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-dedup-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const firstRegistry = createSessionRegistry({ registryPath });
    const firstDeduper = createPersistentFeishuInboundDeduper(firstRegistry);

    assert.equal(firstDeduper.isDuplicate('om_text_1'), false);
    firstDeduper.markDone('om_text_1');
    assert.equal(firstDeduper.isDuplicate('om_text_1'), true);

    const secondRegistry = createSessionRegistry({ registryPath });
    const secondDeduper = createPersistentFeishuInboundDeduper(secondRegistry);
    assert.equal(secondDeduper.isDuplicate('om_text_1'), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('persistent feishu inbound deduper still suppresses replays for messages seen 7 hours ago', () => {
  const { createPersistentFeishuInboundDeduper } = require('../../src/communicate/channel/feishu-runtime') as {
    createPersistentFeishuInboundDeduper: (sessionRegistry: ReturnType<SessionRegistryModule['createSessionRegistry']>) => {
      isDuplicate: (messageId: string) => boolean;
      markDone: (messageId: string) => void;
    };
  };

  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-dedup-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.markInboundMessage('om_text_7h', sevenHoursAgo);

    const deduper = createPersistentFeishuInboundDeduper(registry);
    assert.equal(deduper.isDuplicate('om_text_7h'), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('persistent feishu inbound deduper blocks duplicate claims while a message is in flight', () => {
  const { createPersistentFeishuInboundDeduper } = require('../../src/communicate/channel/feishu-runtime') as {
    createPersistentFeishuInboundDeduper: (sessionRegistry: ReturnType<SessionRegistryModule['createSessionRegistry']>) => {
      claim: (messageId: string) => Record<string, any>;
    };
  };

  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-dedup-claim-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    const deduper = createPersistentFeishuInboundDeduper(registry);

    const firstClaim = deduper.claim('om_text_claim_1');
    assert.equal(firstClaim.kind, 'claimed');

    const duplicateWhileInFlight = deduper.claim('om_text_claim_1');
    assert.equal(duplicateWhileInFlight.kind, 'duplicate');
    assert.equal(duplicateWhileInFlight.source, 'in-flight');

    firstClaim.complete();

    const duplicateAfterComplete = deduper.claim('om_text_claim_1');
    assert.equal(duplicateAfterComplete.kind, 'duplicate');
    assert.equal(duplicateAfterComplete.source, 'recent');
    assert.equal(typeof registry.getInboundMessages().om_text_claim_1, 'number');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('persistent feishu inbound deduper releases failed claims for retry', () => {
  const { createPersistentFeishuInboundDeduper } = require('../../src/communicate/channel/feishu-runtime') as {
    createPersistentFeishuInboundDeduper: (sessionRegistry: ReturnType<SessionRegistryModule['createSessionRegistry']>) => {
      claim: (messageId: string) => Record<string, any>;
    };
  };

  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-dedup-release-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    const deduper = createPersistentFeishuInboundDeduper(registry);

    const firstClaim = deduper.claim('om_text_retry_1');
    assert.equal(firstClaim.kind, 'claimed');
    firstClaim.release();
    assert.equal(registry.getInboundMessages().om_text_retry_1, undefined);

    const secondClaim = deduper.claim('om_text_retry_1');
    assert.equal(secondClaim.kind, 'claimed');
    secondClaim.complete();
    assert.equal(typeof registry.getInboundMessages().om_text_retry_1, 'number');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('persistent feishu inbound deduper claim stays off the registry prune hot path', () => {
  const { createPersistentFeishuInboundDeduper } = require('../../src/communicate/channel/feishu-runtime') as {
    createPersistentFeishuInboundDeduper: (sessionRegistry: ReturnType<SessionRegistryModule['createSessionRegistry']>) => {
      claim: (messageId: string) => Record<string, any>;
    };
  };

  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-dedup-hotpath-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    let pruneCalls = 0;
    const originalPruneInboundMessages = registry.pruneInboundMessages;
    registry.pruneInboundMessages = ((cutoffMs: number) => {
      pruneCalls += 1;
      return originalPruneInboundMessages(cutoffMs);
    }) as typeof registry.pruneInboundMessages;

    const deduper = createPersistentFeishuInboundDeduper(registry);
    const claim = deduper.claim('om_text_hotpath_1');

    assert.equal(claim.kind, 'claimed');
    assert.equal(pruneCalls, 0);

    claim.complete();
    assert.equal(typeof registry.getInboundMessages().om_text_hotpath_1, 'number');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime logs duplicate inbound text metadata when replay is suppressed', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-log-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalConsoleLog = console.log;
  const logs: string[] = [];
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  const seededSeenAt = Date.now();

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.markInboundMessage('om_text_dup_1', seededSeenAt);

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-dup-1' },
        { key: 'trace_id', value: 'trace-dup-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_dup_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          message: {
            chat_id: 'oc_dup_1',
            message_id: 'om_text_dup_1',
            message_type: 'text',
            create_time: '1710000000',
            content: JSON.stringify({ text: '打开Codex窗口' })
          }
        }
      }))
    }));
    await shortDelay();

    const duplicateLog = logs.find((entry) => entry.includes('[feishu-runtime] inbound dedupe duplicate'));
    assert.ok(duplicateLog, 'expected feishu runtime duplicate log');
    assert.match(duplicateLog ?? '', /"eventId":"evt_dup_1"/);
    assert.match(duplicateLog ?? '', /"messageId":"om_text_dup_1"/);
    assert.match(duplicateLog ?? '', /"frameMessageId":"msg-frame-dup-1"/);
    assert.match(duplicateLog ?? '', /"traceId":"trace-dup-1"/);
    assert.match(duplicateLog ?? '', /"dedupeId":"om_text_dup_1"/);
    assert.match(duplicateLog ?? '', /"duplicateHit":true/);
    assert.match(duplicateLog ?? '', new RegExp(`\"seenAt\":${seededSeenAt}`));
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    console.log = originalConsoleLog;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime atomically claims inbound text before handler completion', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const longconnModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-claim-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const longconnModule = require(longconnModulePath) as {
    createFeishuLongConnectionClient: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateLongConnectionClient = longconnModule.createFeishuLongConnectionClient;
  const originalCreateFeishuService = serviceModule.createFeishuService;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let resolveFirstMessage: (() => void) | undefined;
  let onTextMessage: ((message: Record<string, any>) => Promise<void>) | undefined;
  const handledMessages: Array<Record<string, any>> = [];
  const rememberedTargets: Array<Record<string, any>> = [];

  try {
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    longconnModule.createFeishuLongConnectionClient = (input: Record<string, any>) => {
      onTextMessage = input.onTextMessage;
      return {
        start: async () => undefined,
        stop: async () => undefined
      };
    };
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, any>) => {
        handledMessages.push(message);
        await new Promise<void>((resolve) => {
          resolveFirstMessage = resolve;
        });
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: (target: Record<string, any>) => {
        rememberedTargets.push(target);
      }
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };

    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') }
    });

    await runtime.start();
    assert.equal(typeof onTextMessage, 'function');

    const firstDispatch = onTextMessage?.({
      threadId: 'feishu:chat:oc_claim_1',
      text: '你好',
      senderOpenId: 'ou_claim_1',
      eventId: 'evt_claim_1',
      messageId: 'om_text_claim_runtime_1',
      traceId: 'trace-claim-1',
      frameMessageId: 'msg-frame-claim-1',
      createTime: 1_710_000_000
    });
    await nextTick();

    const secondDispatch = onTextMessage?.({
      threadId: 'feishu:chat:oc_claim_1',
      text: '你好',
      senderOpenId: 'ou_claim_1',
      eventId: 'evt_claim_1_dup',
      messageId: 'om_text_claim_runtime_1',
      traceId: 'trace-claim-1-dup',
      frameMessageId: 'msg-frame-claim-1-dup',
      createTime: 1_710_000_000
    });
    await shortDelay();

    assert.equal(handledMessages.length, 1);
    assert.deepEqual(rememberedTargets, [{
      threadId: 'feishu:chat:oc_claim_1',
      senderOpenId: 'ou_claim_1'
    }]);

    resolveFirstMessage?.();
    await firstDispatch;
    await secondDispatch;

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    assert.equal(typeof registry.getInboundMessages().om_text_claim_runtime_1, 'number');
  } finally {
    resolveFirstMessage?.();
    if (runtime) {
      await runtime.stop();
    }
    longconnModule.createFeishuLongConnectionClient = originalCreateLongConnectionClient;
    serviceModule.createFeishuService = originalCreateFeishuService;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime keeps text watermark monotonic when same-thread messages complete out of order', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const longconnModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-watermark-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const longconnModule = require(longconnModulePath) as {
    createFeishuLongConnectionClient: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateLongConnectionClient = longconnModule.createFeishuLongConnectionClient;
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const deferredByMessageId = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let onTextMessage: ((message: Record<string, any>) => Promise<void>) | undefined;
  const handledMessageIds: string[] = [];

  try {
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    longconnModule.createFeishuLongConnectionClient = (input: Record<string, any>) => {
      onTextMessage = input.onTextMessage;
      return {
        start: async () => undefined,
        stop: async () => undefined
      };
    };
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, any>) => {
        handledMessageIds.push(message.messageId);
        let deferred = deferredByMessageId.get(message.messageId);
        if (!deferred) {
          let resolve!: () => void;
          const promise = new Promise<void>((innerResolve) => {
            resolve = innerResolve;
          });
          deferred = { promise, resolve };
          deferredByMessageId.set(message.messageId, deferred);
        }
        await deferred.promise;
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };

    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') }
    });

    await runtime.start();
    assert.equal(typeof onTextMessage, 'function');

    const olderDispatch = onTextMessage?.({
      threadId: 'feishu:chat:oc_watermark_1',
      text: '较老消息',
      senderOpenId: 'ou_watermark_1',
      eventId: 'evt_watermark_older',
      messageId: 'om_text_watermark_older',
      traceId: 'trace-watermark-older',
      frameMessageId: 'msg-frame-watermark-older',
      createTime: 1_710_001_000
    });
    await nextTick();

    const newerDispatch = onTextMessage?.({
      threadId: 'feishu:chat:oc_watermark_1',
      text: '较新消息',
      senderOpenId: 'ou_watermark_1',
      eventId: 'evt_watermark_newer',
      messageId: 'om_text_watermark_newer',
      traceId: 'trace-watermark-newer',
      frameMessageId: 'msg-frame-watermark-newer',
      createTime: 1_710_002_000
    });
    await shortDelay();

    assert.deepEqual(handledMessageIds, ['om_text_watermark_older', 'om_text_watermark_newer']);

    deferredByMessageId.get('om_text_watermark_newer')?.resolve();
    await newerDispatch;
    deferredByMessageId.get('om_text_watermark_older')?.resolve();
    await olderDispatch;

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    assert.equal(
      registry.getThreadUiState('feishu:chat:oc_watermark_1')?.lastAcceptedTextCreateTimeMs,
      1_710_002_000_000
    );
  } finally {
    for (const deferred of deferredByMessageId.values()) {
      deferred.resolve();
    }
    if (runtime) {
      await runtime.stop();
    }
    longconnModule.createFeishuLongConnectionClient = originalCreateLongConnectionClient;
    serviceModule.createFeishuService = originalCreateFeishuService;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime backfills last active delivery target even when replayed text is deduped', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-backfill-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.markInboundMessage('om_text_dup_backfill_1', Date.now());

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-backfill&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-dup-backfill-1' },
        { key: 'trace_id', value: 'trace-dup-backfill-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_dup_backfill_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_dup_backfill_1'
            }
          },
          message: {
            chat_id: 'oc_dup_backfill_1',
            message_id: 'om_text_dup_backfill_1',
            message_type: 'text',
            create_time: '1710000000',
            content: JSON.stringify({ text: '你好' })
          }
        }
      }))
    }));
    await shortDelay();

    const reloadedRegistry = createSessionRegistry({ registryPath });
    assert.equal(reloadedRegistry.getLastActiveFeishuThreadId(), 'feishu:chat:oc_dup_backfill_1');
    assert.equal(reloadedRegistry.getLastActiveFeishuUserOpenId(), 'ou_dup_backfill_1');
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime suppresses replayed card actions after restart', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-card-replay-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const seenActions: Array<Record<string, unknown>> = [];
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.markInboundMessage('evt_card_dup_1', Date.now());

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async () => undefined,
      handleCardAction: async (action: Record<string, unknown>) => {
        seenActions.push(action);
      },
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-card-replay&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-card-dup-1' },
        { key: 'trace_id', value: 'trace-card-dup-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_card_dup_1',
          event_type: 'card.action.trigger'
        },
        event: {
          context: {
            open_chat_id: 'oc_card_dup_1',
            open_message_id: 'om_card_dup_1'
          },
          action: {
            value: {
              kind: 'select_recent_cwd',
              cwd: 'D:\\Workspace\\Alpha'
            }
          }
        }
      }))
    }));
    await shortDelay();

    assert.equal(seenActions.length, 0);
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime releases inbound claim when text handling fails', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-failure-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let inboundAttempts = 0;

  try {
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async () => {
        inboundAttempts += 1;
        if (inboundAttempts === 1) {
          throw new Error('boom');
        }
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-failure&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    const emitFailureMessage = (eventId: string, traceId: string, frameMessageId: string): void => {
      socket?.emitMessage(encodeFeishuFrame({
        SeqID: 1n,
        LogID: 2n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: frameMessageId },
          { key: 'trace_id', value: traceId }
        ],
        payload: new TextEncoder().encode(JSON.stringify({
          schema: '2.0',
          header: {
            event_id: eventId,
            event_type: 'im.message.receive_v1'
          },
          event: {
            sender: {
              sender_id: {
                open_id: 'ou_failure_1'
              }
            },
            message: {
              chat_id: 'oc_failure_1',
              message_id: 'om_text_failure_1',
              message_type: 'text',
              create_time: '1710000000',
              content: JSON.stringify({ text: '你好' })
            }
          }
        }))
      }));
    };

    emitFailureMessage('evt_failure_1', 'trace-failure-1', 'msg-frame-failure-1');
    await shortDelay();

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    assert.equal(registry.getInboundMessages().om_text_failure_1, undefined);
    assert.equal(registry.load().inboundMessages.om_text_failure_1, undefined);

    emitFailureMessage('evt_failure_1_retry', 'trace-failure-1-retry', 'msg-frame-failure-1-retry');
    await shortDelay();

    assert.equal(inboundAttempts, 2);
    const reloadedRegistry = createSessionRegistry({ registryPath });
    assert.equal(typeof reloadedRegistry.getInboundMessages().om_text_failure_1, 'number');
    assert.equal(typeof reloadedRegistry.load().inboundMessages.om_text_failure_1, 'number');
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime suppresses stale inbound text when create_time is older than thread watermark', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-stale-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalConsoleLog = console.log;
  const originalDateNow = Date.now;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const handledMessages: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const seededCreateTimeMs = 1_710_001_000_000;
  const runtimeStartMs = 1_710_001_500_000;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat:oc_stale_1',
      displayMode: 'assistant',
      lastAcceptedTextCreateTimeMs: seededCreateTimeMs
    });

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, unknown>) => {
        handledMessages.push(message);
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    Date.now = () => runtimeStartMs;

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-stale&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-stale-1' },
        { key: 'trace_id', value: 'trace-stale-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_stale_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_stale_1'
            }
          },
          message: {
            chat_id: 'oc_stale_1',
            message_id: 'om_text_stale_1',
            message_type: 'text',
            create_time: '1710000000',
            content: JSON.stringify({ text: '幽灵消息' })
          }
        }
      }))
    }));
    await shortDelay();

    assert.equal(handledMessages.length, 0);
    const staleLog = logs.find((entry) => entry.includes('[feishu-runtime] inbound stale ignored'));
    assert.ok(staleLog, 'expected feishu runtime stale log');
    assert.match(staleLog ?? '', /"messageId":"om_text_stale_1"/);
    assert.match(staleLog ?? '', /"incomingCreateTimeMs":1710000000000/);
    assert.match(staleLog ?? '', /"lastAcceptedTextCreateTimeMs":1710001000000/);

    const reloadedRegistry = createSessionRegistry({ registryPath });
    assert.equal(reloadedRegistry.getThreadUiState('feishu:chat:oc_stale_1')?.lastAcceptedTextCreateTimeMs, seededCreateTimeMs);
    assert.equal(reloadedRegistry.getInboundMessages().om_text_stale_1, undefined);
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    console.log = originalConsoleLog;
    Date.now = originalDateNow;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime completes startup-stale replay even when create_time is older than thread watermark', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-startup-stale-watermark-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalConsoleLog = console.log;
  const originalDateNow = Date.now;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const handledMessages: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const seededCreateTimeMs = 1_710_002_000_000;
  const runtimeStartMs = 1_710_006_000_000;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat:oc_startup_stale_watermark_1',
      displayMode: 'assistant',
      lastAcceptedTextCreateTimeMs: seededCreateTimeMs
    });

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, unknown>) => {
        handledMessages.push(message);
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    Date.now = () => runtimeStartMs;

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-startup-stale-watermark&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-startup-stale-watermark-1' },
        { key: 'trace_id', value: 'trace-startup-stale-watermark-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_startup_stale_watermark_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_startup_stale_watermark_1'
            }
          },
          message: {
            chat_id: 'oc_startup_stale_watermark_1',
            message_id: 'om_text_startup_stale_watermark_1',
            message_type: 'text',
            create_time: '1710001000',
            content: JSON.stringify({ text: '更老的重启回放消息' })
          }
        }
      }))
    }));
    await shortDelay();

    assert.equal(handledMessages.length, 0);
    const staleLog = logs.find((entry) => entry.includes('[feishu-runtime] inbound startup stale ignored'));
    assert.ok(staleLog, 'expected feishu runtime startup stale log');
    assert.match(staleLog ?? '', /"messageId":"om_text_startup_stale_watermark_1"/);
    assert.match(staleLog ?? '', /"incomingCreateTimeMs":1710001000000/);
    assert.match(staleLog ?? '', /"lastAcceptedTextCreateTimeMs":1710002000000/);

    const reloadedRegistry = createSessionRegistry({ registryPath });
    assert.equal(
      reloadedRegistry.getThreadUiState('feishu:chat:oc_startup_stale_watermark_1')?.lastAcceptedTextCreateTimeMs,
      seededCreateTimeMs
    );
    assert.equal(typeof reloadedRegistry.getInboundMessages().om_text_startup_stale_watermark_1, 'number');
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    console.log = originalConsoleLog;
    Date.now = originalDateNow;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime accepts startup-replayed inbound text not older than startup watermark', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-startup-stale-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalConsoleLog = console.log;
  const originalDateNow = Date.now;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const handledMessages: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const seededCreateTimeMs = 1_710_000_000_000;
  const runtimeStartMs = 1_710_006_000_000;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat:oc_startup_stale_1',
      displayMode: 'assistant',
      lastAcceptedTextCreateTimeMs: seededCreateTimeMs
    });

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, unknown>) => {
        handledMessages.push(message);
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    Date.now = () => runtimeStartMs;

    let socket: MockWebSocket | undefined;
    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-startup-stale&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-startup-stale-1' },
        { key: 'trace_id', value: 'trace-startup-stale-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_startup_stale_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_startup_stale_1'
            }
          },
          message: {
            chat_id: 'oc_startup_stale_1',
            message_id: 'om_text_startup_stale_1',
            message_type: 'text',
            create_time: '1710001000',
            content: JSON.stringify({ text: '停机期间的新消息' })
          }
        }
      }))
    }));
    await shortDelay();

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 2n,
      LogID: 3n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-startup-stale-same-ts' },
        { key: 'trace_id', value: 'trace-startup-stale-same-ts' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_startup_stale_same_ts',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_startup_stale_1'
            }
          },
          message: {
            chat_id: 'oc_startup_stale_1',
            message_id: 'om_text_startup_stale_same_ts',
            message_type: 'text',
            create_time: '1710000000',
            content: JSON.stringify({ text: '同秒停机期间的新消息' })
          }
        }
      }))
    }));
    await shortDelay();

    assert.equal(handledMessages.length, 2);
    assert.equal(handledMessages[0]?.messageId, 'om_text_startup_stale_1');
    assert.equal(handledMessages[1]?.messageId, 'om_text_startup_stale_same_ts');
    const staleLog = logs.find((entry) => entry.includes('[feishu-runtime] inbound startup stale ignored'));
    assert.equal(staleLog, undefined);

    const reloadedRegistry = createSessionRegistry({ registryPath });
    assert.equal(
      reloadedRegistry.getThreadUiState('feishu:chat:oc_startup_stale_1')?.lastAcceptedTextCreateTimeMs,
      1_710_001_000_000
    );
    assert.equal(typeof reloadedRegistry.getInboundMessages().om_text_startup_stale_1, 'number');
    assert.equal(typeof reloadedRegistry.getInboundMessages().om_text_startup_stale_same_ts, 'number');
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    console.log = originalConsoleLog;
    Date.now = originalDateNow;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime accepts out-of-order startup replay newer than startup watermark even with clock skew', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const longconnModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-startup-out-of-order-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalDateNow = Date.now;
  const longconnModule = require(longconnModulePath) as {
    createFeishuLongConnectionClient: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateLongConnectionClient = longconnModule.createFeishuLongConnectionClient;
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const handledMessageIds: string[] = [];
  const seededCreateTimeMs = 1_710_000_000_000;
  const runtimeStartMs = 1_710_000_500_000;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let onTextMessage: ((message: Record<string, any>) => Promise<void>) | undefined;

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat:oc_startup_out_of_order_1',
      displayMode: 'assistant',
      lastAcceptedTextCreateTimeMs: seededCreateTimeMs
    });

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    Date.now = () => runtimeStartMs;
    longconnModule.createFeishuLongConnectionClient = (input: Record<string, any>) => {
      onTextMessage = input.onTextMessage;
      return {
        start: async () => undefined,
        stop: async () => undefined
      };
    };
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, any>) => {
        handledMessageIds.push(message.messageId);
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };

    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') }
    });

    await runtime.start();
    assert.equal(typeof onTextMessage, 'function');

    await onTextMessage?.({
      threadId: 'feishu:chat:oc_startup_out_of_order_1',
      text: '停机期间较新的消息',
      senderOpenId: 'ou_startup_out_of_order_1',
      eventId: 'evt_startup_out_of_order_newer',
      messageId: 'om_text_startup_out_of_order_newer',
      traceId: 'trace-startup-out-of-order-newer',
      frameMessageId: 'msg-frame-startup-out-of-order-newer',
      createTime: 1_710_002_000
    });
    await onTextMessage?.({
      threadId: 'feishu:chat:oc_startup_out_of_order_1',
      text: '停机期间较早但未处理的消息',
      senderOpenId: 'ou_startup_out_of_order_1',
      eventId: 'evt_startup_out_of_order_older',
      messageId: 'om_text_startup_out_of_order_older',
      traceId: 'trace-startup-out-of-order-older',
      frameMessageId: 'msg-frame-startup-out-of-order-older',
      createTime: 1_710_001_000
    });

    assert.deepEqual(handledMessageIds, [
      'om_text_startup_out_of_order_newer',
      'om_text_startup_out_of_order_older'
    ]);
    assert.equal(
      createSessionRegistry({ registryPath }).getThreadUiState('feishu:chat:oc_startup_out_of_order_1')?.lastAcceptedTextCreateTimeMs,
      1_710_002_000_000
    );
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    longconnModule.createFeishuLongConnectionClient = originalCreateLongConnectionClient;
    serviceModule.createFeishuService = originalCreateFeishuService;
    Date.now = originalDateNow;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('feishu runtime persists accepted text watermark and suppresses older text after restart', async () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const registryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-stale-restart-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const originalRegistryEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalDateNow = Date.now;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  const firstHandledMessages: Array<Record<string, unknown>> = [];
  const secondHandledMessages: Array<Record<string, unknown>> = [];
  const firstRuntimeStartMs = 1_710_001_200_000;
  const secondRuntimeStartMs = 1_710_001_500_000;
  let nowMs = firstRuntimeStartMs;
  let activeHandledMessages = firstHandledMessages;
  let firstRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let secondRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    Date.now = () => nowMs;
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async (message: Record<string, unknown>) => {
        activeHandledMessages.push(message);
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    let firstSocket: MockWebSocket | undefined;
    firstRuntime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-stale-restart-1&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        firstSocket = new MockWebSocket(url);
        return firstSocket;
      }
    });

    await firstRuntime.start();
    await nextTick();

    firstSocket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-stale-restart-1' },
        { key: 'trace_id', value: 'trace-stale-restart-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_stale_restart_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_stale_restart_1'
            }
          },
          message: {
            chat_id: 'oc_stale_restart_1',
            message_id: 'om_text_stale_restart_1',
            message_type: 'text',
            create_time: '1710001000',
            content: JSON.stringify({ text: '较新的合法消息' })
          }
        }
      }))
    }));
    await shortDelay();

    assert.equal(firstHandledMessages.length, 1);

    const { createSessionRegistry } = loadSessionRegistryModule();
    assert.equal(
      createSessionRegistry({ registryPath }).getThreadUiState('feishu:chat:oc_stale_restart_1')?.lastAcceptedTextCreateTimeMs,
      1_710_001_000_000
    );

    await firstRuntime.stop();
    firstRuntime = undefined;
    activeHandledMessages = secondHandledMessages;
    nowMs = secondRuntimeStartMs;

    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];

    const { createFeishuLongConnectionRuntime: createReloadedRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, any>) => {
        start: () => Promise<void>;
        stop: () => Promise<void>;
      };
    };

    let secondSocket: MockWebSocket | undefined;
    secondRuntime = createReloadedRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-stale-restart-2&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 0,
                ReconnectInterval: 5,
                ReconnectNonce: 0
              }
            }
          }),
          { status: 200 }
        ),
      createWebSocket: (url: string) => {
        secondSocket = new MockWebSocket(url);
        return secondSocket;
      }
    });

    await secondRuntime.start();
    await nextTick();

    secondSocket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-frame-stale-restart-2' },
        { key: 'trace_id', value: 'trace-stale-restart-2' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_stale_restart_2',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_stale_restart_1'
            }
          },
          message: {
            chat_id: 'oc_stale_restart_1',
            message_id: 'om_text_stale_restart_2',
            message_type: 'text',
            create_time: '1710000000',
            content: JSON.stringify({ text: '较老的回放消息' })
          }
        }
      }))
    }));
    await shortDelay();

    assert.equal(secondHandledMessages.length, 0);
    assert.equal(
      createSessionRegistry({ registryPath }).getThreadUiState('feishu:chat:oc_stale_restart_1')?.lastAcceptedTextCreateTimeMs,
      1_710_001_000_000
    );
    assert.equal(createSessionRegistry({ registryPath }).getInboundMessages().om_text_stale_restart_2, undefined);
  } finally {
    if (firstRuntime) {
      await firstRuntime.stop();
    }
    if (secondRuntime) {
      await secondRuntime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    Date.now = originalDateNow;
    if (originalRegistryEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryEnv;
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(registryModulePath)];
    rmSync(rootDir, { recursive: true, force: true });
  }
});
