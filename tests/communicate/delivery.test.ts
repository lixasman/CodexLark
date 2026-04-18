import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCheckpointDelivery,
  formatPolishCandidateDelivery,
  formatTaskProgressDelivery,
  formatStatusQueryDelivery,
  formatTakeoverList
} from '../../src/communicate/delivery/checkpoint-format';
import { segmentText } from '../../src/communicate/delivery/segmenter';

test('formats full checkpoint output with task header', () => {
  const message = formatCheckpointDelivery({
    taskId: 'T3',
    lifecycle: 'WAITING_USER',
    output: 'Need your confirmation',
    waitHint: '对 T3 允许'
  });

  assert.match(message, /T3/);
  assert.match(message, /WAITING_USER/);
  assert.match(message, /Need your confirmation/);
  assert.match(message, /对 T3 允许/);
});

test('formats checkpoint delivery with additive runtime warning lines', () => {
  const message = formatCheckpointDelivery({
    taskId: 'T3',
    lifecycle: 'FAILED',
    output: '原始失败输出',
    runtimeWarnings: [
      {
        code: 'known_bad_codex_version',
        message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
        version: '0.120.0',
        overrideActive: true
      }
    ]
  });

  assert.match(message, /当前Codex版本存在不兼容问题，请尽快升级到最新版本/);
  assert.match(message, /原始失败输出/);
});

test('segments long text into ordered chunks', () => {
  const text = 'A'.repeat(25);
  const chunks = segmentText({ taskId: 'T5', text, maxChars: 10 });

  assert.equal(chunks.length, 3);
  assert.match(chunks[0] ?? '', /T5 \[1\/3\]/);
  assert.match(chunks[1] ?? '', /T5 \[2\/3\]/);
  assert.match(chunks[2] ?? '', /T5 \[3\/3\]/);
});

test('formats status query with quiet duration and screenshot reference', () => {
  const message = formatStatusQueryDelivery({
    taskId: 'T2',
    lifecycle: 'RUNNING',
    model: 'gpt-5.4',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    sessionKind: 'coding',
    startupMode: 'resume',
    interruptedByRestart: true,
    runtimeWarnings: [
      {
        code: 'known_bad_codex_version',
        message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
        version: '0.120.0',
        overrideActive: true
      }
    ],
    quietMinutes: 12,
    recentSummary: '最近没有新输出',
    screenshotPath: 'artifacts/t2-latest.png'
  });

  assert.match(message, /T2/);
  assert.match(message, /配置 model gpt-5\.4 · sandbox workspace-write · approvalPolicy never/);
  assert.match(message, /会话 sessionKind coding · 恢复态 是 · 中断恢复 是/);
  assert.match(message, /当前Codex版本存在不兼容问题，请尽快升级到最新版本/);
  assert.match(message, /gpt-5\.4/);
  assert.match(message, /12/);
  assert.match(message, /artifacts\/t2-latest\.png/);
});

test('formats task progress delivery as the last Codex reply body only', () => {
  const message = formatTaskProgressDelivery({
    taskId: 'T2',
    lifecycle: 'RUNNING_TURN',
    previousOutput: '上一轮已经整理完根因候选。',
    liveOutput: '当前这一轮正在补测试。',
    waitHint: '对 T2 输入: 继续补测试'
  });

  assert.match(message, /上一轮已经整理完根因候选。/);
  assert.doesNotMatch(message, /T2/);
  assert.doesNotMatch(message, /RUNNING_TURN/);
  assert.doesNotMatch(message, /当前这一轮正在补测试。/);
  assert.doesNotMatch(message, /对 T2 输入: 继续补测试/);
  assert.doesNotMatch(message, /静默时长/);
  assert.doesNotMatch(message, /恢复提示/);
  assert.doesNotMatch(message, /Codex Thread/);
});

test('formats polish candidate delivery with confirmation hint', () => {
  const message = formatPolishCandidateDelivery({
    taskId: 'T9',
    candidateText: '请先检查测试失败原因，再决定是否修改实现。'
  });

  assert.match(message, /T9/);
  assert.match(message, /润色候选/);
  assert.match(message, /确认发送/);
});

test('formats takeover list with codex thread summary', () => {
  const message = formatTakeoverList([
    {
      id: 'T2',
      origin: 'cli',
      lifecycle: 'IDLE',
      model: 'gpt-5.2',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      sessionKind: 'coding',
      startupMode: 'new',
      interruptedByRestart: false,
      codexThreadId: 'thread-1',
      cwd: 'D:\\Workspace\\Project',
      summary: '最近输出'
    },
    {
      id: 'T3',
      origin: 'cli',
      lifecycle: 'IDLE',
      model: null,
      sessionKind: 'coding',
      startupMode: 'resume',
      interruptedByRestart: true,
      defaultSandbox: 'danger-full-access',
      defaultApprovalPolicy: 'on-request',
      codexThreadId: 'thread-2',
      cwd: 'D:\\Workspace\\Project',
      summary: '未知模型'
    },
    {
      id: 'T4',
      origin: 'unknown',
      lifecycle: 'STARTING',
      sessionKind: undefined,
      startupMode: undefined,
      interruptedByRestart: undefined,
      codexThreadId: 'thread-3',
      cwd: 'D:\\Workspace\\Project',
      summary: '未设置模型'
    }
  ]);

  assert.match(message, /T2/);
  assert.match(message, /配置 model gpt-5\.2 · sandbox workspace-write · approvalPolicy never/);
  assert.match(message, /会话 sessionKind coding · 恢复态 否 · 中断恢复 否/);
  assert.match(message, /配置 model 未知 · sandbox 默认\(danger-full-access\) · approvalPolicy 默认\(on-request\)/);
  assert.match(message, /会话 sessionKind coding · 恢复态 是 · 中断恢复 是/);
  assert.match(message, /配置 model 未设置 · sandbox 未设置 · approvalPolicy 未设置/);
  assert.match(message, /会话 sessionKind 未设置 · 恢复态 未设置 · 中断恢复 未设置/);
  assert.match(message, /thread-1/);
  assert.match(message, /D:\\Workspace\\Project/);
  assert.match(message, /最近输出/);
});

test('takeover list hides redundant default assistant session summary', () => {
  const message = formatTakeoverList([
    {
      id: 'T9',
      origin: 'cli',
      lifecycle: 'IDLE',
      model: 'gpt-5.4',
      sandbox: 'danger-full-access',
      approvalPolicy: 'on-request',
      sessionKind: 'assistant',
      startupMode: 'new',
      interruptedByRestart: false,
      codexThreadId: 'thread-assistant',
      cwd: 'D:\\Workspace\\Project',
      summary: '助手会话'
    }
  ]);

  assert.match(message, /配置 model gpt-5\.4 · sandbox danger-full-access · approvalPolicy on-request/);
  assert.doesNotMatch(message, /会话 sessionKind assistant · 恢复态 否 · 中断恢复 否/);
});



