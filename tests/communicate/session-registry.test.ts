import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SessionRegistryModule = {
  DEFAULT_SESSION_REGISTRY_PATH: string;
  acquireSessionRegistryWriteLock: (registryPath: string) => {
    release: () => void;
  };
  createSessionRegistry: (input: {
    registryPath: string;
    warn?: (message: string, error?: unknown) => void;
  }) => {
    load: () => {
      nextTaskId: number;
      sessions: Record<string, unknown>;
      threadBindings: Record<string, unknown>;
      threadUiStates: Record<string, unknown>;
      inboundMessages: Record<string, unknown>;
      recentProjectDirs: string[];
      lastActiveFeishuThreadId?: string;
      lastActiveFeishuUserOpenId?: string;
    };
    reserveNextTaskId: () => `T${number}`;
    upsertSessionRecord: (record: Record<string, unknown>) => Record<string, unknown>;
    markClosed: (taskId: `T${number}`, patch?: Record<string, unknown>) => Record<string, unknown> | undefined;
    deleteSessionRecord: (taskId: `T${number}`) => Record<string, unknown> | undefined;
    getSessionRecord: (taskId: `T${number}`) => Record<string, unknown> | undefined;
    listSessionRecords: () => Array<Record<string, unknown>>;
    upsertThreadBinding: (record: Record<string, unknown>) => Record<string, unknown>;
    getThreadBinding: (feishuThreadId: string) => Record<string, unknown> | undefined;
    upsertThreadUiState: (record: Record<string, unknown>) => Record<string, unknown>;
    getThreadUiState: (feishuThreadId: string) => Record<string, unknown> | undefined;
    clearThreadUiState: (feishuThreadId: string) => void;
    clearThreadBinding: (feishuThreadId: string) => void;
    getLastActiveFeishuThreadId: () => string | undefined;
    setLastActiveFeishuThreadId: (feishuThreadId: string) => void;
    getLastActiveFeishuUserOpenId: () => string | undefined;
    setLastActiveFeishuUserOpenId: (openId: string) => void;
    getRecentProjectDirs: () => string[];
    replaceRecentProjectDirs: (dirs: string[]) => string[];
    recomputeNextTaskId: () => number;
  };
};

function loadSessionRegistryModule(): SessionRegistryModule {
  return require(path.resolve(__dirname, '../../src/communicate/storage/session-registry.js')) as SessionRegistryModule;
}

function createRegistryRecord(taskId: `T${number}`): Record<string, unknown> {
  return {
    taskId,
    feishuThreadId: 'feishu:chat-1',
    codexThreadId: 'codex-thread-1',
    cwd: 'D:\\Workspace\\Project\\Communicate',
    logPath: `D:\\Workspace\\Project\\logs\\communicate\\${taskId}.log`,
    approvalPolicy: 'on-request',
    sandbox: 'danger-full-access',
    model: 'gpt-5.4',
    sessionLifecycle: 'IDLE',
    lastCheckpointOutput: 'ready',
    lastCheckpointAt: '2026-03-09T10:00:00.000Z',
    lastEventAt: '2026-03-09T10:00:00.000Z',
    createdAt: '2026-03-09T09:59:59.000Z',
    windowPid: 4321,
    interruptedByRestart: false,
    sessionKind: 'assistant',
    assistantProfileId: 'research-assistant-v1',
    developerInstructions: '你是长期科研助理。',
    personality: 'pragmatic',
    goalSummary: '修复飞书任务切换卡摘要不可读问题',
    goalSummaryStatus: 'ready',
    goalSummarySourceText: '请修复飞书任务切换卡摘要不可读问题',
    firstUserCodingText: '请修复飞书任务切换卡摘要不可读问题'
  };
}

test('session registry initializes empty state and persists nextTaskId across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.deepEqual(registry.load(), {
      nextTaskId: 1,
      sessions: {},
      threadBindings: {},
      threadUiStates: {},
      inboundMessages: {},
      recentProjectDirs: [],
      lastActiveFeishuThreadId: undefined,
      lastActiveFeishuUserOpenId: undefined
    });
    assert.equal(registry.reserveNextTaskId(), 'T1');
    assert.equal(registry.reserveNextTaskId(), 'T2');

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.load().nextTaskId, 3);
    assert.deepEqual(reloaded.listSessionRecords(), []);
    assert.deepEqual(reloaded.load().threadBindings, {});
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry retains records after close and only updates lifecycle metadata', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord(createRegistryRecord('T9'));
    registry.markClosed('T9', {
      sessionLifecycle: 'CLOSED',
      closedAt: '2026-03-09T10:03:00.000Z',
      lastCheckpointOutput: 'session closed'
    });

    const record = registry.getSessionRecord('T9');
    assert.equal(record?.sessionLifecycle, 'CLOSED');
    assert.equal(record?.closedAt, '2026-03-09T10:03:00.000Z');
    assert.equal(record?.lastCheckpointOutput, 'session closed');
    assert.equal(record?.codexThreadId, 'codex-thread-1');
    assert.equal(record?.model, 'gpt-5.4');
    assert.equal(record?.sessionKind, 'assistant');
    assert.equal(registry.listSessionRecords().length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry keeps legacy startup mode missing across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 7,
        sessions: {
          T5: {
            taskId: 'T5',
            feishuThreadId: 'feishu:chat-1',
            codexThreadId: 'codex-thread-5',
            cwd: 'D:\\Workspace\\Project',
            logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T5.log',
            sessionLifecycle: 'IDLE',
            interruptedByRestart: false,
            createdAt: '2026-03-09T10:00:00.000Z'
          },
          T6: {
            taskId: 'T6',
            feishuThreadId: 'feishu:chat-1',
            codexThreadId: 'codex-thread-6',
            cwd: 'D:\\Workspace\\Project',
            logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T6.log',
            sessionLifecycle: 'WAITING_USER',
            createdAt: '2026-03-09T10:05:00.000Z'
          }
        },
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: []
      }),
      'utf8'
    );
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.equal(registry.getSessionRecord('T5')?.startupMode, undefined);
    assert.equal(registry.getSessionRecord('T6')?.startupMode, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry preserves explicit startup mode across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord({
      ...createRegistryRecord('T7'),
      startupMode: 'resume',
      interruptedByRestart: true
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getSessionRecord('T7')?.startupMode, 'resume');
    assert.equal(reloaded.getSessionRecord('T7')?.interruptedByRestart, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry preserves runtime warnings across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord({
      ...createRegistryRecord('T7'),
      runtimeWarnings: [
        {
          code: 'known_bad_codex_version',
          message: '当前Codex版本存在不兼容问题，请尽快升级到最新版本',
          version: '0.120.0',
          overrideActive: true
        }
      ]
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal((reloaded.getSessionRecord('T7') as any)?.runtimeWarnings?.[0]?.code, 'known_bad_codex_version');
    assert.equal((reloaded.getSessionRecord('T7') as any)?.runtimeWarnings?.[0]?.overrideActive, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry can delete a persisted session record', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord(createRegistryRecord('T9'));
    const deleted = registry.deleteSessionRecord('T9');

    assert.equal(deleted?.taskId, 'T9');
    assert.equal(registry.getSessionRecord('T9'), undefined);
    assert.deepEqual(registry.listSessionRecords(), []);

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getSessionRecord('T9'), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry can recompute nextTaskId after reclaiming the highest discarded task', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord(createRegistryRecord('T1'));
    registry.reserveNextTaskId();
    registry.deleteSessionRecord('T1');

    assert.equal(registry.load().nextTaskId, 2);
    assert.equal(registry.recomputeNextTaskId(), 1);
    assert.equal(registry.reserveNextTaskId(), 'T1');

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.load().nextTaskId, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry falls back to an empty registry and warns when JSON is corrupted', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const warnings: string[] = [];

  try {
    writeFileSync(registryPath, '{"nextTaskId":', 'utf8');
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({
      registryPath,
      warn: (message) => warnings.push(message)
    });

    assert.deepEqual(registry.load(), {
      nextTaskId: 1,
      sessions: {},
      threadBindings: {},
      threadUiStates: {},
      inboundMessages: {},
      recentProjectDirs: [],
      lastActiveFeishuThreadId: undefined,
      lastActiveFeishuUserOpenId: undefined
    });
    assert.equal(registry.listSessionRecords().length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /registry/i);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry keeps the latest state after rapid sequential writes', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord(createRegistryRecord('T4'));
    registry.upsertSessionRecord({
      ...createRegistryRecord('T4'),
      sessionLifecycle: 'RUNNING_TURN',
      lastCheckpointOutput: 'second checkpoint',
      lastCheckpointAt: '2026-03-09T10:03:00.000Z',
      lastEventAt: '2026-03-09T10:04:00.000Z'
    });

    const reloaded = createSessionRegistry({ registryPath });
    const record = reloaded.getSessionRecord('T4');
    assert.equal(record?.sessionLifecycle, 'RUNNING_TURN');
    assert.equal(record?.lastCheckpointOutput, 'second checkpoint');
    assert.equal(record?.lastCheckpointAt, '2026-03-09T10:03:00.000Z');
    assert.equal(reloaded.load().nextTaskId, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry reserves unique task ids across separate instances', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const firstRegistry = createSessionRegistry({ registryPath });
    const secondRegistry = createSessionRegistry({ registryPath });

    assert.equal(firstRegistry.reserveNextTaskId(), 'T1');
    assert.equal(secondRegistry.reserveNextTaskId(), 'T2');
    assert.equal(firstRegistry.reserveNextTaskId(), 'T3');

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.load().nextTaskId, 4);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry merges sibling writes from separate instances instead of overwriting them', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const firstRegistry = createSessionRegistry({ registryPath });
    const secondRegistry = createSessionRegistry({ registryPath });

    firstRegistry.upsertSessionRecord(createRegistryRecord('T11'));
    secondRegistry.upsertThreadBinding({
      feishuThreadId: 'feishu:chat-merge-1',
      assistantTaskId: 'T11'
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getSessionRecord('T11')?.taskId, 'T11');
    assert.deepEqual(reloaded.getThreadBinding('feishu:chat-merge-1'), {
      feishuThreadId: 'feishu:chat-merge-1',
      assistantTaskId: 'T11'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry can take over a stale cross-process write lock', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const lockDir = `${registryPath}.lock`;
  const ownerFilePath = path.join(lockDir, 'owner.json');

  try {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(ownerFilePath, JSON.stringify({
      pid: 999999,
      startedAt: '2026-04-07T00:00:00.000Z',
      acquiredAt: '2026-04-07T00:00:00.000Z'
    }, null, 2), 'utf8');

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.equal(registry.reserveNextTaskId(), 'T1');
    assert.equal(existsSync(lockDir), false);

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.load().nextTaskId, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry stale takeover does not steal a newer owner published after stale analysis', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const lockDir = `${registryPath}.lock`;
  const staleOwnerFilePath = path.join(lockDir, 'owner.json');
  const liveOwnerFilePath = path.join(lockDir, 'owner.live-owner.json');

  try {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(staleOwnerFilePath, JSON.stringify({
      pid: 999999,
      startedAt: '2026-04-07T00:00:00.000Z',
      acquiredAt: '2026-04-07T00:00:00.000Z'
    }, null, 2), 'utf8');

    const { acquireSessionRegistryWriteLock } = loadSessionRegistryModule();
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalRenameSync = fsModule.renameSync;
    const originalDateNow = Date.now;
    let fakeNow = Date.parse('2026-04-07T12:32:00.000Z');
    let injectedLiveOwner = false;
    let acquiredLock: { release: () => void } | undefined;

    Date.now = () => {
      fakeNow += injectedLiveOwner ? 35_000 : 1;
      return fakeNow;
    };

    fsModule.renameSync = ((from: Parameters<typeof originalRenameSync>[0], to: Parameters<typeof originalRenameSync>[1]) => {
      const normalizedFrom = String(from);
      if (!injectedLiveOwner && (normalizedFrom === lockDir || normalizedFrom === staleOwnerFilePath)) {
        injectedLiveOwner = true;
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(liveOwnerFilePath, JSON.stringify({
          pid: process.pid,
          startedAt: '2099-01-01T00:00:00.000Z',
          acquiredAt: '2099-01-01T00:00:00.000Z'
        }, null, 2), 'utf8');
      }
      return originalRenameSync(from, to);
    }) as typeof originalRenameSync;

    try {
      assert.throws(
        () => {
          acquiredLock = acquireSessionRegistryWriteLock(registryPath);
        },
        /Session registry write lock timed out/
      );
    } finally {
      fsModule.renameSync = originalRenameSync;
      Date.now = originalDateNow;
      acquiredLock?.release();
    }

    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(liveOwnerFilePath), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry stale owner release does not delete a newer lock owner during cleanup race', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');
  const lockDir = `${registryPath}.lock`;
  const replacementMarkerPath = path.join(lockDir, 'owner.new-owner.json');
  const displacedLockDir = `${lockDir}.displaced`;

  try {
    const { acquireSessionRegistryWriteLock } = loadSessionRegistryModule();
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalRmSync = fsModule.rmSync;
    const staleOwnerLock = acquireSessionRegistryWriteLock(registryPath);
    const currentOwnerFileName = readdirSync(lockDir).find((entry) => entry.startsWith('owner'));
    assert.ok(currentOwnerFileName, 'expected acquired lock metadata file');
    const currentOwnerFilePath = path.join(lockDir, currentOwnerFileName ?? 'owner.json');
    let injectedReplacement = false;

    fsModule.rmSync = ((target: Parameters<typeof originalRmSync>[0], options?: Parameters<typeof originalRmSync>[1]) => {
      const normalizedTarget = String(target);
      if (!injectedReplacement && (normalizedTarget === lockDir || normalizedTarget === currentOwnerFilePath)) {
        injectedReplacement = true;
        if (normalizedTarget === currentOwnerFilePath) {
          originalRmSync(target, options);
        }
        originalRmSync(displacedLockDir, { recursive: true, force: true });
        if (existsSync(lockDir)) {
          renameSync(lockDir, displacedLockDir);
        }
        mkdirSync(lockDir, { recursive: true });
        writeFileSync(replacementMarkerPath, 'new owner', 'utf8');
        if (normalizedTarget === lockDir) {
          return originalRmSync(target, options);
        }
        return undefined;
      }
      return originalRmSync(target, options);
    }) as typeof originalRmSync;

    try {
      staleOwnerLock.release();
    } finally {
      fsModule.rmSync = originalRmSync;
    }

    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(replacementMarkerPath), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry persists assistant metadata and thread bindings across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord(createRegistryRecord('T7'));
    registry.upsertThreadBinding({
      feishuThreadId: 'feishu:chat-1',
      assistantTaskId: 'T7'
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getSessionRecord('T7')?.sessionKind, 'assistant');
    assert.equal(reloaded.getSessionRecord('T7')?.assistantProfileId, 'research-assistant-v1');
    assert.equal(reloaded.getSessionRecord('T7')?.developerInstructions, '你是长期科研助理。');
    assert.equal(reloaded.getSessionRecord('T7')?.personality, 'pragmatic');
    assert.equal(reloaded.getSessionRecord('T7')?.model, 'gpt-5.4');
    assert.equal(reloaded.getSessionRecord('T7')?.goalSummary, '修复飞书任务切换卡摘要不可读问题');
    assert.equal(reloaded.getSessionRecord('T7')?.goalSummaryStatus, 'ready');
    assert.equal(reloaded.getSessionRecord('T7')?.goalSummarySourceText, '请修复飞书任务切换卡摘要不可读问题');
    assert.equal(reloaded.getSessionRecord('T7')?.firstUserCodingText, '请修复飞书任务切换卡摘要不可读问题');
    assert.deepEqual(reloaded.getThreadBinding('feishu:chat-1'), {
      feishuThreadId: 'feishu:chat-1',
      assistantTaskId: 'T7'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry preserves an unknown model marker as null across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord({
      ...createRegistryRecord('T12'),
      model: null
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getSessionRecord('T12')?.model, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry persists thread ui state across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'coding',
      currentCodingTaskId: 'T3',
      statusCardMessageId: 'om_card_9',
      statusCardActionMessageId: 'open_message_card_9',
      statusCardPickerOpen: false
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.deepEqual(reloaded.getThreadUiState('feishu:chat-1'), {
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'coding',
      currentCodingTaskId: 'T3',
      statusCardMessageId: 'om_card_9',
      statusCardActionMessageId: 'open_message_card_9',
      statusCardPickerOpen: false
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry persists launcher status card mode across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'assistant',
      statusCardMode: 'launcher',
      statusCardMessageId: 'om_launcher_1',
      launcherSelectedCwd: 'D:\\Workspace\\CodexLark'
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.deepEqual(reloaded.getThreadUiState('feishu:chat-1'), {
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'assistant',
      statusCardMode: 'launcher',
      statusCardMessageId: 'om_launcher_1',
      launcherSelectedCwd: 'D:\\Workspace\\CodexLark'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry persists takeover picker thread ui fields', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-takeover-1',
      displayMode: 'coding',
      statusCardMode: 'takeover_picker',
      currentCodingTaskId: 'T9',
      takeoverPickerTaskIds: ['T4', 'T9', 'T11'],
      takeoverPickerPage: 1,
      takeoverPickerSelectedTaskId: 'T9',
      takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01',
      takeoverPickerError: '请先选择一个本地 Codex 任务'
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.deepEqual(reloaded.getThreadUiState('feishu:chat-takeover-1'), {
      feishuThreadId: 'feishu:chat-takeover-1',
      displayMode: 'coding',
      statusCardMode: 'takeover_picker',
      currentCodingTaskId: 'T9',
      takeoverPickerTaskIds: ['T4', 'T9', 'T11'],
      takeoverPickerPage: 1,
      takeoverPickerSelectedTaskId: 'T9',
      takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01',
      takeoverPickerError: '请先选择一个本地 Codex 任务'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry drops invalid takeover picker fields during reload', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 2,
        sessions: {},
        threadBindings: {},
        threadUiStates: {
          'feishu:chat-invalid-takeover': {
            feishuThreadId: 'feishu:chat-invalid-takeover',
            displayMode: 'coding',
            statusCardMode: 'bad-mode',
            currentCodingTaskId: 'T3',
            takeoverPickerTaskIds: ['T8', 'T8', '', 'bad-id', 'T11', 'T11'],
            takeoverPickerPage: -1,
            takeoverPickerSelectedTaskId: 'not-a-task',
            takeoverPickerSnapshotUpdatedAt: '   2026-04-21 10:01   ',
            takeoverPickerError: '   请先选择一个任务   '
          }
        },
        inboundMessages: {},
        recentProjectDirs: []
      }, null, 2),
      'utf8'
    );

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.deepEqual(registry.getThreadUiState('feishu:chat-invalid-takeover'), {
      feishuThreadId: 'feishu:chat-invalid-takeover',
      displayMode: 'coding',
      currentCodingTaskId: 'T3',
      takeoverPickerTaskIds: ['T8', 'T11'],
      takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01',
      takeoverPickerError: '请先选择一个任务'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry dedupes takeover picker task ids for valid takeover picker records', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 12,
        sessions: {},
        threadBindings: {},
        threadUiStates: {
          'feishu:chat-valid-takeover': {
            feishuThreadId: 'feishu:chat-valid-takeover',
            displayMode: 'coding',
            statusCardMode: 'takeover_picker',
            currentCodingTaskId: 'T9',
            takeoverPickerTaskIds: ['T9', 'T9', 'T11', 'T11'],
            takeoverPickerPage: 0,
            takeoverPickerSelectedTaskId: 'T11',
            takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01'
          }
        },
        inboundMessages: {},
        recentProjectDirs: []
      }, null, 2),
      'utf8'
    );

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.deepEqual(registry.getThreadUiState('feishu:chat-valid-takeover'), {
      feishuThreadId: 'feishu:chat-valid-takeover',
      displayMode: 'coding',
      statusCardMode: 'takeover_picker',
      currentCodingTaskId: 'T9',
      takeoverPickerTaskIds: ['T9', 'T11'],
      takeoverPickerPage: 0,
      takeoverPickerSelectedTaskId: 'T11',
      takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry preserves launcher and status fields when takeover picker fields are absent', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 4,
        sessions: {},
        threadBindings: {},
        threadUiStates: {
          'feishu:chat-launcher-1': {
            feishuThreadId: 'feishu:chat-launcher-1',
            displayMode: 'assistant',
            statusCardMode: 'launcher',
            statusCardMessageId: 'om_launcher_1',
            launcherSelectedCwd: 'D:\\Workspace\\CodexLark',
            launcherDraftCwd: 'D:\\Workspace\\CodexLark\\draft',
            launcherError: '无法启动'
          },
          'feishu:chat-status-1': {
            feishuThreadId: 'feishu:chat-status-1',
            displayMode: 'coding',
            statusCardMode: 'status',
            currentCodingTaskId: 'T6',
            statusCardMessageId: 'om_status_1',
            statusCardActionMessageId: 'open_message_status_1',
            statusCardPickerOpen: true
          }
        },
        inboundMessages: {},
        recentProjectDirs: []
      }, null, 2),
      'utf8'
    );

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.deepEqual(registry.getThreadUiState('feishu:chat-launcher-1'), {
      feishuThreadId: 'feishu:chat-launcher-1',
      displayMode: 'assistant',
      statusCardMode: 'launcher',
      statusCardMessageId: 'om_launcher_1',
      launcherSelectedCwd: 'D:\\Workspace\\CodexLark',
      launcherDraftCwd: 'D:\\Workspace\\CodexLark\\draft',
      launcherError: '无法启动'
    });
    assert.deepEqual(registry.getThreadUiState('feishu:chat-status-1'), {
      feishuThreadId: 'feishu:chat-status-1',
      displayMode: 'coding',
      statusCardMode: 'status',
      currentCodingTaskId: 'T6',
      statusCardMessageId: 'om_status_1',
      statusCardActionMessageId: 'open_message_status_1',
      statusCardPickerOpen: true
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry clears takeover picker fields when thread ui record is replaced without them', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-takeover-clear-1',
      displayMode: 'coding',
      statusCardMode: 'takeover_picker',
      currentCodingTaskId: 'T5',
      takeoverPickerTaskIds: ['T5', 'T7'],
      takeoverPickerPage: 1,
      takeoverPickerSelectedTaskId: 'T7',
      takeoverPickerSnapshotUpdatedAt: '2026-04-21 10:01',
      takeoverPickerError: '请先选择'
    });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-takeover-clear-1',
      displayMode: 'assistant',
      statusCardMode: 'status',
      takeoverPickerTaskIds: undefined,
      takeoverPickerPage: undefined,
      takeoverPickerSelectedTaskId: undefined,
      takeoverPickerSnapshotUpdatedAt: undefined,
      takeoverPickerError: undefined
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.deepEqual(reloaded.getThreadUiState('feishu:chat-takeover-clear-1'), {
      feishuThreadId: 'feishu:chat-takeover-clear-1',
      displayMode: 'assistant',
      statusCardMode: 'status',
      currentCodingTaskId: 'T5'
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry returns defensive copies of takeover picker task ids', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-takeover-copy-1',
      displayMode: 'coding',
      statusCardMode: 'takeover_picker',
      takeoverPickerTaskIds: ['T2', 'T4']
    });

    const firstRead = registry.getThreadUiState('feishu:chat-takeover-copy-1') as {
      takeoverPickerTaskIds?: string[];
    };
    firstRead.takeoverPickerTaskIds?.push('T99');

    assert.deepEqual(registry.getThreadUiState('feishu:chat-takeover-copy-1'), {
      feishuThreadId: 'feishu:chat-takeover-copy-1',
      displayMode: 'coding',
      statusCardMode: 'takeover_picker',
      takeoverPickerTaskIds: ['T2', 'T4']
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry preserves current coding target when thread mode switches to assistant', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'coding',
      currentCodingTaskId: 'T3',
      statusCardMessageId: 'om_card_9',
      statusCardPickerOpen: true
    });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'assistant'
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.deepEqual(reloaded.getThreadUiState('feishu:chat-1'), {
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'assistant',
      currentCodingTaskId: 'T3',
      statusCardMessageId: 'om_card_9',
      statusCardPickerOpen: true
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry can clear current coding target while preserving status card state', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'coding',
      currentCodingTaskId: 'T8',
      statusCardMessageId: 'om_card_10',
      statusCardPickerOpen: true
    });
    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'assistant',
      currentCodingTaskId: undefined
    });

    const reloaded = createSessionRegistry({ registryPath });
    assert.deepEqual(reloaded.getThreadUiState('feishu:chat-1'), {
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'assistant',
      statusCardMessageId: 'om_card_10',
      statusCardPickerOpen: true
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry can clear a persisted thread binding without deleting the session record', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertSessionRecord(createRegistryRecord('T8'));
    registry.upsertThreadBinding({
      feishuThreadId: 'feishu:chat-1',
      assistantTaskId: 'T8'
    });
    registry.clearThreadBinding('feishu:chat-1');

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getThreadBinding('feishu:chat-1'), undefined);
    assert.equal(reloaded.getSessionRecord('T8')?.taskId, 'T8');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry can clear a persisted thread ui state across reloads', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.upsertThreadUiState({
      feishuThreadId: 'feishu:chat-1',
      displayMode: 'coding',
      currentCodingTaskId: 'T8',
      statusCardMessageId: 'om_card_10',
      statusCardPickerOpen: true
    });
    registry.clearThreadUiState('feishu:chat-1');

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getThreadUiState('feishu:chat-1'), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry persists last active feishu thread and recent project dirs', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.setLastActiveFeishuThreadId('feishu:chat-9');
    registry.setLastActiveFeishuUserOpenId('ou_test_user_1');
    registry.replaceRecentProjectDirs(['D:\\Workspace\\Project', 'D:\\Workspace\\Alpha']);

    const reloaded = createSessionRegistry({ registryPath });
    assert.equal(reloaded.getLastActiveFeishuThreadId(), 'feishu:chat-9');
    assert.equal(reloaded.getLastActiveFeishuUserOpenId(), 'ou_test_user_1');
    assert.deepEqual(reloaded.getRecentProjectDirs(), ['D:\\Workspace\\Project', 'D:\\Workspace\\Alpha']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry derives last active feishu thread from legacy session records when the new field is missing', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    writeFileSync(
      registryPath,
      JSON.stringify({
        nextTaskId: 4,
        sessions: {
          T1: {
            taskId: 'T1',
            feishuThreadId: 'feishu:chat-legacy-older',
            lastEventAt: '2026-03-09T09:00:00.000Z',
            createdAt: '2026-03-09T08:00:00.000Z'
          },
          T2: {
            taskId: 'T2',
            feishuThreadId: 'feishu:chat-legacy-latest',
            lastEventAt: '2026-03-09T11:30:00.000Z',
            createdAt: '2026-03-09T11:00:00.000Z'
          },
          T3: {
            taskId: 'T3',
            lastEventAt: '2026-03-09T12:00:00.000Z',
            createdAt: '2026-03-09T11:45:00.000Z'
          }
        },
        threadBindings: {},
        threadUiStates: {},
        inboundMessages: {},
        recentProjectDirs: ['D:\\Legacy']
      }, null, 2),
      'utf8'
    );

    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    assert.equal(registry.getLastActiveFeishuThreadId(), 'feishu:chat-legacy-latest');
    assert.deepEqual(registry.getRecentProjectDirs(), ['D:\\Legacy']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry recent project dirs keep newest-first uniqueness and length cap', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-'));
  const registryPath = path.join(rootDir, 'registry.json');

  try {
    const { createSessionRegistry } = loadSessionRegistryModule();
    const registry = createSessionRegistry({ registryPath });

    registry.replaceRecentProjectDirs([
      'D:\\One',
      'D:\\Two',
      'D:\\Three',
      'D:\\Two',
      'D:\\Four',
      '',
      'D:\\Five',
      'D:\\Six'
    ]);

    assert.deepEqual(registry.getRecentProjectDirs(), [
      'D:\\One',
      'D:\\Two',
      'D:\\Three',
      'D:\\Four',
      'D:\\Five'
    ]);

    registry.replaceRecentProjectDirs([
      'D:\\Six',
      'D:\\Three',
      'D:\\Seven',
      'D:\\Eight',
      'D:\\Nine',
      'D:\\Ten'
    ]);

    assert.deepEqual(registry.getRecentProjectDirs(), [
      'D:\\Six',
      'D:\\Three',
      'D:\\Seven',
      'D:\\Eight',
      'D:\\Nine'
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session registry default path stays anchored to the repo when cwd changes', () => {
  const modulePath = path.resolve(__dirname, '../../src/communicate/storage/session-registry.js');
  const originalCwd = process.cwd();
  const tempCwd = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-registry-cwd-'));
  const originalRegistryPathEnv = process.env.COMMUNICATE_SESSION_REGISTRY_PATH;

  try {
    process.chdir(tempCwd);
    delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    delete require.cache[require.resolve(modulePath)];

    const { DEFAULT_SESSION_REGISTRY_PATH } = require(modulePath) as SessionRegistryModule;
    const expectedPath = path.join(originalCwd, 'logs', 'communicate', 'registry.json');
    assert.equal(DEFAULT_SESSION_REGISTRY_PATH, expectedPath);
  } finally {
    delete require.cache[require.resolve(modulePath)];
    if (originalRegistryPathEnv === undefined) {
      delete process.env.COMMUNICATE_SESSION_REGISTRY_PATH;
    } else {
      process.env.COMMUNICATE_SESSION_REGISTRY_PATH = originalRegistryPathEnv;
    }
    process.chdir(originalCwd);
    rmSync(tempCwd, { recursive: true, force: true });
  }
});
