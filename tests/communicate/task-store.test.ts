import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskIdGenerator, createTaskStore } from '../../src/communicate/storage/task-store';

test('task IDs are allocated in monotonic short form', () => {
  const nextId = createTaskIdGenerator();
  assert.equal(nextId(), 'T1');
  assert.equal(nextId(), 'T2');
  assert.equal(nextId(), 'T3');
});

test('task IDs can continue from a persisted nextTaskId value', () => {
  const nextId = createTaskIdGenerator(8);
  assert.equal(nextId(), 'T8');
  assert.equal(nextId(), 'T9');
});

test('task store persists and updates task records by task ID', () => {
  const store = createTaskStore();
  const created = store.createTask({
    taskType: 'codex_session',
    threadId: 'feishu:chat-1',
    lifecycle: 'CREATED'
  });

  assert.equal(created.id, 'T1');
  assert.equal(store.getTask('T1')?.threadId, 'feishu:chat-1');

  store.updateTask('T1', {
    lifecycle: 'WAITING_USER',
    waitKind: 'choice',
    checkpointOutput: 'Need your choice',
    latestWaitPrompt: 'Choose 1 or 2'
  });

  const updated = store.getTask('T1');
  assert.equal(updated?.lifecycle, 'WAITING_USER');
  assert.equal(updated?.waitKind, 'choice');
  assert.equal(updated?.checkpointOutput, 'Need your choice');
  assert.equal(updated?.latestWaitPrompt, 'Choose 1 or 2');
});

test('task store filters tasks by thread and current waiting status', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'RUNNING' });
  store.createTask({ taskType: 'chat_reply', threadId: 'feishu:chat-1', lifecycle: 'WAITING_USER', waitKind: 'confirm' });
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-2', lifecycle: 'WAITING_USER', waitKind: 'choice' });

  const chat1Tasks = store.listTasksByThread('feishu:chat-1');
  const chat1Waiting = store.listWaitingTasksByThread('feishu:chat-1');

  assert.equal(chat1Tasks.length, 2);
  assert.equal(chat1Waiting.length, 1);
  assert.equal(chat1Waiting[0]?.threadId, 'feishu:chat-1');
  assert.equal(chat1Waiting[0]?.waitKind, 'confirm');
});

test('task store can delete a task by task ID', () => {
  const store = createTaskStore();
  store.createTask({ taskType: 'codex_session', threadId: 'feishu:chat-1', lifecycle: 'IDLE' });

  const deleted = store.deleteTask('T1');

  assert.equal(deleted?.id, 'T1');
  assert.equal(store.getTask('T1'), undefined);
  assert.deepEqual(store.listTasksByThread('feishu:chat-1'), []);
});

test('task store preserves recovery metadata fields on create and update', () => {
  const store = createTaskStore();
  const created = store.createTask({
    taskType: 'codex_session',
    threadId: 'feishu:chat-1',
    lifecycle: 'IDLE',
    cwd: 'D:\\Workspace\\Project\\Communicate',
    logFilePath: 'D:\\Workspace\\Project\\logs\\communicate\\T1.log',
    codexThreadId: 'codex-thread-1',
    model: 'gpt-5.4',
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    interruptedByRestart: false,
    sessionKind: 'assistant',
    assistantProfileId: 'research-assistant-v1',
    developerInstructions: '你是长期科研助理。',
    personality: 'pragmatic',
    runtimeWarnings: [
      {
        code: 'known_bad_codex_version',
        message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
        version: '0.120.0',
        overrideActive: true
      }
    ],
    goalSummary: '整理飞书任务切换卡的目标摘要',
    goalSummaryStatus: 'pending',
    goalSummarySourceText: '请整理飞书任务切换卡的目标摘要展示',
    firstUserCodingText: '请整理飞书任务切换卡的目标摘要展示'
  } as any);

  assert.equal((created as any).codexThreadId, 'codex-thread-1');
  assert.equal((created as any).model, 'gpt-5.4');
  assert.equal((created as any).approvalPolicy, 'on-request');
  assert.equal((created as any).sandbox, 'danger-full-access');
  assert.equal((created as any).interruptedByRestart, false);
  assert.equal((created as any).sessionKind, 'assistant');
  assert.equal((created as any).assistantProfileId, 'research-assistant-v1');
  assert.equal((created as any).developerInstructions, '你是长期科研助理。');
  assert.equal((created as any).personality, 'pragmatic');
  assert.equal((created as any).runtimeWarnings?.[0]?.code, 'known_bad_codex_version');
  assert.equal((created as any).goalSummary, '整理飞书任务切换卡的目标摘要');
  assert.equal((created as any).goalSummaryStatus, 'pending');
  assert.equal((created as any).goalSummarySourceText, '请整理飞书任务切换卡的目标摘要展示');
  assert.equal((created as any).firstUserCodingText, '请整理飞书任务切换卡的目标摘要展示');

  store.updateTask('T1', {
    codexThreadId: 'codex-thread-2',
    model: null,
    interruptedByRestart: true,
    sessionKind: 'coding',
    runtimeWarnings: [
      {
        code: 'known_bad_codex_version',
        message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
        version: '0.120.0',
        overrideActive: true
      }
    ],
    goalSummary: '修复飞书任务切换卡摘要可读性',
    goalSummaryStatus: 'ready'
  } as any);

  const updated = store.getTask('T1');
  assert.equal((updated as any)?.codexThreadId, 'codex-thread-2');
  assert.equal((updated as any)?.model, null);
  assert.equal((updated as any)?.interruptedByRestart, true);
  assert.equal((updated as any)?.sessionKind, 'coding');
  assert.equal((updated as any)?.runtimeWarnings?.[0]?.overrideActive, true);
  assert.equal((updated as any)?.goalSummary, '修复飞书任务切换卡摘要可读性');
  assert.equal((updated as any)?.goalSummaryStatus, 'ready');
  assert.equal((updated as any)?.goalSummarySourceText, '请整理飞书任务切换卡的目标摘要展示');
  assert.equal((updated as any)?.firstUserCodingText, '请整理飞书任务切换卡的目标摘要展示');
});
