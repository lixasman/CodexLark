import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanCodexCliSessions, scanCodexCliSessionsResult } from '../../src/communicate/control/codex-cli-scan';

test('scans codex cli sessions from index, history, and rollout files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'thread-1', thread_name: 'demo', updated_at: '2026-03-15T00:00:00Z' }),
        JSON.stringify({ id: 'thread-2', thread_name: 'other', updated_at: '2026-03-16T00:00:00Z' })
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'history.jsonl'),
      [
        JSON.stringify({ session_id: 'thread-1', ts: 1, text: 'first text' }),
        JSON.stringify({ session_id: 'thread-1', ts: 10, text: 'latest text' }),
        JSON.stringify({ session_id: 'thread-2', ts: 2, text: 'thread2 text' })
      ].join('\n') + '\n'
    );
    const sessionsDir = path.join(tmp, 'sessions', 'demo');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-1.jsonl'),
      [
        JSON.stringify({ payload: { id: 'thread-1', cwd: 'D:\\Workspace\\Project' } }),
        JSON.stringify({ turn_context: { payload: { model: 'gpt-5.2' } } })
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-2.jsonl'),
      JSON.stringify({ payload: { id: 'thread-2', cwd: 'D:\\Workspace\\Project2' } }) + '\n'
    );

    const results = scanCodexCliSessions({ codexHome: tmp });
    const session1 = results.find((item: { threadId: string; threadName?: string; cwd?: string; firstText?: string; lastText?: string; lastTextTs?: number; model?: string | null }) => item.threadId === 'thread-1');
    const session2 = results.find((item: { threadId: string; threadName?: string; lastTextTs?: number; model?: string | null; cwd?: string }) => item.threadId === 'thread-2');

    assert.equal(results[0]?.threadId, 'thread-1');
    assert.equal(session1?.threadName, 'demo');
    assert.equal(session1?.cwd, 'D:\\Workspace\\Project');
    assert.equal(session1?.model, 'gpt-5.2');
    assert.equal(session1?.firstText, 'first text');
    assert.equal(session1?.lastText, 'latest text');
    assert.equal(session1?.lastTextTs, 10);
    assert.equal(session2?.cwd, 'D:\\Workspace\\Project2');
    assert.equal(session2?.model, null);
    assert.equal(session2?.lastTextTs, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessionsResult returns ok with sessions when files are readable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'session_index.jsonl'),
      JSON.stringify({ id: 'thread-1', thread_name: 'demo', updated_at: '2026-03-15T00:00:00Z' }) + '\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'history.jsonl'),
      JSON.stringify({ session_id: 'thread-1', ts: 10, text: 'latest text' }) + '\n'
    );
    const sessionsDir = path.join(tmp, 'sessions', 'demo');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-1.jsonl'),
      [
        JSON.stringify({ payload: { id: 'thread-1', cwd: 'D:\\Workspace\\Project' } }),
        JSON.stringify({ turn_context: { payload: { model: 'gpt-5.4' } } })
      ].join('\n') + '\n'
    );

    const result = scanCodexCliSessionsResult({ codexHome: tmp });

    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected ok scan result');
    }
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.threadId, 'thread-1');
    assert.equal(result.sessions[0]?.cwd, 'D:\\Workspace\\Project');
    assert.equal(result.sessions[0]?.model, 'gpt-5.4');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessionsResult returns ok with empty sessions for a real empty codex home', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  try {
    const result = scanCodexCliSessionsResult({ codexHome: tmp });

    assert.deepEqual(result, {
      ok: true,
      sessions: []
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessions can skip rollout traversal for lightweight takeover scans', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const originalReaddirSync = fs.readdirSync;
  try {
    fs.writeFileSync(
      path.join(tmp, 'session_index.jsonl'),
      JSON.stringify({ id: 'thread-1', thread_name: 'demo', updated_at: '2026-03-15T00:00:00Z' }) + '\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'history.jsonl'),
      [
        JSON.stringify({ session_id: 'thread-1', ts: 1, text: 'first text' }),
        JSON.stringify({ session_id: 'thread-1', ts: 10, text: 'latest text' })
      ].join('\n') + '\n'
    );
    const sessionsDir = path.join(sessionsRoot, 'demo');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-1.jsonl'),
      [
        JSON.stringify({ payload: { id: 'thread-1', cwd: 'D:\\Workspace\\Project' } }),
        JSON.stringify({ turn_context: { payload: { model: 'gpt-5.4' } } })
      ].join('\n') + '\n'
    );
    fs.readdirSync = ((targetPath: fs.PathLike, options?: any) => {
      if (String(targetPath) === sessionsRoot) {
        throw new Error('rollout traversal should be skipped');
      }
      return originalReaddirSync(targetPath, options);
    }) as typeof fs.readdirSync;

    const result = (scanCodexCliSessions as any)({
      codexHome: tmp,
      includeRolloutMetadata: false
    }) as ReturnType<typeof scanCodexCliSessions>;

    assert.equal(result.length, 1);
    assert.equal(result[0]?.threadId, 'thread-1');
    assert.equal(result[0]?.firstText, 'first text');
    assert.equal(result[0]?.lastText, 'latest text');
    assert.equal(result[0]?.cwd, undefined);
    assert.equal(result[0]?.model, null);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessionsResult returns error when the scan pipeline throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const originalReaddirSync = fs.readdirSync;
  try {
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.readdirSync = ((targetPath: fs.PathLike, options?: any) => {
      if (String(targetPath) === sessionsRoot) {
        throw new Error('synthetic scan failure');
      }
      return originalReaddirSync(targetPath, options);
    }) as typeof fs.readdirSync;

    const result = scanCodexCliSessionsResult({ codexHome: tmp });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected failed scan result');
    }
    assert.match(result.error, /synthetic scan failure/);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessionsResult surfaces rollout root access failures even when existsSync would hide them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  try {
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.existsSync = ((targetPath: fs.PathLike) => {
      if (String(targetPath) === sessionsRoot) {
        return false;
      }
      return originalExistsSync(targetPath);
    }) as typeof fs.existsSync;
    fs.readdirSync = ((targetPath: fs.PathLike, options?: any) => {
      if (String(targetPath) === sessionsRoot) {
        const error = new Error('synthetic rollout root access failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalReaddirSync(targetPath, options);
    }) as typeof fs.readdirSync;

    const result = scanCodexCliSessionsResult({ codexHome: tmp });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected failed scan result');
    }
    assert.match(result.error, /synthetic rollout root access failure/);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessionsResult returns error when a rollout file cannot be read', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const sessionsDir = path.join(tmp, 'sessions', 'demo');
  const rolloutPath = path.join(sessionsDir, 'rollout-1.jsonl');
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({ payload: { id: 'thread-1', cwd: 'D:\\Workspace\\Project' } }),
        JSON.stringify({ turn_context: { payload: { model: 'gpt-5.4' } } })
      ].join('\n') + '\n'
    );
    fs.readFileSync = ((targetPath: fs.PathOrFileDescriptor, options?: any) => {
      if (typeof targetPath === 'string' && path.resolve(targetPath) === path.resolve(rolloutPath)) {
        const error = new Error('synthetic rollout read failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalReadFileSync(targetPath, options);
    }) as typeof fs.readFileSync;

    const result = scanCodexCliSessionsResult({ codexHome: tmp });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected failed scan result');
    }
    assert.match(result.error, /synthetic rollout read failure/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCodexCliSessionsResult returns error when session index cannot be read', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const indexPath = path.join(tmp, 'session_index.jsonl');
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.writeFileSync(indexPath, JSON.stringify({ id: 'thread-1', thread_name: 'demo' }) + '\n');
    fs.readFileSync = ((targetPath: fs.PathOrFileDescriptor, options?: any) => {
      if (typeof targetPath === 'string' && path.resolve(targetPath) === path.resolve(indexPath)) {
        const error = new Error('synthetic read failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalReadFileSync(targetPath, options);
    }) as typeof fs.readFileSync;

    const result = scanCodexCliSessionsResult({ codexHome: tmp });

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail('expected failed scan result');
    }
    assert.match(result.error, /synthetic read failure/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
