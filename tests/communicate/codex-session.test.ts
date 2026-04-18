import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexSession } from '../../src/communicate/workers/codex/session';
import { type CodexSessionLifecycle, type CodexSessionSnapshot } from '../../src/communicate/workers/codex/types';

function createMockChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processEvents = new EventEmitter() as EventEmitter & { stdin: { writes: string[]; write: (chunk: string) => void } };
  processEvents.stdin = {
    writes: [],
    write(chunk: string) {
      this.writes.push(chunk);
    }
  };
  return Object.assign(processEvents, { stdout, stderr });
}

function createTextFallbackSession(input: Parameters<typeof createCodexSession>[0]) {
  return createCodexSession({
    ...input,
    structuredFallback: 'disabled',
    structuredCapabilityProbe:
      input.structuredCapabilityProbe
      ?? (() => ({ supported: false, reason: 'disabled', version: '0.121.0' }))
  });
}

function createMockManagedSession(
  initial?: Partial<{
    taskId: string;
    lifecycle: CodexSessionLifecycle;
    liveBuffer: string;
    checkpointOutput: string;
    waitKind: CodexSessionSnapshot['waitKind'];
    waitOptions: string[];
    model: string;
    codexThreadId: string;
    interruptedByRestart: boolean;
    startImpl: () => void | Promise<void>;
  }>
) {
  const snapshot: CodexSessionSnapshot = {
    taskId: 'T1',
    lifecycle: 'CREATED',
    liveBuffer: '',
    checkpointOutput: '',
    waitKind: undefined,
    waitOptions: undefined,
    model: undefined,
    codexThreadId: undefined,
    interruptedByRestart: false,
    ...initial
  };

  return {
    started: 0,
    replies: [] as Array<Record<string, unknown>>,
    start() {
      this.started += 1;
      return initial?.startImpl?.();
    },
    sendReply(reply: Record<string, unknown>) {
      this.replies.push(reply);
    },
    getSnapshot() {
      return {
        ...snapshot,
        waitOptions: snapshot.waitOptions ? [...snapshot.waitOptions] : undefined
      };
    },
    setSnapshot(next: Partial<typeof snapshot>) {
      Object.assign(snapshot, next);
    }
  };
}

test('starts a managed Codex process with the provided working directory', () => {
  const child = createMockChild();
  let capturedCwd = '';
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: (_command: string, _args: string[], options: { cwd?: string }) => {
      capturedCwd = String(options.cwd ?? '');
      return child;
    }
  });

  session.start();
  assert.equal(capturedCwd, 'D:\\Workspace\\Project');
});

test('captures stdout and stderr into the live buffer', () => {
  const child = createMockChild();
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => child
  });

  session.start();
  child.stdout.emit('data', Buffer.from('hello'));
  child.stderr.emit('data', Buffer.from('warn'));

  assert.match(session.getSnapshot().liveBuffer, /hello/);
  assert.match(session.getSnapshot().liveBuffer, /warn/);
});

test('freezes checkpoint output when the process exits successfully', () => {
  const child = createMockChild();
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => child
  });

  session.start();
  child.stdout.emit('data', Buffer.from('final output'));
  child.emit('exit', 0);

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.lifecycle, 'FINISHED');
  assert.equal(snapshot.checkpointOutput, 'final output');
});

test('detects waiting-user transitions from interactive output', () => {
  const child = createMockChild();
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => child
  });

  session.start();
  child.stdout.emit('data', Buffer.from('1. Allow once\n2. Allow always\nSelect an option:'));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.lifecycle, 'WAITING_USER');
  assert.equal(snapshot.waitKind, 'choice');
  assert.equal(snapshot.checkpointOutput, '1. Allow once\n2. Allow always\nSelect an option:');
});

test('writes validated replies back to stdin', () => {
  const child = createMockChild();
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => child
  });

  session.start();
  session.sendReply({ action: 'input_text', text: '继续下一步' });

  assert.deepEqual(child.stdin.writes, ['继续下一步\n']);
});

test('emits worker events when entering waiting state and when finishing', () => {
  const child = createMockChild();
  const seen: Array<Record<string, unknown>> = [];
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => child,
    onEvent: (event: Record<string, unknown>) => {
      seen.push(event as Record<string, unknown>);
    }
  });

  session.start();
  child.stdout.emit('data', Buffer.from('1. Allow once\n2. Allow always\nSelect an option:'));
  child.emit('exit', 0);

  assert.equal(seen[0]?.type, 'task_waiting_user');
  assert.equal(seen[1]?.type, 'task_finished');
});

test('marks session failed instead of crashing when codex spawn errors', async () => {
  const child = createMockChild();
  const seen: Array<Record<string, unknown>> = [];
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => child,
    onEvent: (event: Record<string, unknown>) => {
      seen.push(event);
    }
  });

  session.start();
  child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.lifecycle, 'FAILED');
  assert.match(snapshot.checkpointOutput ?? '', /ENOENT/);
  assert.equal(seen[0]?.type, 'task_failed');
});

test('marks session failed instead of throwing when spawnFactory throws synchronously', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    spawnFactory: () => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    },
    onEvent: (event: Record<string, unknown>) => {
      seen.push(event);
    }
  });

  session.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.lifecycle, 'FAILED');
  assert.match(snapshot.checkpointOutput ?? '', /EINVAL/);
  assert.equal(seen[0]?.type, 'task_failed');
});

test('uses shell mode for windows command wrappers like codex.cmd', () => {
  const child = createMockChild();
  let capturedShell: boolean | undefined;
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd'],
    spawnFactory: (_command: string, _args: string[], options: { cwd?: string; shell?: boolean }) => {
      capturedShell = options.shell;
      return child;
    }
  });

  session.start();
  assert.equal(capturedShell, true);
});

test('normalizes a PowerShell codex shim to the sibling cmd wrapper before spawn', () => {
  const child = createMockChild();
  const shimRoot = mkdtempSync(path.join(os.tmpdir(), 'communicate-codex-shim-'));
  const ps1Path = path.join(shimRoot, 'codex.ps1');
  const cmdPath = path.join(shimRoot, 'codex.cmd');
  writeFileSync(ps1Path, '# test shim', 'utf8');
  writeFileSync(cmdPath, '@echo off', 'utf8');

  let capturedCommand = '';
  let capturedShell: boolean | undefined;
  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: [ps1Path, '--version'],
    spawnFactory: (command: string, _args: string[], options: { cwd?: string; shell?: boolean }) => {
      capturedCommand = command;
      capturedShell = options.shell;
      return child;
    }
  });

  try {
    session.start();
    assert.equal(capturedCommand, cmdPath);
    assert.equal(capturedShell, true);
  } finally {
    rmSync(shimRoot, { recursive: true, force: true });
  }
});

test('prefers structured fallback when the local Codex CLI reports support', async () => {
  const structuredSession = createMockManagedSession({
    lifecycle: 'WAITING_USER',
    checkpointOutput: '1. Allow once\n2. Allow always',
    waitKind: 'choice',
    waitOptions: ['Allow once', 'Allow always'],
    model: 'gpt-5.4',
    codexThreadId: 'thread-1',
    interruptedByRestart: true
  });
  const textSession = createMockManagedSession({
    lifecycle: 'WAITING_USER',
    checkpointOutput: 'legacy fallback',
    waitKind: 'text_input'
  });
  let structuredFactoryCalls = 0;
  let textFactoryCalls = 0;
  let structuredFactoryInput: Record<string, unknown> | undefined;

  const session = createCodexSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    model: 'gpt-5.4',
    mode: 'resume',
    resumeThreadId: 'thread-1',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    interruptedByRestart: true,
    developerInstructions: 'dev instructions',
    baseInstructions: 'base instructions',
    personality: 'friendly',
    structuredCapabilityProbe: () => ({ supported: true, reason: 'supported', version: '0.119.0' }),
    structuredSessionFactory: (factoryInput) => {
      structuredFactoryCalls += 1;
      structuredFactoryInput = factoryInput as unknown as Record<string, unknown>;
      return structuredSession;
    },
    textSessionFactory: () => {
      textFactoryCalls += 1;
      return textSession;
    }
  });

  await session.start();
  session.sendReply({ action: 'confirm', value: 'allow' });

  assert.equal(structuredFactoryCalls, 1);
  assert.equal(textFactoryCalls, 0);
  assert.equal(structuredSession.started, 1);
  assert.deepEqual(structuredSession.replies, [{ action: 'confirm', value: 'allow' }]);
  assert.equal(session.getSnapshot().waitKind, 'choice');
  assert.deepEqual(session.getSnapshot().waitOptions, ['Allow once', 'Allow always']);
  assert.equal(structuredFactoryInput?.mode, 'resume');
  assert.equal(structuredFactoryInput?.resumeThreadId, 'thread-1');
  assert.equal(structuredFactoryInput?.approvalPolicy, 'never');
  assert.equal(structuredFactoryInput?.sandbox, 'workspace-write');
  assert.equal(structuredFactoryInput?.developerInstructions, 'dev instructions');
  assert.equal(structuredFactoryInput?.baseInstructions, 'base instructions');
  assert.equal(structuredFactoryInput?.personality, 'friendly');
});

test('falls back to legacy text parsing when structured fallback is unsupported', async () => {
  const structuredSession = createMockManagedSession({
    lifecycle: 'WAITING_USER',
    checkpointOutput: 'structured should not start',
    waitKind: 'choice'
  });
  const textSession = createMockManagedSession({
    lifecycle: 'WAITING_USER',
    checkpointOutput: 'Input:',
    waitKind: 'text_input'
  });
  let structuredFactoryCalls = 0;
  let textFactoryCalls = 0;

  const session = createCodexSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    structuredCapabilityProbe: () => ({ supported: false, reason: 'version_too_old', version: '0.110.0' }),
    structuredSessionFactory: () => {
      structuredFactoryCalls += 1;
      return structuredSession;
    },
    textSessionFactory: () => {
      textFactoryCalls += 1;
      return textSession;
    }
  });

  await session.start();
  session.sendReply({ action: 'input_text', text: '继续' });

  assert.equal(structuredFactoryCalls, 0);
  assert.equal(textFactoryCalls, 1);
  assert.equal(textSession.started, 1);
  assert.deepEqual(textSession.replies, [{ action: 'input_text', text: '继续' }]);
  assert.equal(session.getSnapshot().waitKind, 'text_input');
  assert.equal(session.getSnapshot().checkpointOutput, 'Input:');
});

test('blocks a known-bad Codex version before falling back to legacy text mode', async () => {
  let textFactoryCalls = 0;
  let structuredFactoryCalls = 0;

  const session = createCodexSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    structuredCapabilityProbe: () => ({ supported: false, reason: 'known_bad_version', version: '0.120.0' }),
    structuredSessionFactory: () => {
      structuredFactoryCalls += 1;
      return createMockManagedSession();
    },
    textSessionFactory: () => {
      textFactoryCalls += 1;
      return createMockManagedSession();
    }
  });

  await session.start();

  const snapshot = session.getSnapshot();
  assert.equal(structuredFactoryCalls, 0);
  assert.equal(textFactoryCalls, 0);
  assert.equal(snapshot.lifecycle, 'FAILED');
  assert.match(snapshot.checkpointOutput ?? '', /0\.120\.0/);
  assert.match(snapshot.checkpointOutput ?? '', /不兼容|升级/);
});

test('blocks a known-bad Codex version on explicit text-only startup paths', async () => {
  const child = createMockChild();
  let spawnCalls = 0;

  const session = createTextFallbackSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    structuredCapabilityProbe: () => ({ supported: false, reason: 'known_bad_version', version: '0.120.0' }),
    spawnFactory: () => {
      spawnCalls += 1;
      return child;
    }
  });

  await session.start();

  const snapshot = session.getSnapshot();
  assert.equal(spawnCalls, 0);
  assert.equal(snapshot.lifecycle, 'FAILED');
  assert.match(snapshot.checkpointOutput ?? '', /0\.120\.0/);
  assert.match(snapshot.checkpointOutput ?? '', /不兼容|升级/);
});

test('keeps legacy text fallback when structured mode is explicitly disabled', () => {
  const textSession = createMockManagedSession({
    lifecycle: 'WAITING_USER',
    checkpointOutput: 'Input:',
    waitKind: 'text_input'
  });
  let probeCalls = 0;
  let structuredFactoryCalls = 0;
  let textFactoryCalls = 0;

  const session = createCodexSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    structuredFallback: 'disabled',
    structuredCapabilityProbe: () => {
      probeCalls += 1;
      return { supported: true, reason: 'supported', version: '0.119.0' };
    },
    structuredSessionFactory: () => {
      structuredFactoryCalls += 1;
      return createMockManagedSession();
    },
    textSessionFactory: () => {
      textFactoryCalls += 1;
      return textSession;
    }
  });

  session.start();

  assert.equal(probeCalls, 1);
  assert.equal(structuredFactoryCalls, 0);
  assert.equal(textFactoryCalls, 1);
  assert.equal(textSession.started, 1);
  assert.equal(session.getSnapshot().waitKind, 'text_input');
});

test('falls back to legacy text parsing when structured startup fails asynchronously', async () => {
  const structuredSession = createMockManagedSession({
    lifecycle: 'STARTING',
    startImpl: async () => {
      structuredSession.setSnapshot({
        lifecycle: 'FAILED',
        checkpointOutput: 'structured startup failed'
      });
    }
  });
  const textSession = createMockManagedSession({
    lifecycle: 'WAITING_USER',
    checkpointOutput: 'Input:',
    waitKind: 'text_input'
  });
  let textFactoryCalls = 0;

  const session = createCodexSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    structuredCapabilityProbe: () => ({ supported: true, reason: 'supported', version: '0.119.0' }),
    structuredSessionFactory: () => structuredSession,
    textSessionFactory: () => {
      textFactoryCalls += 1;
      return textSession;
    }
  });

  await session.start();
  session.sendReply({ action: 'input_text', text: '继续' });

  assert.equal(structuredSession.started, 1);
  assert.equal(textFactoryCalls, 1);
  assert.equal(textSession.started, 1);
  assert.deepEqual(textSession.replies, [{ action: 'input_text', text: '继续' }]);
  assert.equal(session.getSnapshot().waitKind, 'text_input');
});

test('close during async capability probe prevents any underlying session from starting', async () => {
  let releaseProbe: (() => void) | undefined;
  let structuredFactoryCalls = 0;
  let textFactoryCalls = 0;

  const session = createCodexSession({
    taskId: 'T1',
    cwd: 'D:\\Workspace\\Project',
    command: ['codex'],
    structuredCapabilityProbe: async () => {
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      return { supported: true, reason: 'supported', version: '0.119.0' };
    },
    structuredSessionFactory: () => {
      structuredFactoryCalls += 1;
      return createMockManagedSession();
    },
    textSessionFactory: () => {
      textFactoryCalls += 1;
      return createMockManagedSession();
    }
  });

  const startPromise = session.start();
  const closeResult = await session.close();
  releaseProbe?.();
  await startPromise;

  assert.deepEqual(closeResult, { forced: false });
  assert.equal(structuredFactoryCalls, 0);
  assert.equal(textFactoryCalls, 0);
  assert.equal(session.getSnapshot().lifecycle, 'CLOSED');
});
