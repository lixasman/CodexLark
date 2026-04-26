import test from 'node:test';
import assert from 'node:assert/strict';
import { routeUserMessage } from '../../src/communicate/control/router';

test('routes codex session creation with cwd extracted from natural language', () => {
  const routed = routeUserMessage({
    text: '帮我在 D:\\Workspace\\Project 项目下新建一个 codex 窗口',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'codex_session');
  assert.equal(routed.params.cwd, 'D:\\Workspace\\Project');
  assert.equal(routed.needsClarification, false);
});

test('routes codex session creation when path has no surrounding spaces', () => {
  const routed = routeUserMessage({
    text: '帮我在D:\\Workspace\\Project下开一个codex窗口',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'codex_session');
  assert.equal(routed.params.cwd, 'D:\\Workspace\\Project');
  assert.equal(routed.needsClarification, false);
});

test('routes codex session creation when cwd contains multiple path segments', () => {
  const routed = routeUserMessage({
    text: '帮我在 C:\\Users\\TestUser\\repo 下开一个 codex 窗口',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'codex_session');
  assert.equal(routed.params.cwd, 'C:\\Users\\TestUser\\repo');
  assert.equal(routed.needsClarification, false);
});

test('routes takeover command to local codex intent', () => {
  const routed = routeUserMessage({
    text: '接管本地 codex 会话',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'takeover_local_codex');
  assert.equal(routed.needsClarification, false);
});

test('routes takeover command with explicit task id', () => {
  const routed = routeUserMessage({
    text: '接管T1',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'takeover_local_codex');
  assert.equal(routed.taskId, 'T1');
});

test('does not route takeover capability questions as takeover commands', () => {
  const routed = routeUserMessage({
    text: '目前这个项目是具备接管本地codex项目的能力吗？',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'chat_reply');
  assert.equal(routed.reason, 'default_chat_reply');
  assert.equal(routed.params.message, '目前这个项目是具备接管本地codex项目的能力吗？');
});

test('routes explicit task replies for choice and text input', () => {
  const choice = routeUserMessage({
    text: '对 T2 选择第一个',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });
  const text = routeUserMessage({
    text: '对 T1 输入: npm run build',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(choice.intent, 'reply_task');
  assert.equal(choice.taskId, 'T2');
  assert.equal(choice.params.action, 'choose_index');
  assert.equal(choice.params.index, 1);

  assert.equal(text.intent, 'reply_task');
  assert.equal(text.taskId, 'T1');
  assert.equal(text.params.action, 'input_text');
  assert.equal(text.params.text, 'npm run build');
});

test('routes explicit task replies without spaces around task ID', () => {
  const text = routeUserMessage({
    text: '对T3输入: 只回复已收到',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(text.intent, 'reply_task');
  assert.equal(text.taskId, 'T3');
  assert.equal(text.params.action, 'input_text');
  assert.equal(text.params.text, '只回复已收到');
});

test('routes explicit close commands with trailing punctuation', () => {
  const routed = routeUserMessage({
    text: '关闭T3。',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'cancel_task');
  assert.equal(routed.taskId, 'T3');
});

test('routes resume commands for closed tasks', () => {
  const routed = routeUserMessage({
    text: '恢复T3',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'resume_task');
  assert.equal(routed.taskId, 'T3');
});

test('routes status/progress queries and ordinary chat separately', () => {
  const query = routeUserMessage({
    text: '查询 T3 状态',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });
  const progress = routeUserMessage({
    text: '查询 T3 进展',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });
  const chat = routeUserMessage({
    text: '这个报错是什么意思',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(query.intent, 'query_task');
  assert.equal(query.taskId, 'T3');
  assert.equal(query.reason, 'query_task_status');
  assert.equal(query.params.view, 'status');
  assert.equal(progress.intent, 'query_task');
  assert.equal(progress.taskId, 'T3');
  assert.equal(progress.reason, 'query_task_progress');
  assert.equal(progress.params.view, 'progress');
  assert.equal(chat.intent, 'start_task');
  assert.equal(chat.taskType, 'chat_reply');
  assert.equal(chat.params.message, '这个报错是什么意思');
});

test('marks missing codex cwd as needing clarification', () => {
  const routed = routeUserMessage({
    text: '帮我开一个 codex',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'codex_session');
  assert.equal(routed.needsClarification, true);
});

test('plain allow stays as ordinary chat even when a unique waiting task exists', () => {
  const routed = routeUserMessage({
    text: '允许',
    threadId: 'feishu:chat-1',
    waitingTasks: [
      {
        id: 'T7',
        taskType: 'codex_session',
        threadId: 'feishu:chat-1',
        lifecycle: 'WAITING_USER',
        waitKind: 'confirm'
      }
    ]
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'chat_reply');
  assert.equal(routed.taskId, undefined);
  assert.equal(routed.params.message, '允许');
});

test('plain allow stays as ordinary chat even when multiple waiting tasks exist', () => {
  const routed = routeUserMessage({
    text: '允许',
    threadId: 'feishu:chat-1',
    waitingTasks: [
      {
        id: 'T7',
        taskType: 'codex_session',
        threadId: 'feishu:chat-1',
        lifecycle: 'WAITING_USER',
        waitKind: 'confirm'
      },
      {
        id: 'T8',
        taskType: 'codex_session',
        threadId: 'feishu:chat-1',
        lifecycle: 'WAITING_USER',
        waitKind: 'confirm'
      }
    ]
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'chat_reply');
  assert.equal(routed.taskId, undefined);
  assert.equal(routed.params.message, '允许');
});

test('mentioning codex without an explicit coding instruction stays as chat reply', () => {
  const routed = routeUserMessage({
    text: '用 codex 帮我看看这个报错是什么意思',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'chat_reply');
  assert.equal(routed.params.message, '用 codex 帮我看看这个报错是什么意思');
});

test('capability question about codex stays as chat reply', () => {
  const routed = routeUserMessage({
    text: '比如我想让他调用codex来写代码，或者调用网页gemini进行深度研究，他能做到吗？',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'chat_reply');
  assert.equal(
    routed.params.message,
    '比如我想让他调用codex来写代码，或者调用网页gemini进行深度研究，他能做到吗？'
  );
});

test('deep research requests fall back to ordinary chat after purification', () => {
  const routed = routeUserMessage({
    text: '帮我用 gemini 深度研究一下飞书长连接的恢复机制',
    threadId: 'feishu:chat-1',
    waitingTasks: []
  });

  assert.equal(routed.intent, 'start_task');
  assert.equal(routed.taskType, 'chat_reply');
  assert.equal(routed.params.message, '帮我用 gemini 深度研究一下飞书长连接的恢复机制');
});





