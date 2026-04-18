import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCodexCliProcesses } from '../../src/communicate/control/codex-cli-process';

test('filters codex cli processes and excludes app-server', () => {
  const filtered = filterCodexCliProcesses([
    { pid: 1, commandLine: 'codex --help' },
    { pid: 2, commandLine: 'node app-server codex' },
    { pid: 3, commandLine: 'C:\\Windows\\System32\\notepad.exe' }
  ]);

  assert.deepEqual(filtered.map((proc: { pid: number }) => proc.pid), [1]);
});
