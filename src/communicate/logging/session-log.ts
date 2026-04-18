import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type SessionLogWriter = {
  path: string;
  appendRaw: (text: string) => void;
  appendEvent: (event: string, detail?: string | Record<string, unknown>) => void;
  close: () => void;
};

export function createSessionLog(input: { taskId: `T${number}` | string; cwd: string; rootDir?: string }): SessionLogWriter {
  const rootDir = input.rootDir ?? path.join(process.cwd(), 'logs', 'communicate');
  const filePath = path.join(rootDir, `${input.taskId}.log`);
  let initFailureReported = false;
  let healthCheckReported = false;
  let appendFailureReported = false;

  function reportFailure(kind: 'init failed' | 'health check failed' | 'append failed', error: unknown): void {
    const detail = {
      taskId: input.taskId,
      cwd: input.cwd,
      path: filePath,
      error: error instanceof Error ? error.message : String(error)
    };
    try {
      console.error(`[session-log] ${kind} ${JSON.stringify(detail)}`);
    } catch {
      console.error(`[session-log] ${kind}`);
    }
  }

  try {
    mkdirSync(rootDir, { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '', 'utf8');
    }
  } catch (error) {
    if (!initFailureReported) {
      initFailureReported = true;
      reportFailure('init failed', error);
    }
    throw error;
  }

  try {
    const handle = openSync(filePath, 'a');
    closeSync(handle);
  } catch (error) {
    if (!healthCheckReported) {
      healthCheckReported = true;
      reportFailure('health check failed', error);
    }
  }

  function safeAppend(text: string): void {
    try {
      appendFileSync(filePath, text, 'utf8');
    } catch (error) {
      if (!appendFailureReported) {
        appendFailureReported = true;
        reportFailure('append failed', error);
      }
    }
  }

  return {
    path: filePath,
    appendRaw(text: string) {
      if (!text) return;
      safeAppend(text);
    },
    appendEvent(event: string, detail?: string | Record<string, unknown>) {
      const suffix =
        typeof detail === 'string'
          ? detail
          : detail && Object.keys(detail).length > 0
            ? JSON.stringify(detail)
            : '';
      safeAppend(`[${new Date().toISOString()}] ${event}${suffix ? ` ${suffix}` : ''}\n`);
    },
    close() {
      return;
    }
  };
}
