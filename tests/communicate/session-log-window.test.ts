import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionLogWindowCommand,
  buildSessionLogWindowLauncherArgs,
  createSessionLogWindow
} from '../../src/communicate/logging/session-log-window';

test('buildSessionLogWindowCommand enables utf8 tailing and includes the task title', () => {
  const command = buildSessionLogWindowCommand({
    taskId: 'T3',
    cwd: 'D:\\Workspace\\Project',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T3.log'
  });

  assert.match(command, /Encoding\]::UTF8|Encoding UTF8/);
  assert.match(command, /Codex Session T3/);
  assert.match(command, /T3\.log/);
});

test('buildSessionLogWindowCommand tails raw utf8 bytes without waiting for newline', () => {
  const command = buildSessionLogWindowCommand({
    taskId: 'T3',
    cwd: 'D:\\Workspace\\Project',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T3.log'
  });

  assert.doesNotMatch(command, /Get-Content\s+-LiteralPath.*-Wait/i);
  assert.match(command, /File\]::Open|FileStream/i);
  assert.match(command, /Console\]::Out\.Write/i);
});

test('buildSessionLogWindowLauncherArgs wraps the tail command with Start-Process and encoded command', () => {
  const args = buildSessionLogWindowLauncherArgs({
    taskId: 'T3',
    cwd: 'D:\\Workspace\\Project',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T3.log'
  });

  assert.equal(args[0], '-NoProfile');
  assert.equal(args[1], '-Command');
  assert.match(args[2] ?? '', /Start-Process/);
  assert.match(args[2] ?? '', /-WorkingDirectory/);
  assert.match(args[2] ?? '', /-EncodedCommand/);
});

test('session log window tracks pid and closes the spawned process by pid', () => {
  let capturedCommand = '';
  let capturedArgs: string[] = [];
  const killed: number[] = [];

  const windowRef = createSessionLogWindow({
    taskId: 'T3',
    cwd: 'D:\\Workspace\\Project',
    logPath: 'D:\\Workspace\\Project\\logs\\communicate\\T3.log',
    launchFactory: (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return { pid: 777 };
    },
    killFactory: (pid) => {
      killed.push(pid);
    }
  });

  assert.equal(windowRef.pid, 777);
  assert.equal(capturedCommand, 'powershell.exe');
  assert.equal(capturedArgs[0], '-NoProfile');
  assert.match(capturedArgs[2] ?? '', /Start-Process/);

  windowRef.close();
  assert.deepEqual(killed, [777]);
});
