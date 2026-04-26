import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
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

  emitError(error: unknown = new Error('socket error')): void {
    this.dispatch('error', error);
  }

  private dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FailingOpenWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readyState = FailingOpenWebSocket.CONNECTING;
  binaryType: BinaryType = 'arraybuffer';

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = FailingOpenWebSocket.CLOSED;
      this.dispatch('error', new Error('socket open failed'));
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
    this.readyState = FailingOpenWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  private dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function dispatchCardActionThroughLongconn(input: {
  frameMessageId: string;
  actionValue?: unknown;
  actionName?: string;
  formValue?: Record<string, unknown>;
  context?: Record<string, unknown>;
}): Promise<{
  seen: Array<Record<string, unknown>>;
  ackPayload: Record<string, unknown>;
}> {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (options: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<Record<string, unknown>> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => undefined,
    onCardAction: async (action: Record<string, unknown>) => {
      seen.push(action);
    }
  });

  await client.start();
  await nextTick();

  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: {
            open_chat_id: 'oc_takeover',
            open_message_id: 'om_takeover_card',
            ...(input.context ?? {})
          },
          action: {
            ...(input.actionName ? { name: input.actionName } : {}),
            ...(input.formValue ? { form_value: input.formValue } : {}),
            ...(input.actionValue !== undefined ? { value: input.actionValue } : {})
          }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 101n,
        LogID: 102n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: input.frameMessageId },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find(
        (frame) =>
          frame.method === 1 &&
          (frame.headers ?? []).some(
            (header: { key: string; value: string }) => header.key === 'message_id' && header.value === input.frameMessageId
          )
      );
    assert.ok(ackFrame, `expected callback response for ${input.frameMessageId}`);
    return {
      seen,
      ackPayload: JSON.parse(new TextDecoder().decode(ackFrame.payload))
    };
  } finally {
    await client.stop();
  }
}

function stubCommonJsModule(modulePath: string, exports: Record<string, unknown>): () => void {
  const original = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: [],
    path: path.dirname(modulePath),
    paths: []
  } as unknown as NodeJS.Module;
  return () => {
    if (original) {
      require.cache[modulePath] = original;
      return;
    }
    delete require.cache[modulePath];
  };
}

function captureStructuredFallbackDisabledCalls(targetModulePath: string, options?: { stubLongconnClient?: boolean }): {
  codexSessionCalls: Array<Record<string, unknown>>;
  appSessionCalls: Array<Record<string, unknown>>;
} {
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const sessionModulePath = path.resolve(__dirname, '../../src/communicate/workers/codex/session.js');
  const appSessionModulePath = path.resolve(__dirname, '../../src/communicate/workers/codex/app-session.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const longconnModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const codexSessionCalls: Array<Record<string, unknown>> = [];
  const appSessionCalls: Array<Record<string, unknown>> = [];
  let capturedServiceInput: Record<string, any> | undefined;
  const fakeSession = {
    start: async () => undefined,
    sendReply: async () => undefined,
    getSnapshot: () => ({})
  };
  const restores: Array<() => void> = [
    stubCommonJsModule(serviceModulePath, {
      createFeishuService: (input: Record<string, unknown>) => {
        capturedServiceInput = input as Record<string, any>;
        return {
          handleWorkerEvent: () => undefined,
          handleInboundMessage: async () => undefined,
          handleInboundImage: async () => undefined,
          handleCardAction: async () => undefined,
          rememberInboundDeliveryTarget: () => undefined,
          syncStartupCardForLastActiveThread: async () => undefined
        };
      }
    }),
    stubCommonJsModule(sessionModulePath, {
      createCodexSession: (input: Record<string, unknown>) => {
        codexSessionCalls.push(input);
        return fakeSession;
      }
    }),
    stubCommonJsModule(appSessionModulePath, {
      createCodexAppSession: (input: Record<string, unknown>) => {
        appSessionCalls.push(input);
        return fakeSession;
      }
    }),
    stubCommonJsModule(sessionRegistryModulePath, {
      createSessionRegistry: () => ({
        getInboundMessages: () => ({}),
        getThreadUiState: () => undefined,
        upsertThreadUiState: () => undefined,
        markInboundMessage: () => undefined,
        getInboundMessageSeenAt: () => undefined,
        pruneInboundMessagesOlderThan: () => 0
      })
    })
  ];
  if (options?.stubLongconnClient) {
    restores.push(
      stubCommonJsModule(longconnModulePath, {
        createFeishuLongConnectionClient: () => ({
          start: async () => undefined,
          stop: async () => undefined
        }),
        acquireFeishuLongConnectionLease: () => ({
          release: () => undefined
        })
      })
    );
  }

  const originalTarget = require.cache[targetModulePath];
  delete require.cache[targetModulePath];

  try {
    const { createFeishuLongConnectionRuntime } = require(targetModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => unknown;
    };

    createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      assistantAppServerEnabled: false,
      codingAppServerEnabled: false
    });

    assert.ok(capturedServiceInput, 'expected createFeishuService to capture session factories');

    capturedServiceInput.assistantSessionFactory({
      taskId: 'task-assistant',
      cwd: 'D:\\Workspace\\CodexLark',
      mode: 'assistant'
    });
    capturedServiceInput.codingSessionFactory({
      taskId: 'task-coding',
      cwd: 'D:\\Workspace\\CodexLark',
      mode: 'coding'
    });

    return { codexSessionCalls, appSessionCalls };
  } finally {
    if (originalTarget) {
      require.cache[targetModulePath] = originalTarget;
    } else {
      delete require.cache[targetModulePath];
    }
    while (restores.length > 0) {
      restores.pop()?.();
    }
  }
}

function captureKnownBadVersionOverrideCalls(
  targetModulePath: string,
  options?: { stubLongconnClient?: boolean; assistantAppServerEnabled?: boolean; codingAppServerEnabled?: boolean }
): {
  codexSessionCalls: Array<Record<string, unknown>>;
  appSessionCalls: Array<Record<string, unknown>>;
} {
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const sessionModulePath = path.resolve(__dirname, '../../src/communicate/workers/codex/session.js');
  const appSessionModulePath = path.resolve(__dirname, '../../src/communicate/workers/codex/app-session.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const longconnModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const codexSessionCalls: Array<Record<string, unknown>> = [];
  const appSessionCalls: Array<Record<string, unknown>> = [];
  let capturedServiceInput: Record<string, any> | undefined;
  const fakeSession = {
    start: async () => undefined,
    sendReply: async () => undefined,
    getSnapshot: () => ({})
  };
  const restores: Array<() => void> = [
    stubCommonJsModule(serviceModulePath, {
      createFeishuService: (input: Record<string, unknown>) => {
        capturedServiceInput = input as Record<string, any>;
        return {
          handleWorkerEvent: () => undefined,
          handleInboundMessage: async () => undefined,
          handleInboundImage: async () => undefined,
          handleCardAction: async () => undefined,
          rememberInboundDeliveryTarget: () => undefined,
          syncStartupCardForLastActiveThread: async () => undefined
        };
      }
    }),
    stubCommonJsModule(sessionModulePath, {
      createCodexSession: (input: Record<string, unknown>) => {
        codexSessionCalls.push(input);
        return fakeSession;
      }
    }),
    stubCommonJsModule(appSessionModulePath, {
      createCodexAppSession: (input: Record<string, unknown>) => {
        appSessionCalls.push(input);
        return fakeSession;
      }
    }),
    stubCommonJsModule(sessionRegistryModulePath, {
      createSessionRegistry: () => ({
        getInboundMessages: () => ({}),
        getThreadUiState: () => undefined,
        upsertThreadUiState: () => undefined,
        markInboundMessage: () => undefined,
        getInboundMessageSeenAt: () => undefined,
        pruneInboundMessagesOlderThan: () => 0
      })
    })
  ];
  if (options?.stubLongconnClient) {
    restores.push(
      stubCommonJsModule(longconnModulePath, {
        createFeishuLongConnectionClient: () => ({
          start: async () => undefined,
          stop: async () => undefined
        }),
        acquireFeishuLongConnectionLease: () => ({
          release: () => undefined
        })
      })
    );
  }

  const originalTarget = require.cache[targetModulePath];
  delete require.cache[targetModulePath];

  try {
    const { createFeishuLongConnectionRuntime } = require(targetModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => unknown;
    };

    createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      allowKnownBadCodexVersion: true,
      ...(options?.assistantAppServerEnabled !== undefined
        ? { assistantAppServerEnabled: options.assistantAppServerEnabled }
        : {}),
      ...(options?.codingAppServerEnabled !== undefined
        ? { codingAppServerEnabled: options.codingAppServerEnabled }
        : {})
    });

    assert.ok(capturedServiceInput, 'expected createFeishuService to capture session factories');

    capturedServiceInput.sessionFactory({
      taskId: 'task-generic',
      cwd: 'D:\\Workspace\\CodexLark',
      mode: 'generic'
    });
    capturedServiceInput.assistantSessionFactory({
      taskId: 'task-assistant',
      cwd: 'D:\\Workspace\\CodexLark',
      mode: 'assistant'
    });
    capturedServiceInput.codingSessionFactory({
      taskId: 'task-coding',
      cwd: 'D:\\Workspace\\CodexLark',
      mode: 'coding'
    });

    return { codexSessionCalls, appSessionCalls };
  } finally {
    if (originalTarget) {
      require.cache[targetModulePath] = originalTarget;
    } else {
      delete require.cache[targetModulePath];
    }
    while (restores.length > 0) {
      restores.pop()?.();
    }
  }
}

test('long connection pulls endpoint config, dispatches text event, and sends ack', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<{
    threadId: string;
    text: string;
    messageId?: string;
    senderOpenId?: string;
    traceId?: string;
    frameSeq?: string;
    frameSum?: string;
  }> = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
              ReconnectInterval: 5,
              ReconnectNonce: 0
            }
          }
        }),
        { status: 200 }
      );
    },
    createWebSocket: (url: string) => {
      socket = new MockWebSocket(url);
      return socket;
    },
    onTextMessage: async (message: {
      threadId: string;
      text: string;
      messageId?: string;
      senderOpenId?: string;
      traceId?: string;
      frameSeq?: string;
      frameSum?: string;
    }) => {
      seen.push(message);
    }
  });

  await client.start();
  await nextTick();

  try {
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]?.url ?? '', /\/callback\/ws\/endpoint$/);
    assert.match(String(fetchCalls[0]?.init?.body ?? ''), /"AppID":"app-id"/);
    assert.match(String(fetchCalls[0]?.init?.body ?? ''), /"AppSecret":"app-secret"/);
    assert.equal(socket?.url, 'wss://example.test/ws?device_id=device-1&service_id=321');

    const eventPayload = new TextEncoder().encode(JSON.stringify({
      schema: '2.0',
      header: {
        event_type: 'im.message.receive_v1'
      },
      event: {
        sender: {
          sender_id: {
            open_id: 'ou_test_user_1'
          }
        },
        message: {
          chat_id: 'oc_123',
          message_type: 'text',
          content: JSON.stringify({ text: '允许' })
        }
      }
    }));
    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-1' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: 'trace-1' }
      ],
      payload: eventPayload
    }));
    await nextTick();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.threadId, 'feishu:chat:oc_123');
    assert.equal(seen[0]?.text, '允许');
    assert.equal(seen[0]?.messageId, undefined);
    assert.equal(seen[0]?.senderOpenId, 'ou_test_user_1');
    assert.equal(seen[0]?.traceId, 'trace-1');
    assert.equal((seen[0] as any)?.frameMessageId, 'msg-1');
    assert.equal(seen[0]?.frameSeq, '0');
    assert.equal(seen[0]?.frameSum, '1');
    assert.equal((seen[0] as any)?.messageType, 'text');
    assert.equal((seen[0] as any)?.chatId, 'oc_123');

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find((frame) => frame.method === 1 && (frame.headers ?? []).some((header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-1'));
    assert.ok(ackFrame, 'expected event ack frame');
    const ackHeaders = new Map((ackFrame?.headers ?? []).map((header: { key: string; value: string }) => [header.key, header.value]));
    assert.equal(ackHeaders.get('type'), 'ack');
    assert.equal(ackHeaders.get('message_id'), 'msg-1');
    assert.equal(ackHeaders.get('trace_id'), 'trace-1');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(ackFrame.payload)), { code: 200 });
  } finally {
    await client.stop();
  }
});


test('long connection dispatches image event to onImageMessage', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<{ threadId: string; imageKey: string; messageId?: string; createTime?: number }> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => {
      throw new Error('unexpected text message');
    },
    onImageMessage: async (message: { threadId: string; imageKey: string; messageId?: string; createTime?: number }) => {
      seen.push(message);
    }
  });

  await client.start();
  await nextTick();

  try {
    const eventPayload = new TextEncoder().encode(JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        message: {
          chat_id: 'oc_img',
          message_id: 'om_img_1',
          message_type: 'image',
          create_time: '1710000123',
          content: JSON.stringify({ image_key: 'img_123' })
        }
      }
    }));
    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-img' }
      ],
      payload: eventPayload
    }));
    await nextTick();

    assert.deepEqual(seen, [{ threadId: 'feishu:chat:oc_img', imageKey: 'img_123', messageId: 'om_img_1', createTime: 1710000123 }]);
  } finally {
    await client.stop();
  }
});

test('long connection dispatches card action trigger events', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<Record<string, unknown>> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => undefined,
    onCardAction: async (action: Record<string, unknown>) => {
      seen.push(action);
    }
  });

  await client.start();
  await nextTick();

  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: { open_chat_id: 'oc_123', open_message_id: 'om_card_1' },
          action: { value: { kind: 'switch_mode_coding' } }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 7n,
        LogID: 8n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-card-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.deepEqual(seen[0], {
      threadId: 'feishu:chat:oc_123',
      messageId: 'om_card_1',
      eventId: undefined,
      traceId: undefined,
      frameMessageId: 'msg-card-1',
      kind: 'switch_mode_coding'
    });

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find(
        (frame) =>
          frame.method === 1 &&
          (frame.headers ?? []).some(
            (header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-card-1'
          )
      );
    assert.ok(ackFrame, 'expected card action ack frame');
    const ackHeaders = new Map((ackFrame?.headers ?? []).map((header: { key: string; value: string }) => [header.key, header.value]));
    assert.equal(ackHeaders.get('type'), 'event');
    const ackPayload = JSON.parse(new TextDecoder().decode(ackFrame.payload));
    assert.equal(ackPayload.code, 200);
    assert.equal(typeof ackPayload.data, 'string');
    assert.deepEqual(JSON.parse(Buffer.from(ackPayload.data, 'base64').toString('utf8')), {
      toast: {
        type: 'info',
        content: '正在切换到 Coding 模式'
      }
    });
  } finally {
    await client.stop();
  }
});

test('long connection dispatches create new task card action and returns matching toast', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<Record<string, unknown>> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => undefined,
    onCardAction: async (action: Record<string, unknown>) => {
      seen.push(action);
    }
  });

  await client.start();
  await nextTick();

  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: { open_chat_id: 'oc_123', open_message_id: 'om_card_1' },
          action: { value: { kind: 'create_new_task' } }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 17n,
        LogID: 18n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-card-create-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.deepEqual(seen[0], {
      threadId: 'feishu:chat:oc_123',
      messageId: 'om_card_1',
      eventId: undefined,
      traceId: undefined,
      frameMessageId: 'msg-card-create-1',
      kind: 'create_new_task'
    });

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find(
        (frame) =>
          frame.method === 1 &&
          (frame.headers ?? []).some(
            (header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-card-create-1'
          )
      );
    assert.ok(ackFrame, 'expected create-new-task card action ack frame');
    const ackPayload = JSON.parse(new TextDecoder().decode(ackFrame.payload));
    assert.equal(ackPayload.code, 200);
    assert.equal(typeof ackPayload.data, 'string');
    assert.deepEqual(JSON.parse(Buffer.from(ackPayload.data, 'base64').toString('utf8')), {
      toast: {
        type: 'info',
        content: '正在新建任务'
      }
    });
  } finally {
    await client.stop();
  }
});

test('long connection dispatches return to launcher card action and returns matching toast', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<Record<string, unknown>> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => undefined,
    onCardAction: async (action: Record<string, unknown>) => {
      seen.push(action);
    }
  });

  await client.start();
  await nextTick();

  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: { open_chat_id: 'oc_launcher', open_message_id: 'om_card_launcher' },
          action: { value: JSON.stringify({ kind: 'return_to_launcher' }) }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 19n,
        LogID: 20n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-card-launcher-return-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.deepEqual(seen[0], {
      threadId: 'feishu:chat:oc_launcher',
      messageId: 'om_card_launcher',
      eventId: undefined,
      traceId: undefined,
      frameMessageId: 'msg-card-launcher-return-1',
      kind: 'return_to_launcher'
    });

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find(
        (frame) =>
          frame.method === 1 &&
          (frame.headers ?? []).some(
            (header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-card-launcher-return-1'
          )
      );
    assert.ok(ackFrame, 'expected return-to-launcher card action ack frame');
    const ackPayload = JSON.parse(new TextDecoder().decode(ackFrame.payload));
    assert.equal(ackPayload.code, 200);
    assert.equal(typeof ackPayload.data, 'string');
    assert.deepEqual(JSON.parse(Buffer.from(ackPayload.data, 'base64').toString('utf8')), {
      toast: {
        type: 'info',
        content: '正在返回启动卡'
      }
    });
  } finally {
    await client.stop();
  }
});

test('long connection dispatches card action when payload uses alias context fields and JSON string value', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<Record<string, unknown>> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => undefined,
    onCardAction: async (action: Record<string, unknown>) => {
      seen.push(action);
    }
  });

  await client.start();
  await nextTick();

  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: { chat_id: 'oc_alias', message_id: 'om_alias_card_1' },
          action: { value: JSON.stringify({ kind: 'select_recent_cwd', cwd: 'D:\\Workspace\\CodexLark' }) }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 71n,
        LogID: 72n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-card-alias-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.deepEqual(seen[0], {
      threadId: 'feishu:chat:oc_alias',
      messageId: 'om_alias_card_1',
      eventId: undefined,
      traceId: undefined,
      frameMessageId: 'msg-card-alias-1',
      kind: 'select_recent_cwd',
      cwd: 'D:\\Workspace\\CodexLark'
    });

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find(
        (frame) =>
          frame.method === 1 &&
          (frame.headers ?? []).some(
            (header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-card-alias-1'
          )
      );
    assert.ok(ackFrame, 'expected callback response for alias card action payload');
    const ackPayload = JSON.parse(new TextDecoder().decode(ackFrame.payload));
    assert.equal(ackPayload.code, 200);
    assert.equal(typeof ackPayload.data, 'string');
    assert.deepEqual(JSON.parse(Buffer.from(ackPayload.data, 'base64').toString('utf8')), {
      toast: {
        type: 'info',
        content: '正在选择最近目录'
      }
    });
  } finally {
    await client.stop();
  }
});

test('long connection dispatches launcher submit card action with form value', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<Record<string, unknown>> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => undefined,
    onCardAction: async (action: Record<string, unknown>) => {
      seen.push(action);
    }
  });

  await client.start();
  await nextTick();

  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: { open_chat_id: 'oc_launcher', open_message_id: 'om_card_launcher' },
          action: {
            name: 'submit_launch_coding',
            form_value: { project_cwd: 'D:\\Workspace\\Project' }
          }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 9n,
        LogID: 10n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-card-launcher-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.deepEqual(seen[0], {
      threadId: 'feishu:chat:oc_launcher',
      messageId: 'om_card_launcher',
      eventId: undefined,
      traceId: undefined,
      frameMessageId: 'msg-card-launcher-1',
      kind: 'submit_launch_coding',
      cwd: 'D:\\Workspace\\Project'
    });

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find(
        (frame) =>
          frame.method === 1 &&
          (frame.headers ?? []).some(
            (header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-card-launcher-1'
          )
      );
    assert.ok(ackFrame, 'expected launcher card action ack frame');
    const ackPayload = JSON.parse(new TextDecoder().decode(ackFrame.payload));
    assert.equal(ackPayload.code, 200);
    assert.equal(typeof ackPayload.data, 'string');
    assert.deepEqual(JSON.parse(Buffer.from(ackPayload.data, 'base64').toString('utf8')), {
      toast: {
        type: 'info',
        content: '正在启动编程窗口'
      }
    });
  } finally {
    await client.stop();
  }
});

test('long connection dispatches open takeover picker callback', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-open-1',
    actionValue: { kind: 'open_takeover_picker' }
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-open-1',
    kind: 'open_takeover_picker'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在加载本地 Codex 列表'
    }
  });
});

test('long connection dispatches pick takeover task callback with task id', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-pick-1',
    actionValue: JSON.stringify({ kind: 'pick_takeover_task', taskId: 'T31' })
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-pick-1',
    kind: 'pick_takeover_task',
    taskId: 'T31'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在选择 T31'
    }
  });
});

test('long connection dispatches takeover picker previous page callback', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-prev-1',
    actionValue: { kind: 'takeover_picker_prev_page' }
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-prev-1',
    kind: 'takeover_picker_prev_page'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在加载上一页'
    }
  });
});

test('long connection dispatches takeover picker next page callback', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-next-1',
    actionValue: { kind: 'takeover_picker_next_page' }
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-next-1',
    kind: 'takeover_picker_next_page'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在加载下一页'
    }
  });
});

test('long connection dispatches refresh takeover picker callback', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-refresh-1',
    actionValue: { kind: 'refresh_takeover_picker' }
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-refresh-1',
    kind: 'refresh_takeover_picker'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在刷新本地 Codex 列表'
    }
  });
});

test('long connection dispatches confirm takeover task callback', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-confirm-1',
    actionValue: { kind: 'confirm_takeover_task' }
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-confirm-1',
    kind: 'confirm_takeover_task'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在确认接管'
    }
  });
});

test('long connection dispatches return to status callback', async () => {
  const { seen, ackPayload } = await dispatchCardActionThroughLongconn({
    frameMessageId: 'msg-card-takeover-return-1',
    actionValue: { kind: 'return_to_status' }
  });

  assert.deepEqual(seen[0], {
    threadId: 'feishu:chat:oc_takeover',
    messageId: 'om_takeover_card',
    eventId: undefined,
    traceId: undefined,
    frameMessageId: 'msg-card-takeover-return-1',
    kind: 'return_to_status'
  });
  assert.equal(ackPayload.code, 200);
  assert.equal(typeof ackPayload.data, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(String(ackPayload.data), 'base64').toString('utf8')), {
    toast: {
      type: 'info',
      content: '正在返回状态卡'
    }
  });
});

test('long connection dumps raw event payload before parse for sparse callback debugging', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'feishu-longconn-raw-'));
  const rawDumpPath = path.join(tempRoot, 'feishu-longconn-raw-events.log');
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalInstanceTagEnv = process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
  const originalRawDumpEnv = process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH;
  let client: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let socket: MockWebSocket | undefined;

  try {
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = 'instance-test-raw-1';
    process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH = rawDumpPath;
    delete require.cache[require.resolve('../../src/communicate/channel/feishu-longconn')];

    const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
      createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };
    const { encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    client = createFeishuLongConnectionClient({
      appId: 'app-id',
      appSecret: 'app-secret',
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 3,
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
      },
      onTextMessage: async () => undefined
    });

    await client.start();
    await nextTick();

    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_id: 'evt_sparse_1' },
        event: {
          mystery_context: { foo: 'bar' },
          action: { value: 'not-json' }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 101n,
        LogID: 102n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-raw-1' },
          { key: 'trace_id', value: 'trace-raw-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.equal(existsSync(rawDumpPath), true);
    const dump = readFileSync(rawDumpPath, 'utf8');
    assert.match(dump, /msg-raw-1/);
    assert.match(dump, /trace-raw-1/);
    assert.match(dump, /evt_sparse_1/);
    assert.match(dump, /mystery_context/);
    assert.match(dump, /instance-test-raw-1/);
  } finally {
    if (client) {
      await client.stop();
    }
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    if (originalInstanceTagEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
    } else {
      process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = originalInstanceTagEnv;
    }
    if (originalRawDumpEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH;
    } else {
      process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH = originalRawDumpEnv;
    }
    delete require.cache[require.resolve('../../src/communicate/channel/feishu-longconn')];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('long connection logs compact payload to stdout when sparse callback event misses event_type', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'feishu-longconn-sparse-'));
  const debugLogPath = path.join(tempRoot, 'feishu-longconn-debug.log');
  const rawDumpPath = path.join(tempRoot, 'feishu-longconn-raw-events.log');
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalInstanceTagEnv = process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
  const originalDebugLogEnv = process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH;
  const originalRawDumpEnv = process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH;
  const originalConsoleLog = console.log;
  const capturedLogs: string[] = [];
  let client: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let socket: MockWebSocket | undefined;

  try {
    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.map((value) => String(value)).join(' '));
    };
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = 'instance-test-sparse-1';
    process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH = debugLogPath;
    process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH = rawDumpPath;
    delete require.cache[require.resolve('../../src/communicate/channel/feishu-longconn')];

    const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
      createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };
    const { encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    client = createFeishuLongConnectionClient({
      appId: 'app-id',
      appSecret: 'app-secret',
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 3,
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
      },
      onTextMessage: async () => undefined
    });

    await client.start();
    await nextTick();

    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_id: 'evt_sparse_stdout_1' },
        event: {
          action: {
            value: {
              kind: 'select_recent_cwd',
              cwd: 'D:\\Workspace\\CodexLark'
            }
          },
          context: {
            open_message_id: 'om_sparse_stdout_1',
            open_chat_id: 'oc_sparse_stdout_1'
          }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 201n,
        LogID: 202n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-sparse-stdout-1' },
          { key: 'trace_id', value: 'trace-sparse-stdout-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    const sparseLog = capturedLogs.find((line) => line.includes('event sparse payload'));
    assert.ok(sparseLog, `expected sparse payload stdout log, got: ${capturedLogs.join('\n')}`);
    assert.match(sparseLog ?? '', /evt_sparse_stdout_1/);
    assert.match(sparseLog ?? '', /instance-test-sparse-1/);
    assert.match(sparseLog ?? '', /select_recent_cwd/);
    assert.match(sparseLog ?? '', /open_message_id/);
  } finally {
    if (client) {
      await client.stop();
    }
    console.log = originalConsoleLog;
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    if (originalInstanceTagEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
    } else {
      process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = originalInstanceTagEnv;
    }
    if (originalDebugLogEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH = originalDebugLogEnv;
    }
    if (originalRawDumpEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH;
    } else {
      process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH = originalRawDumpEnv;
    }
    delete require.cache[require.resolve('../../src/communicate/channel/feishu-longconn')];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('long connection reports debug and raw dump sink failures to stderr', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'feishu-longconn-sink-failure-'));
  const debugLogPath = path.join(tempRoot, 'feishu-longconn-debug.log');
  const rawDumpPath = path.join(tempRoot, 'feishu-longconn-raw-events.log');
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalDebugLogEnv = process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH;
  const originalRawDumpEnv = process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH;
  const originalConsoleError = console.error;
  const fsModule = require('node:fs') as typeof import('node:fs') & {
    appendFileSync: typeof import('node:fs').appendFileSync;
  };
  const originalAppendFileSync = fsModule.appendFileSync;
  const capturedErrors: string[] = [];
  let client: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let socket: MockWebSocket | undefined;

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };
    fsModule.appendFileSync = ((filePath: any, data: any, options?: any) => {
      const normalized = String(filePath);
      if (normalized === debugLogPath || normalized === rawDumpPath) {
        throw new Error(`simulated sink failure for ${path.basename(normalized)}`);
      }
      return originalAppendFileSync(filePath, data, options);
    }) as typeof import('node:fs').appendFileSync;
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH = debugLogPath;
    process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH = rawDumpPath;
    delete require.cache[require.resolve('../../src/communicate/channel/feishu-longconn')];

    const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
      createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };
    const { encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    client = createFeishuLongConnectionClient({
      appId: 'app-id',
      appSecret: 'app-secret',
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
              ClientConfig: {
                PingInterval: 30,
                ReconnectCount: 3,
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
      },
      onTextMessage: async () => undefined
    });

    await client.start();
    await nextTick();

    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_id: 'evt_sink_failure_1' },
        event: {
          mystery_context: { foo: 'bar' }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 301n,
        LogID: 302n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-sink-failure-1' },
          { key: 'trace_id', value: 'trace-sink-failure-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();

    assert.ok(
      capturedErrors.some((line) => line.includes('debug log sink failed')),
      `expected debug sink failure stderr log, got: ${capturedErrors.join('\n')}`
    );
    assert.ok(
      capturedErrors.some((line) => line.includes('raw event dump sink failed')),
      `expected raw dump sink failure stderr log, got: ${capturedErrors.join('\n')}`
    );
  } finally {
    if (client) {
      await client.stop();
    }
    console.error = originalConsoleError;
    fsModule.appendFileSync = originalAppendFileSync;
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
    if (originalDebugLogEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH = originalDebugLogEnv;
    }
    if (originalRawDumpEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH;
    } else {
      process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH = originalRawDumpEnv;
    }
    delete require.cache[require.resolve('../../src/communicate/channel/feishu-longconn')];
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('long connection sends ack before handler completes', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  let socket: MockWebSocket | undefined;
  let resolveProcessing!: () => void;
  const processing = new Promise<void>((resolve) => {
    resolveProcessing = resolve;
  });

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async () => {
      await processing;
    }
  });

  await client.start();
  await nextTick();

  try {
    const eventPayload = new TextEncoder().encode(JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        message: {
          chat_id: 'oc_789',
          message_type: 'text',
          content: JSON.stringify({ text: '继续' })
        }
      }
    }));

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 5n,
      LogID: 6n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-3' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: 'trace-3' }
      ],
      payload: eventPayload
    }));

    await nextTick();

    const ackFrame = socket?.sent
      .map((buffer) => decodeFeishuFrame(buffer))
      .find((frame) => frame.method === 1 && (frame.headers ?? []).some((header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-3'));
    assert.ok(ackFrame, 'expected event ack frame before handler completes');
  } finally {
    resolveProcessing();
    await nextTick();
    await client.stop();
  }
});

test('long connection stop waits for in-flight handlers to finish', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  let socket: MockWebSocket | undefined;
  let resolveProcessing!: () => void;
  const processing = new Promise<void>((resolve) => {
    resolveProcessing = resolve;
  });

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            URL: 'wss://example.test/ws?device_id=device-stop-wait&service_id=321',
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
    },
    onTextMessage: async () => {
      await processing;
    }
  });

  await client.start();
  await nextTick();

  try {
    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 51n,
      LogID: 61n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-stop-wait-1' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: 'trace-stop-wait-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_stop_wait_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          message: {
            chat_id: 'oc_stop_wait_1',
            message_id: 'om_stop_wait_1',
            message_type: 'text',
            content: JSON.stringify({ text: '等待 stop drain' })
          }
        }
      }))
    }));
    await nextTick();

    let stopResolved = false;
    const stopPromise = client.stop().then(() => {
      stopResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopResolved, false);

    resolveProcessing();
    await stopPromise;
    assert.equal(stopResolved, true);
  } finally {
    resolveProcessing();
    await client.stop();
  }
});
test('long connection merges fragmented event payload before dispatching', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  const seen: Array<{
    threadId: string;
    text: string;
    messageId?: string;
    traceId?: string;
    frameSeq?: string;
    frameSum?: string;
  }> = [];
  let socket: MockWebSocket | undefined;

  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 3,
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
    },
    onTextMessage: async (message: {
      threadId: string;
      text: string;
      messageId?: string;
      senderOpenId?: string;
      traceId?: string;
      frameSeq?: string;
      frameSum?: string;
    }) => {
      seen.push(message);
    }
  });

  await client.start();
  await nextTick();

  try {
    const fullPayload = new TextEncoder().encode(JSON.stringify({
      schema: '2.0',
      header: {
        event_type: 'im.message.receive_v1'
      },
      event: {
        message: {
          chat_id: 'oc_456',
          message_type: 'text',
          content: JSON.stringify({ text: '输入:继续下一步' })
        }
      }
    }));
    const splitAt = Math.floor(fullPayload.length / 2);
    const partA = fullPayload.slice(0, splitAt);
    const partB = fullPayload.slice(splitAt);

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 3n,
      LogID: 4n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-2' },
        { key: 'sum', value: '2' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: 'trace-2' }
      ],
      payload: partA
    }));
    await nextTick();
    assert.equal(seen.length, 0);

    socket?.emitMessage(encodeFeishuFrame({
      SeqID: 3n,
      LogID: 4n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-2' },
        { key: 'sum', value: '2' },
        { key: 'seq', value: '1' },
        { key: 'trace_id', value: 'trace-2' }
      ],
      payload: partB
    }));
    await nextTick();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.threadId, 'feishu:chat:oc_456');
    assert.equal(seen[0]?.text, '输入:继续下一步');
    assert.equal(seen[0]?.messageId, undefined);
    assert.equal(seen[0]?.traceId, 'trace-2');
    assert.equal((seen[0] as any)?.frameMessageId, 'msg-2');
    assert.equal(seen[0]?.frameSeq, '1');
    assert.equal(seen[0]?.frameSum, '2');
    assert.equal((seen[0] as any)?.messageType, 'text');
    assert.equal((seen[0] as any)?.chatId, 'oc_456');
  } finally {
    await client.stop();
  }
});

test('long connection reconnects after socket error', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };

  const sockets: MockWebSocket[] = [];
  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-1&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 1,
              ReconnectInterval: 0.001,
              ReconnectNonce: 0
            }
          }
        }),
        { status: 200 }
      ),
    createWebSocket: (url: string) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    onTextMessage: async () => undefined
  });

  await client.start();
  await nextTick();
  assert.equal(sockets.length, 1);

  sockets[0]?.emitError(new Error('boom'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets.length, 2);

  await client.stop();
});

test('long connection reuses the cached endpoint on first reconnect after socket error', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };

  const endpointUrls = [
    'wss://example.test/ws?device_id=device-1&service_id=321',
    'wss://example.test/ws?device_id=device-2&service_id=321'
  ];
  const sockets: MockWebSocket[] = [];
  let endpointFetches = 0;
  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> => {
      const nextUrl = endpointUrls[Math.min(endpointFetches, endpointUrls.length - 1)];
      endpointFetches += 1;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: nextUrl,
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 1,
              ReconnectInterval: 0.001,
              ReconnectNonce: 0
            }
          }
        }),
        { status: 200 }
      );
    },
    createWebSocket: (url: string) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    onTextMessage: async () => undefined
  });

  try {
    await client.start();
    await nextTick();
    assert.equal(endpointFetches, 1);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]?.url, endpointUrls[0]);

    sockets[0]?.emitError(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sockets.length, 2);
    assert.equal(endpointFetches, 1);
    assert.equal(sockets[1]?.url, endpointUrls[0]);
  } finally {
    await client.stop();
  }
});

test('long connection refreshes the endpoint after a cached reconnect fails to open', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };

  const endpointUrls = [
    'wss://example.test/ws?device_id=device-1&service_id=321',
    'wss://example.test/ws?device_id=device-2&service_id=321'
  ];
  const sockets: Array<MockWebSocket | FailingOpenWebSocket> = [];
  let endpointFetches = 0;
  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> => {
      const nextUrl = endpointUrls[Math.min(endpointFetches, endpointUrls.length - 1)];
      endpointFetches += 1;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: nextUrl,
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 2,
              ReconnectInterval: 0.001,
              ReconnectNonce: 0
            }
          }
        }),
        { status: 200 }
      );
    },
    createWebSocket: (url: string) => {
      const socket =
        sockets.length === 1
          ? new FailingOpenWebSocket(url)
          : new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    onTextMessage: async () => undefined
  });

  try {
    await client.start();
    await nextTick();
    assert.equal(endpointFetches, 1);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]?.url, endpointUrls[0]);

    (sockets[0] as MockWebSocket).emitError(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(sockets.length, 3);
    assert.equal(sockets[1]?.url, endpointUrls[0]);
    assert.equal(sockets[2]?.url, endpointUrls[1]);
    assert.equal(endpointFetches, 2);
  } finally {
    await client.stop();
  }
});

test('long connection refreshes the endpoint after repeated cached reconnects close before receiving frames', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };

  const endpointUrls = [
    'wss://example.test/ws?device_id=device-1&service_id=321',
    'wss://example.test/ws?device_id=device-2&service_id=321'
  ];
  const sockets: MockWebSocket[] = [];
  let endpointFetches = 0;
  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl: async (): Promise<Response> => {
      const nextUrl = endpointUrls[Math.min(endpointFetches, endpointUrls.length - 1)];
      endpointFetches += 1;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: nextUrl,
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 4,
              ReconnectInterval: 0.001,
              ReconnectNonce: 0
            }
          }
        }),
        { status: 200 }
      );
    },
    createWebSocket: (url: string) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    onTextMessage: async () => undefined
  });

  try {
    await client.start();
    await nextTick();
    assert.equal(endpointFetches, 1);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]?.url, endpointUrls[0]);

    sockets[0]?.emitError(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1]?.url, endpointUrls[0]);
    assert.equal(endpointFetches, 1);

    sockets[1]?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets.length, 3);
    assert.equal(sockets[2]?.url, endpointUrls[0]);
    assert.equal(endpointFetches, 1);

    sockets[2]?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets.length, 4);
    assert.equal(sockets[3]?.url, endpointUrls[1]);
    assert.equal(endpointFetches, 2);
  } finally {
    await client.stop();
  }
});

test('long connection acks 500 when fragment count exceeds limit', async () => {
  const { createFeishuLongConnectionClient } = require('../../src/communicate/channel/feishu-longconn') as {
    createFeishuLongConnectionClient: (input: Record<string, any>) => { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const { decodeFeishuFrame, encodeFeishuFrame } = require('../../src/communicate/channel/feishu-frame') as {
    decodeFeishuFrame: (buffer: Uint8Array) => Record<string, any>;
    encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
  };

  let socket: MockWebSocket | undefined;
  const client = createFeishuLongConnectionClient({
    appId: 'app-id',
    appSecret: 'app-secret',
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
    },
    onTextMessage: async () => undefined
  });

  await client.start();
  await nextTick();

  socket?.emitMessage(encodeFeishuFrame({
    SeqID: 9n,
    LogID: 10n,
    service: 321,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg-3' },
      { key: 'sum', value: '9999' },
      { key: 'seq', value: '0' },
      { key: 'trace_id', value: 'trace-3' }
    ],
    payload: new TextEncoder().encode('{}')
  }));
  await nextTick();

  const ackFrame = socket?.sent
    .map((buffer) => decodeFeishuFrame(buffer))
    .find((frame) => (frame.headers ?? []).some((header: { key: string; value: string }) => header.key === 'message_id' && header.value === 'msg-3'));
  assert.ok(ackFrame, 'expected ack frame for invalid fragments');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(ackFrame.payload)), { code: 500 });

  await client.stop();
});

test('feishu runtime exposes long connection runtime', () => {
  const { createFeishuLongConnectionRuntime } = require('../../src/communicate/channel/feishu-runtime') as {
    createFeishuLongConnectionRuntime: () => unknown;
  };
  assert.equal(typeof createFeishuLongConnectionRuntime, 'function');
});

test('feishu runtime disables structured fallback when app-server sessions are explicitly turned off', () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const { codexSessionCalls, appSessionCalls } = captureStructuredFallbackDisabledCalls(runtimeModulePath, {
    stubLongconnClient: true
  });

  assert.equal(codexSessionCalls.length, 2);
  assert.equal(codexSessionCalls[0]?.structuredFallback, 'disabled');
  assert.equal(codexSessionCalls[1]?.structuredFallback, 'disabled');
  assert.equal(appSessionCalls.length, 0);
});

test('feishu long connection runtime disables structured fallback when app-server sessions are explicitly turned off', () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const { codexSessionCalls, appSessionCalls } = captureStructuredFallbackDisabledCalls(runtimeModulePath);

  assert.equal(codexSessionCalls.length, 2);
  assert.equal(codexSessionCalls[0]?.structuredFallback, 'disabled');
  assert.equal(codexSessionCalls[1]?.structuredFallback, 'disabled');
  assert.equal(appSessionCalls.length, 0);
});

test('feishu runtime forwards allowKnownBadCodexVersion to text fallback sessions when app-server sessions are disabled', () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const { codexSessionCalls, appSessionCalls } = captureKnownBadVersionOverrideCalls(runtimeModulePath, {
    stubLongconnClient: true,
    assistantAppServerEnabled: false,
    codingAppServerEnabled: false
  });

  assert.equal(codexSessionCalls.length, 3);
  assert.equal(codexSessionCalls[0]?.allowKnownBadCodexVersion, true);
  assert.equal(codexSessionCalls[1]?.allowKnownBadCodexVersion, true);
  assert.equal(codexSessionCalls[2]?.allowKnownBadCodexVersion, true);
  assert.equal(appSessionCalls.length, 0);
});

test('feishu long connection runtime forwards allowKnownBadCodexVersion to app sessions when app-server sessions stay enabled', () => {
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-longconn.js');
  const { codexSessionCalls, appSessionCalls } = captureKnownBadVersionOverrideCalls(runtimeModulePath);

  assert.equal(codexSessionCalls.length, 1);
  assert.equal(codexSessionCalls[0]?.allowKnownBadCodexVersion, true);
  assert.equal(appSessionCalls.length, 2);
  assert.equal(appSessionCalls[0]?.allowKnownBadCodexVersion, true);
  assert.equal(appSessionCalls[1]?.allowKnownBadCodexVersion, true);
});

test('default long connection lease path is normalized by app id instead of registry location', () => {
  const { resolveFeishuLongConnectionLeaseDir } = require('../../src/communicate/channel/feishu-longconn') as {
    resolveFeishuLongConnectionLeaseDir: (input?: unknown) => string;
  };
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-lease-path-'));
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalLocalAppDataEnv = process.env.LOCALAPPDATA;

  try {
    process.env.LOCALAPPDATA = path.join(rootDir, 'local-app-data');
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = path.join(rootDir, 'worktree-a', 'registry.json');
    const firstPath = resolveFeishuLongConnectionLeaseDir({ appId: 'cli_unit_test_app' } as unknown);

    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = path.join(rootDir, 'worktree-b', 'registry.json');
    const secondPath = resolveFeishuLongConnectionLeaseDir({ appId: 'cli_unit_test_app' } as unknown);
    const otherAppPath = resolveFeishuLongConnectionLeaseDir({ appId: 'cli_unit_test_other_app' } as unknown);

    assert.equal(firstPath, secondPath);
    assert.notEqual(firstPath, otherAppPath);
  } finally {
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    if (originalLocalAppDataEnv === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppDataEnv;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('lease release keeps the owner snapshot but removes the active heartbeat marker', () => {
  const { acquireFeishuLongConnectionLease } = require('../../src/communicate/channel/feishu-longconn') as {
    acquireFeishuLongConnectionLease: (input: Record<string, unknown>) => { getState: () => { owner: { ownerId: string } }; release: () => void };
  };
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-lease-release-race-'));
  const leaseDir = path.join(rootDir, 'lease');
  const ownerFilePath = path.join(leaseDir, 'owner.json');
  const firstLease = acquireFeishuLongConnectionLease({
    dirPath: leaseDir,
    instanceTag: 'owner-one'
  });
  const ownerId = firstLease.getState().owner.ownerId;
  const heartbeatFilePath = path.join(leaseDir, `heartbeat.${ownerId}.json`);

  try {
    assert.equal(existsSync(ownerFilePath), true);
    assert.equal(existsSync(heartbeatFilePath), true);
    firstLease.release();
    assert.equal(existsSync(ownerFilePath), true);
    assert.equal(existsSync(heartbeatFilePath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('lease heartbeat updates an owner-specific file without rewriting the shared owner snapshot', async () => {
  const { acquireFeishuLongConnectionLease } = require('../../src/communicate/channel/feishu-longconn') as {
    acquireFeishuLongConnectionLease: (input: Record<string, unknown>) => { getState: () => { owner: { ownerId: string } }; release: () => void };
  };
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-lease-heartbeat-race-'));
  const leaseDir = path.join(rootDir, 'lease');
  const ownerFilePath = path.join(leaseDir, 'owner.json');
  const firstLease = acquireFeishuLongConnectionLease({
    dirPath: leaseDir,
    instanceTag: 'owner-one',
    heartbeatIntervalMs: 10
  });
  const ownerId = firstLease.getState().owner.ownerId;
  const heartbeatFilePath = path.join(leaseDir, `heartbeat.${ownerId}.json`);
  const initialOwnerSnapshot = readFileSync(ownerFilePath, 'utf8');

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(readFileSync(ownerFilePath, 'utf8'), initialOwnerSnapshot);
    assert.equal(existsSync(heartbeatFilePath), true);
  } finally {
    firstLease.release();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime start syncs startup launcher card to last active thread', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let socket: MockWebSocket | undefined;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 1,
        sessions: {},
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: ['D:\\Workspace\\CodexLark'],
        lastActiveFeishuThreadId: 'feishu:chat:oc_startup'
      }),
      'utf8'
    );
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };

    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const href = String(url);
        fetchCalls.push({ url: href, init });
        if (href.includes('/tenant_access_token/internal')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
        }
        if (href.includes('/callback/ws/endpoint')) {
          return new Response(
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
          );
        }
        if (href.includes('/open-apis/im/v1/messages?receive_id_type=chat_id')) {
          return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_card_startup_1' } }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${href}`);
      },
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    const cardCall = fetchCalls.find((call) => call.url.includes('/open-apis/im/v1/messages?receive_id_type=chat_id'));
    assert.ok(cardCall, 'expected runtime startup to send launcher card');
    const cardBody = JSON.parse(String(cardCall?.init?.body ?? '{}'));
    assert.equal(cardBody.receive_id, 'oc_startup');
    assert.equal(cardBody.msg_type, 'interactive');
    assert.match(String(cardBody.content ?? ''), /启动 Codex 编程窗口/);
    socket = undefined;
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    if (socket) {
      socket.close();
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime rejects a second long connection instance before it opens a websocket', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-lease-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalInstanceTagEnv = process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
  let firstSocket: MockWebSocket | undefined;
  let firstRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let secondRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 1,
        sessions: {},
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: []
      }),
      'utf8'
    );
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = 'lease-runtime-test';
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };

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
        firstSocket = new MockWebSocket(url);
        return firstSocket;
      }
    });

    let secondFetchCalls = 0;
    let secondSocketCreates = 0;
    secondRuntime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> => {
        secondFetchCalls += 1;
        throw new Error('unexpected second fetch');
      },
      createWebSocket: (_url: string) => {
        secondSocketCreates += 1;
        return new MockWebSocket('wss://unexpected.test/ws');
      }
    });

    await firstRuntime.start();
    await nextTick();

    await assert.rejects(
      async () => secondRuntime?.start(),
      /lease|already held|already owned|PID/i
    );
    assert.equal(secondFetchCalls, 0);
    assert.equal(secondSocketCreates, 0);
  } finally {
    if (secondRuntime) {
      await secondRuntime.stop();
    }
    if (firstRuntime) {
      await firstRuntime.stop();
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    if (originalInstanceTagEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
    } else {
      process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = originalInstanceTagEnv;
    }
    if (firstSocket) {
      firstSocket.close();
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime can start a replacement instance after the previous long connection releases its lease', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-lease-release-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalInstanceTagEnv = process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
  let firstSocket: MockWebSocket | undefined;
  let secondSocket: MockWebSocket | undefined;
  let firstRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let secondRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 1,
        sessions: {},
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: []
      }),
      'utf8'
    );
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = 'lease-runtime-release-test';
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };

    const buildFetch = async (): Promise<Response> =>
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
      );

    firstRuntime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: buildFetch,
      createWebSocket: (url: string) => {
        firstSocket = new MockWebSocket(url);
        return firstSocket;
      }
    });

    let secondFetchCalls = 0;
    secondRuntime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (): Promise<Response> => {
        secondFetchCalls += 1;
        return buildFetch();
      },
      createWebSocket: (url: string) => {
        secondSocket = new MockWebSocket(url);
        return secondSocket;
      }
    });

    await firstRuntime.start();
    await nextTick();
    await firstRuntime.stop();
    firstRuntime = undefined;
    await nextTick();

    await secondRuntime.start();
    await nextTick();

    assert.equal(secondFetchCalls, 1);
    assert.equal(secondSocket?.url, 'wss://example.test/ws?device_id=device-1&service_id=321');
  } finally {
    if (secondRuntime) {
      await secondRuntime.stop();
    }
    if (firstRuntime) {
      await firstRuntime.stop();
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    if (originalInstanceTagEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
    } else {
      process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = originalInstanceTagEnv;
    }
    if (firstSocket) {
      firstSocket.close();
    }
    if (secondSocket) {
      secondSocket.close();
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime keeps lease until in-flight handlers drain during stop', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-stop-drain-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const serviceModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-service.js');
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const originalInstanceTagEnv = process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
  const serviceModule = require(serviceModulePath) as {
    createFeishuService: (...args: Array<any>) => Record<string, unknown>;
  };
  const originalCreateFeishuService = serviceModule.createFeishuService;
  let firstSocket: MockWebSocket | undefined;
  let secondSocket: MockWebSocket | undefined;
  let firstRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let secondRuntime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
  let resolveProcessing!: () => void;
  const processing = new Promise<void>((resolve) => {
    resolveProcessing = resolve;
  });

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 1,
        sessions: {},
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: []
      }),
      'utf8'
    );
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = 'lease-runtime-stop-drain-test';
    serviceModule.createFeishuService = () => ({
      handleInboundImage: async () => undefined,
      handleInboundMessage: async () => {
        await processing;
      },
      handleCardAction: async () => undefined,
      handleWorkerEvent: async () => undefined,
      syncStartupCardForLastActiveThread: async () => undefined,
      rememberInboundDeliveryTarget: () => undefined
    });
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    const buildFetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            URL: 'wss://example.test/ws?device_id=device-stop-drain&service_id=321',
            ClientConfig: {
              PingInterval: 30,
              ReconnectCount: 0,
              ReconnectInterval: 5,
              ReconnectNonce: 0
            }
          }
        }),
        { status: 200 }
      );

    firstRuntime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: buildFetch,
      createWebSocket: (url: string) => {
        firstSocket = new MockWebSocket(url);
        return firstSocket;
      }
    });

    secondRuntime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: buildFetch,
      createWebSocket: (url: string) => {
        secondSocket = new MockWebSocket(url);
        return secondSocket;
      }
    });

    await firstRuntime.start();
    await nextTick();

    firstSocket?.emitMessage(encodeFeishuFrame({
      SeqID: 71n,
      LogID: 81n,
      service: 321,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-stop-drain-1' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: 'trace-stop-drain-1' }
      ],
      payload: new TextEncoder().encode(JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'evt_stop_drain_1',
          event_type: 'im.message.receive_v1'
        },
        event: {
          sender: {
            sender_id: {
              open_id: 'ou_stop_drain_1'
            }
          },
          message: {
            chat_id: 'oc_stop_drain_1',
            message_id: 'om_stop_drain_1',
            message_type: 'text',
            create_time: '1710000000',
            content: JSON.stringify({ text: 'stop drain' })
          }
        }
      }))
    }));
    await nextTick();

    let firstStopResolved = false;
    const firstStopPromise = firstRuntime.stop().then(() => {
      firstStopResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(firstStopResolved, false);

    await assert.rejects(
      async () => secondRuntime?.start(),
      /lease|already held|already owned|PID/i
    );

    resolveProcessing();
    await firstStopPromise;
    firstRuntime = undefined;

    await secondRuntime.start();
    await nextTick();
    assert.equal(secondSocket?.url, 'wss://example.test/ws?device_id=device-stop-drain&service_id=321');
  } finally {
    resolveProcessing();
    if (secondRuntime) {
      await secondRuntime.stop();
    }
    if (firstRuntime) {
      await firstRuntime.stop();
    }
    serviceModule.createFeishuService = originalCreateFeishuService;
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    if (originalInstanceTagEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_INSTANCE_TAG;
    } else {
      process.env.COMMUNICATE_FEISHU_INSTANCE_TAG = originalInstanceTagEnv;
    }
    if (firstSocket) {
      firstSocket.close();
    }
    if (secondSocket) {
      secondSocket.close();
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('runtime dispatches card actions to the Feishu service', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-feishu-runtime-card-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const runtimeModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-runtime.js');
  const sessionRegistryModulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const frameModulePath = path.resolve(__dirname, '../../src/communicate/channel/feishu-frame.js');
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let socket: MockWebSocket | undefined;
  let runtime: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 1,
        sessions: {},
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: ['D:\\Workspace\\CodexLark', 'D:\\Workspace\\Alpha'],
        lastActiveFeishuThreadId: 'feishu:chat:oc_startup'
      }),
      'utf8'
    );
    process.env.COMMUNICATE_SESSION_REGISTRY_PATH = registryPath;
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];
    delete require.cache[require.resolve(frameModulePath)];

    const { createFeishuLongConnectionRuntime } = require(runtimeModulePath) as {
      createFeishuLongConnectionRuntime: (input: Record<string, unknown>) => { start: () => Promise<void>; stop: () => Promise<void> };
    };
    const { encodeFeishuFrame } = require(frameModulePath) as {
      encodeFeishuFrame: (frame: Record<string, unknown>) => Uint8Array;
    };

    runtime = createFeishuLongConnectionRuntime({
      appId: 'app-id',
      appSecret: 'app-secret',
      codexCommand: ['codex'],
      lease: { dirPath: path.join(rootDir, 'feishu-longconn.lease') },
      fetchImpl: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const href = String(url);
        fetchCalls.push({ url: href, init });
        if (href.includes('/tenant_access_token/internal')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }), { status: 200 });
        }
        if (href.includes('/callback/ws/endpoint')) {
          return new Response(
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
          );
        }
        if (href.includes('/open-apis/im/v1/messages?receive_id_type=chat_id')) {
          return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_card_startup_1' } }), { status: 200 });
        }
        if (href.includes('/open-apis/im/v1/messages/om_card_startup_1')) {
          return new Response(JSON.stringify({ code: 0 }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${href}`);
      },
      createWebSocket: (url: string) => {
        socket = new MockWebSocket(url);
        return socket;
      }
    });

    await runtime.start();
    await nextTick();

    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          context: { open_chat_id: 'oc_startup', open_message_id: 'open_message_launcher_1' },
          action: { value: { kind: 'select_recent_cwd', cwd: 'D:\\Workspace\\Alpha' } }
        }
      })
    );

    socket?.emitMessage(
      encodeFeishuFrame({
        SeqID: 11n,
        LogID: 12n,
        service: 321,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg-card-runtime-1' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload
      })
    );
    await nextTick();
    await nextTick();

    const persisted = JSON.parse(String(require('node:fs').readFileSync(registryPath, 'utf8')));
    assert.equal(
      persisted.threadUiStates?.['feishu:chat:oc_startup']?.launcherSelectedCwd,
      'D:\\Workspace\\Alpha'
    );

    const patchCall = fetchCalls.find((call) => call.url.includes('/open-apis/im/v1/messages/om_card_startup_1'));
    assert.ok(patchCall, 'expected card action to trigger a status card update');
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    delete require.cache[require.resolve(runtimeModulePath)];
    delete require.cache[require.resolve(sessionRegistryModulePath)];
    delete require.cache[require.resolve(frameModulePath)];
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    if (socket) {
      socket.close();
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});








