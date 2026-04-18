import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMUNICATE_TASK_INTENTS,
  COMMUNICATE_TASK_TYPES,
  formatCommunicateTaskRuntimeConfig,
  isCommunicateTaskId,
  normalizeWaitKind,
  type CommunicateRuntimeWarning,
  type CommunicateTaskState
} from '../../src/communicate/protocol/task-types';
import { COMMUNICATE_TASK_EVENTS, normalizeTaskEventType } from '../../src/communicate/protocol/task-events';

test('isCommunicateTaskId only accepts T<number> format', () => {
  assert.equal(isCommunicateTaskId('T1'), true);
  assert.equal(isCommunicateTaskId('T25'), true);
  assert.equal(isCommunicateTaskId('t1'), false);
  assert.equal(isCommunicateTaskId('1'), false);
  assert.equal(isCommunicateTaskId('TASK1'), false);
});

test('communicate protocol exports the expected finite task intents and task types', () => {
  assert.deepEqual(COMMUNICATE_TASK_INTENTS, [
  'start_task',
  'reply_task',
  'query_task',
  'cancel_task',
  'resume_task',
  'takeover_local_codex'
]);
  assert.deepEqual(COMMUNICATE_TASK_TYPES, ['codex_session', 'chat_reply']);
});

test('waiting state requires a valid waitKind', () => {
  const waitingState: CommunicateTaskState = {
    lifecycle: 'WAITING_USER',
    waitKind: 'choice'
  };
  assert.equal(waitingState.waitKind, 'choice');
  assert.equal(normalizeWaitKind('confirm'), 'confirm');
  assert.equal(normalizeWaitKind('nope'), null);
});

test('communicate task record can carry assistant session metadata', () => {
  const assistantTask = {
    id: 'T9',
    taskType: 'codex_session',
    threadId: 'feishu:chat-1',
    lifecycle: 'IDLE',
    sessionKind: 'assistant',
    startupMode: 'new',
    assistantProfileId: 'research-assistant-v1',
    developerInstructions: '你是长期科研助理。',
    personality: 'pragmatic'
  };

  assert.equal(assistantTask.sessionKind, 'assistant');
  assert.equal(assistantTask.startupMode, 'new');
  assert.equal(assistantTask.assistantProfileId, 'research-assistant-v1');
  assert.equal(assistantTask.personality, 'pragmatic');
});

test('runtime config formatter distinguishes unknown, default, and unset placeholders', () => {
  const labels = formatCommunicateTaskRuntimeConfig({
    model: null,
    sandbox: undefined,
    approvalPolicy: undefined,
    sessionKind: undefined,
    startupMode: undefined,
    interruptedByRestart: null,
    defaultSandbox: 'danger-full-access',
    defaultApprovalPolicy: 'on-request'
  });

  assert.equal(labels.primary, 'model 未知 · sandbox 默认(danger-full-access) · approvalPolicy 默认(on-request)');
  assert.equal(labels.secondary, 'sessionKind 未设置 · 恢复态 未设置 · 中断恢复 未知');
  assert.equal(labels.showSecondary, true);
});

test('runtime config formatter hides redundant default assistant session summary', () => {
  const labels = formatCommunicateTaskRuntimeConfig({
    model: 'gpt-5.4',
    sandbox: 'danger-full-access',
    approvalPolicy: 'on-request',
    sessionKind: 'assistant',
    startupMode: 'new',
    interruptedByRestart: false
  });

  assert.equal(labels.primary, 'model gpt-5.4 · sandbox danger-full-access · approvalPolicy on-request');
  assert.equal(labels.secondary, 'sessionKind assistant · 恢复态 否 · 中断恢复 否');
  assert.equal(labels.showSecondary, false);
});

test('worker events normalize to the known communicate task events set', () => {
  assert.deepEqual(COMMUNICATE_TASK_EVENTS, [
    'task_started',
    'task_output',
    'task_waiting_user',
    'task_finished',
    'task_failed',
    'task_status_snapshot'
  ]);
  assert.equal(normalizeTaskEventType('task_finished'), 'task_finished');
  assert.equal(normalizeTaskEventType('bad_event'), null);
});

test('communicate protocol exposes runtime warning metadata for known bad Codex versions', () => {
  const warning: CommunicateRuntimeWarning = {
    code: 'known_bad_codex_version',
    message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
    version: '0.120.0',
    overrideActive: true
  };

  assert.equal(warning.code, 'known_bad_codex_version');
  assert.equal(warning.overrideActive, true);
  assert.match(warning.message, /当前Codex版本存在不兼容问题/);
});


