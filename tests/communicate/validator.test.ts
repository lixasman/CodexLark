import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore } from '../../src/communicate/storage/task-store';
import { validateReplyCommand } from '../../src/communicate/control/validator';

function buildReplyCommand(taskId: string, params: Record<string, unknown>) {
  return {
    intent: 'reply_task' as const,
    taskId,
    params,
    targetThreadId: 'feishu:chat-1',
    confidence: 1,
    needsClarification: false,
    reason: 'test'
  };
}

test('validator rejects replies to closed tasks', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'CLOSED' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'confirm', value: 'allow' })
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /已关闭|已结束|not waiting/i);
});

test('validator rejects choose_index when waitKind is not choice', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'WAITING_USER', waitKind: 'confirm' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'choose_index', index: 1 })
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /choice/i);
});

test('validator rejects input_text when waitKind is not text_input', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'WAITING_USER', waitKind: 'choice' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'input_text', text: 'hello' })
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /text_input/i);
});

test('validator allows bootstrap task input for a starting codex session', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'STARTING' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'input_text', text: 'hello' })
  });

  assert.equal(result.ok, true);
});

test('validator allows a new turn input for an idle codex session', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'IDLE' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'input_text', text: 'hello again' })
  });

  assert.equal(result.ok, true);
});

test('validator allows input while the codex session is running a turn', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'RUNNING_TURN' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'input_text', text: 'hello again' })
  });

  assert.equal(result.ok, true);
});

test('validator requires explicit task ID when multiple waiting tasks exist', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'WAITING_USER', waitKind: 'confirm' });
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'WAITING_USER', waitKind: 'confirm' });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: {
      intent: 'reply_task',
      params: { action: 'confirm', value: 'allow' },
      targetThreadId: 'feishu:chat-1',
      confidence: 1,
      needsClarification: false,
      reason: 'test'
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsClarification, true);
});

test('validator rejects non-unique allow mapping when confirm options are ambiguous', () => {
  const store = createTaskStore();
  store.createTask({
    taskType: 'codex_session',
    threadId: 'feishu:chat-1',
    lifecycle: 'WAITING_USER',
    waitKind: 'confirm',
    waitOptions: ['Allow once', 'Allow always']
  });

  const result = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: buildReplyCommand('T1', { action: 'confirm', value: 'allow' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsClarification, true);
});

