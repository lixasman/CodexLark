import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeCommunicateTaskModel } from '../protocol/task-types';

export type CodexCliSessionInfo = {
  threadId: string;
  threadName?: string;
  updatedAt?: string;
  cwd?: string;
  model?: string | null;
  firstText?: string;
  lastText?: string;
  lastTextTs?: number;
};

export type CodexCliScanResult =
  | { ok: true; sessions: CodexCliSessionInfo[] }
  | { ok: false; error: string };

type ScanOptions = {
  codexHome?: string;
  includeRolloutMetadata?: boolean;
};

export function scanCodexCliSessions(options: ScanOptions = {}): CodexCliSessionInfo[] {
  const codexHome = resolveCodexHome(options.codexHome);
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const historyPath = path.join(codexHome, 'history.jsonl');
  const sessionsRoot = path.join(codexHome, 'sessions');

  const base = new Map<string, CodexCliSessionInfo>();
  for (const entry of readJsonLines(indexPath)) {
    const threadId = typeof entry?.id === 'string' ? entry.id : undefined;
    if (!threadId) continue;
    base.set(threadId, {
      threadId,
      threadName: typeof entry.thread_name === 'string' ? entry.thread_name : undefined,
      updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : undefined
    });
  }

  const firstTextByThread = new Map<string, { ts: number; text: string }>();
  const lastTextByThread = new Map<string, { ts: number; text: string }>();
  for (const entry of readJsonLines(historyPath)) {
    const threadId = typeof entry?.session_id === 'string' ? entry.session_id : undefined;
    const ts = typeof entry?.ts === 'number' ? entry.ts : undefined;
    const text = typeof entry?.text === 'string' ? entry.text : undefined;
    if (!threadId || ts == null || !text) continue;

    const first = firstTextByThread.get(threadId);
    if (!first || ts < first.ts) {
      firstTextByThread.set(threadId, { ts, text });
    }

    const last = lastTextByThread.get(threadId);
    if (!last || ts >= last.ts) {
      lastTextByThread.set(threadId, { ts, text });
    }
  }

  const rolloutMetadataByThread = new Map<string, { cwd?: string; model?: string }>();
  if (options.includeRolloutMetadata !== false) {
    for (const filePath of listRolloutFiles(sessionsRoot)) {
      const rolloutMetadata = readRolloutMetadata(filePath);
      if (!rolloutMetadata.threadId) continue;
      const current = rolloutMetadataByThread.get(rolloutMetadata.threadId) ?? {};
      rolloutMetadataByThread.set(rolloutMetadata.threadId, {
        cwd: current.cwd ?? rolloutMetadata.cwd,
        model: current.model ?? rolloutMetadata.model
      });
    }
  }

  for (const [threadId, first] of firstTextByThread) {
    const record = base.get(threadId) || { threadId };
    record.firstText = first.text;
    base.set(threadId, record);
  }

  for (const [threadId, last] of lastTextByThread) {
    const record = base.get(threadId) || { threadId };
    record.lastText = last.text;
    record.lastTextTs = last.ts;
    base.set(threadId, record);
  }

  for (const [threadId, metadata] of rolloutMetadataByThread) {
    const record = base.get(threadId) || { threadId };
    if (metadata.cwd) {
      record.cwd = metadata.cwd;
    }
    record.model = metadata.model ?? null;
    base.set(threadId, record);
  }

  const parseUpdatedAt = (value?: string): number => {
    if (!value) return 0;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  };

  for (const record of base.values()) {
    if (record.model === undefined) {
      record.model = null;
    }
  }

  return Array.from(base.values()).sort((a, b) => {
    const aLast = a.lastTextTs ?? 0;
    const bLast = b.lastTextTs ?? 0;
    if (aLast !== bLast) return bLast - aLast;
    const aUpdated = parseUpdatedAt(a.updatedAt);
    const bUpdated = parseUpdatedAt(b.updatedAt);
    if (aUpdated !== bUpdated) return bUpdated - aUpdated;
    return (a.threadId || '').localeCompare(b.threadId || '');
  });
}

export function scanCodexCliSessionsResult(options: ScanOptions = {}): CodexCliScanResult {
  try {
    return {
      ok: true,
      sessions: scanCodexCliSessions(options)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolveCodexHome(override?: string): string {
  if (override && override.trim()) return override;
  const envHome = (process.env.COMMUNICATE_CODEX_HOME || '').trim() || (process.env.CODEX_HOME || '').trim();
  if (envHome) return envHome;
  return path.join(os.homedir(), '.codex');
}

function readJsonLines(filePath: string): Array<Record<string, any>> {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeJsonParse(line))
      .filter((value): value is Record<string, any> => Boolean(value));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readRolloutMetadata(filePath: string): {
  threadId?: string;
  cwd?: string;
  model?: string;
} {
  const result: {
    threadId?: string;
    cwd?: string;
    model?: string;
  } = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const entry = safeJsonParse(line);
      if (!entry) continue;
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : undefined;
      if (!result.threadId && typeof payload?.id === 'string') {
        result.threadId = payload.id;
      }
      if (!result.cwd && typeof payload?.cwd === 'string') {
        result.cwd = payload.cwd;
      }
      if (!result.model) {
        const normalizedModel = resolveRolloutModel(entry);
        if (normalizedModel) {
          result.model = normalizedModel;
        }
      }
      if (result.threadId && result.cwd && result.model) {
        break;
      }
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return result;
    }
    throw error;
  }
  return result;
}

function resolveRolloutModel(entry: Record<string, any>): string | undefined {
  const candidates = [
    entry.turn_context?.payload?.model,
    entry.payload?.model
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCommunicateTaskModel(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function safeJsonParse(line: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function listRolloutFiles(rootDir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return files;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRolloutFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}




