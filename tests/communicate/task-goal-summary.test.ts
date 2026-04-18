import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskGoalSummaryGenerator } from '../../src/communicate/summary/task-goal-summary';

type CodexSummaryGenerator = {
  summarize: (input: { sourceText: string; cwd?: string }) => Promise<string | undefined>;
};

type MockSummarySession = {
  startCalls: number;
  closeCalls: number;
  replies: Array<Record<string, unknown>>;
  start: () => void;
  sendReply: (reply: Record<string, unknown>) => void;
  close: () => Promise<{ forced: boolean }>;
  getSnapshot: () => {
    lifecycle: string;
    liveBuffer: string;
    checkpointOutput?: string;
  };
};

function loadCodexSummaryGeneratorFactory(): (input: {
  codexCommand: string[];
  timeoutMs: number;
  allowKnownBadCodexVersion?: boolean;
  sessionFactory?: (options: {
    taskId: string;
    cwd: string;
    command: string[];
    approvalPolicy: string;
    sandbox: string;
    ephemeral?: boolean;
    allowKnownBadCodexVersion?: boolean;
    developerInstructions: string;
    baseInstructions: string;
    enableLogWindow: boolean;
    onEvent: (event: { type: 'task_finished' | 'task_failed' | 'task_waiting_user'; taskId: string; output: string }) => void;
  }) => {
    start: () => void;
    sendReply: (reply: { action: string; text?: string }) => void;
    close?: () => Promise<{ forced: boolean }> | { forced: boolean };
    getSnapshot?: () => {
      lifecycle: string;
      liveBuffer: string;
      checkpointOutput?: string;
    };
  };
}) => CodexSummaryGenerator {
  const mod = require('../../src/communicate/summary/task-goal-summary') as {
    createTaskGoalSummaryGeneratorFromCodexCommand?: unknown;
  };
  assert.equal(typeof mod.createTaskGoalSummaryGeneratorFromCodexCommand, 'function');
  return mod.createTaskGoalSummaryGeneratorFromCodexCommand as (input: {
    codexCommand: string[];
    timeoutMs: number;
    allowKnownBadCodexVersion?: boolean;
    sessionFactory?: (options: {
      taskId: string;
      cwd: string;
      command: string[];
      approvalPolicy: string;
      sandbox: string;
      ephemeral?: boolean;
      allowKnownBadCodexVersion?: boolean;
      developerInstructions: string;
      baseInstructions: string;
      enableLogWindow: boolean;
      onEvent: (event: { type: 'task_finished' | 'task_failed' | 'task_waiting_user'; taskId: string; output: string }) => void;
    }) => {
      start: () => void;
      sendReply: (reply: { action: string; text?: string }) => void;
      close?: () => Promise<{ forced: boolean }> | { forced: boolean };
      getSnapshot?: () => {
        lifecycle: string;
        liveBuffer: string;
        checkpointOutput?: string;
      };
    };
  }) => CodexSummaryGenerator;
}

function createMockSummarySession(input?: {
  onSendReply?: (reply: Record<string, unknown>, replyIndex: number) => void;
  closeImpl?: () => Promise<{ forced: boolean }>;
}): MockSummarySession {
  let replyIndex = 0;
  return {
    startCalls: 0,
    closeCalls: 0,
    replies: [],
    start() {
      this.startCalls += 1;
    },
    sendReply(reply) {
      this.replies.push(reply);
      input?.onSendReply?.(reply, replyIndex++);
    },
    async close() {
      this.closeCalls += 1;
      if (input?.closeImpl) {
        return await input.closeImpl();
      }
      return { forced: false };
    },
    getSnapshot() {
      return {
        lifecycle: 'IDLE',
        liveBuffer: '',
        checkpointOutput: ''
      };
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

test('task goal summary generator sends a constrained chinese prompt', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const generator = createTaskGoalSummaryGenerator({
    model: 'gpt-test',
    timeoutMs: 1000,
    client: {
      async complete(req) {
        calls.push(req as unknown as Record<string, unknown>);
        return {
          id: 'resp_1',
          choices: [{ index: 0, message: { role: 'assistant', content: '修复飞书任务切换卡摘要不可读问题' } }]
        };
      }
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题，不要只显示当前进展。'
  });

  assert.equal(summary, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, 'gpt-test');
  assert.equal(calls[0]?.temperature, 0);
  assert.match(String(((calls[0]?.messages as Array<{ role: string; content: string }>)?.[0]?.content) ?? ''), /任务最初要做什么/);
  assert.match(String(((calls[0]?.messages as Array<{ role: string; content: string }>)?.[0]?.content) ?? ''), /只输出一句简体中文短摘要/);
  assert.match(String(((calls[0]?.messages as Array<{ role: string; content: string }>)?.[1]?.content) ?? ''), /请修复飞书任务切换卡摘要不可读问题/);
});

test('task goal summary generator normalizes model output into a single line', async () => {
  const generator = createTaskGoalSummaryGenerator({
    model: 'gpt-test',
    timeoutMs: 1000,
    client: {
      async complete() {
        return {
          id: 'resp_2',
          choices: [{ index: 0, message: { role: 'assistant', content: '\n修复飞书任务切换卡摘要不可读问题\n补充状态卡三行展示\n' } }]
        };
      }
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题，并补充更稳定的三行展示。'
  });

  assert.equal(summary, '修复飞书任务切换卡摘要不可读问题');
});

test('task goal summary generator preserves legitimate numeric prefixes in task names', async () => {
  const generator = createTaskGoalSummaryGenerator({
    model: 'gpt-test',
    timeoutMs: 1000,
    client: {
      async complete() {
        return {
          id: 'resp_2b',
          choices: [{ index: 0, message: { role: 'assistant', content: '2FA 登录接入' } }]
        };
      }
    }
  });

  const summary = await generator.summarize({
    sourceText: '请完成 2FA 登录接入。'
  });

  assert.equal(summary, '2FA 登录接入');
});

test('task goal summary generator returns undefined on model failure', async () => {
  const generator = createTaskGoalSummaryGenerator({
    model: 'gpt-test',
    timeoutMs: 1000,
    client: {
      async complete() {
        throw new Error('upstream failed');
      }
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。'
  });

  assert.equal(summary, undefined);
});

test('task goal summary generator returns undefined on timeout', async () => {
  const generator = createTaskGoalSummaryGenerator({
    model: 'gpt-test',
    timeoutMs: 10,
    client: {
      async complete() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          id: 'resp_3',
          choices: [{ index: 0, message: { role: 'assistant', content: '修复飞书任务切换卡摘要不可读问题' } }]
        };
      }
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。'
  });

  assert.equal(summary, undefined);
});

test('task goal summary codex generator creates and closes a fresh ephemeral app session per request', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  const factoryCalls: Array<Record<string, unknown>> = [];
  const sessions: MockSummarySession[] = [];
  const outputs = ['修复飞书任务切换卡摘要不可读问题', '整理任务切换卡摘要回填链路'];
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex', '--model', 'gpt-5.4'],
    timeoutMs: 1000,
    allowKnownBadCodexVersion: true,
    sessionFactory: (options) => {
      const sessionIndex = sessions.length;
      factoryCalls.push({ ...options, onEvent: undefined });
      const session = createMockSummarySession({
        onSendReply: () => {
          queueMicrotask(() => {
            options.onEvent({
              type: 'task_finished',
              taskId: options.taskId,
              output: `\n${outputs[sessionIndex]}\n补充说明\n`
            });
          });
        }
      });
      sessions.push(session);
      return session;
    }
  });

  const first = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题，不要只显示当前进展。',
    cwd: 'D:\\Workspace\\CodexLark'
  });
  const second = await generator.summarize({
    sourceText: '请整理任务切换卡摘要回填链路。',
    cwd: 'D:\\Workspace\\CodexLark'
  });

  assert.equal(first, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(second, '整理任务切换卡摘要回填链路');
  assert.equal(factoryCalls.length, 2);
  assert.deepEqual(factoryCalls[0]?.command, ['missing-codex', '--model', 'gpt-5.4']);
  assert.equal(factoryCalls[0]?.cwd, 'D:\\Workspace\\CodexLark');
  assert.equal(factoryCalls[0]?.approvalPolicy, 'never');
  assert.equal(factoryCalls[0]?.sandbox, 'read-only');
  assert.equal(factoryCalls[0]?.ephemeral, true);
  assert.equal(factoryCalls[0]?.allowKnownBadCodexVersion, true);
  assert.equal(factoryCalls[1]?.ephemeral, true);
  assert.equal(factoryCalls[1]?.allowKnownBadCodexVersion, true);
  assert.equal(factoryCalls[0]?.enableLogWindow, false);
  assert.match(String(factoryCalls[0]?.developerInstructions ?? ''), /忽略此前会话内容/);
  assert.equal(sessions[0]?.startCalls, 1);
  assert.equal(sessions[1]?.startCalls, 1);
  assert.equal(sessions[0]?.closeCalls, 1);
  assert.equal(sessions[1]?.closeCalls, 1);
  assert.equal(sessions[0]?.replies.length, 1);
  assert.equal(sessions[1]?.replies.length, 1);
  assert.deepEqual(sessions[0]?.replies.map((reply) => reply.action), ['free_text']);
  assert.deepEqual(sessions[1]?.replies.map((reply) => reply.action), ['free_text']);
  const prompt = String(sessions[0]?.replies[0]?.text ?? '');
  assert.match(prompt, /只根据本轮给出的原始任务描述生成摘要/);
  assert.match(prompt, /任务最初要做什么/);
  assert.match(prompt, /请修复飞书任务切换卡摘要不可读问题/);
});

test('task goal summary codex generator closes a failed one-shot session before the next request', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  const sessions: MockSummarySession[] = [];
  let factoryCalls = 0;
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex'],
    timeoutMs: 1000,
    sessionFactory: (options) => {
      factoryCalls += 1;
      const session = createMockSummarySession({
        onSendReply: () => {
          queueMicrotask(() => {
            options.onEvent(
              factoryCalls === 1
                ? { type: 'task_failed', taskId: options.taskId, output: 'stream disconnected before completion' }
                : { type: 'task_finished', taskId: options.taskId, output: '修复飞书任务切换卡摘要不可读问题' }
            );
          });
        }
      });
      sessions.push(session);
      return session;
    }
  });

  const first = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });
  const second = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });

  assert.equal(first, undefined);
  assert.equal(second, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(factoryCalls, 2);
  assert.equal(sessions[0]?.closeCalls, 1);
  assert.equal(sessions[1]?.startCalls, 1);
  assert.equal(sessions[1]?.closeCalls, 1);
});

test('task goal summary codex generator returns undefined on timeout and closes the one-shot session', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  let session: MockSummarySession | undefined;
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex'],
    timeoutMs: 10,
    sessionFactory: () => {
      session = createMockSummarySession();
      return session;
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });

  assert.equal(summary, undefined);
  assert.equal(session?.closeCalls, 1);
});

test('task goal summary codex generator closes the one-shot session when Codex waits for user input', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  let session: MockSummarySession | undefined;
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex'],
    timeoutMs: 1000,
    sessionFactory: (options) => {
      session = createMockSummarySession({
        onSendReply: () => {
          queueMicrotask(() => {
            options.onEvent({
              type: 'task_waiting_user',
              taskId: options.taskId,
              output: 'Need user approval'
            });
          });
        }
      });
      return session;
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });

  assert.equal(summary, undefined);
  assert.equal(session?.closeCalls, 1);
});

test('task goal summary codex generator preserves serial queue without reusing sessions', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  const sessions: MockSummarySession[] = [];
  const events: Array<(event: { type: 'task_finished' | 'task_failed' | 'task_waiting_user'; taskId: string; output: string }) => void> = [];
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex'],
    timeoutMs: 1000,
    sessionFactory: (options) => {
      events.push(options.onEvent);
      const session = createMockSummarySession();
      sessions.push(session);
      return session;
    }
  });

  const firstPromise = generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondPromise = generator.summarize({
    sourceText: '请整理任务切换卡摘要回填链路。',
    cwd: 'D:\\Workspace\\CodexLark'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.replies.length, 1);

  events[0]?.({
    type: 'task_finished',
    taskId: 'goal-summary',
    output: '修复飞书任务切换卡摘要不可读问题'
  });
  const first = await firstPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(first, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.closeCalls, 1);
  assert.equal(sessions[1]?.replies.length, 1);

  events[1]?.({
    type: 'task_finished',
    taskId: 'goal-summary',
    output: '整理任务切换卡摘要回填链路'
  });
  const second = await secondPromise;

  assert.equal(second, '整理任务切换卡摘要回填链路');
  assert.equal(sessions[1]?.closeCalls, 1);
});
test('task goal summary codex generator waits for close before resolving and starting the next session', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  const sessions: MockSummarySession[] = [];
  const events: Array<(event: { type: 'task_finished' | 'task_failed' | 'task_waiting_user'; taskId: string; output: string }) => void> = [];
  const firstClose = createDeferred<{ forced: boolean }>();
  const secondClose = createDeferred<{ forced: boolean }>();
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex'],
    timeoutMs: 1000,
    sessionFactory: (options) => {
      const sessionIndex = sessions.length;
      events.push(options.onEvent);
      const session = createMockSummarySession({
        closeImpl: () => (sessionIndex === 0 ? firstClose.promise : secondClose.promise)
      });
      sessions.push(session);
      return session;
    }
  });

  let firstResolved = false;
  const firstPromise = generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });
  void firstPromise.then(() => {
    firstResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  events[0]?.({
    type: 'task_finished',
    taskId: 'goal-summary',
    output: '修复飞书任务切换卡摘要不可读问题'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(firstResolved, false);
  assert.equal(sessions[0]?.closeCalls, 1);

  const secondPromise = generator.summarize({
    sourceText: '请整理任务切换卡摘要回填链路。',
    cwd: 'D:\\Workspace\\CodexLark'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sessions.length, 1);

  firstClose.resolve({ forced: false });
  const first = await firstPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(first, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(firstResolved, true);
  assert.equal(sessions.length, 2);

  events[1]?.({
    type: 'task_finished',
    taskId: 'goal-summary',
    output: '整理任务切换卡摘要回填链路'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  secondClose.resolve({ forced: false });
  const second = await secondPromise;

  assert.equal(second, '整理任务切换卡摘要回填链路');
  assert.equal(sessions[1]?.closeCalls, 1);
});

test('task goal summary codex generator still returns the summary when close cleanup fails', async () => {
  const createCodexGenerator = loadCodexSummaryGeneratorFactory();
  let session: MockSummarySession | undefined;
  const generator = createCodexGenerator({
    codexCommand: ['missing-codex'],
    timeoutMs: 1000,
    sessionFactory: (options) => {
      session = createMockSummarySession({
        closeImpl: async () => {
          throw new Error('cleanup failed');
        },
        onSendReply: () => {
          queueMicrotask(() => {
            options.onEvent({
              type: 'task_finished',
              taskId: options.taskId,
              output: '修复飞书任务切换卡摘要不可读问题'
            });
          });
        }
      });
      return session;
    }
  });

  const summary = await generator.summarize({
    sourceText: '请修复飞书任务切换卡摘要不可读问题。',
    cwd: 'D:\\Workspace\\CodexLark'
  });

  assert.equal(summary, '修复飞书任务切换卡摘要不可读问题');
  assert.equal(session?.closeCalls, 1);
});

