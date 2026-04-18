import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanCodexCliSessions } from '../../src/communicate/control/codex-cli-scan';

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
