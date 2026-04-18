import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFeishuService } from '../../src/communicate/channel/feishu-service';

const EXISTING_PROJECT_CWD = process.cwd();
const EXISTING_PROJECT_CWD_REGEX = literalRegex(EXISTING_PROJECT_CWD);
const EXISTING_PROJECT_CWD_JSON_REGEX = literalRegex(EXISTING_PROJECT_CWD.replace(/\\/g, '\\\\'));
const DEFAULT_ASSISTANT_CWD = EXISTING_PROJECT_CWD;

function literalRegex(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function collectCardButtons(node: unknown): Array<Record<string, any>> {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const nested = Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((item) => collectCardButtons(item));
    return collectCardButtons(value);
  });
  return record.tag === 'button' ? [record as Record<string, any>, ...nested] : nested;
}

function collectCardNodesByTag(node: unknown, tag: string): Array<Record<string, unknown>> {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const nested = Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((item) => collectCardNodesByTag(item, tag));
    return collectCardNodesByTag(value, tag);
  });
  return record.tag === tag ? [record, ...nested] : nested;
}

function collectCardTextContents(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const ownTexts = ['content', 'default_value', 'name']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string');
  const nested = Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((item) => collectCardTextContents(item));
    return collectCardTextContents(value);
  });
  return [...ownTexts, ...nested];
}

function createMockSession(initial?: Partial<{
  lifecycle: string;
  liveBuffer: string;
  checkpointOutput: string;
  waitKind: string;
  waitOptions: string[];
  activeTurnId: string;
  sessionInstanceId: string;
  logPath: string;
  codexThreadId: string;
  model: string;
  interruptedByRestart: boolean;
  runtimeWarnings: Array<Record<string, unknown>>;
  lastProgressAt: string;
  activeCommand: boolean;
  activeCommandCommand: string;
  activeCommandStartedAt: string;
  lastCommandProgressAt: string;
  replyLifecycle: string;
  interruptImpl: () => Promise<{ interrupted: boolean; turnId?: string | null }> | { interrupted: boolean; turnId?: string | null };
}>) {
  const snapshot = {
    taskId: 'T1',
    lifecycle: 'STARTING',
    liveBuffer: '',
    checkpointOutput: '',
    sessionInstanceId: 'session-1',
    waitKind: undefined,
    waitOptions: undefined,
    activeTurnId: undefined,
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
    codexThreadId: 'codex-thread-1',
    model: undefined,
    interruptedByRestart: false,
    runtimeWarnings: undefined,
    lastProgressAt: undefined,
    activeCommand: false,
    activeCommandCommand: undefined,
    activeCommandStartedAt: undefined,
    lastCommandProgressAt: undefined,
    ...initial
  };

  return {
    started: false,
    closed: false,
    closeCalls: 0,
    interruptCalls: 0,
    stallDiagnostics: [] as Array<Record<string, unknown>>,
    replies: [] as Array<Record<string, unknown>>,
    start() {
      this.started = true;
    },
    sendReply(reply: Record<string, unknown>) {
      this.replies.push(reply);
      snapshot.lifecycle = initial?.replyLifecycle ?? 'RUNNING_TURN';
      snapshot.checkpointOutput = '';
      snapshot.waitKind = undefined;
      snapshot.waitOptions = undefined;
    },
    async interruptCurrentTurn() {
      this.interruptCalls += 1;
      if (typeof initial?.interruptImpl === 'function') {
        return await initial.interruptImpl();
      }
      snapshot.lifecycle = 'IDLE';
      snapshot.liveBuffer = '';
      snapshot.checkpointOutput = '当前运行已打断，等待下一步指令。';
      snapshot.activeCommand = false;
      snapshot.activeCommandCommand = undefined;
      snapshot.activeCommandStartedAt = undefined;
      snapshot.lastCommandProgressAt = undefined;
      return { interrupted: true, turnId: 'turn-1' };
    },
    async close() {
      this.closed = true;
      this.closeCalls += 1;
      snapshot.lifecycle = 'CLOSED';
      return { forced: false };
    },
    getSnapshot() {
      return {
        taskId: snapshot.taskId,
        lifecycle: snapshot.lifecycle,
        liveBuffer: snapshot.liveBuffer,
        checkpointOutput: snapshot.checkpointOutput,
        waitKind: snapshot.waitKind,
        waitOptions: snapshot.waitOptions,
        activeTurnId: snapshot.activeTurnId,
        sessionInstanceId: snapshot.sessionInstanceId,
        logPath: snapshot.logPath,
        codexThreadId: snapshot.codexThreadId,
        model: snapshot.model,
        interruptedByRestart: snapshot.interruptedByRestart,
        runtimeWarnings: snapshot.runtimeWarnings ? [...snapshot.runtimeWarnings] : undefined,
        lastProgressAt: snapshot.lastProgressAt,
        activeCommand: snapshot.activeCommand,
        activeCommandCommand: snapshot.activeCommandCommand,
        activeCommandStartedAt: snapshot.activeCommandStartedAt,
        lastCommandProgressAt: snapshot.lastCommandProgressAt
      };
    },
    getLogPath() {
      return snapshot.logPath;
    },
    recordStallDiagnostic(input: Record<string, unknown>) {
      this.stallDiagnostics.push(input);
    },
    setSnapshot(next: Partial<typeof snapshot>) {
      Object.assign(snapshot, next);
    }
  };
}

function createMockRegistry(initial?: {
  nextTaskId?: number;
  records?: Array<Record<string, unknown>>;
  threadBindings?: Array<Record<string, unknown>>;
  threadUiStates?: Array<Record<string, unknown>>;
  recentProjectDirs?: string[];
  lastActiveFeishuThreadId?: string;
  lastActiveFeishuUserOpenId?: string;
}) {
  let nextTaskId = initial?.nextTaskId ?? 1;
  let lastActiveFeishuThreadId = initial?.lastActiveFeishuThreadId;
  let lastActiveFeishuUserOpenId = initial?.lastActiveFeishuUserOpenId;
  let recentProjectDirs = [...(initial?.recentProjectDirs ?? [])];
  const sessions = new Map<string, Record<string, unknown>>();
  const threadBindings = new Map<string, Record<string, unknown>>();
  const threadUiStates = new Map<string, Record<string, unknown>>();
  const reserveCalls: string[] = [];
  const upsertCalls: Array<Record<string, unknown>> = [];
  const markClosedCalls: Array<{ taskId: string; patch?: Record<string, unknown> }> = [];
  const deleteSessionRecordCalls: string[] = [];
  const upsertThreadBindingCalls: Array<Record<string, unknown>> = [];
  const clearThreadBindingCalls: string[] = [];
  const upsertThreadUiStateCalls: Array<Record<string, unknown>> = [];
  const clearThreadUiStateCalls: string[] = [];

  for (const record of initial?.records ?? []) {
    sessions.set(String(record.taskId), { ...record });
  }
  for (const record of initial?.threadBindings ?? []) {
    threadBindings.set(String(record.feishuThreadId), { ...record });
  }
  for (const record of initial?.threadUiStates ?? []) {
    threadUiStates.set(String(record.feishuThreadId), { ...record });
  }

  return {
    reserveCalls,
    upsertCalls,
    markClosedCalls,
    deleteSessionRecordCalls,
    upsertThreadBindingCalls,
    clearThreadBindingCalls,
    upsertThreadUiStateCalls,
    clearThreadUiStateCalls,
    load() {
      return {
        nextTaskId,
        sessions: Object.fromEntries(Array.from(sessions.entries()).map(([taskId, record]) => [taskId, { ...record }])),
        threadBindings: Object.fromEntries(
          Array.from(threadBindings.entries()).map(([threadId, record]) => [threadId, { ...record }])
        ),
        threadUiStates: Object.fromEntries(
          Array.from(threadUiStates.entries()).map(([threadId, record]) => [threadId, { ...record }])
        ),
        inboundMessages: {},
        recentProjectDirs: [...recentProjectDirs],
        lastActiveFeishuThreadId,
        lastActiveFeishuUserOpenId
      };
    },
    getLastActiveFeishuThreadId() {
      return lastActiveFeishuThreadId;
    },
    setLastActiveFeishuThreadId(feishuThreadId: string) {
      lastActiveFeishuThreadId = feishuThreadId;
    },
    getLastActiveFeishuUserOpenId() {
      return lastActiveFeishuUserOpenId;
    },
    setLastActiveFeishuUserOpenId(openId: string) {
      lastActiveFeishuUserOpenId = openId;
    },
    getRecentProjectDirs() {
      return [...recentProjectDirs];
    },
    replaceRecentProjectDirs(dirs: string[]) {
      recentProjectDirs = [...dirs];
      return [...recentProjectDirs];
    },
    recomputeNextTaskId() {
      nextTaskId = Array.from(sessions.keys()).reduce((highest, taskId) => {
        const ordinal = Number.parseInt(taskId.slice(1), 10);
        return Number.isInteger(ordinal) && ordinal > highest ? ordinal : highest;
      }, 0) + 1;
      return nextTaskId;
    },
    reserveNextTaskId() {
      const taskId = `T${nextTaskId++}`;
      reserveCalls.push(taskId);
      return taskId;
    },
    upsertSessionRecord(record: Record<string, unknown>) {
      upsertCalls.push({ ...record });
      const taskId = String(record.taskId);
      const updated = {
        ...(sessions.get(taskId) ?? {}),
        ...record
      };
      sessions.set(taskId, updated);
      return { ...updated };
    },
    markClosed(taskId: string, patch?: Record<string, unknown>) {
      markClosedCalls.push({ taskId, patch });
      const updated = {
        ...(sessions.get(taskId) ?? { taskId }),
        ...(patch ?? {}),
        taskId,
        sessionLifecycle: 'CLOSED'
      };
      sessions.set(taskId, updated);
      return { ...updated };
    },
    getSessionRecord(taskId: string) {
      const record = sessions.get(taskId);
      return record ? { ...record } : undefined;
    },
    listSessionRecords() {
      return Array.from(sessions.values()).map((record) => ({ ...record }));
    },
    deleteSessionRecord(taskId: string) {
      deleteSessionRecordCalls.push(taskId);
      const existing = sessions.get(taskId);
      sessions.delete(taskId);
      return existing ? { ...existing } : undefined;
    },
    upsertThreadBinding(record: Record<string, unknown>) {
      upsertThreadBindingCalls.push({ ...record });
      const threadId = String(record.feishuThreadId);
      const updated = {
        ...(threadBindings.get(threadId) ?? {}),
        ...record
      };
      threadBindings.set(threadId, updated);
      return { ...updated };
    },
    getThreadBinding(feishuThreadId: string) {
      const record = threadBindings.get(feishuThreadId);
      return record ? { ...record } : undefined;
    },
    clearThreadBinding(feishuThreadId: string) {
      clearThreadBindingCalls.push(feishuThreadId);
      threadBindings.delete(feishuThreadId);
    },
    upsertThreadUiState(record: Record<string, unknown>) {
      upsertThreadUiStateCalls.push({ ...record });
      const threadId = String(record.feishuThreadId);
      const updated = {
        ...(threadUiStates.get(threadId) ?? {}),
        ...record,
        feishuThreadId: threadId
      };
      threadUiStates.set(threadId, updated);
      return { ...updated };
    },
    getThreadUiState(feishuThreadId: string) {
      const record = threadUiStates.get(feishuThreadId);
      return record ? { ...record } : undefined;
    },
    clearThreadUiState(feishuThreadId: string) {
      clearThreadUiStateCalls.push(feishuThreadId);
      threadUiStates.delete(feishuThreadId);
    }
  };
}

function createTempLogFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'codexlark-feishu-service-'));
  return {
    writeLog(taskId: string, content: string) {
      const logPath = path.join(rootDir, `${taskId}.log`);
      writeFileSync(logPath, content, 'utf8');
      return logPath;
    },
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockIntervalScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void | Promise<void>>();
  const intervals = new Map<number, number>();

  async function tick(handle: number): Promise<void> {
    const callback = callbacks.get(handle);
    if (!callback) return;
    await callback();
  }

  return {
    scheduler: {
      setInterval(callback: () => void, intervalMs: number) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        intervals.set(handle, intervalMs);
        return handle;
      },
      clearInterval(handle: unknown) {
        const normalized = Number(handle);
        callbacks.delete(normalized);
        intervals.delete(normalized);
      }
    },
    activeCount() {
      return callbacks.size;
    },
    getActiveIntervals() {
      return Array.from(intervals.values());
    },
    async tickAll(): Promise<void> {
      for (const handle of Array.from(callbacks.keys())) {
        await tick(handle);
      }
    }
  };
}

function createTestService(options: {
  sent: string[];
  session?: ReturnType<typeof createMockSession>;
  sessionFactory?: (sessionOptions: Record<string, unknown>) => ReturnType<typeof createMockSession>;
  assistantSessionFactory?: (sessionOptions: Record<string, unknown>) => ReturnType<typeof createMockSession>;
  codingSessionFactory?: (sessionOptions: Record<string, unknown>) => ReturnType<typeof createMockSession>;
  createServiceImpl?: typeof createFeishuService;
  sendTextImpl?: (threadId: string, text: string) => Promise<void> | void;
  sendCardImpl?: (threadId: string, card: Record<string, unknown>) => Promise<string> | string;
  sendCardToRecipientImpl?: (input: {
    receiveId: string;
    receiveIdType: string;
    card: Record<string, unknown>;
  }) => Promise<string> | string;
  updateCardImpl?: (messageId: string, card: Record<string, unknown>) => Promise<void> | void;
  registry?: ReturnType<typeof createMockRegistry>;
  polishRewrite?: (text: string) => Promise<string> | string;
  cliScanner?: () => Array<any>;
  cliProcess?: {
    list: () => Array<any>;
    kill: (processes: Array<any>) => { killed: number; failed: number; errors: string[] };
  };
  takeoverListLimit?: number;
  goalSummaryGenerator?: {
    summarize: (input: { sourceText: string }) => Promise<string | undefined>;
  };
  replyStatusScheduler?: {
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  replyStatusRefreshMs?: number;
  defaultModel?: string;
}) {
  const registry = options.registry ?? createMockRegistry({ nextTaskId: 1 });
  const fallbackSessionFactory =
    options.sessionFactory ??
    options.assistantSessionFactory ??
    options.codingSessionFactory ??
    ((sessionOptions: Record<string, unknown>) => options.session!);
  const createServiceImpl = options.createServiceImpl ?? createFeishuService;
  const service = createServiceImpl({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        if (options.sendTextImpl) {
          await options.sendTextImpl(_threadId, text);
          return;
        }
        options.sent.push(text);
      },
      sendCard: options.sendCardImpl
        ? async (threadId: string, card: Record<string, unknown>) => await options.sendCardImpl!(threadId, card)
        : undefined,
      sendCardToRecipient: options.sendCardToRecipientImpl
        ? async (input: { receiveId: string; receiveIdType: string; card: Record<string, unknown> }) =>
            await options.sendCardToRecipientImpl!(input)
        : undefined,
      updateCard: options.updateCardImpl
        ? async (messageId: string, card: Record<string, unknown>) => await options.updateCardImpl!(messageId, card)
        : undefined
    },
    sessionFactory: fallbackSessionFactory,
    assistantSessionFactory: options.assistantSessionFactory,
    codingSessionFactory: options.codingSessionFactory,
    polishRewrite: options.polishRewrite,
    cliScanner: options.cliScanner,
    cliProcess: options.cliProcess,
    sessionRegistry: registry,
    takeoverListLimit: options.takeoverListLimit,
    defaultModel: options.defaultModel,
    goalSummaryGenerator: options.goalSummaryGenerator,
    replyStatusScheduler: options.replyStatusScheduler,
    replyStatusRefreshMs: options.replyStatusRefreshMs
  } as any);
  return { service, registry };
}

test('assistant terminal delivery failure logs task and thread context before surfacing the error', async () => {
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const capturedErrors: string[] = [];
  const originalConsoleError = console.error;

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };
    const { service } = createTestService({
      sent: [],
      session,
      sendTextImpl: async () => {
        throw new Error('simulated sendText failure');
      }
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我分析这段代码' });

    await assert.rejects(
      service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'assistant final answer' }),
      /simulated sendText failure/
    );

    const failureLog = capturedErrors.find((line) => line.includes('[feishu-service] text delivery failed'));
    assert.ok(failureLog, `expected text delivery failure log, got: ${capturedErrors.join('\n')}`);
    assert.match(failureLog ?? '', /"threadId":"feishu:chat-1"/);
    assert.match(failureLog ?? '', /"assistantTaskId":"T1"/);
    assert.match(failureLog ?? '', /simulated sendText failure/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('assistant failed terminal delivery keeps the original task context even after rebinding a replacement session', async () => {
  const firstSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const replacementSession = createMockSession({ lifecycle: 'STARTING', codexThreadId: 'assistant-thread-2' });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const capturedErrors: string[] = [];
  const originalConsoleError = console.error;

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };
    const { service } = createTestService({
      sent: [],
      registry,
      sessionFactory: (sessionOptions) => (sessionOptions.taskId === 'T1' ? firstSession : replacementSession),
      sendTextImpl: async () => {
        throw new Error('simulated sendText failure');
      }
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续' });

    await assert.rejects(
      service.handleWorkerEvent({
        type: 'task_failed',
        taskId: 'T1',
        output: 'Error: no rollout found for thread id 019cdd30-06c2-7681-b855-8857c5769ba6'
      }),
      /simulated sendText failure/
    );

    const failureLog = capturedErrors.find((line) => line.includes('[feishu-service] text delivery failed'));
    assert.ok(failureLog, `expected text delivery failure log, got: ${capturedErrors.join('\n')}`);
    assert.match(failureLog ?? '', /"taskId":"T1"/);
    assert.match(failureLog ?? '', /"assistantTaskId":"T1"/);
    assert.match(failureLog ?? '', /"boundAssistantTaskId":"T2"/);
    assert.match(failureLog ?? '', /"threadId":"feishu:chat-1"/);
    assert.match(failureLog ?? '', /simulated sendText failure/);
    assert.equal(registry.getThreadBinding('feishu:chat-1')?.assistantTaskId, 'T2');
  } finally {
    console.error = originalConsoleError;
  }
});

test('start-task message creates a task and dispatches to the Codex session factory', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  assert.match(sent[0] || '', /^\[模式: 助手\]/);
  assert.equal(session.started, true);
  assert.match(sent[0] || '', /T1/);
  assert.equal(service.getTask('T1')?.taskType, 'codex_session');
  assert.equal(service.getTask('T1')?.logFilePath, 'D:\\Workspace\\Project\\logs\\communicate\\T1.log');
});

test('assistant uses assistant session factory when provided', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession();
  const codingSession = createMockSession();
  let assistantCalls = 0;
  let codingCalls = 0;
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => {
      assistantCalls += 1;
      return assistantSession;
    },
    codingSessionFactory: () => {
      codingCalls += 1;
      return codingSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '你好' });

  assert.equal(assistantCalls, 1);
  assert.equal(codingCalls, 0);
});

test('coding uses coding session factory when provided', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession();
  const codingSession = createMockSession();
  let assistantCalls = 0;
  let codingCalls = 0;
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => {
      assistantCalls += 1;
      return assistantSession;
    },
    codingSessionFactory: () => {
      codingCalls += 1;
      return codingSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  assert.equal(assistantCalls, 0);
  assert.equal(codingCalls, 1);
});

test('waiting-user worker event becomes a full-output delivery payload', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'choice',
    output: '1. Allow once\n2. Allow always\nSelect an option:',
    waitHint: '对 T1 选择第一个'
  });

  assert.match(sent[sent.length - 1] || '', /Allow once/);
  assert.match(sent[sent.length - 1] || '', /对 T1 选择第一个/);
});

test('reply message resumes the matching waiting task by task ID', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: 'Please input your response:',
    waitHint: '对 T1 输入: xxx'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续下一步' });

  assert.deepEqual(session.replies[0], { action: 'input_text', text: '继续下一步' });
  assert.match(sent[sent.length - 1] || '', /已恢复执行/);
});

test('reply message can queue a first input while the codex session is still starting', async () => {
  const sent: string[] = [];
  const session = createMockSession({ lifecycle: 'STARTING' });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 只回复已收到' });

  assert.deepEqual(session.replies[0], { action: 'input_text', text: '只回复已收到' });
  assert.match(sent[sent.length - 1] ?? '', /已接收输入|自动执行/);
});

test('reply message accepts input while the same session is still running', async () => {
  const sent: string[] = [];
  const session = createMockSession({ lifecycle: 'RUNNING_TURN', liveBuffer: 'still running' });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续下一步' });

  assert.deepEqual(session.replies[0], { action: 'input_text', text: '继续下一步' });
  assert.match(sent[sent.length - 1] ?? '', /正在运行/);
  assert.match(sent[sent.length - 1] ?? '', /消息已送达/);
});

test('query message returns formatted task status with log path', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'choice',
    output: '1. A\n2. B\nSelect an option:',
    waitHint: '对 T1 选择第一个'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 状态' });

  assert.match(sent[sent.length - 1] ?? '', /WAITING_USER/);
  assert.match(sent[sent.length - 1] ?? '', /T1/);
  assert.match(sent[sent.length - 1] ?? '', /T1\.log/);
});

test('query progress message returns only the last Codex reply body', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'choice',
    output: '1. A\n2. B\nSelect an option:',
    waitHint: '对 T1 选择第一个'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

  assert.match(sent[sent.length - 1] ?? '', /1\. A/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /WAITING_USER/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /对 T1 选择第一个/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /静默时长/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /T1\.log/);
});

test('query progress message does not surface stale live output while reusing the last Codex reply', async () => {
  const sent: string[] = [];
  const session = createMockSession({ lifecycle: 'WAITING_USER', liveBuffer: 'stale live buffer from prior turn' });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'choice',
    output: '1. A\n2. B\nSelect an option:',
    waitHint: '对 T1 选择第一个'
  });
  session.setSnapshot({
    lifecycle: 'WAITING_USER',
    liveBuffer: 'stale live buffer from prior turn'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

  assert.match(sent[sent.length - 1] ?? '', /1\. A/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /WAITING_USER/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /stale live buffer from prior turn/);
});

test('query message prefers the live session snapshot when task is still running', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'live codex output',
    checkpointOutput: 'stale checkpoint'
  });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 状态' });

  assert.match(sent[sent.length - 1] ?? '', /RUNNING_TURN/);
  assert.match(sent[sent.length - 1] ?? '', /live codex output/);
});

test('query progress message keeps only the last completed Codex reply while task is still running', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'live codex output',
    checkpointOutput: 'previous checkpoint'
  });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

  assert.match(sent[sent.length - 1] ?? '', /previous checkpoint/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /RUNNING_TURN/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /live codex output/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /T1\.log/);
});

test('query progress clears stale wait hint and keeps only the last completed Codex reply after resume', async () => {
  const sent: string[] = [];
  const session = createMockSession({ lifecycle: 'IDLE' });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'choice',
    output: '1. A\n2. B\nSelect an option:',
    waitHint: '对 T1 选择第一个'
  });
  session.setSnapshot({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: '继续执行中',
    checkpointOutput: ''
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 选择第一个' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

  assert.match(sent[sent.length - 1] ?? '', /1\. A/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /RUNNING_TURN/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /继续执行中/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /可直接回复 对 T1 选择第一个/);
});

test('query progress returns the dedicated placeholder before the first Codex reply exists', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '当前轮正在补测试',
      checkpointOutput: '',
      logPath: logs.writeLog('T1', 'log-only tail')
    });
    const { service } = createTestService({ sent, session });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

    assert.match(sent[sent.length - 1] ?? '', /暂无上一轮 Codex 回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /RUNNING_TURN/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮正在补测试/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /log-only tail/);
  } finally {
    logs.cleanup();
  }
});

test('query progress keeps the dedicated placeholder during startup before the first Codex reply exists', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'STARTING',
    liveBuffer: '启动阶段正在读取任务上下文',
    checkpointOutput: ''
  });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

  assert.match(sent[sent.length - 1] ?? '', /暂无上一轮 Codex 回复。/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /STARTING/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /启动阶段正在读取任务上下文/);
});

test('query progress ignores startup log tail before the first Codex reply exists', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const session = createMockSession({
      lifecycle: 'STARTING',
      liveBuffer: '',
      checkpointOutput: '',
      logPath: logs.writeLog('T1', 'starting log tail')
    });
    const { service } = createTestService({ sent, session });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

    assert.match(sent[sent.length - 1] ?? '', /暂无上一轮 Codex 回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /STARTING/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /starting log tail/);
  } finally {
    logs.cleanup();
  }
});

test('assistant task still uses diagnostic status formatting when querying progress text', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    liveBuffer: 'assistant live output',
    checkpointOutput: 'assistant checkpoint',
    codexThreadId: 'assistant-thread-1'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '请帮我复盘一下刚刚的实现风险' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 进展' });

  assert.match(sent[sent.length - 1] ?? '', /静默时长/);
  assert.match(sent[sent.length - 1] ?? '', /最近摘要/);
  assert.match(sent[sent.length - 1] ?? '', /配置 model 未设置 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /会话 sessionKind assistant · 恢复态 否 · 中断恢复 否/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
});

test('card action query_current_task sends only the last Codex reply body', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'live codex output',
    checkpointOutput: 'previous checkpoint'
  });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

  assert.match(sent[sent.length - 1] ?? '', /previous checkpoint/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /live codex output/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /RUNNING_TURN/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /静默时长/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /Codex Thread/);
});

test('card action query_current_task prunes a launcher-started empty coding task instead of surfacing startup buffer text', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'STARTING',
    liveBuffer: '启动阶段正在整理工作区',
    checkpointOutput: ''
  });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

  assert.equal(session.closed, true);
  assert.equal(service.getTask('T1'), undefined);
  assert.match(sent[sent.length - 1] ?? '', /当前没有可用的 Coding 任务，已保持助手模式。/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /启动阶段正在整理工作区/);
});

test('card action query_current_task prunes a launcher-created empty coding task before delivering progress', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'assistant',
        statusCardMode: 'launcher',
        statusCardMessageId: 'om_card_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'coding-thread-1'
  });
  const { service } = createTestService({ sent, registry, session });

  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    messageId: 'om_card_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

  assert.equal(session.closed, true);
  assert.equal(service.getTask('T1'), undefined);
  assert.deepEqual(registry.deleteSessionRecordCalls, ['T1']);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.match(sent.at(-1) ?? '', /当前没有可用的 Coding 任务，已保持助手模式。/);
  assert.doesNotMatch(sent.at(-1) ?? '', /上一轮输出/);
});

test('card action query_current_task falls back to the previous real coding task after pruning a newer empty one', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let calls = 0;
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => {
      calls += 1;
      return calls === 1 ? codingSessionA : codingSessionB;
    },
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: `帮我在 ${EXISTING_PROJECT_CWD} 下开一个 codex 窗口` });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续实现状态卡' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: '已完成 T1 的第一轮实现',
    waitHint: '请继续下一步'
  });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'create_new_task', messageId: 'om_card_1' } as any);

  assert.equal(service.getTask('T2')?.id, 'T2');

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

  assert.equal(codingSessionB.closed, true);
  assert.equal(service.getTask('T2'), undefined);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.match(sent.at(-1) ?? '', /已完成 T1 的第一轮实现/);
  assert.doesNotMatch(sent.at(-1) ?? '', /当前没有可用的 Coding 任务/);
});

test('card action query_current_task does not auto-bind an older task when no empty task was pruned', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let calls = 0;
  let cardSendCount = 0;
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => {
      calls += 1;
      return calls === 1 ? codingSessionA : codingSessionB;
    },
    sendCardImpl: async (_threadId, card) => {
      cardSendCount += 1;
      cards.push({ kind: 'send', card });
      return cardSendCount === 1 ? 'om_status_1' : `om_reply_${cardSendCount - 1}`;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: `帮我在 ${EXISTING_PROJECT_CWD} 下开一个 codex 窗口` });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续实现状态卡' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: '已完成 T1 的第一轮实现',
    waitHint: '请继续 T1'
  });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'create_new_task', messageId: 'om_status_1' } as any);
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T2 输入: 继续拆分状态卡' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T2',
    waitKind: 'text_input',
    output: '已完成 T2 的第一轮实现',
    waitHint: '请继续 T2'
  });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'close_current_task', messageId: 'om_status_1' } as any);

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_status_1' } as any);

  assert.match(sent.at(-1) ?? '', /当前没有可用的 Coding 任务，已保持助手模式。/);
  assert.doesNotMatch(sent.at(-1) ?? '', /已完成 T1 的第一轮实现/);
});

test('card action query_current_task prefers the last completed final answer from the log over polluted checkpoint diagnostics', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const finalAnswer = [
      '这轮已经把查询任务进展改成只看上一轮 Codex 回复。',
      '',
      '- 现在不会再把调试日志混进来。',
      '- 还保留了当前任务前缀，方便你知道这是哪个任务。'
    ].join('\n');
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 继续整理任务进展输出',
        finalAnswer,
        '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":72}',
        '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":72,"lastFinishedTurnId":"turn-1"}',
        '[2026-03-26T00:05:00.000Z] CHILD_EXIT {"code":1}',
        '[2026-03-26T00:05:00.001Z] TURN FAILED ' + finalAnswer,
        'codex app-server (WebSockets)',
        'Exit code: 1'
      ].join('\n')
    );
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'RUNNING_TURN',
          sessionKind: 'coding',
          lastCheckpointOutput: [
            finalAnswer,
            'codex app-server (WebSockets)',
            'Exit code: 1'
          ].join('\n')
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '当前轮正在继续补测试',
      checkpointOutput: '',
      logPath
    });
    const { service } = createTestService({ sent, registry, sessionFactory: () => session });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /这轮已经把查询任务进展改成只看上一轮 Codex 回复。/);
    assert.match(sent[sent.length - 1] ?? '', /现在不会再把调试日志混进来。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮正在继续补测试/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /codex app-server \(WebSockets\)/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /Exit code: 1/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task prefers the latest commentary-phase reply from the log', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const olderFinalAnswer = '第一轮已经完成基础排查。';
    const latestCommentary = [
      '补充说明：',
      '- 这次只返回上一轮 Codex 回复。',
      '- 不再附带状态诊断包装。'
    ].join('\n');
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 先做第一轮排查',
        olderFinalAnswer,
        '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":13}',
        '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":13,"lastFinishedTurnId":"turn-1"}',
        '[2026-03-26T00:01:00.000Z] FEISHU IN 再补一句给用户看的进展说明',
        latestCommentary,
        '[2026-03-26T00:01:01.000Z] AGENT_MESSAGE {"turnId":"turn-2","phase":"commentary","textLength":39}',
        '[2026-03-26T00:01:01.001Z] TURN DONE {"completedTurnId":"turn-2","outputLength":39,"lastFinishedTurnId":"turn-2"}'
      ].join('\n')
    );
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: olderFinalAnswer
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /补充说明：/);
    assert.match(sent[sent.length - 1] ?? '', /这次只返回上一轮 Codex 回复/);
    assert.match(sent[sent.length - 1] ?? '', /不再附带状态诊断包装/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /第一轮已经完成基础排查/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task prefers a newer clean checkpoint over an older flushed log reply', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const olderReply = '旧日志里仍是上一轮较早的回复。';
    const newerCheckpoint = '内存里的 checkpoint 已经更新成最新回复。';
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '当前轮正在继续补验证。',
      checkpointOutput: newerCheckpoint,
      logPath: logs.writeLog(
        'T1',
        [
          '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
          '[2026-03-26T00:00:00.500Z] FEISHU IN 继续修这条进展查询',
          olderReply,
          '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":17}',
          '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":17,"lastFinishedTurnId":"turn-1"}'
        ].join('\n')
      )
    });
    const { service } = createTestService({ sent, session });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /内存里的 checkpoint 已经更新成最新回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /旧日志里仍是上一轮较早的回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮正在继续补验证。/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task prefers a newer recovered checkpoint over an older flushed log reply', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const olderReply = '旧日志里还是更早一轮的回复。';
    const newerRecoveredCheckpoint = '恢复后的 checkpoint 已经更新成更新一轮的回复。';
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 继续修这条进展查询',
        olderReply,
        '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":16}',
        '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":16,"lastFinishedTurnId":"turn-1"}'
      ].join('\n')
    );
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointAt: '2026-03-26T00:00:02.000Z',
          lastCheckpointOutput: newerRecoveredCheckpoint
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /恢复后的 checkpoint 已经更新成更新一轮的回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /旧日志里还是更早一轮的回复。/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task falls back to the newer log reply when only lastEventAt was refreshed after restart', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const staleRecoveredCheckpoint = '恢复态 checkpoint 其实还是旧的一轮。';
    const newerReply = '日志里已经是更新一轮的真实回复。';
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 继续确认上一轮进展',
        newerReply,
        '[2026-03-26T00:00:02.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":15}',
        '[2026-03-26T00:00:02.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":15,"lastFinishedTurnId":"turn-1"}'
      ].join('\n')
    );
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointAt: '2026-03-26T00:00:01.000Z',
          lastCheckpointOutput: staleRecoveredCheckpoint,
          lastEventAt: '2026-03-26T00:05:00.000Z'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /日志里已经是更新一轮的真实回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /恢复态 checkpoint 其实还是旧的一轮。/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task keeps a freshly failed in-memory checkpoint after the live session is removed', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const olderReply = '日志里还是上一次较早的回复。';
    const failedCheckpoint = '这次失败后的最终 checkpoint 已经更新。';
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 继续跑这组回归',
        olderReply,
        '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":15}',
        '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":15,"lastFinishedTurnId":"turn-1"}'
      ].join('\n')
    );
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      checkpointOutput: '',
      logPath,
      codexThreadId: 'codex-thread-1'
    });
    const { service } = createTestService({ sent, session });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleWorkerEvent({
      type: 'task_failed',
      taskId: 'T1',
      output: failedCheckpoint
    });
    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /这次失败后的最终 checkpoint 已经更新。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /日志里还是上一次较早的回复。/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task keeps a newer checkpoint even when it quotes plain-text failure output lines', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const olderReply = '旧日志里仍是更早一轮的安全回复。';
    const newerCheckpoint = [
      '我把上一轮的原文保留如下：',
      'Exit code: 1',
      'stderr: command failed',
      'spawn git ENOENT'
    ].join('\n');
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '当前轮继续验证中',
      checkpointOutput: newerCheckpoint,
      logPath: logs.writeLog(
        'T1',
        [
          '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
          '[2026-03-26T00:00:00.500Z] FEISHU IN 继续修这条进展查询',
          olderReply,
          '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":18}',
          '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":18,"lastFinishedTurnId":"turn-1"}'
        ].join('\n')
      )
    });
    const { service } = createTestService({ sent, session });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /我把上一轮的原文保留如下：/);
    assert.match(sent[sent.length - 1] ?? '', /Exit code: 1/);
    assert.match(sent[sent.length - 1] ?? '', /stderr: command failed/);
    assert.match(sent[sent.length - 1] ?? '', /spawn git ENOENT/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /旧日志里仍是更早一轮的安全回复。/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮继续验证中/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task falls back to the latest real log output when the recovered checkpoint is only a resume placeholder', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog(
            'T1',
            [
              '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
              '[2026-03-26T00:00:00.500Z] FEISHU IN 继续排查进展查询为何只显示占位文案',
              '已完成依赖排查',
              '下一步准备补测试',
              '[2026-03-26T00:00:00.800Z] WAITING_USER choice',
              '[2026-03-26T00:00:01.000Z] SESSION RESUMED',
              '[2026-03-26T00:00:02.000Z] SESSION READY'
            ].join('\n')
          ),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /已完成依赖排查/);
    assert.match(sent[sent.length - 1] ?? '', /下一步准备补测试/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /WAITING_USER choice/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /会话已恢复，等待你的任务描述/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task raw-log fallback stops at the latest recovery marker when no new turn boundary was logged yet', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog(
            'T1',
            [
              '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
              '[2026-03-26T00:00:00.500Z] FEISHU IN 继续排查恢复后的进展查询',
              '上一轮原始输出：已完成依赖排查',
              '上一轮原始输出：下一步补测试',
              '[2026-03-26T00:00:01.000Z] SESSION RESUMED',
              '[2026-03-26T00:00:02.000Z] SESSION READY',
              '当前轮原始输出：这行还没有边界事件，不该被当成上一轮'
            ].join('\n')
          ),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'RUNNING_TURN',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '当前轮实时缓冲：继续执行中',
      checkpointOutput: '',
      logPath: registry.getSessionRecord('T1')?.logPath as string
    });
    const { service } = createTestService({ sent, registry, sessionFactory: () => session });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /上一轮原始输出：已完成依赖排查/);
    assert.match(sent[sent.length - 1] ?? '', /上一轮原始输出：下一步补测试/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮原始输出：这行还没有边界事件/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时缓冲：继续执行中/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task does not mislabel current-turn log output as previous output after a recovered task resumes', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 继续排查进展回退',
        '上一轮真实输出：已完成依赖排查',
        '上一轮真实输出：下一步补测试',
        '[2026-03-26T00:00:01.000Z] SESSION RESUMED',
        '[2026-03-26T00:00:02.000Z] SESSION READY',
        '[2026-03-26T00:00:03.000Z] FEISHU IN 继续执行剩余测试',
        '[2026-03-26T00:00:03.100Z] TURN START',
        '当前轮日志片段：正在跑回归'
      ].join('\n')
    );
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '当前轮实时缓冲：正在跑回归',
      checkpointOutput: '',
      logPath
    });
    const { service } = createTestService({ sent, registry, sessionFactory: () => session });

    await service.handleCardAction({
      threadId: 'feishu:chat-1',
      kind: 'pick_current_task',
      taskId: 'T1',
      messageId: 'om_card_1'
    } as any);
    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_2' } as any);

    assert.match(sent[sent.length - 1] ?? '', /上一轮真实输出：已完成依赖排查/);
    assert.match(sent[sent.length - 1] ?? '', /上一轮真实输出：下一步补测试/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /上一轮输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时输出/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮实时缓冲：正在跑回归/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /当前轮日志片段：正在跑回归/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task keeps timestamp-like raw lines in the recovered previous-output block', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog(
            'T1',
            [
              '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
              '[2026-03-26T00:00:00.500Z] FEISHU IN 继续排查时间戳样式日志',
              '[2026-03-26T10:00:00.000Z] webpack building...',
              'build finished',
              '[2026-03-26T00:00:01.000Z] SESSION RESUMED',
              '[2026-03-26T00:00:02.000Z] SESSION READY'
            ].join('\n')
          ),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /\[2026-03-26T10:00:00.000Z\] webpack building\.\.\./);
    assert.match(sent[sent.length - 1] ?? '', /build finished/);
  } finally {
    logs.cleanup();
  }
});

test('card action query_current_task preserves quoted structured-looking lines inside the last Codex reply', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const quotedReadyLine = '[2026-03-26T10:00:00.000Z] SESSION READY';
    const quotedWaitLine = '[2026-03-26T10:00:01.000Z] WAITING_USER choice';
    const logPath = logs.writeLog(
      'T1',
      [
        '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
        '[2026-03-26T00:00:00.500Z] FEISHU IN 帮我原样贴出上一轮回复',
        '我把你上次看到的原文贴回来：',
        quotedReadyLine,
        quotedWaitLine,
        '建议先对照这两行定位恢复点。',
        '[2026-03-26T00:00:01.000Z] ITEM_COMPLETED {"turnId":"turn-1","phase":"final_answer","textLength":72}',
        '[2026-03-26T00:00:01.001Z] TURN DONE {"completedTurnId":"turn-1","outputLength":72,"lastFinishedTurnId":"turn-1"}'
      ].join('\n')
    );
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_1' } as any);

    assert.match(sent[sent.length - 1] ?? '', /我把你上次看到的原文贴回来：/);
    assert.match(sent[sent.length - 1] ?? '', /\[2026-03-26T10:00:00.000Z\] SESSION READY/);
    assert.match(sent[sent.length - 1] ?? '', /\[2026-03-26T10:00:01.000Z\] WAITING_USER choice/);
    assert.match(sent[sent.length - 1] ?? '', /建议先对照这两行定位恢复点。/);
  } finally {
    logs.cleanup();
  }
});

test('query status ignores a recovered resume placeholder and falls back to the latest meaningful log summary', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog(
            'T1',
            [
              '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}',
              '[2026-03-26T00:00:00.500Z] FEISHU IN 继续排查状态摘要回退',
              '最近真实输出：已完成依赖排查',
              '最近真实输出：下一步补测试',
              '[2026-03-26T00:00:00.800Z] WAITING_USER choice',
              '[2026-03-26T00:00:01.000Z] SESSION RESUMED',
              '[2026-03-26T00:00:02.000Z] SESSION READY'
            ].join('\n')
          ),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ]
    });
    const { service } = createTestService({ sent, registry, session: createMockSession() });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 状态' });

    assert.match(sent[sent.length - 1] ?? '', /最近摘要 最近真实输出：下一步补测试/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /WAITING_USER choice/);
    assert.doesNotMatch(sent[sent.length - 1] ?? '', /会话已恢复，等待你的任务描述/);
  } finally {
    logs.cleanup();
  }
});

test('close message closes the matching session and marks the task closed', async () => {
  const sent: string[] = [];
  const session = createMockSession({ lifecycle: 'IDLE' });
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '关闭T1。' });

  assert.equal(session.closed, true);
  assert.equal(session.closeCalls, 1);
  assert.equal(service.getTask('T1')?.lifecycle, 'CLOSED');
  assert.match(sent[sent.length - 1] ?? '', /已关闭/);
});

test('resume command reopens a closed task', async () => {
  const sent: string[] = [];
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return createMockSession({ lifecycle: 'IDLE', codexThreadId: 'codex-thread-1' });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '关闭T1。' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '恢复T1' });

  assert.equal(sessionFactoryCalls.length, 2);
  assert.equal(sessionFactoryCalls[1]?.mode, 'resume');
  assert.equal(sessionFactoryCalls[1]?.resumeThreadId, 'codex-thread-1');
  assert.match(sent[sent.length - 1] ? sent[sent.length - 1] : '', /重新打开|恢复/);
});

test('clarification follow-up with bare cwd starts the pending codex task', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我开一个 codex' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: 'D:\\Workspace\\Project' });

  assert.equal(session.started, true);
  assert.match(sent[0] ?? '', /请告诉我要在哪个目录下启动 Codex/);
  assert.match(sent[sent.length - 1] ?? '', /T1/);
  assert.equal(service.getTask('T1')?.taskType, 'codex_session');
});

test('clarification follow-up can extract cwd from natural language suffix', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我开一个 codex' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '在 D:\\Workspace\\Project 下开一个窗口' });

  assert.equal(session.started, true);
  assert.equal(service.getTask('T1')?.cwd, 'D:\\Workspace\\Project');
  assert.match(sent[0] ?? '', /请告诉我要在哪个目录下启动 Codex/);
  assert.match(sent[sent.length - 1] ?? '', /T1/);
});

test('ordinary text auto-creates a thread assistant in the default assistant cwd', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return assistantSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我分析这个实验设计有什么漏洞' });

  assert.equal(service.getTask('T1')?.taskType, 'codex_session');
  assert.equal((service.getTask('T1') as any)?.sessionKind, 'assistant');
  assert.equal(service.getTask('T1')?.cwd, DEFAULT_ASSISTANT_CWD);
  assert.deepEqual(assistantSession.replies[0], { action: 'input_text', text: '帮我分析这个实验设计有什么漏洞' });
  assert.equal(sessionFactoryCalls[0]?.cwd, DEFAULT_ASSISTANT_CWD);
  assert.equal(sessionFactoryCalls[0]?.mode, 'new');
  assert.equal(sessionFactoryCalls[0]?.personality, 'pragmatic');
  assert.match(String(sessionFactoryCalls[0]?.developerInstructions ?? ''), /长期科研助理/);
  assert.equal(registry.getThreadBinding('feishu:chat-1')?.assistantTaskId, 'T1');
  assert.equal(sent.some((text) => /T1/.test(text)), false);
});

test('ordinary text keeps a blocked assistant startup in FAILED instead of rewriting it to STARTING', async () => {
  const sent: string[] = [];
  const blockedOutput = '检测到当前 Codex 版本 0.120.0 属于已知不兼容版本，可能导致任务执行中被异常打断。请尽快升级到最新版本后重试。';
  const assistantSession = createMockSession({
    lifecycle: 'FAILED',
    checkpointOutput: blockedOutput,
    codexThreadId: 'assistant-thread-blocked'
  });
  assistantSession.sendReply = () => {
    throw new Error('startup blocked');
  };
  const { service } = createTestService({
    sent,
    registry: createMockRegistry({ nextTaskId: 1 }),
    sessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我分析这个实验设计有什么漏洞' });

  assert.equal(service.getTask('T1')?.lifecycle, 'FAILED');
  assert.match(service.getTask('T1')?.checkpointOutput ?? '', /已知不兼容版本/);
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 状态' });
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /启动中|STARTING/);
  assert.match(sent[sent.length - 1] ?? '', /已知不兼容版本|失败/);
});

test('ordinary text reuses the same thread assistant instead of creating another task', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return assistantSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '先帮我梳理问题' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '再给我一个最小方案' });

  assert.equal(sessionFactoryCalls.length, 1);
  assert.equal(service.getTask('T1')?.id, 'T1');
  assert.equal(service.getTask('T2'), undefined);
  assert.deepEqual(assistantSession.replies, [
    { action: 'input_text', text: '先帮我梳理问题' },
    { action: 'input_text', text: '再给我一个最小方案' }
  ]);
  assert.equal(sent.some((text) => /T1/.test(text)), false);
});

test('ordinary text still goes to the thread assistant even when a coding task is waiting', async () => {
  const sent: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: (sessionOptions) =>
      String(sessionOptions.cwd) === DEFAULT_ASSISTANT_CWD ? assistantSession : codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: 'Please input your response:',
    waitHint: '对 T1 输入: xxx'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '顺便帮我看看这个方案还有什么风险' });

  assert.equal(service.getTask('T2')?.id, 'T2');
  assert.equal((service.getTask('T2') as any)?.sessionKind, 'assistant');
  assert.deepEqual(assistantSession.replies[0], { action: 'input_text', text: '顺便帮我看看这个方案还有什么风险' });
  assert.equal(codingSession.replies.length, 0);
});

test('hidden mode commands switch display mode and route ordinary text to the current coding task', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) =>
      String(sessionOptions.cwd) === DEFAULT_ASSISTANT_CWD ? assistantSession : codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修这个 bug' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.deepEqual(codingSession.replies.at(-1), { action: 'free_text', text: '继续修这个 bug' });
  assert.equal(assistantSession.replies.length, 0);
  assert.equal(service.getTask('T2'), undefined);
  assert.match(sent.at(-1) ?? '', /Coding/);
});

test('creating a coding task does not use the launcher request as the goal summary source', async () => {
  const sent: string[] = [];
  const summaryCalls: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service, registry } = createTestService({
    sent,
    registry: createMockRegistry({ nextTaskId: 1 }),
    codingSessionFactory: () => codingSession,
    goalSummaryGenerator: {
      async summarize(input) {
        summaryCalls.push(input.sourceText);
        return '不应被调用';
      }
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  assert.equal(service.getTask('T1')?.goalSummary, undefined);
  assert.equal(service.getTask('T1')?.goalSummaryStatus, undefined);
  assert.equal(service.getTask('T1')?.goalSummarySourceText, undefined);
  assert.deepEqual(summaryCalls, []);
  assert.equal(registry.getSessionRecord('T1')?.goalSummary, undefined);
});

test('first real coding instruction queues goal summary generation and persists the async result without refreshing cards', async () => {
  const sent: string[] = [];
  const cardCalls: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const deferred = createDeferred<string | undefined>();
  const summaryCalls: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'assistant',
        statusCardMessageId: 'om_card_1'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: () => codingSession,
    sendCardImpl: async (_threadId, card) => {
      cardCalls.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cardCalls.push({ kind: 'update', messageId, card });
    },
    goalSummaryGenerator: {
      async summarize(input) {
        summaryCalls.push(input.sourceText);
        return await deferred.promise;
      }
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  cardCalls.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '修复飞书任务切换卡摘要不可读问题' });

  assert.deepEqual(summaryCalls, ['修复飞书任务切换卡摘要不可读问题']);
  assert.equal(service.getTask('T1')?.goalSummary, undefined);
  assert.equal(service.getTask('T1')?.goalSummaryStatus, 'pending');
  assert.equal(service.getTask('T1')?.goalSummarySourceText, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(service.getTask('T1')?.firstUserCodingText, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(registry.getSessionRecord('T1')?.goalSummaryStatus, 'pending');
  assert.equal(registry.getSessionRecord('T1')?.firstUserCodingText, '修复飞书任务切换卡摘要不可读问题');
  assert.deepEqual(codingSession.replies.at(-1), { action: 'free_text', text: '修复飞书任务切换卡摘要不可读问题' });
  assert.equal(cardCalls.filter((entry) => entry.kind === 'send').length, 1);
  assert.equal(cardCalls.filter((entry) => entry.kind === 'update').length, 0);
  assert.match(JSON.stringify(cardCalls[0]?.card ?? {}), /查询任务进展/);

  deferred.resolve('修复飞书任务切换卡摘要不可读问题');
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(service.getTask('T1')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(service.getTask('T1')?.goalSummaryStatus, 'ready');
  assert.equal(registry.getSessionRecord('T1')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(registry.getSessionRecord('T1')?.goalSummaryStatus, 'ready');
  assert.equal(cardCalls.filter((entry) => entry.kind === 'send').length, 1);
  assert.equal(cardCalls.filter((entry) => entry.kind === 'update').length, 0);
});

test('first real coding instruction can mention codex 会话 without being filtered as launcher text', async () => {
  const sent: string[] = [];
  const summaryCalls: string[] = [];
  const deferred = createDeferred<string | undefined>();
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    registry: createMockRegistry({ nextTaskId: 1 }),
    codingSessionFactory: () => codingSession,
    goalSummaryGenerator: {
      async summarize(input) {
        summaryCalls.push(input.sourceText);
        return await deferred.promise;
      }
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 修复 codex 会话恢复异常' });

  assert.deepEqual(summaryCalls, ['修复 codex 会话恢复异常']);
  assert.equal(service.getTask('T1')?.goalSummarySourceText, '修复 codex 会话恢复异常');
  assert.equal(service.getTask('T1')?.firstUserCodingText, '修复 codex 会话恢复异常');
  assert.deepEqual(codingSession.replies.at(-1), { action: 'free_text', text: '修复 codex 会话恢复异常' });

  deferred.resolve('修复 codex 会话恢复异常');
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(service.getTask('T1')?.goalSummary, '修复 codex 会话恢复异常');
});

test('starting another coding task keeps prior task when first real coding instruction mentions 打开 codex', async () => {
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({ nextTaskId: 1 });
    const codingSessionA = createMockSession({
      lifecycle: 'IDLE',
      codexThreadId: 'coding-thread-1',
      logPath: logs.writeLog('T1', '')
    });
    const codingSessionB = createMockSession({
      lifecycle: 'IDLE',
      codexThreadId: 'coding-thread-2',
      logPath: logs.writeLog('T2', '')
    });
    let calls = 0;
    const { service } = createTestService({
      sent: [],
      registry,
      sessionFactory: () => {
        calls += 1;
        return calls === 1 ? codingSessionA : codingSessionB;
      }
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 打开 codex 配置文件并排查日志' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project\\Subdir 下开一个 codex 窗口' });

    assert.equal(codingSessionA.closed, false);
    assert.equal(service.getTask('T1')?.firstUserCodingText, '打开 codex 配置文件并排查日志');
    assert.equal(registry.getSessionRecord('T1')?.firstUserCodingText, '打开 codex 配置文件并排查日志');
    assert.equal(service.getTask('T1')?.cwd, 'D:\\Workspace\\Project');
    assert.equal(service.getTask('T2')?.cwd, 'D:\\Workspace\\Project\\Subdir');
  } finally {
    logs.cleanup();
  }
});

test('mode status reports the current display mode and coding target', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode status' });

  assert.match(sent.at(-1) ?? '', /^\[模式: 助手\]/);
  assert.match(sent.at(-1) ?? '', /当前模式：助手/);
  assert.match(sent.at(-1) ?? '', /当前 Coding 目标：T1/);
});

test('mode assistant preserves current coding target and routes ordinary text back to assistant', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) =>
      String(sessionOptions.cwd) === DEFAULT_ASSISTANT_CWD ? assistantSession : codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode assistant' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '这条应该回到助手' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal((service.getTask('T2') as any)?.sessionKind, 'assistant');
  assert.deepEqual(assistantSession.replies[0], { action: 'input_text', text: '这条应该回到助手' });
  assert.equal(codingSession.replies.length, 0);
});

test('mode task switches the current coding target', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let codingIndex = 0;
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) => {
      if (String(sessionOptions.cwd) === DEFAULT_ASSISTANT_CWD) {
        return createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
      }
      return codingIndex++ === 0 ? codingSessionA : codingSessionB;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 修复第一个任务的上下文' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Projects 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode task T1' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修第一个任务' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.deepEqual(codingSessionA.replies.at(-1), { action: 'free_text', text: '继续修第一个任务' });
  assert.equal(codingSessionB.replies.length, 0);
});

test('service creates or updates a status card for thread mode changes', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  assert.equal(cards[0]?.kind, 'send');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_1');

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });

  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
});

test('service syncs startup launcher card to last active thread', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    recentProjectDirs: [EXISTING_PROJECT_CWD, 'D:\\Workspace\\Alpha']
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();

  assert.equal(cards[0]?.kind, 'send');
  assert.equal(registry.getThreadUiState('feishu:chat-9')?.statusCardMessageId, 'om_startup_1');
  const cardJson = JSON.stringify(cards[0]?.card ?? {});
  assert.match(cardJson, /启动 Codex 编程窗口/);
  assert.match(cardJson, EXISTING_PROJECT_CWD_JSON_REGEX);
});

test('service startup sync sends a fresh launcher card instead of silently updating a historical thread card', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-9',
        statusCardMessageId: 'om_history_1',
        displayMode: 'assistant'
      }
    ],
    recentProjectDirs: [EXISTING_PROJECT_CWD]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_fresh_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();

  assert.equal(cards[0]?.kind, 'send');
  assert.equal(cards.some((item) => item.kind === 'update'), false);
  assert.equal(registry.getThreadUiState('feishu:chat-9')?.statusCardMessageId, 'om_startup_fresh_1');
});

test('service remembers last active feishu delivery target from inbound messages', async () => {
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession()
  });

  await service.handleInboundMessage({
    threadId: 'feishu:chat-1',
    text: '你好',
    senderOpenId: 'ou_test_user_1'
  } as any);

  assert.equal((registry as any).getLastActiveFeishuThreadId(), 'feishu:chat-1');
  assert.equal((registry as any).getLastActiveFeishuUserOpenId(), 'ou_test_user_1');
});

test('service syncs startup launcher card to last active user private chat before falling back to a thread', async () => {
  const directCards: Array<{ receiveId: string; receiveIdType: string; card: Record<string, unknown> }> = [];
  const threadCards: Array<{ threadId: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    lastActiveFeishuUserOpenId: 'ou_test_user_1',
    recentProjectDirs: [EXISTING_PROJECT_CWD, 'D:\\Workspace\\Alpha']
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async (threadId, card) => {
      threadCards.push({ threadId, card });
      return 'om_startup_thread_1';
    },
    sendCardToRecipientImpl: async (input) => {
      directCards.push(input);
      return 'om_private_startup_1';
    }
  });

  await service.syncStartupCardForLastActiveThread();

  assert.equal(directCards.length, 1);
  assert.equal(directCards[0]?.receiveId, 'ou_test_user_1');
  assert.equal(directCards[0]?.receiveIdType, 'open_id');
  assert.match(JSON.stringify(directCards[0]?.card ?? {}), /启动 Codex 编程窗口/);
  assert.equal(threadCards.length, 0);
});

test('startup launcher sent to open_id preserves the real message id for later card updates', async () => {
  const cards: Array<{ kind: 'update'; messageId: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    lastActiveFeishuUserOpenId: 'ou_test_user_1',
    recentProjectDirs: [EXISTING_PROJECT_CWD, 'D:\\Workspace\\Alpha']
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async () => 'om_fallback_thread_1',
    sendCardToRecipientImpl: async () => 'om_private_startup_1',
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();

  assert.equal(registry.getThreadUiState('feishu:chat-9')?.statusCardMessageId, 'om_private_startup_1');

  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'open_message_private_1',
    kind: 'select_recent_cwd',
    cwd: EXISTING_PROJECT_CWD
  } as any);

  assert.equal(cards.at(-1)?.messageId, 'om_private_startup_1');
  assert.equal(registry.getThreadUiState('feishu:chat-9')?.statusCardActionMessageId, 'open_message_private_1');
});

test('service falls back to last active thread when no user open id is available', async () => {
  const cards: Array<{ threadId: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    recentProjectDirs: [EXISTING_PROJECT_CWD, 'D:\\Workspace\\Alpha']
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async (threadId, card) => {
      cards.push({ threadId, card });
      return 'om_startup_1';
    },
    updateCardImpl: async () => undefined
  });

  await service.syncStartupCardForLastActiveThread();

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.threadId, 'feishu:chat-9');
});

test('launcher card action selects recent cwd and refreshes launcher card', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    recentProjectDirs: [EXISTING_PROJECT_CWD, 'D:\\Workspace\\Alpha']
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();
  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_startup_1',
    kind: 'select_recent_cwd',
    cwd: EXISTING_PROJECT_CWD
  } as any);

  assert.equal(registry.getThreadUiState('feishu:chat-9')?.launcherSelectedCwd, EXISTING_PROJECT_CWD);
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), EXISTING_PROJECT_CWD_JSON_REGEX);
});

test('persisted launcher mode survives a restart and a later ordinary refresh even when recoverable coding tasks exist', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-9',
          codexThreadId: 'persisted-thread-1',
          cwd: EXISTING_PROJECT_CWD,
          logPath: logs.writeLog('T1', '[2026-03-28T08:00:00.000Z] FEISHU IN 继续之前的修复任务\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-9',
          displayMode: 'assistant',
          statusCardMode: 'launcher',
          statusCardMessageId: 'om_launcher_1',
          currentCodingTaskId: 'T1',
          launcherSelectedCwd: EXISTING_PROJECT_CWD
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
      sendCardImpl: async (_threadId, card) => {
        cards.push({ kind: 'send', card });
        return 'om_unexpected_send';
      },
      updateCardImpl: async (messageId, card) => {
        cards.push({ kind: 'update', messageId, card });
      }
    });

    assert.equal(service.getTask('T1')?.id, 'T1');

    await service.handleWorkerEvent({
      taskId: 'T1',
      type: 'task_finished',
      output: '已恢复完成'
    } as any);

    assert.equal(registry.getThreadUiState('feishu:chat-9')?.statusCardMode, 'launcher');
    assert.equal(registry.getThreadUiState('feishu:chat-9')?.currentCodingTaskId, 'T1');
    assert.equal(cards.at(-1)?.kind, 'update');
    assert.equal(cards.at(-1)?.messageId, 'om_launcher_1');
    const cardJson = JSON.stringify(cards.at(-1)?.card ?? {});
    assert.match(cardJson, /启动 Codex 编程窗口/);
    assert.match(cardJson, EXISTING_PROJECT_CWD_JSON_REGEX);
    assert.equal(/Codex 模式状态/.test(cardJson), false);
  } finally {
    logs.cleanup();
  }
});

test('card action from a mismatched status card sends a fresh replacement card instead of updating the stale tracked card', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'persisted-thread-1',
          model: 'gpt-5.4',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:05.000Z] FEISHU IN 继续之前的修复任务\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'assistant',
          statusCardMessageId: 'om_tracked_old_1',
          statusCardActionMessageId: 'open_message_tracked_old_1'
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
      sendCardImpl: async (_threadId, card) => {
        cards.push({ kind: 'send', card });
        return 'om_card_fresh_1';
      },
      updateCardImpl: async (messageId, card) => {
        cards.push({ kind: 'update', messageId, card });
      }
    });

    await service.handleCardAction({
      threadId: 'feishu:chat-1',
      messageId: 'open_message_clicked_other_1',
      kind: 'open_task_picker'
    } as any);

    assert.equal(cards.some((card) => card.kind === 'update' && card.messageId === 'om_tracked_old_1'), false);
    assert.equal(cards.at(-1)?.kind, 'send');
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_fresh_1');
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardActionMessageId, undefined);
    assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /T1/);
  } finally {
    logs.cleanup();
  }
});

test('project card keyword resends the current status view instead of forcing launcher', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复状态卡'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_status_old_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_project_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 1);
  assert.equal(cards.some((entry) => entry.kind === 'update'), false);
  assert.equal(codingSession.replies.length, 0);
  assert.match(cardText, /查询任务进展/);
  assert.match(cardText, /切换当前任务/);
  assert.doesNotMatch(cardText, /project_cwd/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_project_card_1');
});

test('project card keyword preserves launcher view when the current card is launcher', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'assistant',
        statusCardMode: 'launcher',
        statusCardMessageId: 'om_launcher_old_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_launcher_fresh_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 1);
  assert.equal(cards.some((entry) => entry.kind === 'update'), false);
  assert.match(cardText, /project_cwd/);
  assert.match(cardText, /启动编程窗口/);
  assert.doesNotMatch(cardText, /查询任务进展/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMode, 'launcher');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherSelectedCwd, EXISTING_PROJECT_CWD);
});

test('project card keyword preserves launcher error view and draft input', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'assistant',
        statusCardMode: 'launcher',
        statusCardMessageId: 'om_launcher_old_1',
        launcherDraftCwd: 'D:\\Broken',
        launcherError: '目录不存在，请重新输入。'
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_launcher_error_1';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.match(cardText, /目录不存在，请重新输入。/);
  assert.match(cardText, /D:\\Broken/);
  assert.match(cardText, /project_cwd/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMode, 'launcher');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherDraftCwd, 'D:\\Broken');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherError, '目录不存在，请重新输入。');
});

test('project card keyword preserves task picker when the current card has picker open', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 3,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: 'D:\\Workspace\\Project\\One',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        goalSummary: '修复第一个项目卡问题',
        goalSummaryStatus: 'ready'
      },
      {
        taskId: 'T2',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-2',
        cwd: 'D:\\Workspace\\Project\\Two',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T2.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'RUNNING_TURN',
        sessionKind: 'coding',
        goalSummary: '修复第二个项目卡问题',
        goalSummaryStatus: 'ready'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardPickerOpen: true,
        statusCardMessageId: 'om_status_old_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_picker_copy_1';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.match(cardText, /请选择新的 Coding 目标：/);
  assert.match(cardText, /切换到 T1/);
  assert.match(cardText, /切换到 T2/);
  assert.doesNotMatch(cardText, /查询任务进展/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMode, 'status');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardPickerOpen, true);
});

test('project card keyword accepts surrounding whitespace but still requires exact content', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_status_old_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_project_card_trimmed_1';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '  项目卡  ' });

  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 1);
  assert.equal(codingSession.replies.length, 0);
});

test('project card keyword does not trigger when recent images are appended to the same message', async () => {
  const sent: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    session: codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  codingSession.replies.length = 0;
  const sentCountBefore = sent.length;

  await service.handleInboundImage({
    threadId: 'feishu:chat-1',
    imagePath: 'D:\\Workspace\\Project\\Communicate\\keyword.png',
    receivedAt: Date.now() - 1_000
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  assert.equal(codingSession.replies.length, 1);
  assert.deepEqual(codingSession.replies.at(-1), {
    action: 'free_text',
    text: '项目卡\n\n[图片]\n- D:\\Workspace\\Project\\Communicate\\keyword.png'
  });
  assert.equal(sent.length, sentCountBefore + 1);
  assert.doesNotMatch(sent.at(-1) ?? '', /项目卡暂不可用/);
});

test('non exact variants like 项目卡片 still route as ordinary text', async () => {
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    session: codingSession,
    sendCardImpl: async () => 'om_status_1',
    updateCardImpl: async () => undefined
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  codingSession.replies.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡片' });

  assert.deepEqual(codingSession.replies.at(-1), { action: 'free_text', text: '项目卡片' });
});

test('project card keyword does not route to the current coding task and does not change display mode or currentCodingTaskId', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const registry = createMockRegistry({
    nextTaskId: 3,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: 'D:\\Workspace\\Project\\One',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复第一个任务'
      },
      {
        taskId: 'T2',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-2',
        cwd: 'D:\\Workspace\\Project\\Two',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T2.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复第二个任务'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_status_old_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return sessionOptions.taskId === 'T2' ? codingSessionB : codingSessionA;
    },
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_project_card_2';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(codingSessionA.replies.length, 0);
  assert.equal(codingSessionB.replies.length, 0);
  assert.equal(sessionFactoryCalls.length, 0);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修这个 bug' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.deepEqual(codingSessionA.replies.at(-1), { action: 'free_text', text: '继续修这个 bug' });
  assert.equal(codingSessionB.replies.length, 0);
});

test('project card keyword preserves assistant status lifecycle and current model', async () => {
  const cards: Array<{ kind: 'send'; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    model: 'gpt-5.4'
  });
  const { service } = createTestService({
    sent: [],
    session: assistantSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_project_card_assistant_1';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个方案' });
  const replyCountBefore = assistantSession.replies.length;
  cards.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.match(cardText, /任务状态：RUNNING_TURN/);
  assert.match(cardText, /配置：model gpt-5\.4 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(cardText, /会话：sessionKind assistant · 恢复态 否 · 中断恢复 否/);
  assert.equal(assistantSession.replies.length, replyCountBefore);
});

test('project card keyword does not satisfy WAITING_USER text_input reply', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: '请补充日志',
    waitHint: '对 T1 输入: 请补充日志'
  });
  cards.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  assert.equal(session.replies.length, 0);
  assert.equal(service.getTask('T1')?.waitKind, 'text_input');
  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 1);
});

test('project card keyword does not satisfy WAITING_USER confirm reply', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'confirm',
    output: 'Codex 请求执行命令审批。\n命令: git status',
    waitHint: '对 T1 允许'
  });
  cards.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  assert.equal(session.replies.length, 0);
  assert.equal(service.getTask('T1')?.waitKind, 'confirm');
  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 1);
});

test('project card keyword preserves WAITING_USER lifecycle even when snapshot regresses to RUNNING_TURN', async () => {
  const cards: Array<Record<string, unknown>> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push(card);
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async () => undefined
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: '请补充日志',
    waitHint: '对 T1 输入: 请补充日志'
  });
  cards.length = 0;
  session.setSnapshot({
    lifecycle: 'RUNNING_TURN',
    checkpointOutput: 'stale running snapshot'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1) ?? {}).join('\n');
  assert.match(cardText, /任务状态：WAITING_USER/);
});

test('project card keyword preserves FAILED lifecycle even when snapshot regresses to RUNNING_TURN', async () => {
  const cards: Array<Record<string, unknown>> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push(card);
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async () => undefined
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: 'Codex 线程进入 systemError 状态。'
  });
  cards.length = 0;
  session.setSnapshot({
    lifecycle: 'RUNNING_TURN',
    checkpointOutput: 'stale running snapshot'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1) ?? {}).join('\n');
  assert.match(cardText, /任务状态：FAILED/);
});

test('project card keyword clears a stale CLOSED current coding target before resending the status card', async () => {
  const cards: Array<Record<string, unknown>> = [];
  let sessionFactoryCalls = 0;
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'CLOSED',
        sessionKind: 'coding',
        firstUserCodingText: '已经关闭的任务'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_card_old',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    sessionFactory: () => {
      sessionFactoryCalls += 1;
      return createMockSession({ lifecycle: 'STARTING', codexThreadId: 'coding-thread-1' });
    },
    sendCardImpl: async (_threadId, card) => {
      cards.push(card);
      return 'om_card_new';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const cardText = collectCardTextContents(cards.at(-1) ?? {}).join('\n');
  assert.equal(sessionFactoryCalls, 0);
  assert.match(cardText, /当前 Coding 目标：未绑定/);
  assert.match(cardText, /普通消息默认去向：助手/);
  assert.match(cardText, /任务状态：N\/A/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
});

test('project card keyword rebinds future status card refreshes to the newest card message id', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复重绑问题'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_card_old',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_new';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode status' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_new');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_new'), true);
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_old'), false);
});

test('project card keyword clears stale statusCardActionMessageId before the new card is clicked', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复 alias 问题'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_card_old',
        statusCardActionMessageId: 'om_alias_old',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_new';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardActionMessageId, undefined);
  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'open_task_picker',
    messageId: 'om_alias_new'
  } as any);

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_new');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardActionMessageId, 'om_alias_new');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 1);
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_new'), true);
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_old'), false);
});

test('project card keyword works even when the thread had no previous status card', async () => {
  const cards: Array<{ kind: 'send'; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '无旧卡也能召回'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_first';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  assert.equal(cards.length, 1);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_first');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherSelectedCwd, EXISTING_PROJECT_CWD);
});

test('project card keyword surfaces a short failure message when status card send fails', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: EXISTING_PROJECT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '处理发送失败'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMode: 'status',
        statusCardMessageId: 'om_card_old',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async () => {
      throw new Error('simulated send failure');
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  assert.match(sent.at(-1) ?? '', /项目卡发送失败，请稍后重试。/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_old');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherSelectedCwd, EXISTING_PROJECT_CWD);
});

test('project card keyword reads live coding status without persisting snapshot changes', async () => {
  const cards: Array<Record<string, unknown>> = [];
  const codingSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'coding-thread-1',
    model: 'gpt-4.1-stale'
  });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent: [],
    registry,
    session: codingSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push(card);
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async () => undefined
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  const upsertCountBefore = registry.upsertCalls.length;
  const taskBefore = service.getTask('T1');
  const taskBeforeSnapshot = taskBefore
    ? {
        lifecycle: taskBefore.lifecycle,
        model: taskBefore.model,
        checkpointOutput: taskBefore.checkpointOutput,
        lastEventAt: taskBefore.lastEventAt
      }
    : undefined;
  codingSession.setSnapshot({
    lifecycle: 'RUNNING_TURN',
    model: 'gpt-5.4-live',
    checkpointOutput: 'live snapshot output'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const taskAfter = service.getTask('T1');
  const cardText = collectCardTextContents(cards.at(-1) ?? {}).join('\n');
  assert.match(cardText, /任务状态：RUNNING_TURN/);
  assert.match(cardText, /配置：model gpt-5\.4-live · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(cardText, /会话：sessionKind coding · 恢复态 否 · 中断恢复 否/);
  assert.equal(taskAfter?.lifecycle, taskBeforeSnapshot?.lifecycle);
  assert.equal(taskAfter?.model, taskBeforeSnapshot?.model);
  assert.equal(taskAfter?.checkpointOutput, taskBeforeSnapshot?.checkpointOutput);
  assert.equal(taskAfter?.lastEventAt, taskBeforeSnapshot?.lastEventAt);
  assert.equal(registry.upsertCalls.length, upsertCountBefore);
});

test('project card keyword clears a live CLOSED current coding target without persisting snapshot changes', async () => {
  const cards: Array<Record<string, unknown>> = [];
  const codingSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'coding-thread-1',
    model: 'gpt-4.1-stale'
  });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent: [],
    registry,
    session: codingSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push(card);
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async () => undefined
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  const upsertCountBefore = registry.upsertCalls.length;
  const taskBefore = service.getTask('T1');
  const taskBeforeSnapshot = taskBefore
    ? {
        lifecycle: taskBefore.lifecycle,
        model: taskBefore.model,
        checkpointOutput: taskBefore.checkpointOutput,
        lastEventAt: taskBefore.lastEventAt
      }
    : undefined;
  codingSession.setSnapshot({
    lifecycle: 'CLOSED',
    model: 'gpt-5.4-live-closed',
    checkpointOutput: 'live closed snapshot output'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const taskAfter = service.getTask('T1');
  const cardText = collectCardTextContents(cards.at(-1) ?? {}).join('\n');
  assert.match(cardText, /当前 Coding 目标：未绑定/);
  assert.match(cardText, /普通消息默认去向：助手/);
  assert.match(cardText, /任务状态：N\/A/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal(taskAfter?.lifecycle, taskBeforeSnapshot?.lifecycle);
  assert.equal(taskAfter?.model, taskBeforeSnapshot?.model);
  assert.equal(taskAfter?.checkpointOutput, taskBeforeSnapshot?.checkpointOutput);
  assert.equal(taskAfter?.lastEventAt, taskBeforeSnapshot?.lastEventAt);
  assert.equal(registry.upsertCalls.length, upsertCountBefore);
});

test('project card keyword does not keep a live CLOSED task in the picker after clearing the stale current target', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const codingSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'coding-thread-1',
    model: 'gpt-4.1-stale'
  });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent: [],
    registry,
    session: codingSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return `om_card_${cards.length}`;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' } as any);
  cards.length = 0;
  const upsertCountBefore = registry.upsertCalls.length;
  const taskBefore = service.getTask('T1');
  const taskBeforeSnapshot = taskBefore
    ? {
        lifecycle: taskBefore.lifecycle,
        model: taskBefore.model,
        checkpointOutput: taskBefore.checkpointOutput,
        lastEventAt: taskBefore.lastEventAt
      }
    : undefined;
  codingSession.setSnapshot({
    lifecycle: 'CLOSED',
    model: 'gpt-5.4-live-closed',
    checkpointOutput: 'live closed snapshot output'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '项目卡' });

  const taskAfter = service.getTask('T1');
  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.match(cardText, /请选择新的 Coding 目标：/);
  assert.match(cardText, /当前没有可切换的 Coding 任务。/);
  assert.doesNotMatch(cardText, /切换到 T1/);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardPickerOpen, true);
  assert.equal(taskAfter?.lifecycle, taskBeforeSnapshot?.lifecycle);
  assert.equal(taskAfter?.model, taskBeforeSnapshot?.model);
  assert.equal(taskAfter?.checkpointOutput, taskBeforeSnapshot?.checkpointOutput);
  assert.equal(taskAfter?.lastEventAt, taskBeforeSnapshot?.lastEventAt);
  assert.equal(registry.upsertCalls.length, upsertCountBefore);
});

test('launcher submit starts coding task, persists model metadata, and updates global recent dirs', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9',
    recentProjectDirs: ['D:\\Workspace\\Alpha']
  });
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1', model: 'gpt-5.4' });
  const { service } = createTestService({
    sent: [],
    registry,
    session,
    defaultModel: 'gpt-5.4',
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();
  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_startup_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);

  assert.equal(service.getTask('T1')?.cwd, EXISTING_PROJECT_CWD);
  assert.equal(service.getTask('T1')?.model, 'gpt-5.4');
  assert.equal(session.started, true);
  assert.deepEqual(registry.getRecentProjectDirs(), [EXISTING_PROJECT_CWD, 'D:\\Workspace\\Alpha']);
  assert.equal(registry.getLastActiveFeishuThreadId(), 'feishu:chat-9');
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /当前 Coding 目标：T1/);
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /配置：model gpt-5\.4 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(JSON.stringify(cards.at(-1)?.card ?? {}), /会话：sessionKind coding · 恢复态 否 · 中断恢复 否/);
  assert.equal(registry.upsertCalls.at(-1)?.model, 'gpt-5.4');
});

test('launcher submit waits for startup-resolved model before persisting and presenting it', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9'
  });
  const session = createMockSession({ lifecycle: 'STARTING', codexThreadId: 'coding-thread-1' });
  const originalStart = session.start.bind(session);
  session.start = async () => {
    originalStart();
    await Promise.resolve();
    session.setSnapshot({ lifecycle: 'IDLE', model: 'gpt-5.4-resolved' });
  };
  const { service } = createTestService({
    sent,
    registry,
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();
  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_startup_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);

  assert.equal(service.getTask('T1')?.model, 'gpt-5.4-resolved');
  assert.equal(registry.getSessionRecord('T1')?.model, 'gpt-5.4-resolved');
  assert.match(sent.find((line) => line.includes('已创建任务 T1')) ?? '', /模型 gpt-5\.4-resolved/);
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /配置：model gpt-5\.4-resolved · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(JSON.stringify(cards.at(-1)?.card ?? {}), /会话：sessionKind coding · 恢复态 否 · 中断恢复 否/);
});

test('launcher submit keeps a blocked coding startup in FAILED instead of rewriting it to STARTING', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const blockedOutput = '检测到当前 Codex 版本 0.120.0 属于已知不兼容版本，可能导致任务执行中被异常打断。请尽快升级到最新版本后重试。';
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9'
  });
  const session = createMockSession({
    lifecycle: 'FAILED',
    checkpointOutput: blockedOutput,
    codexThreadId: 'coding-thread-blocked'
  });
  const { service } = createTestService({
    sent,
    registry,
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();
  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_startup_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);

  assert.equal(service.getTask('T1')?.lifecycle, 'FAILED');
  assert.match(service.getTask('T1')?.checkpointOutput ?? '', /已知不兼容版本/);
  const cardText = collectCardTextContents(cards.at(-1)?.card ?? {}).join('\n');
  assert.equal(sent.some((line) => /正在启动 Codex 会话/.test(line)), false);
  assert.doesNotMatch(cardText, /启动中|STARTING/);
  assert.match(cardText, /任务状态：FAILED|任务状态：失败/);
});

test('launcher submit persists runtime warnings from startup snapshot and status query keeps the fixed warning line', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const warning = {
    code: 'known_bad_codex_version',
    message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
    version: '0.120.0',
    overrideActive: true
  };
  const registry = createMockRegistry({
    nextTaskId: 1,
    lastActiveFeishuThreadId: 'feishu:chat-9'
  });
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'coding-thread-warning',
    runtimeWarnings: [warning]
  });
  const { service } = createTestService({
    sent,
    registry,
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_startup_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.syncStartupCardForLastActiveThread();
  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_startup_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);

  assert.equal(service.getTask('T1')?.runtimeWarnings?.[0]?.code, 'known_bad_codex_version');
  assert.equal((registry.getSessionRecord('T1') as any)?.runtimeWarnings?.[0]?.code, 'known_bad_codex_version');
  await service.handleInboundMessage({ threadId: 'feishu:chat-9', text: '查询 T1 状态' });
  assert.match(sent[sent.length - 1] ?? '', /当前Codex版本存在不兼容问题，请尽快升级到最新版本/);
});

test('opening the task picker keeps a warning-only empty coding task for diagnostics', async () => {
  const warning = {
    code: 'known_bad_codex_version',
    message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
    version: '0.120.0',
    overrideActive: true
  };
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-9',
        displayMode: 'assistant',
        statusCardMode: 'launcher',
        statusCardMessageId: 'om_card_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const warningSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'coding-thread-warning-only',
    runtimeWarnings: [warning]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    sessionFactory: () => warningSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_fallback';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_card_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);
  await service.handleCardAction({ threadId: 'feishu:chat-9', kind: 'open_task_picker', messageId: 'om_card_1' } as any);

  assert.equal(service.getTask('T1')?.runtimeWarnings?.[0]?.code, 'known_bad_codex_version');
  assert.equal(registry.deleteSessionRecordCalls.length, 0);
  assert.equal(cards.some((entry) => JSON.stringify(entry.card).includes('T1')), true);
});

test('opening the task picker prunes a launcher-created empty coding task and frees its Tn', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-9',
        displayMode: 'assistant',
        statusCardMode: 'launcher',
        statusCardMessageId: 'om_card_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let calls = 0;
  const { service } = createTestService({
    sent: [],
    registry,
    sessionFactory: () => {
      calls += 1;
      return calls === 1 ? codingSessionA : codingSessionB;
    },
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_fallback';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleCardAction({
    threadId: 'feishu:chat-9',
    messageId: 'om_card_1',
    kind: 'submit_launch_coding',
    cwd: EXISTING_PROJECT_CWD
  } as any);
  await service.handleCardAction({ threadId: 'feishu:chat-9', kind: 'open_task_picker', messageId: 'om_card_1' } as any);

  assert.equal(codingSessionA.closed, true);
  assert.deepEqual(registry.deleteSessionRecordCalls, ['T1']);
  assert.equal(service.getTask('T1'), undefined);
  assert.equal(registry.getThreadUiState('feishu:chat-9')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-9')?.currentCodingTaskId, undefined);
  assert.equal(JSON.stringify(cards.at(-1)?.card ?? {}).includes('T1'), false);

  await service.handleCardAction({ threadId: 'feishu:chat-9', kind: 'create_new_task', messageId: 'om_card_1' } as any);

  assert.deepEqual(registry.reserveCalls, ['T1', 'T1']);
  assert.equal(service.getTask('T1')?.cwd, EXISTING_PROJECT_CWD);
  assert.equal(service.getTask('T2'), undefined);
});

test('starting another coding task sends a fresh status card instead of only updating the old one', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let calls = 0;
  const { service } = createTestService({
    sent: [],
    registry,
    sessionFactory: () => {
      calls += 1;
      return calls === 1 ? codingSessionA : codingSessionB;
    },
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return `om_card_${cards.filter((item) => item.kind === 'send').length}`;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project\\Subdir 下开一个 codex 窗口' });

  assert.equal(cards.map((item) => item.kind).join(','), 'send,send');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMessageId, 'om_card_2');
});

test('create new task card action reuses the current coding task cwd and updates the tracked status card', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let codingIndex = 0;
  const { service } = createTestService({
    sent: [],
    registry,
    codingSessionFactory: () => (codingIndex++ === 0 ? codingSessionA : codingSessionB),
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: `帮我在 ${EXISTING_PROJECT_CWD} 下开一个 codex 窗口` });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 修复当前项目的上下文' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'create_new_task', messageId: 'om_card_1' } as any);

  assert.equal(service.getTask('T1')?.cwd, EXISTING_PROJECT_CWD);
  assert.equal(service.getTask('T2')?.cwd, EXISTING_PROJECT_CWD);
  assert.equal(codingSessionB.started, true);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T2');
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /当前 Coding 目标：T2/);
});

test('explicit coding reply sends a reply status card instead of the old running receipt when cards are available', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_' + cards.filter((item) => item.kind === 'send').length;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'text_input',
    output: 'Please input your response:',
    waitHint: '对 T1 输入: xxx'
  });
  const sendCountBeforeReply = cards.filter((item) => item.kind === 'send').length;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续下一步' });

  assert.deepEqual(session.replies.at(-1), { action: 'input_text', text: '继续下一步' });
  assert.equal(cards.filter((item) => item.kind === 'send').length, sendCountBeforeReply + 1);
  assert.equal(/消息已送达|已恢复执行|待会话就绪后自动执行|已恢复会话/.test(sent.at(-1) ?? ''), false);
  const cardJson = JSON.stringify(cards.filter((item) => item.kind === 'send').at(-1)?.card ?? {});
  assert.match(cardJson, /T1 · 执行中/);
  assert.match(cardJson, /当前阶段：执行中/);
  assert.match(cardJson, /最近动作：正在推进当前任务/);
  assert.match(cardJson, /最近更新：0 秒前|最近更新：\d+ 秒前/);
  assert.match(cardJson, /query_current_task/);
  assert.match(cardJson, /查询任务进展/);
});

test('reply status card uses a 10 second refresh cadence by default', async () => {
  const sent: string[] = [];
  const intervalHarness = createMockIntervalScheduler();
  const session = createMockSession({ lifecycle: 'RUNNING_TURN', liveBuffer: 'still running', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async () => 'om_card_1',
    updateCardImpl: async () => {},
    replyStatusScheduler: intervalHarness.scheduler
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });

  assert.deepEqual(intervalHarness.getActiveIntervals(), [10_000]);
  assert.equal(intervalHarness.activeCount(), 1);
});

test('implicit coding reply sends a fresh reply status card and later completion updates only the latest one', async () => {
  const sent: string[] = [];
  const timeline: Array<{ kind: 'send' | 'update'; messageId: string; cardJson: string }> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async (_threadId, card) => {
      sendIndex += 1;
      const messageId = 'om_card_' + sendIndex;
      timeline.push({ kind: 'send', messageId, cardJson: JSON.stringify(card) });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      timeline.push({ kind: 'update', messageId, cardJson: JSON.stringify(card) });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  timeline.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修复第一轮' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'first done' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修复第二轮' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'second done' });

  assert.equal(timeline.filter((entry) => entry.kind === 'send').length, 2);
  assert.equal(timeline.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_2' && /已完成/.test(entry.cardJson)), true);
  assert.equal(timeline.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_3' && /已完成/.test(entry.cardJson)), true);
  const secondSendIndex = timeline.findIndex((entry) => entry.kind === 'send' && entry.messageId === 'om_card_3');
  assert.equal(
    timeline.slice(secondSendIndex + 1).some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_2'),
    false
  );
});

test('reply status card refresh updates the active card in place and stops after interruption', async () => {
  const sent: string[] = [];
  const intervalHarness = createMockIntervalScheduler();
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const session = createMockSession({ lifecycle: 'RUNNING_TURN', liveBuffer: 'still running', codexThreadId: 'coding-thread-1' });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async () => {
      sendIndex += 1;
      return 'om_card_' + sendIndex;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, cardJson: JSON.stringify(card) });
    },
    replyStatusScheduler: intervalHarness.scheduler,
    replyStatusRefreshMs: 1234
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  updates.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });

  assert.deepEqual(intervalHarness.getActiveIntervals(), [1234]);
  assert.equal(intervalHarness.activeCount(), 1);

  await intervalHarness.tickAll();

  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /T1 · 执行中/.test(entry.cardJson)), true);

  await service.handleWorkerEvent({ type: 'task_failed', taskId: 'T1', output: 'ordinary tool stderr', interruptionKind: 'unknown' } as any);

  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /执行失败/.test(entry.cardJson)), true);
  assert.equal(intervalHarness.activeCount(), 0);
  const updateCountAfterFailure = updates.length;

  await intervalHarness.tickAll();

  assert.equal(updates.length, updateCountAfterFailure);
});

test('reply status card refresh renders human-readable analysis progress and relative update time', async () => {
  const sent: string[] = [];
  const intervalHarness = createMockIntervalScheduler();
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const originalNow = Date.now;
  const baseNow = Date.parse('2026-04-10T00:00:00.000Z');
  let now = baseNow;
  Date.now = () => now;

  try {
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: 'still running',
      codexThreadId: 'coding-thread-1',
      activeCommand: true,
      activeCommandCommand: 'Get-Content .\\src\\communicate\\channel\\feishu-service.ts',
      activeCommandStartedAt: new Date(baseNow).toISOString(),
      lastCommandProgressAt: new Date(baseNow).toISOString(),
      lastProgressAt: new Date(baseNow).toISOString()
    });
    const { service } = createTestService({
      sent,
      session,
      sendCardImpl: async () => 'om_card_2',
      updateCardImpl: async (messageId, card) => {
        updates.push({ messageId, cardJson: JSON.stringify(card) });
      },
      replyStatusScheduler: intervalHarness.scheduler
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
    updates.length = 0;

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
    now += 30_000;
    await intervalHarness.tickAll();

    const cardJson = updates.at(-1)?.cardJson ?? '';
    assert.match(cardJson, /T1 · 分析中/);
    assert.match(cardJson, /当前阶段：分析中/);
    assert.match(cardJson, /最近动作：正在阅读相关代码/);
    assert.match(cardJson, /最近更新：30 秒前/);
  } finally {
    Date.now = originalNow;
  }
});

test('reply status card shows waiting-for-confirm progress instead of collapsing directly to completed', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; cardJson: string }> = [];
  const originalNow = Date.now;
  const baseNow = Date.parse('2026-04-10T00:00:00.000Z');
  let now = baseNow;
  Date.now = () => now;

  try {
    const session = createMockSession({
      lifecycle: 'RUNNING_TURN',
      liveBuffer: 'still running',
      codexThreadId: 'coding-thread-1',
      lastProgressAt: new Date(baseNow).toISOString()
    });
    const { service } = createTestService({
      sent,
      session,
      sendCardImpl: async (_threadId, card) => {
        cards.push({ kind: 'send', messageId: 'om_card_2', cardJson: JSON.stringify(card) });
        return 'om_card_2';
      },
      updateCardImpl: async (messageId, card) => {
        cards.push({ kind: 'update', messageId, cardJson: JSON.stringify(card) });
      }
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });

    now += 40_000;
    session.setSnapshot({
      lifecycle: 'WAITING_USER',
      waitKind: 'confirm',
      checkpointOutput: 'Allow this command?'
    });
    await service.handleWorkerEvent({
      type: 'task_waiting_user',
      taskId: 'T1',
      waitKind: 'confirm',
      output: 'Allow this command?',
      waitHint: '对 T1 允许'
    });

    const cardJson = [...cards].reverse().find((entry) => /T1 · 等待你确认/.test(entry.cardJson))?.cardJson ?? '';
    assert.match(cardJson, /T1 · 等待你确认/);
    assert.match(cardJson, /当前阶段：等待你确认/);
    assert.match(cardJson, /最近动作：Codex 请求执行一项需要你确认的操作/);
    assert.match(cardJson, /最近更新：40 秒前/);
  } finally {
    Date.now = originalNow;
  }
});

test('reply status card marks stalled command execution and query_current_task returns the last Codex reply body', async () => {
  const sent: string[] = [];
  const intervalHarness = createMockIntervalScheduler();
  const sentCards: Array<{ messageId: string; cardJson: string }> = [];
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const quietSince = new Date(Date.now() - 20 * 60_000).toISOString();
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'still running',
    checkpointOutput: '上一轮回复：已经开始跑测试。',
    codexThreadId: 'coding-thread-1',
    activeCommand: true,
    activeCommandCommand: 'npm test',
    activeCommandStartedAt: quietSince,
    lastCommandProgressAt: quietSince,
    lastProgressAt: quietSince
  });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async (_threadId, card) => {
      sendIndex += 1;
      const messageId = 'om_card_' + sendIndex;
      sentCards.push({ messageId, cardJson: JSON.stringify(card) });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, cardJson: JSON.stringify(card) });
    },
    replyStatusScheduler: intervalHarness.scheduler,
    replyStatusRefreshMs: 1234
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  updates.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });

  assert.equal(sentCards.some((entry) => entry.messageId === 'om_card_2' && /T1 · 暂时无新进展/.test(entry.cardJson)), false);
  assert.equal(sentCards.some((entry) => entry.messageId === 'om_card_2' && /当前阶段：暂时无新进展/.test(entry.cardJson)), false);
  assert.equal(sentCards.some((entry) => entry.messageId === 'om_card_2' && /T1 · 验证中/.test(entry.cardJson)), true);
  assert.equal(sentCards.some((entry) => entry.messageId === 'om_card_2' && /当前阶段：验证中/.test(entry.cardJson)), true);
  assert.equal(sentCards.some((entry) => entry.messageId === 'om_card_2' && /打断当前任务/.test(entry.cardJson)), false);

  await intervalHarness.tickAll();
  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /T1 · 暂时无新进展/.test(entry.cardJson)), true);
  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /当前阶段：暂时无新进展/.test(entry.cardJson)), true);
  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /最近动作：正在验证修改/.test(entry.cardJson)), true);
  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /打断当前任务/.test(entry.cardJson)), true);

  sent.length = 0;
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_2', cardSource: 'reply_status_card' } as any);

  assert.match(sent.at(-1) ?? '', /上一轮回复：已经开始跑测试。/);
  assert.doesNotMatch(sent.at(-1) ?? '', /静默时长 20 分钟/);
});

test('reply status card records stall diagnostics when it first becomes suspected stalled and when interrupt is requested', async () => {
  const sent: string[] = [];
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const intervalHarness = createMockIntervalScheduler();
  const quietSince = new Date(Date.now() - 20 * 60_000).toISOString();
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'still running',
    codexThreadId: 'coding-thread-1',
    activeCommand: true,
    activeCommandCommand: 'npm test',
    activeCommandStartedAt: quietSince,
    lastCommandProgressAt: quietSince,
    lastProgressAt: quietSince
  });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async () => {
      sendIndex += 1;
      return 'om_card_' + sendIndex;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, cardJson: JSON.stringify(card) });
    },
    replyStatusScheduler: intervalHarness.scheduler,
    replyStatusRefreshMs: 1234
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  updates.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
  await intervalHarness.tickAll();
  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /T1 · 暂时无新进展/.test(entry.cardJson)), true);
  const suspectedDiagnostic = session.stallDiagnostics.find((entry) => entry.trigger === 'reply_status_suspected_stalled');
  assert.ok(suspectedDiagnostic);
  assert.equal(suspectedDiagnostic?.threadId, 'feishu:chat-1');
  assert.equal(suspectedDiagnostic?.stallConfirmations, 1);
  assert.equal(suspectedDiagnostic?.replyStatusCardMessageId, 'om_card_2');
  assert.equal(typeof suspectedDiagnostic?.quietMs, 'number');

  await intervalHarness.tickAll();
  assert.equal(session.stallDiagnostics.some((entry) => entry.trigger === 'reply_status_suspected_stalled'), true);

  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'interrupt_stalled_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);

  const interruptDiagnostic = session.stallDiagnostics.find((entry) => entry.trigger === 'reply_status_interrupt_requested');
  assert.ok(interruptDiagnostic);
  assert.equal(interruptDiagnostic?.threadId, 'feishu:chat-1');
  assert.equal(interruptDiagnostic?.replyStatusCardMessageId, 'om_card_2');
});

test('text query status prefers command quiet time over general progress when a command is still active', async () => {
  const sent: string[] = [];
  const quietSince = new Date(Date.now() - 20 * 60_000).toISOString();
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'still running',
    codexThreadId: 'coding-thread-1',
    activeCommand: true,
    activeCommandCommand: 'npm test',
    activeCommandStartedAt: quietSince,
    lastCommandProgressAt: quietSince,
    lastProgressAt: new Date().toISOString()
  });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async () => {
      sendIndex += 1;
      return 'om_card_' + sendIndex;
    },
    updateCardImpl: async () => {}
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 状态' });

  assert.match(sent.at(-1) ?? '', /静默时长 20 分钟/);
  assert.match(sent.at(-1) ?? '', /配置 model 未设置 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.match(sent.at(-1) ?? '', /会话 sessionKind coding · 恢复态 否 · 中断恢复 否/);
});

test('interrupting a suspected stalled task keeps the card in interrupting state, auto-summarizes progress, and adds follow-up safeguards only for later user input', async () => {
  const sent: string[] = [];
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const intervalHarness = createMockIntervalScheduler();
  const interruptGate = createDeferred<{ interrupted: boolean; turnId?: string | null }>();
  const quietSince = new Date(Date.now() - 20 * 60_000).toISOString();
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'still running',
    codexThreadId: 'coding-thread-1',
    activeCommand: true,
    activeCommandCommand: 'npm test',
    activeCommandStartedAt: quietSince,
    lastCommandProgressAt: quietSince,
    lastProgressAt: quietSince,
    interruptImpl: () => interruptGate.promise
  });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async () => {
      sendIndex += 1;
      return 'om_card_' + sendIndex;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, cardJson: JSON.stringify(card) });
    },
    replyStatusScheduler: intervalHarness.scheduler,
    replyStatusRefreshMs: 1234
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  updates.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
  await intervalHarness.tickAll();
  await intervalHarness.tickAll();

  const interruptPromise = service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'interrupt_stalled_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);
  await Promise.resolve();

  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /打断中/.test(entry.cardJson)), true);
  assert.equal(session.replies.length, 1);

  interruptGate.resolve({ interrupted: true, turnId: 'turn-1' });
  await interruptPromise;

  assert.deepEqual(session.replies[1], { action: 'input_text', text: '请总结当前进展。' });

  session.setSnapshot({
    lifecycle: 'IDLE',
    activeCommand: false,
    activeCommandCommand: undefined,
    activeCommandStartedAt: undefined,
    lastCommandProgressAt: undefined
  });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: '当前进展：已经定位到失败测试。' });

  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /已完成/.test(entry.cardJson)), true);

  sent.length = 0;
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修复' });

  assert.equal(session.replies.length, 3);
  assert.match(String(session.replies[2]?.text ?? ''), /继续修复/);
  assert.match(String(session.replies[2]?.text ?? ''), /命令级硬超时/);
  assert.equal(/命令级硬超时/.test(String(session.replies[1]?.text ?? '')), false);
});

test('stall recovery does not inject hidden guardrails into confirm_polish_send payloads', async () => {
  const sent: string[] = [];
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const intervalHarness = createMockIntervalScheduler();
  const quietSince = new Date(Date.now() - 20 * 60_000).toISOString();
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'still running',
    codexThreadId: 'coding-thread-1',
    activeCommand: true,
    activeCommandCommand: 'npm test',
    activeCommandStartedAt: quietSince,
    lastCommandProgressAt: quietSince,
    lastProgressAt: quietSince
  });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    polishRewrite: () => '润色后的候选',
    sendCardImpl: async () => {
      sendIndex += 1;
      return 'om_card_' + sendIndex;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, cardJson: JSON.stringify(card) });
    },
    replyStatusScheduler: intervalHarness.scheduler,
    replyStatusRefreshMs: 1234
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
  await intervalHarness.tickAll();
  await intervalHarness.tickAll();

  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'interrupt_stalled_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);

  session.setSnapshot({
    lifecycle: 'IDLE',
    activeCommand: false,
    activeCommandCommand: undefined,
    activeCommandStartedAt: undefined,
    lastCommandProgressAt: undefined
  });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: '当前进展：已经定位到失败测试。' });

  await service.handleInboundMessage({
    threadId: 'feishu:chat-1',
    text: '对 T1 请帮我润色我的话语后发送给codex: 继续修复这个任务'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 确认发送' });

  assert.deepEqual(session.replies.at(-1), { action: 'input_text', text: '润色后的候选' });
});

test('stall recovery summary send failure rolls back hidden guardrails for later user input', async () => {
  const sent: string[] = [];
  const updates: Array<{ messageId: string; cardJson: string }> = [];
  const intervalHarness = createMockIntervalScheduler();
  const quietSince = new Date(Date.now() - 20 * 60_000).toISOString();
  const session = createMockSession({
    lifecycle: 'RUNNING_TURN',
    liveBuffer: 'still running',
    codexThreadId: 'coding-thread-1',
    activeCommand: true,
    activeCommandCommand: 'npm test',
    activeCommandStartedAt: quietSince,
    lastCommandProgressAt: quietSince,
    lastProgressAt: quietSince
  });
  const originalSendReply = session.sendReply.bind(session);
  session.sendReply = function(reply: Record<string, unknown>) {
    if (reply.action === 'input_text' && reply.text === '请总结当前进展。') {
      throw new Error('summary send failed');
    }
    originalSendReply(reply);
  };
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async () => {
      sendIndex += 1;
      return 'om_card_' + sendIndex;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, cardJson: JSON.stringify(card) });
    },
    replyStatusScheduler: intervalHarness.scheduler,
    replyStatusRefreshMs: 1234
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  updates.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
  await intervalHarness.tickAll();
  await intervalHarness.tickAll();

  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'interrupt_stalled_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);

  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /打断中/.test(entry.cardJson)), true);
  assert.equal(updates.some((entry) => entry.messageId === 'om_card_2' && /已完成/.test(entry.cardJson)), true);
  assert.match(sent.at(-1) ?? '', /打断失败|summary send failed/);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修复' });

  assert.equal(/命令级硬超时/.test(String(session.replies.at(-1)?.text ?? '')), false);
});

test('query action from a reply status card keeps the tracked mode status card intact', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async (_threadId, card) => {
      sendIndex += 1;
      const messageId = 'om_card_' + sendIndex;
      cards.push({ kind: 'send', messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  cards.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现状态卡' });
  const sendCountBeforeQuery = cards.filter((entry) => entry.kind === 'send').length;

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_2' } as any);

  assert.equal(cards.filter((entry) => entry.kind === 'send').length, sendCountBeforeQuery);
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_1'), true);
  assert.match(sent.at(-1) ?? '', /暂无上一轮 Codex 回复。/);
  assert.doesNotMatch(sent.at(-1) ?? '', /最近摘要|静默时长|状态/);
});

test('stale reply status card actions do not poison the tracked mode status card alias', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    session,
    sendCardImpl: async (_threadId, card) => {
      sendIndex += 1;
      const messageId = 'om_card_' + sendIndex;
      cards.push({ kind: 'send', messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  cards.length = 0;

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现第一轮' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'first done' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现第二轮' });
  const sendCountBeforeActions = cards.filter((entry) => entry.kind === 'send').length;

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'query_current_task', messageId: 'om_card_2' } as any);
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' } as any);

  assert.equal(cards.filter((entry) => entry.kind === 'send').length, sendCountBeforeActions);
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_1'), true);
});

test('reply status card actions remain isolated from the mode status card after a service restart', async () => {
  const registry = createMockRegistry({ nextTaskId: 1 });
  const firstSent: string[] = [];
  const firstCards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const firstSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  let firstSendIndex = 0;
  const first = createTestService({
    sent: firstSent,
    session: firstSession,
    registry,
    sendCardImpl: async (_threadId, card) => {
      firstSendIndex += 1;
      const messageId = 'om_card_' + firstSendIndex;
      firstCards.push({ kind: 'send', messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      firstCards.push({ kind: 'update', messageId, card });
    }
  });

  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现第一轮' });

  const restartedCards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  let restartedSendIndex = 0;
  const restarted = createTestService({
    sent: [],
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' }),
    registry,
    sendCardImpl: async (_threadId, card) => {
      restartedSendIndex += 1;
      const messageId = 'om_card_restart_' + restartedSendIndex;
      restartedCards.push({ kind: 'send', messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      restartedCards.push({ kind: 'update', messageId, card });
    }
  });

  await restarted.service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'query_current_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);
  await restarted.service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' } as any);

  assert.equal(restartedCards.filter((entry) => entry.kind === 'send').length, 0);
  assert.equal(restartedCards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_1'), true);
});

test('stale query action from a pre-restart reply status card does not query the new current task', async () => {
  const registry = createMockRegistry({ nextTaskId: 1 });
  const first = createTestService({
    sent: [],
    sessionFactory: (sessionOptions) =>
      createMockSession({
        lifecycle: 'IDLE',
        codexThreadId: `coding-thread-${String(sessionOptions.taskId)}`
      }),
    registry,
    sendCardImpl: async (_threadId, _card) => 'om_card_1',
    updateCardImpl: async () => {}
  });

  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现第一轮' });

  let restartedSendIndex = 0;
  const restartedSent: string[] = [];
  const restarted = createTestService({
    sent: restartedSent,
    sessionFactory: (sessionOptions) =>
      createMockSession({
        lifecycle: 'IDLE',
        codexThreadId: `coding-thread-${String(sessionOptions.taskId)}`
      }),
    registry,
    sendCardImpl: async (_threadId, _card) => {
      restartedSendIndex += 1;
      return `om_restart_${restartedSendIndex}`;
    },
    updateCardImpl: async () => {}
  });

  await restarted.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  restartedSent.length = 0;
  await restarted.service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'query_current_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);

  assert.match(restartedSent.at(-1) ?? '', /状态卡已更新|最新卡片|已失效/);
  assert.equal(restartedSent.some((entry) => /任务 T2/.test(entry)), false);
});

test('stale interrupt action from a pre-restart reply status card reports the card as expired', async () => {
  const registry = createMockRegistry({ nextTaskId: 1 });
  const first = createTestService({
    sent: [],
    sessionFactory: (sessionOptions) =>
      createMockSession({
        lifecycle: 'RUNNING_TURN',
        codexThreadId: `coding-thread-${String(sessionOptions.taskId)}`,
        activeCommand: true,
        activeCommandCommand: 'npm test',
        activeCommandStartedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        lastCommandProgressAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        lastProgressAt: new Date(Date.now() - 20 * 60_000).toISOString()
      }),
    registry,
    sendCardImpl: async (_threadId, _card) => 'om_card_2',
    updateCardImpl: async () => {}
  });

  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });

  const restartedSent: string[] = [];
  const restarted = createTestService({
    sent: restartedSent,
    sessionFactory: (sessionOptions) =>
      createMockSession({
        lifecycle: 'RUNNING_TURN',
        codexThreadId: `coding-thread-${String(sessionOptions.taskId)}`,
        activeCommand: true,
        activeCommandCommand: 'npm test',
        activeCommandStartedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        lastCommandProgressAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        lastProgressAt: new Date(Date.now() - 20 * 60_000).toISOString()
      }),
    registry,
    sendCardImpl: async (_threadId, _card) => 'om_restart_1',
    updateCardImpl: async () => {}
  });

  await restarted.service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'interrupt_stalled_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);

  assert.match(restartedSent.at(-1) ?? '', /状态卡已失效|最新卡片|状态卡已更新/);
  assert.equal(restartedSent.some((entry) => /当前没有可打断的运行中任务/.test(entry)), false);
});

test('stale query action from an older reply status card does not query a newer task', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  let sendIndex = 0;
  const { service } = createTestService({
    sent,
    sessionFactory: (sessionOptions) => {
      const taskId = String(sessionOptions.taskId);
      const session = createMockSession({
        lifecycle: 'IDLE',
        codexThreadId: `coding-thread-${taskId}`
      });
      return session;
    },
    sendCardImpl: async (_threadId, card) => {
      sendIndex += 1;
      const messageId = 'om_card_' + sendIndex;
      cards.push({ kind: 'send', messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现第一轮' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'first done' });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现第二轮' });

  sent.length = 0;
  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    kind: 'query_current_task',
    messageId: 'om_card_2',
    cardSource: 'reply_status_card'
  } as any);

  assert.match(sent.at(-1) ?? '', /状态卡已更新|最新卡片/);
  assert.equal(sent.some((entry) => /任务 T2/.test(entry)), false);
});

test('create new task card action falls back to launcher selected cwd when current task is unavailable', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'assistant',
          statusCardMessageId: 'om_card_1',
          launcherSelectedCwd: EXISTING_PROJECT_CWD
        }
      ]
    });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    registry,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'create_new_task', messageId: 'om_card_1' } as any);

  assert.equal(service.getTask('T1')?.cwd, EXISTING_PROJECT_CWD);
  assert.equal(codingSession.started, true);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
});

test('status card keeps main actions visible when status mode has no recoverable coding tasks', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 1,
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'assistant',
        statusCardMode: 'status',
        statusCardMessageId: 'om_card_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const { service } = createTestService({
    sent: [],
    registry,
    session: createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'switch_mode_assistant', messageId: 'om_card_1' } as any);

  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
  const cardJson = JSON.stringify(cards.at(-1)?.card ?? {});
  assert.match(cardJson, /Codex 模式状态/);
  assert.match(cardJson, /新建任务/);
  assert.match(cardJson, /返回启动卡/);
  assert.equal(/启动 Codex 编程窗口/.test(cardJson), false);
});

test('create new task card action validates a stale current task cwd before starting', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: 'D:\\DefinitelyMissing\\Project',
        logPath: path.join(EXISTING_PROJECT_CWD, 'logs', 'communicate', 'T1.log'),
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复之前的持久化任务'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1',
        statusCardMessageId: 'om_card_1',
        launcherSelectedCwd: EXISTING_PROJECT_CWD
      }
    ]
  });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  const { service } = createTestService({
    sent: [],
    registry,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'create_new_task', messageId: 'om_card_1' } as any);

  assert.equal(service.getTask('T2'), undefined);
  assert.equal(codingSession.started, false);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMode, 'launcher');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherDraftCwd, 'D:\\DefinitelyMissing\\Project');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherError, '项目目录不存在。');
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /项目目录不存在。/);
});

test('return to launcher card action resets status view while preserving launcher cwd selection', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    registry,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' }),
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\CodexLark 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'return_to_launcher', messageId: 'om_card_1' } as any);

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardMode, 'launcher');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.statusCardPickerOpen, false);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherSelectedCwd, 'D:\\Workspace\\CodexLark');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherDraftCwd, undefined);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.launcherError, undefined);
  assert.equal(codingSession.closed, false);
  assert.equal(service.getTask('T1')?.lifecycle, 'IDLE');
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
  assert.match(JSON.stringify(cards.at(-1)?.card ?? {}), /启动 Codex 编程窗口/);
});

test('starting another coding task discards older empty coding tasks without real conversation and reuses the same Tn', async () => {
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({ nextTaskId: 1 });
    const codingSessionA = createMockSession({
      lifecycle: 'IDLE',
      codexThreadId: 'coding-thread-1',
      logPath: logs.writeLog('T1', '')
    });
    const codingSessionB = createMockSession({
      lifecycle: 'IDLE',
      codexThreadId: 'coding-thread-2',
      logPath: logs.writeLog('T2', '')
    });
    let calls = 0;
    const { service } = createTestService({
      sent: [],
      registry,
      sessionFactory: () => {
        calls += 1;
        return calls === 1 ? codingSessionA : codingSessionB;
      }
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project\\Subdir 下开一个 codex 窗口' });

    assert.equal(codingSessionA.closed, true);
    assert.deepEqual(registry.deleteSessionRecordCalls, ['T1']);
    assert.deepEqual(registry.reserveCalls, ['T1', 'T1']);
    assert.equal(service.getTask('T1')?.cwd, 'D:\\Workspace\\Project\\Subdir');
    assert.equal(registry.getSessionRecord('T1')?.cwd, 'D:\\Workspace\\Project\\Subdir');
    assert.equal(service.getTask('T2'), undefined);
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  } finally {
    logs.cleanup();
  }
});

test('card action switches display mode and refreshes current coding target', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    registry,
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'switch_mode_coding', messageId: 'om_card_1' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续实现状态卡' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.deepEqual(session.replies.at(-1), { action: 'free_text', text: '继续实现状态卡' });
  assert.equal(cards.some((entry) => entry.kind === 'update' && entry.messageId === 'om_card_1'), true);
  assert.equal(cards.some((entry) => entry.kind === 'send' && /查询任务进展/.test(JSON.stringify(entry.card))), true);
});

test('pick current task card action also switches to coding mode and routes ordinary text to that task', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionA = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const codingSessionB = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-2' });
  let codingIndex = 0;
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: () => (codingIndex++ === 0 ? codingSessionA : codingSessionB),
    assistantSessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' })
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 修复第一个任务的上下文' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project\\Subdir 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'pick_current_task', taskId: 'T1', messageId: 'om_card_1' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修第一个任务' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.deepEqual(codingSessionA.replies.at(-1), { action: 'free_text', text: '继续修第一个任务' });
  assert.equal(codingSessionB.replies.length, 0);
});

test('task picker card shows the latest five recoverable coding tasks with placeholder summaries when needed', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 11,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project\\Oldest',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:00.000Z] SESSION OPEN {"taskId":"T1"}\n[2026-03-26T00:00:01.000Z] SESSION READY\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        },
        {
          taskId: 'T2',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-2',
          cwd: 'D:\\Workspace\\Project\\Second',
          logPath: logs.writeLog('T2', '[2026-03-26T00:00:02.000Z] SESSION OPEN {"taskId":"T2"}\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: '继续整理遗留任务的上下文。'
        },
        {
          taskId: 'T3',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-3',
          cwd: 'D:\\Workspace\\Project\\Third',
          logPath: logs.writeLog('T3', '[2026-03-26T00:00:03.000Z] SESSION OPEN {"taskId":"T3"}\n[2026-03-26T00:00:04.000Z] SESSION READY\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        },
        {
          taskId: 'T4',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-4',
          cwd: 'D:\\Workspace\\Project\\Fourth',
          logPath: logs.writeLog('T4', '[2026-03-26T00:00:05.000Z] FEISHU IN 继续排查卡片恢复逻辑\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        },
        {
          taskId: 'T5',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-5',
          cwd: 'D:\\Workspace\\Project\\Fifth',
          logPath: logs.writeLog('T5', '[2026-03-26T00:00:06.000Z] SESSION OPEN {"taskId":"T5"}\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: '补齐恢复态任务在卡片里的展示。'
        },
        {
          taskId: 'T6',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-6',
          cwd: 'D:\\Workspace\\Project\\Sixth',
          logPath: logs.writeLog(
            'T6',
            '[2026-03-26T00:00:07.000Z] SESSION OPEN {"taskId":"T6"}\n我在整理旧任务的输出摘要，准备切换。\n'
          ),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        },
        {
          taskId: 'T7',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-7',
          cwd: 'D:\\Workspace\\Project\\Seventh',
          logPath: logs.writeLog('T7', '[2026-03-26T00:00:08.000Z] SESSION OPEN {"taskId":"T7"}\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: '已完成状态卡任务排序规则调整。'
        },
        {
          taskId: 'T8',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-8',
          cwd: 'D:\\Workspace\\Project\\Newest',
          logPath: logs.writeLog('T8', '[2026-03-26T00:00:09.000Z] SESSION OPEN {"taskId":"T8"}\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: '最新恢复任务：修复任务选择器。'
        },
        {
          taskId: 'T9',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-9',
          cwd: 'D:\\Workspace\\Project\\PlaceholderA',
          logPath: logs.writeLog('T9', '[2026-03-26T00:00:10.000Z] SESSION OPEN {"taskId":"T9"}\n[2026-03-26T00:00:11.000Z] SESSION READY\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已启动，等待你的任务描述。'
        },
        {
          taskId: 'T10',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-10',
          cwd: 'D:\\Workspace\\Project\\PlaceholderB',
          logPath: logs.writeLog('T10', '[2026-03-26T00:00:12.000Z] SESSION OPEN {"taskId":"T10"}\n[2026-03-26T00:00:13.000Z] SESSION READY\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession(),
      sendCardImpl: async (_threadId, card) => {
        cards.push({ kind: 'send', card });
        return 'om_card_1';
      },
      updateCardImpl: async (messageId, card) => {
        cards.push({ kind: 'update', messageId, card });
      }
    });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' });

    const cardJson = JSON.stringify(cards.at(-1)?.card ?? {});
    assert.match(cardJson, /切换到 T8/);
    assert.match(cardJson, /切换到 T7/);
    assert.match(cardJson, /切换到 T5/);
    assert.match(cardJson, /切换到 T4/);
    assert.match(cardJson, /切换到 T2/);
    assert.equal(/切换到 T10/.test(cardJson), false);
    assert.equal(/切换到 T9/.test(cardJson), false);
    assert.equal(/切换到 T6/.test(cardJson), false);
    assert.equal(/切换到 T3/.test(cardJson), false);
    assert.equal(/切换到 T1(?!\d)/.test(cardJson), false);
    assert.match(cardJson, /目标：暂无摘要/);
  } finally {
    logs.cleanup();
  }
});

test('task picker card includes failed coding tasks when they remain recoverable', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 4,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project\\FailedRecoverable',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:00.000Z] FEISHU IN 继续补测失败恢复链路\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'FAILED',
          sessionKind: 'coding',
          lastCheckpointOutput: '上一轮执行失败，但上下文还在。'
        },
        {
          taskId: 'T2',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-2',
          cwd: 'D:\\Workspace\\Project\\FailedPlaceholder',
          logPath: logs.writeLog('T2', '[2026-03-26T00:00:01.000Z] SESSION OPEN {"taskId":"T2"}\n[2026-03-26T00:00:02.000Z] SESSION READY\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'FAILED',
          sessionKind: 'coding',
          lastCheckpointOutput: 'Codex 会话已恢复，等待你的任务描述。'
        },
        {
          taskId: 'T3',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-3',
          cwd: 'D:\\Workspace\\Project\\IdleRecoverable',
          logPath: logs.writeLog('T3', '[2026-03-26T00:00:03.000Z] FEISHU IN 当前活跃任务\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession(),
      sendCardImpl: async (_threadId, card) => {
        cards.push({ kind: 'send', card });
        return 'om_card_1';
      },
      updateCardImpl: async (messageId, card) => {
        cards.push({ kind: 'update', messageId, card });
      }
    });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' });

    const cardJson = JSON.stringify(cards.at(-1)?.card ?? {});
    assert.match(cardJson, /T1/);
    assert.match(cardJson, /T2/);
    assert.match(cardJson, /T3/);
    assert.match(cardJson, /目标：暂无摘要/);
  } finally {
    logs.cleanup();
  }
});

test('opening task picker lazily backfills missing goal summaries without triggering a second card refresh', async () => {
  const cardCalls: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const logs = createTempLogFixture();
  const summaryCalls: string[] = [];
  const deferred = createDeferred<string | undefined>();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:05.000Z] FEISHU IN 修复飞书任务切换卡摘要不可读问题\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'assistant',
          statusCardMessageId: 'om_card_1'
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession(),
      sendCardImpl: async (_threadId, card) => {
        cardCalls.push({ kind: 'send', card });
        return 'om_card_1';
      },
      updateCardImpl: async (messageId, card) => {
        cardCalls.push({ kind: 'update', messageId, card });
      },
      goalSummaryGenerator: {
        async summarize(input) {
          summaryCalls.push(input.sourceText);
          return await deferred.promise;
        }
      }
    });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' });

    assert.deepEqual(summaryCalls, ['修复飞书任务切换卡摘要不可读问题']);
    assert.equal(service.getTask('T1')?.goalSummaryStatus, 'pending');
    const refreshCountAfterOpen = cardCalls.length;

    deferred.resolve('修复飞书任务切换卡摘要不可读问题');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(service.getTask('T1')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
    assert.equal(registry.getSessionRecord('T1')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
    assert.equal(cardCalls.length, refreshCountAfterOpen);
  } finally {
    logs.cleanup();
  }
});

test('service startup discards recovered empty coding tasks without real conversation', async () => {
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 3,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-empty',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:05.000Z] FEISHU IN 帮我在 D:\\Workspace\\Project 下开一个 codex 窗口\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        },
        {
          taskId: 'T2',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-real',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T2', '[2026-03-26T00:00:06.000Z] FEISHU IN 修复飞书任务切换卡摘要不可读问题\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding',
          goalSummarySourceText: '修复飞书任务切换卡摘要不可读问题'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });

    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession()
    });

    assert.equal(service.getTask('T1'), undefined);
    assert.equal(registry.getSessionRecord('T1'), undefined);
    assert.deepEqual(registry.deleteSessionRecordCalls, ['T1']);
    assert.equal(service.getTask('T2')?.id, 'T2');
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  } finally {
    logs.cleanup();
  }
});

test('restart reuses Tn after discarding an unused recovered empty coding task', async () => {
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-empty',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:05.000Z] FEISHU IN 帮我在 D:\\Workspace\\Project 下开一个 codex 窗口\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'coding',
          currentCodingTaskId: 'T1'
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession({
        lifecycle: 'IDLE',
        codexThreadId: 'coding-thread-1',
        logPath: logs.writeLog('T1-new', '')
      })
    });

    assert.equal(service.getTask('T1'), undefined);
    assert.deepEqual(registry.deleteSessionRecordCalls, ['T1']);

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

    assert.deepEqual(registry.reserveCalls, ['T1']);
    assert.equal(service.getTask('T1')?.cwd, 'D:\\Workspace\\Project');
    assert.equal(service.getTask('T2'), undefined);
  } finally {
    logs.cleanup();
  }
});

test('starting another coding task discards older waiting coding tasks that only contain system output and reuses the same Tn', async () => {
  const logs = createTempLogFixture();
  try {
    const registry = createMockRegistry({ nextTaskId: 1 });
    const codingSessionA = createMockSession({
      lifecycle: 'IDLE',
      codexThreadId: 'coding-thread-1',
      logPath: logs.writeLog('T1', '')
    });
    const codingSessionB = createMockSession({
      lifecycle: 'IDLE',
      codexThreadId: 'coding-thread-2',
      logPath: logs.writeLog('T2', '')
    });
    let calls = 0;
    const { service } = createTestService({
      sent: [],
      registry,
      sessionFactory: () => {
        calls += 1;
        return calls === 1 ? codingSessionA : codingSessionB;
      }
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleWorkerEvent({
      type: 'task_waiting_user',
      taskId: 'T1',
      waitKind: 'choice',
      output: '1. Allow once\n2. Allow always\nSelect an option:',
      waitHint: '请选择授权方式'
    });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project\\Subdir 下开一个 codex 窗口' });

    assert.equal(codingSessionA.closed, true);
    assert.equal(service.getTask('T1')?.cwd, 'D:\\Workspace\\Project\\Subdir');
    assert.equal(registry.getSessionRecord('T1')?.cwd, 'D:\\Workspace\\Project\\Subdir');
    assert.deepEqual(registry.deleteSessionRecordCalls, ['T1']);
    assert.deepEqual(registry.reserveCalls, ['T1', 'T1']);
    assert.equal(service.getTask('T2'), undefined);
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  } finally {
    logs.cleanup();
  }
});

test('lazy goal summary backfill skips launcher-style FEISHU IN lines and uses the first real coding instruction', async () => {
  const logs = createTempLogFixture();
  const summaryCalls: string[] = [];
  const deferred = createDeferred<string | undefined>();
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'coding-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog(
            'T1',
            [
              '[2026-03-26T00:00:05.000Z] FEISHU IN 帮我在 D:\\Workspace\\Project 下开一个 codex 窗口',
              '[2026-03-26T00:00:06.000Z] FEISHU IN 修复飞书任务切换卡摘要不可读问题'
            ].join('\n')
          ),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ]
    });
    const { service } = createTestService({
      sent: [],
      registry,
      session: createMockSession(),
      goalSummaryGenerator: {
        async summarize(input) {
          summaryCalls.push(input.sourceText);
          return await deferred.promise;
        }
      }
    });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'open_task_picker', messageId: 'om_card_1' });

    assert.deepEqual(summaryCalls, ['修复飞书任务切换卡摘要不可读问题']);
    assert.equal(service.getTask('T1')?.goalSummarySourceText, '修复飞书任务切换卡摘要不可读问题');

    deferred.resolve('修复飞书任务切换卡摘要不可读问题');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(service.getTask('T1')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
  } finally {
    logs.cleanup();
  }
});

test('pick current task resumes a recoverable persisted coding task before routing ordinary text', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const resumedSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'persisted-thread-1' });
  const codingSessionFactoryCalls: Array<Record<string, unknown>> = [];
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'persisted-thread-1',
          model: 'gpt-5.4',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:05.000Z] FEISHU IN 继续之前的修复任务\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'IDLE',
          sessionKind: 'coding'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'assistant'
        }
      ]
    });
    const { service } = createTestService({
      sent,
      registry,
      codingSessionFactory: (sessionOptions) => {
        codingSessionFactoryCalls.push({ ...sessionOptions });
        return resumedSession;
      },
      assistantSessionFactory: () => assistantSession
    });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'pick_current_task', taskId: 'T1', messageId: 'om_card_1' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修复旧任务' });

    assert.equal(codingSessionFactoryCalls.length, 1);
    assert.equal(codingSessionFactoryCalls[0]?.mode, 'resume');
    assert.equal(codingSessionFactoryCalls[0]?.resumeThreadId, 'persisted-thread-1');
    assert.equal(codingSessionFactoryCalls[0]?.model, 'gpt-5.4');
    assert.equal(resumedSession.started, true);
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
    assert.deepEqual(resumedSession.replies.at(-1), { action: 'free_text', text: '继续修复旧任务' });
    assert.equal(assistantSession.replies.length, 0);
  } finally {
    logs.cleanup();
  }
});

test('pick current task resumes a recoverable failed persisted coding task before routing ordinary text', async () => {
  const sent: string[] = [];
  const logs = createTempLogFixture();
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const resumedSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'persisted-thread-1' });
  const codingSessionFactoryCalls: Array<Record<string, unknown>> = [];
  try {
    const registry = createMockRegistry({
      nextTaskId: 2,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'persisted-thread-1',
          cwd: 'D:\\Workspace\\Project',
          logPath: logs.writeLog('T1', '[2026-03-26T00:00:05.000Z] FEISHU IN 继续失败后的修复任务\n'),
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          sessionLifecycle: 'FAILED',
          sessionKind: 'coding',
          lastCheckpointOutput: '上一轮失败，但可以继续恢复。'
        }
      ],
      threadUiStates: [
        {
          feishuThreadId: 'feishu:chat-1',
          displayMode: 'assistant'
        }
      ]
    });
    const { service } = createTestService({
      sent,
      registry,
      codingSessionFactory: (sessionOptions) => {
        codingSessionFactoryCalls.push({ ...sessionOptions });
        return resumedSession;
      },
      assistantSessionFactory: () => assistantSession
    });

    await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'pick_current_task', taskId: 'T1', messageId: 'om_card_1' });
    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续修复失败恢复' });

    assert.equal(codingSessionFactoryCalls.length, 1);
    const { resumeContext: pickCurrentResumeContext, ...pickCurrentResumeCall } = codingSessionFactoryCalls[0] as {
      resumeContext?: Record<string, unknown>;
    };
    assert.deepEqual(pickCurrentResumeCall, {
      taskId: 'T1',
      cwd: 'D:\\Workspace\\Project',
      threadId: 'feishu:chat-1',
      mode: 'resume',
      resumeThreadId: 'persisted-thread-1',
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
      interruptedByRestart: true
    });
    assert.deepEqual(pickCurrentResumeContext, {
      sourceSessionLifecycle: 'FAILED'
    });
    assert.equal(resumedSession.started, true);
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
    assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
    assert.deepEqual(resumedSession.replies.at(-1), { action: 'free_text', text: '继续修复失败恢复' });
    assert.equal(assistantSession.replies.length, 0);
  } finally {
    logs.cleanup();
  }
});

test('closing current coding task via card action falls back to assistant mode', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({ sent, registry, session });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'switch_mode_coding', messageId: 'om_card_1' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'close_current_task', messageId: 'om_card_1' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal(session.closed, true);
  assert.match(sent.at(-1) ?? '', /\[模式: 助手\]/);
});

test('closing the last coding task keeps status card main actions visible', async () => {
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const registry = createMockRegistry({ nextTaskId: 1 });
  const session = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent: [],
    registry,
    session,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', card });
      return 'om_card_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'switch_mode_coding', messageId: 'om_card_1' } as any);
  await service.handleCardAction({ threadId: 'feishu:chat-1', kind: 'close_current_task', messageId: 'om_card_1' } as any);

  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_card_1');
  const cardJson = JSON.stringify(cards.at(-1)?.card ?? {});
  assert.match(cardJson, /Codex 模式状态/);
  assert.match(cardJson, /新建任务/);
  assert.match(cardJson, /返回启动卡/);
  assert.equal(/启动 Codex 编程窗口/.test(cardJson), false);
});

test('worker replies are prefixed in assistant mode', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'done' });

  assert.match(sent[sent.length - 1] ?? '', /^\[模式: 助手\]\s*done/);
});

test('assistant worker replies keep assistant prefix even when thread display mode is coding', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: (sessionOptions) =>
      String(sessionOptions.cwd) === DEFAULT_ASSISTANT_CWD ? assistantSession : codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '先作为助手帮我拆解问题' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'assistant done' });

  assert.match(sent[sent.length - 1] ?? '', /^\[模式: 助手\]\s*assistant done/);
});

test('worker replies are prefixed in coding mode', async () => {
  const sent: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({ type: 'task_finished', taskId: 'T1', output: 'done' });

  assert.match(sent[sent.length - 1] ?? '', /^\[模式: Coding \| 当前任务: T1\]/);
  assert.match(sent[sent.length - 1] ?? '', /done/);
});

test('mode status clears an invalid current coding target before reporting state', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' })
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode status' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.match(sent[sent.length - 1] ?? '', /当前 Coding 目标：未绑定/);
});

test('mode task rejects an invalid coding target without recovery metadata', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' })
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode task T1' });

  assert.equal(registry.getThreadUiState('feishu:chat-1'), undefined);
  assert.match(sent[sent.length - 1] ?? '', /不是当前线程可用的 Coding 目标/);
});

test('invalid current coding target falls back to assistant and clears the target', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-2' });
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '失效后应回到助手' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode ?? 'assistant', 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal((service.getTask('T1') as any)?.sessionKind, 'assistant');
  assert.deepEqual(assistantSession.replies[0], { action: 'input_text', text: '失效后应回到助手' });
});

test('accepted assistant input sends a lightweight receipt card without exposing Tn', async () => {
  const sent: string[] = [];
  const cards: Array<Record<string, unknown>> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-1'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push(card);
      return 'om_assistant_receipt_1';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  assert.deepEqual(assistantSession.replies.at(-1), { action: 'input_text', text: '帮我继续分析这个技术方案' });
  assert.equal(cards.length, 1);
  assert.equal((cards[0] as any)?.header?.title?.content, '助手 · 执行中');
  assert.doesNotMatch(JSON.stringify(cards[0]), /T1|任务 T1/);
  const buttons = collectCardButtons((cards[0] as any)?.body);
  assert.deepEqual(buttons.map((button) => button.behaviors), [
    [
      {
        type: 'callback',
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-1'
        }
      }
    ]
  ]);
});

test('assistant receipt is sent alongside an existing coding reply status card instead of overwriting it', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const codingSession = createMockSession({
    lifecycle: 'RUNNING_TURN',
    codexThreadId: 'coding-thread-1',
    lastProgressAt: '2026-04-11T00:00:00.000Z'
  });
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-2'
  });
  const { service } = createTestService({
    sent,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_card_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async () => {}
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode assistant' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  const progressCards = sends.filter((entry) => {
    const title = String((entry.card as any)?.header?.title?.content ?? '');
    return /^T\d+ · /.test(title) || /^助手 · /.test(title);
  });

  assert.equal(progressCards.length, 2);
  assert.notEqual(progressCards[0]?.messageId, progressCards[1]?.messageId);
  assert.match(String((progressCards[0]?.card as any)?.header?.title?.content ?? ''), /^T1 · /);
  assert.equal((progressCards[1]?.card as any)?.header?.title?.content, '助手 · 执行中');
  const assistantButtons = collectCardButtons((progressCards[1]?.card as any)?.body);
  assert.deepEqual(assistantButtons.map((button) => button.behaviors), [
    [
      {
        type: 'callback',
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-2'
        }
      }
    ]
  ]);
});

test('assistant receipt query action resolves the tracked assistant task instead of the current coding task', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const codingSession = createMockSession({
    lifecycle: 'RUNNING_TURN',
    codexThreadId: 'coding-thread-1',
    lastProgressAt: '2026-04-11T00:00:00.000Z'
  });
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-assistant-query-1'
  });
  const { service } = createTestService({
    sent,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_card_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async () => {}
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续观察运行状态' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode assistant' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  const assistantReceiptMessageId = [...sends]
    .reverse()
    .find((entry) => String((entry.card as any)?.header?.title?.content ?? '').startsWith('助手 · '))?.messageId;

  sent.length = 0;
  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    messageId: assistantReceiptMessageId,
    kind: 'query_current_task',
    cardSource: 'assistant_reply_receipt',
    turnId: 'turn-assistant-query-1'
  } as any);

  assert.match(sent.at(-1) ?? '', /任务 T2/);
  assert.equal(sent.some((entry) => /任务 T1/.test(entry)), false);
  assert.equal(sent.some((entry) => /当前没有可用的 Coding 任务/.test(entry)), false);
});

test('assistant receipt query stays bound to the original turn after a later assistant turn starts', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-assistant-a'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第一轮 assistant 输入' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-assistant-a',
    output: 'assistant final answer A'
  });

  assistantSession.setSnapshot({
    lifecycle: 'IDLE',
    activeTurnId: 'turn-assistant-b',
    checkpointOutput: 'assistant final answer A'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第二轮 assistant 输入' });

  sent.length = 0;
  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    messageId: 'om_assistant_receipt_1',
    kind: 'query_current_task',
    cardSource: 'assistant_reply_receipt',
    turnId: 'turn-assistant-a'
  } as any);

  assert.match(sent.at(-1) ?? '', /任务 T1/);
  assert.match(sent.at(-1) ?? '', /状态 IDLE/);
  assert.match(sent.at(-1) ?? '', /assistant final answer A/);
  assert.equal(sent.some((entry) => /状态 RUNNING_TURN/.test(entry)), false);
  assert.equal(sends.length, 2);
  assert.equal(updates.some((entry) => entry.messageId === 'om_assistant_receipt_2'), false);
});

test('late assistant events from an older turn do not overwrite the latest turn receipt card', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-assistant-a'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第一轮 assistant 输入' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-assistant-a',
    output: 'assistant final answer A'
  });

  assistantSession.setSnapshot({
    lifecycle: 'IDLE',
    activeTurnId: 'turn-assistant-b',
    checkpointOutput: 'assistant final answer A'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第二轮 assistant 输入' });
  assert.equal(service.getTask('T1')?.lifecycle, 'RUNNING_TURN');
  updates.length = 0;
  sent.length = 0;

  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-assistant-a',
    output: 'assistant late duplicate A'
  });

  assert.equal(updates.some((entry) => entry.messageId === 'om_assistant_receipt_2'), false);
  assert.equal(updates.some((entry) => entry.messageId === 'om_assistant_receipt_1'), true);
  assert.equal(sent.length, 0);
  assert.equal(service.getTask('T1')?.lifecycle, 'RUNNING_TURN');
  assert.notEqual(service.getTask('T1')?.checkpointOutput, 'assistant late duplicate A');
});

test('turnless assistant events are ignored after a newer turn receipt already exists', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-assistant-a'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第一轮 assistant 输入' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-assistant-a',
    output: 'assistant final answer A'
  });

  assistantSession.setSnapshot({
    lifecycle: 'IDLE',
    activeTurnId: 'turn-assistant-b',
    checkpointOutput: 'assistant final answer A'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第二轮 assistant 输入' });
  updates.length = 0;
  sent.length = 0;

  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant late duplicate without turn id'
  });

  assert.equal(updates.length, 0);
  assert.equal(sent.length, 0);
});

test('turnless late events do not overwrite a newer placeholder receipt that still lacks turn id', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-assistant-a'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第一轮 assistant 输入' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-assistant-a',
    output: 'assistant final answer A'
  });

  assistantSession.setSnapshot({
    lifecycle: 'STARTING',
    activeTurnId: undefined,
    checkpointOutput: 'assistant final answer A'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第二轮 assistant 输入' });
  updates.length = 0;
  sent.length = 0;

  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant late duplicate without turn id'
  });

  assert.equal(updates.length, 0);
  assert.equal(sent.length, 0);
  assert.equal((sends.at(-1)?.card as any)?.header?.title?.content, '助手 · 执行中');
  assert.equal(collectCardButtons((sends.at(-1)?.card as any)?.body).length, 0);
});

test('current turnless terminal after a later assistant turn starts still completes the latest placeholder receipt', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1',
    activeTurnId: 'turn-assistant-a'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第一轮 assistant 输入' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-assistant-a',
    output: 'assistant final answer A'
  });

  assistantSession.setSnapshot({
    lifecycle: 'STARTING',
    activeTurnId: undefined,
    checkpointOutput: 'assistant final answer A'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第二轮 assistant 输入' });
  updates.length = 0;
  sent.length = 0;

  assistantSession.setSnapshot({
    lifecycle: 'IDLE',
    activeTurnId: undefined,
    checkpointOutput: 'assistant final answer B'
  });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant final answer B'
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.messageId, 'om_assistant_receipt_2');
  assert.equal((updates[0]?.card as any)?.header?.title?.content, '助手 · 已完成');
  assert.equal(collectCardButtons((updates[0]?.card as any)?.body).length, 0);
  assert.match(sent.at(-1) ?? '', /assistant final answer B/);
});

test('assistant reply accepted during recovered startup sends a placeholder receipt immediately and updates it to completed', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'assistant-thread-resumed',
    interruptedByRestart: true
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  assert.deepEqual(assistantSession.replies.at(-1), { action: 'input_text', text: '帮我继续分析这个技术方案' });
  assert.equal(sends.length, 1);
  assert.equal(updates.length, 0);
  assert.equal((sends[0]?.card as any)?.header?.title?.content, '助手 · 执行中');
  assert.equal(collectCardButtons((sends[0]?.card as any)?.body).length, 0);

  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-delayed-1',
    output: 'assistant final answer'
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.messageId, 'om_assistant_receipt_1');
  assert.equal((updates[0]?.card as any)?.header?.title?.content, '助手 · 已完成');
  assert.doesNotMatch(JSON.stringify(updates[0]?.card), /T1|任务 T1/);
  const buttons = collectCardButtons((updates[0]?.card as any)?.body);
  assert.deepEqual(buttons.map((button) => button.behaviors), [
    [
      {
        type: 'callback',
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-delayed-1'
        }
      }
    ]
  ]);
});

test('assistant receipt refreshes from starting to running and keeps monitoring progress until the terminal reply arrives', async () => {
  const intervalHarness = createMockIntervalScheduler();
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'STARTING',
    replyLifecycle: 'STARTING',
    codexThreadId: 'assistant-thread-resumed',
    interruptedByRestart: true
  });
  const { service } = createTestService({
    sent: [],
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    },
    replyStatusScheduler: intervalHarness.scheduler
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  assert.equal(sends.length, 1);
  assert.equal((sends[0]?.card as any)?.header?.title?.content, '助手 · 准备中');
  assert.equal(intervalHarness.activeCount(), 1);

  assistantSession.setSnapshot({
    lifecycle: 'RUNNING_TURN',
    activeCommand: true,
    activeCommandCommand: 'Get-Content .\\src\\communicate\\channel\\feishu-service.ts'
  });
  await intervalHarness.tickAll();

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.messageId, 'om_assistant_receipt_1');
  assert.equal((updates[0]?.card as any)?.header?.title?.content, '助手 · 分析中');
  assert.match(JSON.stringify(updates[0]?.card ?? {}), /正在阅读相关代码/);
  assert.equal(intervalHarness.activeCount(), 1);

  assistantSession.setSnapshot({
    lifecycle: 'RUNNING_TURN',
    activeCommand: true,
    activeCommandCommand: 'Set-Content .\\tmp.txt done'
  });
  await intervalHarness.tickAll();

  assert.equal(updates.length, 2);
  assert.equal(updates[1]?.messageId, 'om_assistant_receipt_1');
  assert.equal((updates[1]?.card as any)?.header?.title?.content, '助手 · 执行中');
  assert.match(JSON.stringify(updates[1]?.card ?? {}), /正在修改代码/);
  assert.equal(intervalHarness.activeCount(), 1);

  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-delayed-refresh-1',
    output: 'assistant final answer'
  });

  assert.equal(updates.length, 3);
  assert.equal((updates[2]?.card as any)?.header?.title?.content, '助手 · 已完成');
  assert.equal(intervalHarness.activeCount(), 0);
});

test('assistant receipt updates to completed even when terminal event still lacks turn id', async () => {
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'assistant-thread-resumed',
    interruptedByRestart: true
  });
  const { service } = createTestService({
    sent: [],
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  assert.equal(sends.length, 1);
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant final answer'
  });

  assert.equal(updates.length, 1);
  assert.equal((updates[0]?.card as any)?.header?.title?.content, '助手 · 已完成');
  assert.equal(collectCardButtons((updates[0]?.card as any)?.body).length, 0);
});

test('assistant placeholder receipt updates to waiting status when the first turn-scoped event is waiting_user', async () => {
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'assistant-thread-resumed',
    interruptedByRestart: true
  });
  const { service } = createTestService({
    sent: [],
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    turnId: 'turn-waiting-1',
    waitKind: 'confirm',
    output: '请确认是否继续当前分析',
    waitHint: '回复继续'
  });

  assert.equal(sends.length, 1);
  assert.equal(updates.length, 1);
  assert.equal((updates[0]?.card as any)?.header?.title?.content, '助手 · 等待你确认');
  const buttons = collectCardButtons((updates[0]?.card as any)?.body);
  assert.deepEqual(buttons.map((button) => button.behaviors), [
    [
      {
        type: 'callback',
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-waiting-1'
        }
      }
    ]
  ]);
});

test('assistant immediate receipt send failure falls back to a later completed receipt', async () => {
  const cards: Array<Record<string, unknown>> = [];
  let sendAttempts = 0;
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-ready',
    activeTurnId: 'turn-immediate-fallback-1'
  });
  const { service } = createTestService({
    sent: [],
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error('transient assistant receipt failure');
      }
      cards.push(card);
      return `om_assistant_receipt_${cards.length}`;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-immediate-fallback-1',
    output: 'assistant final answer'
  });

  assert.equal(sendAttempts, 2);
  assert.equal(cards.length, 1);
  assert.equal((cards[0] as any)?.header?.title?.content, '助手 · 已完成');
  const buttons = collectCardButtons((cards[0] as any)?.body);
  assert.deepEqual(buttons.map((button) => button.behaviors), [
    [
      {
        type: 'callback',
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-immediate-fallback-1'
        }
      }
    ]
  ]);
});

test('assistant delayed receipt does not send duplicate cards when terminal events overlap', async () => {
  const cards: Array<Record<string, unknown>> = [];
  const firstTerminalSend = createDeferred<string>();
  let sendAttempts = 0;
  const assistantSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'assistant-thread-resumed',
    interruptedByRestart: true
  });
  const { service } = createTestService({
    sent: [],
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error('initial placeholder failure');
      }
      if (sendAttempts === 2) {
        cards.push(card);
        return await firstTerminalSend.promise;
      }
      cards.push(card);
      return `om_assistant_receipt_${cards.length}`;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  const firstEvent = service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-overlap-1',
    output: 'assistant final answer'
  });
  const secondEvent = service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-overlap-1',
    output: 'assistant final answer duplicate'
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sendAttempts, 2);

  firstTerminalSend.resolve('om_assistant_receipt_1');
  await Promise.all([firstEvent, secondEvent]);

  assert.equal(sendAttempts, 2);
  assert.equal(cards.length, 1);
  assert.equal((cards[0] as any)?.header?.title?.content, '助手 · 已完成');
});

test('assistant delayed receipt retries automatically after an overlapping in-flight failure', async () => {
  const cards: Array<Record<string, unknown>> = [];
  const firstTerminalSend = createDeferred<string>();
  let sendAttempts = 0;
  const assistantSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'assistant-thread-resumed',
    interruptedByRestart: true
  });
  const { service } = createTestService({
    sent: [],
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error('initial placeholder failure');
      }
      if (sendAttempts === 2) {
        return await firstTerminalSend.promise;
      }
      cards.push(card);
      return `om_assistant_receipt_${cards.length}`;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });

  const firstEvent = service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-overlap-retry-1',
    output: 'assistant final answer'
  });
  const secondEvent = service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    turnId: 'turn-overlap-retry-1',
    output: 'assistant final answer duplicate'
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sendAttempts, 2);

  firstTerminalSend.reject(new Error('transient overlapping failure'));
  await Promise.all([firstEvent, secondEvent]);

  assert.equal(sendAttempts, 3);
  assert.equal(cards.length, 1);
  assert.equal((cards[0] as any)?.header?.title?.content, '助手 · 已完成');
  const buttons = collectCardButtons((cards[0] as any)?.body);
  assert.deepEqual(buttons.map((button) => button.behaviors), [
    [
      {
        type: 'callback',
        value: {
          kind: 'query_current_task',
          cardSource: 'assistant_reply_receipt',
          turnId: 'turn-overlap-retry-1'
        }
      }
    ]
  ]);
});

test('turnless late events do not consume a newer pending assistant receipt retry when both turns are turnless', async () => {
  const sent: string[] = [];
  const sends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  let sendAttempts = 0;
  const assistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-1'
  });
  const { service } = createTestService({
    sent,
    assistantSessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      sendAttempts += 1;
      if (sendAttempts === 2) {
        throw new Error('second placeholder failed');
      }
      const messageId = `om_assistant_receipt_${sends.length + 1}`;
      sends.push({ messageId, card });
      return messageId;
    },
    updateCardImpl: async (messageId, card) => {
      updates.push({ messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第一轮 assistant 输入' });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant final answer A'
  });

  assistantSession.setSnapshot({
    lifecycle: 'STARTING',
    activeTurnId: undefined,
    checkpointOutput: 'assistant final answer A'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '第二轮 assistant 输入' });
  assert.equal(sendAttempts, 2);
  updates.length = 0;
  sent.length = 0;

  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant late duplicate without turn id'
  });

  assert.equal(updates.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(sends.length, 1);

  assistantSession.setSnapshot({
    lifecycle: 'IDLE',
    activeTurnId: undefined,
    checkpointOutput: 'assistant final answer B'
  });
  await service.handleWorkerEvent({
    type: 'task_finished',
    taskId: 'T1',
    output: 'assistant final answer B'
  });

  assert.equal(sends.length, 2);
  assert.equal((sends.at(-1)?.card as any)?.header?.title?.content, '助手 · 已完成');
  assert.equal(collectCardButtons((sends.at(-1)?.card as any)?.body).length, 0);
  assert.equal(sent.some((entry) => /assistant late duplicate without turn id/.test(entry)), false);
  assert.match(sent.at(-1) ?? '', /assistant final answer B/);
});

test('assistant waiting prompts do not expose Tn and plain replies continue the assistant session', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'confirm',
    output: 'Codex 请求执行命令审批。\n命令: git status',
    waitHint: '对 T1 允许'
  });

  assert.match(sent[sent.length - 1] ?? '', /git status/);
  assert.equal(/T1|任务 T1|对 T1/.test(sent[sent.length - 1] ?? ''), false);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '允许' });

  assert.deepEqual(assistantSession.replies.at(-1), { action: 'confirm', value: 'allow' });
  assert.equal(/T1|任务 T1|对 T1/.test(sent.at(-1) ?? ''), false);
});

test('assistant command approvals send an approval card alongside the assistant receipt without duplicate plain text', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', messageId: 'om_approval_1', card });
      return 'om_approval_1';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'confirm',
    output: 'Codex 请求执行命令审批。\n命令: python diag.py\nWrite-Host done\n目录: D:\\Quantitative_Trading\n原因: 排查卡住现象',
    waitHint: '对 T1 允许'
  });

  assert.equal(sent.length, 0);
  assert.equal(cards.filter((entry) => entry.kind === 'send').length, 2);
  assert.equal(cards.filter((entry) => entry.kind === 'update').length, 1);
  const assistantReceiptUpdate = cards.find((entry) => (entry.card as any)?.header?.title?.content === '助手 · 等待你确认');
  assert.ok(assistantReceiptUpdate);
  const approvalCard = cards.find((entry) => (entry.card as any)?.header?.title?.content === '任务 T1 等待审批');
  assert.ok(approvalCard);
  assert.equal(approvalCard?.kind, 'send');
  const collapsiblePanels = collectCardNodesByTag(approvalCard?.card.body, 'collapsible_panel');
  assert.equal(collapsiblePanels.length, 1);
  const buttons = collectCardButtons(approvalCard?.card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );
  assert.deepEqual(byLabel.get('允许')?.behaviors, [
    { type: 'callback', value: { kind: 'allow_waiting_task', taskId: 'T1', cardSource: 'approval_card' } }
  ]);
  assert.deepEqual(byLabel.get('拒绝')?.behaviors, [
    { type: 'callback', value: { kind: 'deny_waiting_task', taskId: 'T1', cardSource: 'approval_card' } }
  ]);
});

test('assistant command approvals still send an approval card when prior output prefixes the approval prompt', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', messageId: 'om_approval_prefixed', card });
      return 'om_approval_prefixed';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'confirm',
    output:
      '先把这组改动一次性迁到 D:\\CodexLark。\n\nCodex 请求执行命令审批。\n命令: node scripts/check.js\n目录: D:\\CodexLark\n原因: 运行聚焦验证',
    waitHint: '对 T1 允许'
  });

  const approvalCard = cards.find((entry) => (entry.card as any)?.header?.title?.content === '任务 T1 等待审批');
  assert.equal(sent.length, 0);
  assert.ok(approvalCard);
  assert.match(JSON.stringify(approvalCard?.card ?? {}), /运行聚焦验证/);
  assert.match(JSON.stringify(approvalCard?.card ?? {}), /D:\\\\CodexLark/);
  assert.match(JSON.stringify(approvalCard?.card ?? {}), /node scripts\/check\.js/);
});

test('assistant file-change approvals send an approval card when cards are available', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', messageId: 'om_file_change_1', card });
      return 'om_file_change_1';
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'confirm',
    output: 'Codex 请求文件改动审批。\n原因: 需要写入项目目录\n范围: D:\\CodexLark\\src',
    waitHint: '对 T1 允许'
  });

  const approvalCard = cards.find((entry) => (entry.card as any)?.header?.title?.content === '任务 T1 等待审批');
  assert.equal(sent.length, 0);
  assert.ok(approvalCard);
  assert.match(JSON.stringify(approvalCard?.card ?? {}), /需要写入项目目录/);
  assert.match(JSON.stringify(approvalCard?.card ?? {}), /范围：D:\\\\CodexLark\\\\src/);
  assert.match(JSON.stringify(approvalCard?.card ?? {}), /展开查看完整审批内容/);
  const buttons = collectCardButtons(approvalCard?.card.body);
  const byLabel = new Map(
    buttons.map((button) => [String((button.text as Record<string, unknown>)?.content ?? ''), button])
  );
  assert.deepEqual(byLabel.get('允许')?.behaviors, [
    { type: 'callback', value: { kind: 'allow_waiting_task', taskId: 'T1', cardSource: 'approval_card' } }
  ]);
  assert.deepEqual(byLabel.get('拒绝')?.behaviors, [
    { type: 'callback', value: { kind: 'deny_waiting_task', taskId: 'T1', cardSource: 'approval_card' } }
  ]);
});

test('approval card allow action replies to the waiting task and updates the approval card state', async () => {
  const sent: string[] = [];
  const cards: Array<{ kind: 'send' | 'update'; messageId?: string; card: Record<string, unknown> }> = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const { service } = createTestService({
    sent,
    sessionFactory: () => assistantSession,
    sendCardImpl: async (_threadId, card) => {
      cards.push({ kind: 'send', messageId: 'om_approval_2', card });
      return 'om_approval_2';
    },
    updateCardImpl: async (messageId, card) => {
      cards.push({ kind: 'update', messageId, card });
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我继续分析这个技术方案' });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T1',
    waitKind: 'confirm',
    output: 'Codex 请求执行命令审批。\n命令: python diag.py\n目录: D:\\Quantitative_Trading\n原因: 排查卡住现象',
    waitHint: '对 T1 允许'
  });

  await service.handleCardAction({
    threadId: 'feishu:chat-1',
    messageId: 'om_approval_2',
    kind: 'allow_waiting_task',
    taskId: 'T1',
    cardSource: 'approval_card'
  } as any);

  assert.deepEqual(assistantSession.replies.at(-1), { action: 'confirm', value: 'allow' });
  assert.equal(cards.at(-1)?.kind, 'update');
  assert.equal(cards.at(-1)?.messageId, 'om_approval_2');
  assert.match(String((cards.at(-1)?.card as any)?.header?.title?.content ?? ''), /已允许|审批已通过/);
  assert.equal(sent.length, 0);
});

test('ordinary text cold-resumes a registry-backed assistant and preserves persona metadata', async () => {
  const sent: string[] = [];
  const resumedAssistant = createMockSession({ lifecycle: 'STARTING', codexThreadId: 'assistant-thread-9' });
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'assistant-thread-9',
        cwd: DEFAULT_ASSISTANT_CWD,
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'assistant',
        assistantProfileId: 'research-assistant-v1',
        developerInstructions: '你是长期科研助理。',
        baseInstructions: '默认使用简体中文回答。',
        personality: 'pragmatic',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ],
    threadBindings: [
      {
        feishuThreadId: 'feishu:chat-1',
        assistantTaskId: 'T1'
      }
    ]
  });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return resumedAssistant;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续帮我拆这个实验方案' });

  assert.equal(service.getTask('T1')?.id, 'T1');
  assert.equal((service.getTask('T1') as any)?.sessionKind, 'assistant');
  assert.deepEqual(resumedAssistant.replies[0], { action: 'input_text', text: '继续帮我拆这个实验方案' });
  const { resumeContext: assistantResumeContext, ...assistantResumeCall } = sessionFactoryCalls[0] as {
    resumeContext?: Record<string, unknown>;
  };
  assert.deepEqual(assistantResumeCall, {
    taskId: 'T1',
    cwd: DEFAULT_ASSISTANT_CWD,
    threadId: 'feishu:chat-1',
    mode: 'resume',
    resumeThreadId: 'assistant-thread-9',
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    interruptedByRestart: true,
    developerInstructions: '你是长期科研助理。',
    baseInstructions: '默认使用简体中文回答。',
    personality: 'pragmatic'
  });
  assert.equal(assistantResumeContext?.sourceSessionLifecycle, 'IDLE');
  assert.equal(assistantResumeContext?.sourceCreatedAt, '2026-03-09T10:00:00.000Z');
  assert.equal(typeof assistantResumeContext?.sourceAgeMs, 'number');
  assert.equal(sent.some((text) => /T1/.test(text)), false);
});

test('closing an assistant task clears the thread binding', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我看看这个方案' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '关闭T1。' });

  assert.deepEqual(registry.clearThreadBindingCalls, ['feishu:chat-1']);
  assert.equal(registry.getThreadBinding('feishu:chat-1'), undefined);
  assert.match(sent[sent.length - 1] ?? '', /已关闭/);
});

test('assistant failures clear the thread binding and the next message auto-creates a new assistant session', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const recoveredAssistantSession = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'assistant-thread-2',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T2.log'
  });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) =>
      sessionOptions.taskId === 'T1' ? assistantSession : recoveredAssistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我看看这个方案' });
  await service.handleWorkerEvent({ type: 'task_failed', taskId: 'T1', output: 'systemError' });
  (assistantSession as any).sendReply = () => {
    throw new Error('Codex app session has already failed.');
  };

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续' });

  assert.deepEqual(recoveredAssistantSession.replies[0], { action: 'input_text', text: '继续' });
  assert.equal(registry.getThreadBinding('feishu:chat-1')?.assistantTaskId, 'T2');
  assert.equal(sent.some((text) => /助手暂时无法接收输入/.test(text)), false);
});


test('assistant failure auto-creates a new assistant session and asks to resend', async () => {
  const sent: string[] = [];
  const firstSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const secondSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-2' });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return sessionOptions.taskId === 'T1' ? firstSession : secondSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: 'Error: no rollout found for thread id 019cdd30-06c2-7681-b855-8857c5769ba6'
  });

  assert.equal(sessionFactoryCalls.length, 2);
  assert.equal(service.getTask('T2')?.id, 'T2');
  assert.equal(registry.getThreadBinding('feishu:chat-1')?.assistantTaskId, 'T2');
  const last = sent[sent.length - 1] ?? '';
  assert.match(last, /已为你新建会话|重新发送/);
  assert.equal(/no rollout found/i.test(last), false);
});

test('explicit reply cold-resumes a failed coding task on the same Tn without losing model metadata', async () => {
  const sent: string[] = [];
  const firstCodingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1', model: 'gpt-5.4' });
  const recoveredCodingSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'coding-thread-1',
    model: 'gpt-5.4',
    interruptedByRestart: true,
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1-recovered.log'
  });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: (sessionOptions) => {
      codingSessionFactoryCalls.push({ ...sessionOptions });
      return codingSessionFactoryCalls.length === 1 ? firstCodingSession : recoveredCodingSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: 'Codex 线程进入 systemError 状态。'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续' });

  assert.equal(recoveredCodingSession.started, true);
  assert.deepEqual(recoveredCodingSession.replies[0], { action: 'input_text', text: '继续' });
  const { resumeContext: explicitReplyResumeContext, ...explicitReplyResumeCall } = codingSessionFactoryCalls[1] as {
    resumeContext?: Record<string, unknown>;
  };
  assert.deepEqual(explicitReplyResumeCall, {
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    threadId: 'feishu:chat-1',
    mode: 'resume',
    resumeThreadId: 'coding-thread-1',
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    model: 'gpt-5.4',
    interruptedByRestart: true
  });
  assert.equal(explicitReplyResumeContext?.sourceSessionLifecycle, 'FAILED');
  assert.equal(typeof explicitReplyResumeContext?.sourceCreatedAt, 'string');
  assert.equal(typeof explicitReplyResumeContext?.sourceLastEventAt, 'string');
  assert.equal(typeof explicitReplyResumeContext?.sourceAgeMs, 'number');
  assert.equal(typeof explicitReplyResumeContext?.sourceIdleMs, 'number');
  assert.equal(sent.some((text) => /已失败，无法继续接收输入/.test(text)), false);
});

test('explicit reply cold-resume persists the startup-resolved model when the stored model is unknown', async () => {
  const sent: string[] = [];
  const resumedCodingSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'coding-thread-1',
    interruptedByRestart: true,
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1-recovered.log'
  });
  const originalStart = resumedCodingSession.start.bind(resumedCodingSession);
  resumedCodingSession.start = async () => {
    originalStart();
    await Promise.resolve();
    resumedCodingSession.setSnapshot({
      lifecycle: 'IDLE',
      model: 'gpt-5.4-resolved'
    });
  };
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        model: null,
        sessionLifecycle: 'FAILED',
        sessionKind: 'coding',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: () => resumedCodingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续' });

  assert.equal(service.getTask('T1')?.model, 'gpt-5.4-resolved');
  assert.equal(registry.getSessionRecord('T1')?.model, 'gpt-5.4-resolved');
  assert.deepEqual(resumedCodingSession.replies[0], { action: 'input_text', text: '继续' });
});

test('coding task failure push uses only the structured interruption copy while preserving raw checkpoint output for task lookup', async () => {
  const cases = [
    {
      interruptionKind: 'local_comm',
      expectedDelivery: '任务 T1 已中断：本地通讯链路中断。',
      rawOutput: 'Codex app-server exited with code 1.\nTraceback preserved in checkpoint.'
    },
    {
      interruptionKind: 'approval_denied',
      expectedDelivery: '任务 T1 已中断：审批未通过。',
      rawOutput: 'Approval request was declined.\nThe detailed rejection trace stays in checkpoint.'
    },
    {
      interruptionKind: 'upstream_execution',
      expectedDelivery: '任务 T1 已中断：上游执行异常中断。',
      rawOutput: 'Turn completed with status: interrupted\nDetailed upstream output is preserved.'
    },
    {
      interruptionKind: 'version_incompatible',
      expectedDelivery: '任务 T1 已中断：Codex app-server 版本不兼容。',
      rawOutput: 'Codex app-server compatibility check failed.\ncurrent version: 0.110.0'
    },
    {
      interruptionKind: 'capability_missing',
      expectedDelivery: '任务 T1 已中断：Codex app-server 缺少所需能力。',
      rawOutput: 'Codex app-server compatibility check failed.\nmissing capabilities: turn/start'
    },
    {
      interruptionKind: 'unknown',
      expectedDelivery: '任务 T1 已中断：原因暂未归类。',
      rawOutput: 'Exit code: 1\nParserError\nDetailed stderr remains in checkpoint.'
    }
  ] as const;

  for (const current of cases) {
    const sent: string[] = [];
    const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
    const { service } = createTestService({
      sent,
      codingSessionFactory: () => codingSession
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
    await service.handleWorkerEvent({
      type: 'task_failed',
      taskId: 'T1',
      output: current.rawOutput,
      interruptionKind: current.interruptionKind
    } as any);

    const push = sent.at(-1) ?? '';
    assert.equal(push.endsWith(current.expectedDelivery), true);
    assert.equal(push.includes('\n'), false);
    assert.equal(push.includes(current.rawOutput), false);
    assert.equal(service.getTask('T1')?.checkpointOutput, current.rawOutput);

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T1 状态' });
    assert.match(sent.at(-1) ?? '', literalRegex(current.rawOutput.split('\n')[0] ?? current.rawOutput));
  }
});

test('coding task failure without structured evidence falls back to unknown instead of guessing from ordinary tool output', async () => {
  const sent: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const rawOutput = 'Exit code: 1\nParserError\nTraceback: tool stderr should not drive classification.';
  const { service } = createTestService({
    sent,
    codingSessionFactory: () => codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: rawOutput
  } as any);

  const push = sent.at(-1) ?? '';
  assert.equal(push.endsWith('任务 T1 已中断：原因暂未归类。'), true);
  assert.equal(push.includes('ParserError'), false);
  assert.equal(push.includes('Exit code: 1'), false);
  assert.equal(push.includes('Traceback'), false);
  assert.equal(service.getTask('T1')?.checkpointOutput, rawOutput);
});

test('recoverable failed coding task keeps coding mode and current target', async () => {
  const sent: string[] = [];
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: () => codingSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: 'Codex 线程进入 systemError 状态。'
  });

  assert.equal(service.getTask('T1')?.lifecycle, 'FAILED');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
});

test('coding mode ordinary text auto-resumes a recoverable failed current coding task', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const firstCodingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const recoveredCodingSession = createMockSession({
    lifecycle: 'STARTING',
    codexThreadId: 'coding-thread-1',
    interruptedByRestart: true,
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1-recovered.log'
  });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const codingSessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: (sessionOptions) => {
      codingSessionFactoryCalls.push({ ...sessionOptions });
      return codingSessionFactoryCalls.length === 1 ? firstCodingSession : recoveredCodingSession;
    },
    assistantSessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: 'Codex 线程进入 systemError 状态。'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续刚才失败的修复' });

  assert.equal(codingSessionFactoryCalls.length, 2);
  const { resumeContext: codingModeResumeContext, ...codingModeResumeCall } = codingSessionFactoryCalls[1] as {
    resumeContext?: Record<string, unknown>;
  };
  assert.deepEqual(codingModeResumeCall, {
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    threadId: 'feishu:chat-1',
    mode: 'resume',
    resumeThreadId: 'coding-thread-1',
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    interruptedByRestart: true
  });
  assert.equal(codingModeResumeContext?.sourceSessionLifecycle, 'FAILED');
  assert.equal(typeof codingModeResumeContext?.sourceCreatedAt, 'string');
  assert.equal(typeof codingModeResumeContext?.sourceLastEventAt, 'string');
  assert.equal(typeof codingModeResumeContext?.sourceAgeMs, 'number');
  assert.equal(typeof codingModeResumeContext?.sourceIdleMs, 'number');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.deepEqual(recoveredCodingSession.replies[0], { action: 'free_text', text: '继续刚才失败的修复' });
  assert.equal(assistantSession.replies.length, 0);
  assert.equal(service.getTask('T2'), undefined);
  assert.match(sent.at(-1) ?? '', /已恢复执行|已恢复会话|消息已送达/);
});

test('non-recoverable failed coding task does not auto-resume and falls back to assistant', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-1' });
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: undefined });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: () => codingSession,
    assistantSessionFactory: () => assistantSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleWorkerEvent({
    type: 'task_failed',
    taskId: 'T1',
    output: 'Codex 线程失败且缺少恢复元数据。'
  });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '这条应该回到助手' });

  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'assistant');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, undefined);
  assert.equal((service.getTask('T2') as any)?.sessionKind, 'assistant');
  assert.deepEqual(assistantSession.replies.at(-1), { action: 'input_text', text: '这条应该回到助手' });
});

test('ordinary text clears a stale assistant binding when recovery metadata is missing', async () => {
  const sent: string[] = [];
  let sessionFactoryCalls = 0;
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        cwd: DEFAULT_ASSISTANT_CWD,
        sessionLifecycle: 'IDLE',
        sessionKind: 'assistant',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ],
    threadBindings: [
      {
        feishuThreadId: 'feishu:chat-1',
        assistantTaskId: 'T1'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => {
      sessionFactoryCalls += 1;
      return createMockSession();
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续分析' });

  assert.equal(sessionFactoryCalls, 0);
  assert.equal(registry.getThreadBinding('feishu:chat-1'), undefined);
  assert.match(sent[sent.length - 1] ?? '', /恢复失败|清理旧绑定/);
  assert.equal(/T1|任务 T1|对 T1/.test(sent[sent.length - 1] ?? ''), false);
});

test('ordinary text does not cold-resume a coding task after restart', async () => {
  const sent: string[] = [];
  const assistantSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'assistant-thread-2' });
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'WAITING_USER',
        sessionKind: 'coding',
        firstUserCodingText: '修复旧任务',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return assistantSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '普通问题应该走助手' });

  assert.equal(service.getTask('T1')?.id, 'T1');
  assert.equal(service.getTask('T2')?.id, 'T2');
  assert.equal((service.getTask('T2') as any)?.sessionKind, 'assistant');
  assert.equal(sessionFactoryCalls[0]?.taskId, 'T2');
  assert.deepEqual(assistantSession.replies[0], { action: 'input_text', text: '普通问题应该走助手' });
});

test('coding mode ordinary text cold-resumes a persisted coding target and stays in coding mode', async () => {
  const sent: string[] = [];
  const resumedCodingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-resumed' });
  let codingCalls = 0;
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'coding-thread-1',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复旧任务',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ],
    threadUiStates: [
      {
        feishuThreadId: 'feishu:chat-1',
        displayMode: 'coding',
        currentCodingTaskId: 'T1'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    codingSessionFactory: () => {
      codingCalls += 1;
      return resumedCodingSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '你的人设是什么？' });

  assert.equal(codingCalls, 1);
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.displayMode, 'coding');
  assert.equal(registry.getThreadUiState('feishu:chat-1')?.currentCodingTaskId, 'T1');
  assert.equal(service.getTask('T1')?.id, 'T1');
  assert.equal(service.getTask('T2'), undefined);
  assert.deepEqual(resumedCodingSession.replies[0], { action: 'free_text', text: '你的人设是什么？' });
  assert.match(sent.at(-1) ?? '', /已恢复执行|已恢复会话|消息已送达/);
});

test('service reserves next task id from registry and syncs task metadata on start and worker events', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'codex-thread-3',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T3.log'
  });
  const registry = createMockRegistry({ nextTaskId: 3 });
  const service = createFeishuService({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        sent.push(text);
      }
    },
    sessionFactory: () => session,
    sessionRegistry: registry,
  } as any);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });

  assert.equal(service.getTask('T3')?.id, 'T3');
  assert.deepEqual(registry.reserveCalls, ['T3']);
  assert.equal(registry.upsertCalls[0]?.taskId, 'T3');
  assert.equal(registry.upsertCalls[0]?.feishuThreadId, 'feishu:chat-1');
  assert.equal(registry.upsertCalls[0]?.codexThreadId, 'codex-thread-3');
  assert.equal(registry.upsertCalls[0]?.logPath, 'D:\\Workspace\\Project\\logs\\communicate\\T3.log');

  session.setSnapshot({
    lifecycle: 'WAITING_USER',
    checkpointOutput: '1. Allow once\n2. Allow always',
    codexThreadId: 'codex-thread-3'
  });
  await service.handleWorkerEvent({
    type: 'task_waiting_user',
    taskId: 'T3',
    waitKind: 'choice',
    output: '1. Allow once\n2. Allow always',
    waitHint: '对 T3 选择第一个'
  });

  assert.equal(registry.upsertCalls.at(-1)?.sessionLifecycle, 'WAITING_USER');
  assert.equal(registry.upsertCalls.at(-1)?.lastCheckpointOutput, '1. Allow once\n2. Allow always');
  assert.equal(registry.upsertCalls.at(-1)?.codexThreadId, 'codex-thread-3');
  assert.match(sent[sent.length - 1] ?? '', /Allow once/);
});

test('service restores registry-backed tasks without spawning a hot session and continues next task ids after restart', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'codex-thread-5',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T5.log'
  });
  const registry = createMockRegistry({
    nextTaskId: 6,
    records: [
      {
        taskId: 'T5',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-5',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T5.log',
        sessionLifecycle: 'RUNNING_TURN',
        lastCheckpointOutput: 'Recovered checkpoint',
        interruptedByRestart: true,
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  let sessionFactoryCalls = 0;
  const service = createFeishuService({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        sent.push(text);
      }
    },
    sessionFactory: () => {
      sessionFactoryCalls += 1;
      return session;
    },
    sessionRegistry: registry,
  } as any);

  assert.equal(service.getTask('T5')?.id, 'T5');
  assert.equal(sessionFactoryCalls, 0);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T5 状态' });

  assert.equal(sessionFactoryCalls, 0);
  assert.match(sent[sent.length - 1] ?? '', /T5/);
  assert.match(sent[sent.length - 1] ?? '', /IDLE/);
  assert.match(sent[sent.length - 1] ?? '', /Recovered checkpoint/);
  assert.match(sent[sent.length - 1] ?? '', /codex-thread-5/);
  assert.match(sent[sent.length - 1] ?? '', /codex resume codex-thread-5/);
  assert.match(sent[sent.length - 1] ?? '', /重启|中断/);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  assert.equal(service.getTask('T6')?.id, 'T6');
  assert.deepEqual(registry.reserveCalls, ['T6']);
});

test('legacy restored task keeps startup mode unknown when querying status', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'codex-thread-5',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T5.log'
  });
  const registry = createMockRegistry({
    nextTaskId: 6,
    records: [
      {
        taskId: 'T5',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-5',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T5.log',
        sessionLifecycle: 'RUNNING_TURN',
        lastCheckpointOutput: 'Recovered checkpoint',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  let sessionFactoryCalls = 0;
  const service = createFeishuService({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        sent.push(text);
      }
    },
    sessionFactory: () => {
      sessionFactoryCalls += 1;
      return session;
    },
    sessionRegistry: registry,
  } as any);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T5 状态' });

  assert.equal(sessionFactoryCalls, 0);
  assert.match(sent[sent.length - 1] ?? '', /会话 sessionKind coding · 恢复态 未知 · 中断恢复 是/);
});

test('legacy idle task renders unknown startup mode instead of unset when querying status', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'codex-thread-6',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T6.log'
  });
  const registry = createMockRegistry({
    nextTaskId: 7,
    records: [
      {
        taskId: 'T6',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-6',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T6.log',
        sessionLifecycle: 'IDLE',
        lastCheckpointOutput: 'Idle checkpoint',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  let sessionFactoryCalls = 0;
  const service = createFeishuService({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        sent.push(text);
      }
    },
    sessionFactory: () => {
      sessionFactoryCalls += 1;
      return session;
    },
    sessionRegistry: registry,
  } as any);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T6 状态' });

  assert.equal(sessionFactoryCalls, 0);
  assert.match(sent[sent.length - 1] ?? '', /会话 sessionKind coding · 恢复态 未知 · 中断恢复 否/);
});

test('legacy assistant task keeps session summary visible when startup mode is unknown', async () => {
  const sent: string[] = [];
  const session = createMockSession({
    lifecycle: 'IDLE',
    codexThreadId: 'codex-thread-7',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T7.log'
  });
  const registry = createMockRegistry({
    nextTaskId: 8,
    records: [
      {
        taskId: 'T7',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-7',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T7.log',
        sessionLifecycle: 'IDLE',
        interruptedByRestart: false,
        sessionKind: 'assistant',
        lastCheckpointOutput: 'Assistant checkpoint',
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  const service = createFeishuService({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        sent.push(text);
      }
    },
    sessionFactory: () => session,
    sessionRegistry: registry,
  } as any);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T7 状态' });

  assert.match(sent[sent.length - 1] ?? '', /会话 sessionKind assistant · 恢复态 未知 · 中断恢复 否/);
});
test('reply message cold-resumes a registry-backed task on the same Tn after restart', async () => {
  const sent: string[] = [];
  const resumedSession = createMockSession({ lifecycle: 'STARTING', codexThreadId: 'codex-thread-8' });
  const registry = createMockRegistry({
    nextTaskId: 9,
    records: [
      {
        taskId: 'T8',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-8',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T8.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'WAITING_USER',
        lastCheckpointOutput: 'Please approve',
        interruptedByRestart: true,
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  const sessionFactoryCalls: Array<Record<string, unknown>> = [];
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: (sessionOptions) => {
      sessionFactoryCalls.push({ ...sessionOptions });
      return resumedSession;
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T8 输入: 继续执行' });

  assert.equal(resumedSession.started, true);
  assert.deepEqual(resumedSession.replies[0], { action: 'input_text', text: '继续执行' });
  const { resumeContext: restartReplyResumeContext, ...restartReplyResumeCall } = sessionFactoryCalls[0] as {
    resumeContext?: Record<string, unknown>;
  };
  assert.deepEqual(restartReplyResumeCall, {
    taskId: 'T8',
    cwd: 'D:\\Workspace\\Project',
    threadId: 'feishu:chat-1',
    mode: 'resume',
    resumeThreadId: 'codex-thread-8',
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    interruptedByRestart: true
  });
  assert.equal(restartReplyResumeContext?.sourceSessionLifecycle, 'WAITING_USER');
  assert.equal(restartReplyResumeContext?.sourceCreatedAt, '2026-03-09T10:00:00.000Z');
  assert.equal(typeof restartReplyResumeContext?.sourceAgeMs, 'number');
  assert.match(sent[sent.length - 1] ?? '', /重启|恢复/);
});

test('reply message cold-resume keeps a blocked startup in FAILED instead of rewriting it to STARTING', async () => {
  const sent: string[] = [];
  const blockedOutput = '检测到当前 Codex 版本 0.120.0 属于已知不兼容版本，可能导致任务执行中被异常打断。请尽快升级到最新版本后重试。';
  const resumedSession = createMockSession({
    lifecycle: 'FAILED',
    checkpointOutput: blockedOutput,
    codexThreadId: 'codex-thread-8'
  });
  resumedSession.sendReply = () => {
    throw new Error('startup blocked');
  };
  const registry = createMockRegistry({
    nextTaskId: 9,
    records: [
      {
        taskId: 'T8',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-8',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T8.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'WAITING_USER',
        lastCheckpointOutput: 'Please approve',
        interruptedByRestart: true,
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => resumedSession
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T8 输入: 继续执行' });

  assert.equal(service.getTask('T8')?.lifecycle, 'FAILED');
  assert.match(service.getTask('T8')?.checkpointOutput ?? '', /已知不兼容版本/);
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T8 状态' });
  assert.doesNotMatch(sent[sent.length - 1] ?? '', /启动中|STARTING/);
  assert.match(sent[sent.length - 1] ?? '', /已知不兼容版本|失败/);
});

test('recovered status query keeps persisted runtime warnings after restart', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 8,
    records: [
      {
        taskId: 'T7',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-7',
        cwd: 'D:\\Workspace\\Project',
        logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T7.log',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        sessionLifecycle: 'IDLE',
        interruptedByRestart: false,
        runtimeWarnings: [
          {
            code: 'known_bad_codex_version',
            message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
            version: '0.120.0',
            overrideActive: true
          }
        ],
        createdAt: '2026-03-09T10:00:00.000Z'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    sessionFactory: () => createMockSession({ lifecycle: 'IDLE' })
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '查询 T7 状态' });

  assert.match(sent[sent.length - 1] ?? '', /当前Codex版本存在不兼容问题，请尽快升级到最新版本/);
});

test('close message marks the registry record closed instead of deleting it', async () => {
  const sent: string[] = [];
  const session = createMockSession({ lifecycle: 'IDLE' });
  const registry = createMockRegistry({ nextTaskId: 1 });
  const service = createFeishuService({
    channel: {
      sendText: async (_threadId: string, text: string) => {
        sent.push(text);
      }
    },
    sessionFactory: () => session,
    sessionRegistry: registry,
  } as any);

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '关闭T1。' });

  assert.equal(registry.markClosedCalls.length, 1);
  assert.equal(registry.markClosedCalls[0]?.taskId, 'T1');
  assert.equal(registry.getSessionRecord('T1')?.sessionLifecycle, 'CLOSED');
  assert.match(sent[sent.length - 1] ?? '', /已关闭/);
});

test('the same Tn can still accept input after two service restarts', async () => {
  const registry = createMockRegistry({ nextTaskId: 1 });
  const firstSent: string[] = [];
  const firstSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'codex-thread-1' });
  const first = createTestService({ sent: firstSent, session: firstSession, registry });

  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 初始化第一轮上下文' });
  assert.equal(first.service.getTask('T1')?.id, 'T1');

  const secondSent: string[] = [];
  const secondSession = createMockSession({ lifecycle: 'STARTING', codexThreadId: 'codex-thread-1' });
  const secondFactoryCalls: Array<Record<string, unknown>> = [];
  const second = createTestService({
    sent: secondSent,
    registry,
    sessionFactory: (sessionOptions) => {
      secondFactoryCalls.push({ ...sessionOptions });
      return secondSession;
    }
  });

  await second.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 第一次重启后继续' });
  assert.deepEqual(secondSession.replies[0], { action: 'input_text', text: '第一次重启后继续' });
  assert.equal(secondFactoryCalls[0]?.taskId, 'T1');

  const thirdSent: string[] = [];
  const thirdSession = createMockSession({ lifecycle: 'STARTING', codexThreadId: 'codex-thread-1' });
  const thirdFactoryCalls: Array<Record<string, unknown>> = [];
  const third = createTestService({
    sent: thirdSent,
    registry,
    sessionFactory: (sessionOptions) => {
      thirdFactoryCalls.push({ ...sessionOptions });
      return thirdSession;
    }
  });

  await third.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 第二次重启后继续' });
  assert.deepEqual(thirdSession.replies[0], { action: 'input_text', text: '第二次重启后继续' });
  assert.equal(thirdFactoryCalls[0]?.taskId, 'T1');
});

test('reply after closing Tn is rejected clearly even after a service restart', async () => {
  const registry = createMockRegistry({ nextTaskId: 1 });
  const firstSent: string[] = [];
  const firstSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'codex-thread-1' });
  const first = createTestService({ sent: firstSent, session: firstSession, registry });

  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await first.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '关闭T1。' });

  const secondSent: string[] = [];
  let sessionFactoryCalls = 0;
  const second = createTestService({
    sent: secondSent,
    registry,
    sessionFactory: () => {
      sessionFactoryCalls += 1;
      return createMockSession({ lifecycle: 'STARTING', codexThreadId: 'codex-thread-1' });
    }
  });

  await second.service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 再试一次' });

  assert.equal(sessionFactoryCalls, 0);
  assert.match(secondSent[secondSent.length - 1] ?? '', /已关闭/);
});









test('appends recent images to next text message and clears the queue', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  const now = Date.now();
  await service.handleInboundImage({
    threadId: 'feishu:chat-1',
    imagePath: 'D:\\Workspace\\Project\Communicate\a.jpg',
    receivedAt: now - 60_000
  });
  await service.handleInboundImage({
    threadId: 'feishu:chat-1',
    imagePath: 'D:\\Workspace\\Project\Communicate\b.png',
    receivedAt: now - 30_000
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '你好' });

  assert.equal(session.replies.length, 1);
  assert.deepEqual(session.replies[0], {
    action: 'input_text',
    text: '你好\n\n[图片]\n- D:\\Workspace\\Project\Communicate\a.jpg\n- D:\\Workspace\\Project\Communicate\b.png'
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '继续' });

  assert.equal(session.replies.length, 2);
  assert.deepEqual(session.replies[1], { action: 'input_text', text: '继续' });
});

test('goal summary generation strips appended image paths from the first real coding instruction', async () => {
  const sent: string[] = [];
  const summaryCalls: string[] = [];
  const deferred = createDeferred<string | undefined>();
  const codingSession = createMockSession({ lifecycle: 'IDLE', codexThreadId: 'coding-thread-1' });
  const { service } = createTestService({
    sent,
    registry: createMockRegistry({ nextTaskId: 1 }),
    codingSessionFactory: () => codingSession,
    goalSummaryGenerator: {
      async summarize(input) {
        summaryCalls.push(input.sourceText);
        return await deferred.promise;
      }
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '帮我在 D:\\Workspace\\Project 下开一个 codex 窗口' });
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '/mode coding' });
  await service.handleInboundImage({
    threadId: 'feishu:chat-1',
    imagePath: 'D:\\Workspace\\Project\\Communicate\\a.jpg',
    receivedAt: Date.now() - 30_000
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '修复飞书任务切换卡摘要不可读问题' });

  assert.deepEqual(summaryCalls, ['修复飞书任务切换卡摘要不可读问题']);
  assert.equal(service.getTask('T1')?.goalSummarySourceText, '修复飞书任务切换卡摘要不可读问题');
  assert.deepEqual(codingSession.replies.at(-1), {
    action: 'free_text',
    text: '修复飞书任务切换卡摘要不可读问题\n\n[图片]\n- D:\\Workspace\\Project\\Communicate\\a.jpg'
  });

  deferred.resolve('修复飞书任务切换卡摘要不可读问题');
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(service.getTask('T1')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
});

test('does not append images older than 5 minutes', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({ sent, session });

  const now = Date.now();
  await service.handleInboundImage({
    threadId: 'feishu:chat-1',
    imagePath: 'D:\\Workspace\\Project\Communicate\expired.jpg',
    receivedAt: now - 6 * 60_000
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '你好' });

  assert.equal(session.replies.length, 1);
  assert.deepEqual(session.replies[0], { action: 'input_text', text: '你好' });
});


test('takeover list no longer kills processes', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  let killCalls = 0;
  const { service } = createTestService({
    sent,
    session,
    cliScanner: () => [
      { threadId: 'codex-thread-99', updatedAt: '2026-03-15T00:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'last output' }
    ],
    cliProcess: {
      list: () => [{ pid: 11, commandLine: 'codex --foo' }],
      kill: () => {
        killCalls += 1;
        return { killed: 0, failed: 0, errors: [] };
      }
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  assert.equal(killCalls, 0);
  assert.match(sent[sent.length - 1] ?? '', /接管Tn/);
});

test('takeover list truncates to limit', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({
    sent,
    session,
    takeoverListLimit: 2,
    cliScanner: () => [
      { threadId: 'codex-thread-3', updatedAt: '2026-03-15T03:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'third' },
      { threadId: 'codex-thread-2', updatedAt: '2026-03-15T02:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'second' },
      { threadId: 'codex-thread-1', updatedAt: '2026-03-15T01:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'first' }
    ]
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  const last = sent[sent.length - 1] || '';
  assert.match(last, /codex-thread-3/);
  assert.match(last, /codex-thread-2/);
  assert.doesNotMatch(last, /codex-thread-1/);
});

test('takeover list falls back to default limit when invalid', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({
    sent,
    session,
    takeoverListLimit: 0,
    cliScanner: () => [
      { threadId: 'codex-thread-6', updatedAt: '2026-03-15T06:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'sixth' },
      { threadId: 'codex-thread-5', updatedAt: '2026-03-15T05:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'fifth' },
      { threadId: 'codex-thread-4', updatedAt: '2026-03-15T04:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'fourth' },
      { threadId: 'codex-thread-3', updatedAt: '2026-03-15T03:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'third' },
      { threadId: 'codex-thread-2', updatedAt: '2026-03-15T02:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'second' },
      { threadId: 'codex-thread-1', updatedAt: '2026-03-15T01:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'first' }
    ]
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  const last = sent[sent.length - 1] || '';
  assert.match(last, /codex-thread-6/);
  assert.match(last, /codex-thread-5/);
  assert.match(last, /codex-thread-4/);
  assert.match(last, /codex-thread-3/);
  assert.match(last, /codex-thread-2/);
  assert.doesNotMatch(last, /codex-thread-1/);
});

test('takeover list prefers thread name then first text', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  const { service } = createTestService({
    sent,
    session,
    cliScanner: () => [
      {
        threadId: 'codex-thread-1',
        updatedAt: '2026-03-15T01:00:00Z',
        cwd: 'D:\\Workspace\\Project',
        model: 'gpt-5.2',
        threadName: 'Resume 标题',
        firstText: 'first prompt',
        lastText: 'latest reply'
      }
    ]
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  const last = sent[sent.length - 1] || '';
  assert.match(last, /配置 model gpt-5\.2 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.match(last, /会话 sessionKind coding · 恢复态 是 · 中断恢复 是/);
  assert.match(last, /最近摘要 Resume 标题/);
});

test('takeover list hides redundant default assistant session summary', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'codex-thread-1',
        cwd: 'D:\\Workspace\\Project',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        model: 'gpt-5.4',
        sessionLifecycle: 'IDLE',
        sessionKind: 'assistant',
        startupMode: 'new',
        interruptedByRestart: false
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    session: createMockSession(),
    cliScanner: () => [
      {
        threadId: 'codex-thread-1',
        updatedAt: '2026-03-15T01:00:00Z',
        cwd: 'D:\\Workspace\\Project',
        model: 'gpt-5.4',
        threadName: '助手线程',
        lastText: 'latest reply'
      }
    ]
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  const last = sent[sent.length - 1] || '';
  assert.match(last, /配置 model gpt-5\.4 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(last, /会话 sessionKind assistant · 恢复态 否 · 中断恢复 否/);
});

test('takeover list marks a missing cli model as unknown instead of guessing', async () => {
  const sent: string[] = [];
  const { service } = createTestService({
    sent,
    session: createMockSession(),
    cliScanner: () => [
      {
        threadId: 'codex-thread-1',
        updatedAt: '2026-03-15T01:00:00Z',
        cwd: 'D:\\Workspace\\Project',
        model: null,
        lastText: 'latest reply'
      }
    ]
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  const last = sent[sent.length - 1] || '';
  assert.match(last, /配置 model 未知 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(last, /配置 model gpt-/);
});

test('takeover list backfills a previously unknown cli model when a later scan finds it', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'cli-thread-1',
        cwd: 'D:\\Workspace\\Project',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        model: null,
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    session: createMockSession(),
    cliScanner: () => [
      {
        threadId: 'cli-thread-1',
        updatedAt: '2026-03-15T01:00:00Z',
        cwd: 'D:\\Workspace\\Project',
        model: 'gpt-5.4',
        firstText: '修复模型丢失'
      }
    ]
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  assert.equal(service.getTask('T1')?.model, 'gpt-5.4');
  assert.equal(registry.getSessionRecord('T1')?.model, 'gpt-5.4');
  assert.match(sent[0] ?? '', /配置 model gpt-5\.4 · sandbox danger-full-access · approvalPolicy on-request/);
});

test('takeover list does not overwrite a known model with a later scanned value', async () => {
  const sent: string[] = [];
  const registry = createMockRegistry({
    nextTaskId: 2,
    records: [
      {
        taskId: 'T1',
        feishuThreadId: 'feishu:chat-1',
        codexThreadId: 'cli-thread-1',
        cwd: 'D:\\Workspace\\Project',
        approvalPolicy: 'on-request',
        sandbox: 'danger-full-access',
        model: 'gpt-5.4-resolved',
        sessionLifecycle: 'IDLE',
        sessionKind: 'coding',
        firstUserCodingText: '修复模型丢失'
      }
    ]
  });
  const { service } = createTestService({
    sent,
    registry,
    session: createMockSession(),
    cliScanner: () => [
      {
        threadId: 'cli-thread-1',
        updatedAt: '2026-03-15T01:00:00Z',
        cwd: 'D:\\Workspace\\Project',
        model: 'gpt-4.1-stale',
        firstText: '修复模型丢失'
      }
    ]
  });

  assert.equal(service.getTask('T1')?.model, 'gpt-5.4-resolved');
  assert.equal(registry.getSessionRecord('T1')?.model, 'gpt-5.4-resolved');
  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管 codex' });

  assert.equal(service.getTask('T1')?.model, 'gpt-5.4-resolved');
  assert.equal(registry.getSessionRecord('T1')?.model, 'gpt-5.4-resolved');
  assert.match(sent[0] ?? '', /配置 model gpt-5\.4-resolved · sandbox danger-full-access · approvalPolicy on-request/);
});

test('takeover by task id kills a uniquely matched process and resumes', async () => {
  const sent: string[] = [];
  const session = createMockSession();
  let killed: Array<any> = [];
  let factoryOptions: Record<string, unknown> | undefined;
  const { service } = createTestService({
    sent,
    sessionFactory: (options: Record<string, unknown>) => {
      factoryOptions = options;
      return session;
    },
    cliScanner: () => [
      { threadId: 'codex-thread-99', updatedAt: '2026-03-15T00:00:00Z', cwd: 'D:\\Workspace\\Project', lastText: 'last output' }
    ],
    cliProcess: {
      list: () => [{ pid: 11, commandLine: 'codex run --thread codex-thread-99' }],
      kill: (processes: Array<any>) => {
        killed = processes;
        return { killed: processes.length, failed: 0, errors: [] };
      }
    }
  });

  await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管T1' });

  assert.equal(killed.length, 1);
  assert.equal((killed[0] as any)?.pid, 11);
  assert.equal(session.started, true);
  assert.equal(factoryOptions?.mode, 'resume');
  assert.equal(factoryOptions?.resumeThreadId, 'codex-thread-99');
  assert.match(sent[sent.length - 1] ?? '', /已开始接管 T1/);
});

test('debug diagnostics log recovered-thread conflicts and resume caller metadata', async () => {
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalConsoleLog = console.log;
  const capturedLogs: string[] = [];
  const modulePath = require.resolve('../../src/communicate/channel/feishu-service');

  try {
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.map((value) => String(value)).join(' '));
    };
    delete require.cache[modulePath];

    const { createFeishuService: createDebugFeishuService } = require('../../src/communicate/channel/feishu-service') as {
      createFeishuService: typeof createFeishuService;
    };

    const registry = createMockRegistry({
      nextTaskId: 10,
      records: [
        {
          taskId: 'T1',
          feishuThreadId: 'feishu:chat-1',
          codexThreadId: 'codex-thread-1',
          sessionLifecycle: 'FAILED',
          sessionKind: 'coding'
        },
        {
          taskId: 'T9',
          feishuThreadId: 'feishu:chat-9',
          codexThreadId: 'codex-thread-1',
          sessionLifecycle: 'FAILED',
          sessionKind: 'coding'
        }
      ]
    });
    const session = createMockSession({
      lifecycle: 'STARTING',
      codexThreadId: 'codex-thread-1',
      sessionInstanceId: 'session-resume-1'
    });
    const { service } = createTestService({
      sent: [],
      registry,
      sessionFactory: () => session,
      createServiceImpl: createDebugFeishuService
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '对 T1 输入: 继续下一步' });

    assert(
      capturedLogs.some(
        (line) =>
          line.includes('[feishu-service] recovered task codex thread conflict') &&
          line.includes('"codexThreadId":"codex-thread-1"') &&
          line.includes('"taskId":"T1"') &&
          line.includes('"taskId":"T9"')
      )
    );
    assert(
      capturedLogs.some(
        (line) =>
          line.includes('[feishu-service] session ensure begin') &&
          line.includes('"caller":"explicit_task_reply"') &&
          line.includes('"taskId":"T1"') &&
          line.includes('"codexThreadId":"codex-thread-1"')
      )
    );
    assert(
      capturedLogs.some(
        (line) =>
          line.includes('[feishu-service] session ensure resume') &&
          line.includes('"caller":"explicit_task_reply"') &&
          line.includes('"sessionInstanceId":"session-resume-1"')
      )
    );
    assert(
      capturedLogs.some(
        (line) =>
          line.includes('[feishu-service] registry codex thread conflict') &&
          line.includes('"codexThreadId":"codex-thread-1"') &&
          line.includes('"taskId":"T9"')
      )
    );
  } finally {
    console.log = originalConsoleLog;
    delete require.cache[modulePath];
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
  }
});

test('debug diagnostics log takeover kill targets and result', async () => {
  const originalDebugEnv = process.env.COMMUNICATE_FEISHU_DEBUG;
  const originalConsoleLog = console.log;
  const capturedLogs: string[] = [];
  const modulePath = require.resolve('../../src/communicate/channel/feishu-service');

  try {
    process.env.COMMUNICATE_FEISHU_DEBUG = '1';
    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.map((value) => String(value)).join(' '));
    };
    delete require.cache[modulePath];

    const { createFeishuService: createDebugFeishuService } = require('../../src/communicate/channel/feishu-service') as {
      createFeishuService: typeof createFeishuService;
    };

    const session = createMockSession({
      lifecycle: 'STARTING',
      codexThreadId: 'codex-thread-99',
      sessionInstanceId: 'session-takeover-1'
    });
    const { service } = createTestService({
      sent: [],
      sessionFactory: () => session,
      cliScanner: () => [
        {
          threadId: 'codex-thread-99',
          updatedAt: '2026-03-15T00:00:00Z',
          cwd: 'D:\\Workspace\\Project',
          lastText: 'last output'
        }
      ],
      cliProcess: {
        list: () => [{ pid: 11, commandLine: 'codex run --thread codex-thread-99' }],
        kill: (processes: Array<any>) => ({ killed: processes.length, failed: 0, errors: [] })
      },
      createServiceImpl: createDebugFeishuService
    });

    await service.handleInboundMessage({ threadId: 'feishu:chat-1', text: '接管T1' });

    assert(
      capturedLogs.some(
        (line) =>
          line.includes('[feishu-service] takeover process kill scan') &&
          line.includes('"targetTaskId":"T1"') &&
          line.includes('"targetCodexThreadId":"codex-thread-99"') &&
          line.includes('"pid":11')
      )
    );
    assert(
      capturedLogs.some(
        (line) =>
          line.includes('[feishu-service] takeover process kill result') &&
          line.includes('"targetTaskId":"T1"') &&
          line.includes('"targetCodexThreadId":"codex-thread-99"') &&
          line.includes('"killed":1') &&
          line.includes('"failed":0')
      )
    );
  } finally {
    console.log = originalConsoleLog;
    delete require.cache[modulePath];
    if (originalDebugEnv === undefined) {
      delete process.env.COMMUNICATE_FEISHU_DEBUG;
    } else {
      process.env.COMMUNICATE_FEISHU_DEBUG = originalDebugEnv;
    }
  }
});
