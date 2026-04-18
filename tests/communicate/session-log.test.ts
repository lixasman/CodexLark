import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionLog } from '../../src/communicate/logging/session-log';

test('session log writes utf8 control events and raw output to a stable file path', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-log-'));

  try {
    const log = createSessionLog({ taskId: 'T3', cwd: 'D:\\Workspace\\Project', rootDir });
    log.appendEvent('SESSION OPEN', { cwd: 'D:\\Workspace\\Project' });
    log.appendRaw('第一行输出\n');
    log.appendRaw('第二行输出');

    const content = readFileSync(log.path, 'utf8');
    assert.match(log.path, /T3\.log$/);
    assert.match(content, /SESSION OPEN/);
    assert.match(content, /第一行输出/);
    assert.match(content, /第二行输出/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session log reports init failure before rethrowing when the log file cannot be created', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-log-init-'));
  const fsModule = require('node:fs') as typeof import('node:fs') & {
    writeFileSync: typeof import('node:fs').writeFileSync;
  };
  const originalConsoleError = console.error;
  const originalWriteFileSync = fsModule.writeFileSync;
  const capturedErrors: string[] = [];

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };
    fsModule.writeFileSync = ((filePath: any, data: any, options?: any) => {
      if (String(filePath).endsWith('T8.log')) {
        throw new Error('simulated init denied');
      }
      return originalWriteFileSync(filePath, data, options);
    }) as typeof import('node:fs').writeFileSync;

    assert.throws(
      () => createSessionLog({ taskId: 'T8', cwd: 'D:\\CodexLark', rootDir }),
      /simulated init denied/
    );
    assert.ok(
      capturedErrors.some((line) => line.includes('[session-log] init failed') && line.includes('"taskId":"T8"')),
      `expected structured session-log init error, got: ${capturedErrors.join('\n')}`
    );
  } finally {
    console.error = originalConsoleError;
    fsModule.writeFileSync = originalWriteFileSync;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session log reports a structured health check failure when the existing log is not writable', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-log-health-'));
  const fsModule = require('node:fs') as typeof import('node:fs') & {
    openSync: typeof import('node:fs').openSync;
  };
  const originalConsoleError = console.error;
  const originalOpenSync = fsModule.openSync;
  const capturedErrors: string[] = [];

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };
    fsModule.openSync = ((filePath: any, flags: any, mode?: any) => {
      if (String(filePath).endsWith('T8.log') && flags === 'a') {
        throw new Error('simulated open denied');
      }
      return originalOpenSync(filePath, flags, mode);
    }) as typeof import('node:fs').openSync;

    createSessionLog({ taskId: 'T8', cwd: 'D:\\CodexLark', rootDir });

    assert.ok(
      capturedErrors.some((line) => line.includes('[session-log] health check failed') && line.includes('"taskId":"T8"')),
      `expected structured session-log health check error, got: ${capturedErrors.join('\n')}`
    );
  } finally {
    console.error = originalConsoleError;
    fsModule.openSync = originalOpenSync;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('session log reports append failure once with task context', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'communicate-session-log-append-'));
  const fsModule = require('node:fs') as typeof import('node:fs') & {
    appendFileSync: typeof import('node:fs').appendFileSync;
  };
  const originalConsoleError = console.error;
  const originalAppendFileSync = fsModule.appendFileSync;
  const capturedErrors: string[] = [];

  try {
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map((value) => String(value)).join(' '));
    };
    fsModule.appendFileSync = ((filePath: any, data: any, options?: any) => {
      if (String(filePath).endsWith('T8.log')) {
        throw new Error('simulated append denied');
      }
      return originalAppendFileSync(filePath, data, options);
    }) as typeof import('node:fs').appendFileSync;

    const log = createSessionLog({ taskId: 'T8', cwd: 'D:\\CodexLark', rootDir });
    log.appendEvent('FEISHU IN', 'hello');
    log.appendEvent('TURN START');

    const appendErrors = capturedErrors.filter((line) => line.includes('[session-log] append failed'));
    assert.equal(appendErrors.length, 1);
    assert.match(appendErrors[0] ?? '', /"taskId":"T8"/);
    assert.match(appendErrors[0] ?? '', /simulated append denied/);
  } finally {
    console.error = originalConsoleError;
    fsModule.appendFileSync = originalAppendFileSync;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
