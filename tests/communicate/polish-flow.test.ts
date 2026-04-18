import test from 'node:test';
import assert from 'node:assert/strict';
import { routeUserMessage } from '../../src/communicate/control/router';
import { createTaskStore } from '../../src/communicate/storage/task-store';
import { confirmPolishCandidate, preparePolishCandidateTask } from '../../src/communicate/workers/chat/polish';
import { validateReplyCommand } from '../../src/communicate/control/validator';

test('router parses polish-then-confirm as a reply task', () => {
  const routed = routeUserMessage({
    text: '对 T1 请帮我润色我的话语后发送给 codex: 请先检查测试失败原因，再决定是否修改实现',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'reply_task');
  assert.equal(routed.taskId, 'T1');
  assert.equal(routed.params.action, 'polish_then_confirm');
});

test('preparePolishCandidateTask stores a candidate and moves the task into polish_confirm', async () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'WAITING_USER', waitKind: 'text_input' });

  const updated = await preparePolishCandidateTask({
    store,
    taskId: 'T1',
    originalText: '请先检查测试失败原因，再决定是否修改实现',
    rewrite: async (text: string) => `${text}。请把改动范围控制在最小。`
  });

  assert.equal(updated.waitKind, 'polish_confirm');
  assert.match(updated.polishCandidateText ?? '', /改动范围控制在最小/);
});

test('confirmPolishCandidate transforms the candidate into an input_text reply', async () => {
  const store = createTaskStore();
  store.createTask({
    taskType: 'codex_session',
    threadId: 'feishu:chat-1',
    lifecycle: 'WAITING_USER',
    waitKind: 'polish_confirm',
    polishCandidateText: '请先检查测试失败原因，再决定是否修改实现。请把改动范围控制在最小。'
  });

  const validation = validateReplyCommand({
    currentThreadId: 'feishu:chat-1',
    store,
    command: {
      intent: 'reply_task',
      taskId: 'T1',
      params: { action: 'confirm_polish_send' },
      targetThreadId: 'feishu:chat-1',
      confidence: 1,
      needsClarification: false,
      reason: 'test'
    }
  });

  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const reply = confirmPolishCandidate(validation.task);
  assert.deepEqual(reply, {
    action: 'input_text',
    text: '请先检查测试失败原因，再决定是否修改实现。请把改动范围控制在最小。'
  });
});
