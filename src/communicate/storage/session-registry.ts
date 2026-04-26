import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  cloneCommunicateRuntimeWarnings,
  type CommunicateTaskId,
  type CommunicateAssistantPersonality,
  type CommunicateSessionKind,
  type CommunicateSessionStartupMode,
  type NormalizedCodexSessionLifecycle
} from '../protocol/task-types';

function resolveSessionRegistryRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

export const DEFAULT_SESSION_REGISTRY_PATH =
  (process.env.COMMUNICATE_SESSION_REGISTRY_PATH ?? '').trim() ||
  path.join(resolveSessionRegistryRoot(__dirname), 'logs', 'communicate', 'registry.json');

export type SessionRegistryRecord = {
  taskId: CommunicateTaskId;
  feishuThreadId?: string;
  codexThreadId?: string;
  cwd?: string;
  logPath?: string;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string | null;
  sessionLifecycle?: NormalizedCodexSessionLifecycle;
  lastCheckpointOutput?: string;
  lastCheckpointAt?: string;
  lastEventAt?: string;
  createdAt?: string;
  closedAt?: string;
  windowPid?: number;
  interruptedByRestart?: boolean;
  sessionKind?: CommunicateSessionKind;
  startupMode?: CommunicateSessionStartupMode;
  assistantProfileId?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  personality?: CommunicateAssistantPersonality;
  runtimeWarnings?: import('../protocol/task-types').CommunicateRuntimeWarning[];
  goalSummary?: string;
  goalSummaryStatus?: 'pending' | 'ready' | 'failed';
  goalSummarySourceText?: string;
  firstUserCodingText?: string;
};

export type SessionThreadBindingRecord = {
  feishuThreadId: string;
  assistantTaskId: CommunicateTaskId;
};

export type SessionThreadUiMode = 'assistant' | 'coding';
export type SessionThreadStatusCardMode = 'status' | 'launcher' | 'takeover_picker';

export type SessionThreadUiStateRecord = {
  feishuThreadId: string;
  displayMode: SessionThreadUiMode;
  lastAcceptedTextCreateTimeMs?: number;
  statusCardMode?: SessionThreadStatusCardMode;
  currentCodingTaskId?: CommunicateTaskId;
  statusCardMessageId?: string;
  statusCardActionMessageId?: string;
  statusCardPickerOpen?: boolean;
  launcherSelectedCwd?: string;
  launcherDraftCwd?: string;
  launcherError?: string;
  takeoverPickerTaskIds?: CommunicateTaskId[];
  takeoverPickerPage?: number;
  takeoverPickerTotalPages?: number;
  takeoverPickerSelectedTaskId?: CommunicateTaskId;
  takeoverPickerSnapshotUpdatedAt?: string;
  takeoverPickerError?: string;
};

export type SessionRegistryState = {
  nextTaskId: number;
  sessions: Record<CommunicateTaskId, SessionRegistryRecord>;
  threadBindings: Record<string, SessionThreadBindingRecord>;
  threadUiStates: Record<string, SessionThreadUiStateRecord>;
  inboundMessages: Record<string, number>;
  recentProjectDirs: string[];
  lastActiveFeishuThreadId?: string;
  lastActiveFeishuUserOpenId?: string;
};

type CreateSessionRegistryInput = {
  registryPath?: string;
  warn?: (message: string, error?: unknown) => void;
};

type SessionRegistryRecordPatch = Partial<SessionRegistryRecord> & Pick<SessionRegistryRecord, 'taskId'>;

type SessionRegistryMutationResult<T> = {
  nextState: SessionRegistryState;
  result: T;
  changed: boolean;
};

type SessionRegistryWriteLockOwner = {
  ownerId?: string;
  pid: number;
  startedAt: string;
  acquiredAt: string;
};

type SessionRegistryWriteLockOwnerSnapshot = {
  owner?: SessionRegistryWriteLockOwner;
  ownerFilePath?: string;
};

type SessionRegistryWriteLockAnalysis = {
  owner?: SessionRegistryWriteLockOwner;
  ownerFilePath?: string;
  stale: boolean;
  reason: 'active-owner' | 'stale-owner' | 'invalid-state';
};

const SESSION_REGISTRY_WRITE_LOCK_DIR_SUFFIX = '.lock';
const SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE = 'owner.json';
const SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE_PREFIX = 'owner.';
const SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE_SUFFIX = '.json';
const DEFAULT_SESSION_REGISTRY_WRITE_LOCK_STALE_AFTER_MS = 30_000;
const DEFAULT_SESSION_REGISTRY_WRITE_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_REGISTRY_WRITE_LOCK_RETRY_DELAY_MS = 25;
const sessionRegistryWriteLockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function createEmptyState(): SessionRegistryState {
  return {
    nextTaskId: 1,
    sessions: {},
    threadBindings: {},
    threadUiStates: {},
    inboundMessages: {},
    recentProjectDirs: [],
    lastActiveFeishuThreadId: undefined,
    lastActiveFeishuUserOpenId: undefined
  };
}

function cloneRecord(record: SessionRegistryRecord): SessionRegistryRecord {
  return { ...record, runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings) };
}

function cloneThreadBinding(record: SessionThreadBindingRecord): SessionThreadBindingRecord {
  return { ...record };
}

function cloneThreadUiState(record: SessionThreadUiStateRecord): SessionThreadUiStateRecord {
  if (!record.takeoverPickerTaskIds) {
    return { ...record };
  }
  return {
    ...record,
    takeoverPickerTaskIds: [...record.takeoverPickerTaskIds]
  };
}

function cloneState(state: SessionRegistryState): SessionRegistryState {
  const sessions: SessionRegistryState['sessions'] = {};
  for (const taskId of Object.keys(state.sessions) as CommunicateTaskId[]) {
    sessions[taskId] = cloneRecord(state.sessions[taskId]);
  }
  const threadBindings: SessionRegistryState['threadBindings'] = {};
  for (const feishuThreadId of Object.keys(state.threadBindings)) {
    threadBindings[feishuThreadId] = cloneThreadBinding(state.threadBindings[feishuThreadId]);
  }
  const threadUiStates: SessionRegistryState['threadUiStates'] = {};
  for (const feishuThreadId of Object.keys(state.threadUiStates)) {
    threadUiStates[feishuThreadId] = cloneThreadUiState(state.threadUiStates[feishuThreadId]);
  }
  return {
    nextTaskId: state.nextTaskId,
    sessions,
    threadBindings,
    threadUiStates,
    inboundMessages: { ...state.inboundMessages },
    recentProjectDirs: [...state.recentProjectDirs],
    lastActiveFeishuThreadId: state.lastActiveFeishuThreadId,
    lastActiveFeishuUserOpenId: state.lastActiveFeishuUserOpenId
  };
}

function normalizeInboundMessageSeenAt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function normalizeCommunicateTaskId(value: unknown): CommunicateTaskId | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^T\d+$/.test(trimmed) ? (trimmed as CommunicateTaskId) : undefined;
}

function normalizeTakeoverPickerTaskIds(value: unknown): CommunicateTaskId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: CommunicateTaskId[] = [];
  const seen = new Set<CommunicateTaskId>();
  for (const item of value) {
    const taskId = normalizeCommunicateTaskId(item);
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    normalized.push(taskId);
  }
  return normalized;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRecentProjectDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    normalized.push(trimmed);
    seen.add(trimmed);
    if (normalized.length >= 5) break;
  }
  return normalized;
}

function normalizeLastActiveFeishuThreadId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeLastActiveFeishuUserOpenId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getSessionRecencyMs(record: SessionRegistryRecord): number {
  const candidates = [record.lastEventAt, record.createdAt, record.closedAt];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function deriveLastActiveFeishuThreadId(
  sessions: SessionRegistryState['sessions'],
  explicitThreadId: string | undefined
): string | undefined {
  if (explicitThreadId) return explicitThreadId;

  let latestThreadId: string | undefined;
  let latestRecencyMs = Number.NEGATIVE_INFINITY;
  let latestTaskOrdinal = Number.NEGATIVE_INFINITY;

  for (const record of Object.values(sessions)) {
    const feishuThreadId = normalizeLastActiveFeishuThreadId(record.feishuThreadId);
    if (!feishuThreadId) continue;

    const recencyMs = getSessionRecencyMs(record);
    const taskOrdinal = Number.parseInt(record.taskId.slice(1), 10);
    if (
      recencyMs > latestRecencyMs ||
      (recencyMs === latestRecencyMs && taskOrdinal > latestTaskOrdinal)
    ) {
      latestThreadId = feishuThreadId;
      latestRecencyMs = recencyMs;
      latestTaskOrdinal = taskOrdinal;
    }
  }

  return latestThreadId;
}

function deriveNextTaskIdFromSessions(sessions: SessionRegistryState['sessions']): number {
  let nextTaskId = 1;
  for (const taskId of Object.keys(sessions) as CommunicateTaskId[]) {
    const ordinal = Number.parseInt(taskId.slice(1), 10);
    if (Number.isInteger(ordinal) && ordinal >= nextTaskId) {
      nextTaskId = ordinal + 1;
    }
  }
  return nextTaskId;
}

function normalizeState(raw: unknown): SessionRegistryState {
  if (!raw || typeof raw !== 'object') return createEmptyState();

  const input = raw as {
    nextTaskId?: unknown;
    sessions?: Record<string, unknown>;
    threadBindings?: Record<string, unknown>;
    threadUiStates?: Record<string, unknown>;
    inboundMessages?: Record<string, unknown>;
    recentProjectDirs?: unknown;
    lastActiveFeishuThreadId?: unknown;
    lastActiveFeishuUserOpenId?: unknown;
  };
  const nextTaskId =
    typeof input.nextTaskId === 'number' && Number.isInteger(input.nextTaskId) && input.nextTaskId > 0
      ? input.nextTaskId
      : 1;

  const sessions: SessionRegistryState['sessions'] = {};
  if (input.sessions && typeof input.sessions === 'object') {
    for (const [taskId, value] of Object.entries(input.sessions)) {
      if (!/^T\d+$/.test(taskId) || !value || typeof value !== 'object') continue;
      sessions[taskId as CommunicateTaskId] = {
        ...(value as SessionRegistryRecord),
        taskId: taskId as CommunicateTaskId,
        runtimeWarnings: cloneCommunicateRuntimeWarnings(
          (value as SessionRegistryRecord).runtimeWarnings
        )
      };
    }
  }

  const threadBindings: SessionRegistryState['threadBindings'] = {};
  if (input.threadBindings && typeof input.threadBindings === 'object') {
    for (const [feishuThreadId, value] of Object.entries(input.threadBindings)) {
      if (!value || typeof value !== 'object') continue;
      const assistantTaskId = typeof (value as { assistantTaskId?: unknown }).assistantTaskId === 'string'
        ? (value as { assistantTaskId: string }).assistantTaskId
        : '';
      if (!/^T\d+$/.test(assistantTaskId)) continue;
      threadBindings[feishuThreadId] = {
        feishuThreadId,
        assistantTaskId: assistantTaskId as CommunicateTaskId
      };
    }
  }

  const threadUiStates: SessionRegistryState['threadUiStates'] = {};
  if (input.threadUiStates && typeof input.threadUiStates === 'object') {
    for (const [feishuThreadId, value] of Object.entries(input.threadUiStates)) {
      if (!value || typeof value !== 'object') continue;
      const displayMode = (value as { displayMode?: unknown }).displayMode;
      if (displayMode !== 'assistant' && displayMode !== 'coding') continue;
      const currentCodingTaskId = normalizeCommunicateTaskId(
        (value as { currentCodingTaskId?: unknown }).currentCodingTaskId
      );
      const nextRecord: SessionThreadUiStateRecord = {
        feishuThreadId,
        displayMode
      };
      const statusCardMode = (value as { statusCardMode?: unknown }).statusCardMode;
      if (statusCardMode === 'status' || statusCardMode === 'launcher' || statusCardMode === 'takeover_picker') {
        nextRecord.statusCardMode = statusCardMode;
      }
      if (currentCodingTaskId) {
        nextRecord.currentCodingTaskId = currentCodingTaskId;
      }
      if (typeof (value as { statusCardMessageId?: unknown }).statusCardMessageId === 'string') {
        nextRecord.statusCardMessageId = (value as { statusCardMessageId: string }).statusCardMessageId;
      }
      if (typeof (value as { statusCardActionMessageId?: unknown }).statusCardActionMessageId === 'string') {
        const statusCardActionMessageId = (value as { statusCardActionMessageId: string }).statusCardActionMessageId.trim();
        if (statusCardActionMessageId) {
          nextRecord.statusCardActionMessageId = statusCardActionMessageId;
        }
      }
      if (typeof (value as { statusCardPickerOpen?: unknown }).statusCardPickerOpen === 'boolean') {
        nextRecord.statusCardPickerOpen = (value as { statusCardPickerOpen: boolean }).statusCardPickerOpen;
      }
      if (typeof (value as { launcherSelectedCwd?: unknown }).launcherSelectedCwd === 'string') {
        const launcherSelectedCwd = (value as { launcherSelectedCwd: string }).launcherSelectedCwd.trim();
        if (launcherSelectedCwd) {
          nextRecord.launcherSelectedCwd = launcherSelectedCwd;
        }
      }
      if (typeof (value as { launcherDraftCwd?: unknown }).launcherDraftCwd === 'string') {
        const launcherDraftCwd = (value as { launcherDraftCwd: string }).launcherDraftCwd.trim();
        if (launcherDraftCwd) {
          nextRecord.launcherDraftCwd = launcherDraftCwd;
        }
      }
      if (typeof (value as { launcherError?: unknown }).launcherError === 'string') {
        const launcherError = (value as { launcherError: string }).launcherError.trim();
        if (launcherError) {
          nextRecord.launcherError = launcherError;
        }
      }
      const takeoverPickerTaskIds = normalizeTakeoverPickerTaskIds(
        (value as { takeoverPickerTaskIds?: unknown }).takeoverPickerTaskIds
      );
      if (takeoverPickerTaskIds !== undefined) {
        nextRecord.takeoverPickerTaskIds = takeoverPickerTaskIds;
      }
      const takeoverPickerPage = normalizeNonNegativeInteger(
        (value as { takeoverPickerPage?: unknown }).takeoverPickerPage
      );
      if (takeoverPickerPage !== undefined) {
        nextRecord.takeoverPickerPage = takeoverPickerPage;
      }
      const takeoverPickerTotalPages = normalizeNonNegativeInteger(
        (value as { takeoverPickerTotalPages?: unknown }).takeoverPickerTotalPages
      );
      if (takeoverPickerTotalPages !== undefined) {
        nextRecord.takeoverPickerTotalPages = Math.max(1, takeoverPickerTotalPages);
      }
      const takeoverPickerSelectedTaskId = normalizeCommunicateTaskId(
        (value as { takeoverPickerSelectedTaskId?: unknown }).takeoverPickerSelectedTaskId
      );
      if (takeoverPickerSelectedTaskId) {
        nextRecord.takeoverPickerSelectedTaskId = takeoverPickerSelectedTaskId;
      }
      const takeoverPickerSnapshotUpdatedAt = normalizeOptionalTrimmedString(
        (value as { takeoverPickerSnapshotUpdatedAt?: unknown }).takeoverPickerSnapshotUpdatedAt
      );
      if (takeoverPickerSnapshotUpdatedAt) {
        nextRecord.takeoverPickerSnapshotUpdatedAt = takeoverPickerSnapshotUpdatedAt;
      }
      const takeoverPickerError = normalizeOptionalTrimmedString(
        (value as { takeoverPickerError?: unknown }).takeoverPickerError
      );
      if (takeoverPickerError) {
        nextRecord.takeoverPickerError = takeoverPickerError;
      }
      const lastAcceptedTextCreateTimeMs = normalizeInboundMessageSeenAt(
        (value as { lastAcceptedTextCreateTimeMs?: unknown }).lastAcceptedTextCreateTimeMs
      );
      if (lastAcceptedTextCreateTimeMs !== undefined) {
        nextRecord.lastAcceptedTextCreateTimeMs = lastAcceptedTextCreateTimeMs;
      }
      threadUiStates[feishuThreadId] = nextRecord;
    }
  }

  const inboundMessages: SessionRegistryState['inboundMessages'] = {};
  if (input.inboundMessages && typeof input.inboundMessages === 'object') {
    for (const [messageId, value] of Object.entries(input.inboundMessages)) {
      const normalized = normalizeInboundMessageSeenAt(value);
      if (!messageId.trim() || normalized === undefined) continue;
      inboundMessages[messageId] = normalized;
    }
  }
  const recentProjectDirs = normalizeRecentProjectDirs(input.recentProjectDirs);
  const lastActiveFeishuThreadId = deriveLastActiveFeishuThreadId(
    sessions,
    normalizeLastActiveFeishuThreadId(input.lastActiveFeishuThreadId)
  );
  const lastActiveFeishuUserOpenId = normalizeLastActiveFeishuUserOpenId(input.lastActiveFeishuUserOpenId);

  return {
    nextTaskId,
    sessions,
    threadBindings,
    threadUiStates,
    inboundMessages,
    recentProjectDirs,
    lastActiveFeishuThreadId,
    lastActiveFeishuUserOpenId
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function isPermissionError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTEMPTY';
}

function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(sessionRegistryWriteLockSleepBuffer, 0, 0, Math.floor(ms));
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

function writeStateToDisk(registryPath: string, nextState: SessionRegistryState): void {
  const dirPath = path.dirname(registryPath);
  mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync(tempPath, JSON.stringify(cloneState(nextState), null, 2), 'utf8');
  renameSync(tempPath, registryPath);
}

function buildSessionRegistryWriteLockDir(registryPath: string): string {
  return `${registryPath}${SESSION_REGISTRY_WRITE_LOCK_DIR_SUFFIX}`;
}

function buildSessionRegistryWriteLockOwnerFilePath(lockDir: string, ownerId?: string): string {
  if (typeof ownerId === 'string' && ownerId.trim()) {
    return path.join(
      lockDir,
      `${SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE_PREFIX}${ownerId}${SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE_SUFFIX}`
    );
  }
  return path.join(lockDir, SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE);
}

function buildSessionRegistryWriteLockPendingDir(lockDir: string, ownerId?: string): string {
  return `${lockDir}.pending.${ownerId ?? randomUUID()}`;
}

function isSessionRegistryWriteLockOwnerFileName(fileName: string): boolean {
  return (
    fileName === SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE ||
    (fileName.startsWith(SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE_PREFIX) &&
      fileName.endsWith(SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE_SUFFIX))
  );
}

function listSessionRegistryWriteLockOwnerFilePaths(lockDir: string): string[] {
  try {
    const ownerSpecific: string[] = [];
    let legacyOwnerFilePath: string | undefined;
    for (const entry of readdirSync(lockDir, { withFileTypes: true })) {
      if (!entry.isFile() || !isSessionRegistryWriteLockOwnerFileName(entry.name)) {
        continue;
      }
      const ownerFilePath = path.join(lockDir, entry.name);
      if (entry.name === SESSION_REGISTRY_WRITE_LOCK_OWNER_FILE) {
        legacyOwnerFilePath = ownerFilePath;
        continue;
      }
      ownerSpecific.push(ownerFilePath);
    }
    ownerSpecific.sort();
    if (legacyOwnerFilePath) {
      ownerSpecific.push(legacyOwnerFilePath);
    }
    if (ownerSpecific.length > 0) {
      return ownerSpecific;
    }
  } catch {
    // Treat unreadable lock metadata as invalid-state and let stale takeover recover it.
  }
  return [];
}

function parseSessionRegistryWriteLockOwner(ownerFilePath: string): SessionRegistryWriteLockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(ownerFilePath, 'utf8')) as Partial<SessionRegistryWriteLockOwner>;
    if (
      typeof raw?.pid !== 'number' ||
      !Number.isFinite(raw.pid) ||
      typeof raw.startedAt !== 'string' ||
      typeof raw.acquiredAt !== 'string'
    ) {
      return undefined;
    }
    return {
      ownerId: typeof raw.ownerId === 'string' && raw.ownerId.trim() ? raw.ownerId : undefined,
      pid: Math.floor(raw.pid),
      startedAt: raw.startedAt,
      acquiredAt: raw.acquiredAt
    };
  } catch {
    return undefined;
  }
}

function readSessionRegistryWriteLockOwner(lockDir: string): SessionRegistryWriteLockOwnerSnapshot {
  let firstOwnerFilePath: string | undefined;
  for (const ownerFilePath of listSessionRegistryWriteLockOwnerFilePaths(lockDir)) {
    firstOwnerFilePath ??= ownerFilePath;
    const owner = parseSessionRegistryWriteLockOwner(ownerFilePath);
    if (owner) {
      return {
        owner,
        ownerFilePath
      };
    }
  }
  return {
    ownerFilePath: firstOwnerFilePath
  };
}

function cleanupSessionRegistryWriteLockOwner(ownerFilePath: string, lockDir: string): void {
  rmSync(ownerFilePath, { force: true });
  try {
    rmdirSync(lockDir);
  } catch (error) {
    if (isMissingError(error)) {
      return;
    }
    throw error;
  }
}

function publishSessionRegistryWriteLock(lockDir: string, owner: SessionRegistryWriteLockOwner): void {
  const pendingDir = buildSessionRegistryWriteLockPendingDir(lockDir, owner.ownerId);
  const pendingOwnerFilePath = buildSessionRegistryWriteLockOwnerFilePath(pendingDir, owner.ownerId);
  rmSync(pendingDir, { recursive: true, force: true });
  mkdirSync(pendingDir);
  try {
    writeFileSync(pendingOwnerFilePath, JSON.stringify(owner, null, 2), 'utf8');
    renameSync(pendingDir, lockDir);
  } catch (error) {
    rmSync(pendingDir, { recursive: true, force: true });
    throw error;
  }
}

function analyzeSessionRegistryWriteLock(input: {
  lockDir: string;
  now: () => number;
  staleAfterMs: number;
  isProcessAlive: (pid: number) => boolean;
}): SessionRegistryWriteLockAnalysis {
  const snapshot = readSessionRegistryWriteLockOwner(input.lockDir);
  if (!snapshot.owner) {
    return {
      ownerFilePath: snapshot.ownerFilePath,
      stale: true,
      reason: 'invalid-state'
    };
  }

  const acquiredAtMs = Date.parse(snapshot.owner.acquiredAt);
  const acquiredAgeMs = Number.isFinite(acquiredAtMs) ? Math.max(0, input.now() - acquiredAtMs) : Number.POSITIVE_INFINITY;
  const alive = input.isProcessAlive(snapshot.owner.pid);
  const stale = !alive || acquiredAgeMs > input.staleAfterMs;
  return {
    owner: snapshot.owner,
    ownerFilePath: snapshot.ownerFilePath,
    stale,
    reason: stale ? 'stale-owner' : 'active-owner'
  };
}

export function acquireSessionRegistryWriteLock(registryPath: string): { release: () => void } {
  const lockDir = buildSessionRegistryWriteLockDir(registryPath);
  const staleAfterMs = DEFAULT_SESSION_REGISTRY_WRITE_LOCK_STALE_AFTER_MS;
  const timeoutMs = DEFAULT_SESSION_REGISTRY_WRITE_LOCK_TIMEOUT_MS;
  const retryDelayMs = DEFAULT_SESSION_REGISTRY_WRITE_LOCK_RETRY_DELAY_MS;
  const now = Date.now;
  const waitStartedAt = now();
  const owner: SessionRegistryWriteLockOwner = {
    ownerId: randomUUID(),
    pid: process.pid,
    startedAt: new Date(now() - Math.max(0, Math.floor(process.uptime() * 1_000))).toISOString(),
    acquiredAt: new Date(now()).toISOString()
  };
  const ownerFilePath = buildSessionRegistryWriteLockOwnerFilePath(lockDir, owner.ownerId);
  let released = false;

  mkdirSync(path.dirname(lockDir), { recursive: true });

  while (true) {
    try {
      publishSessionRegistryWriteLock(lockDir, owner);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error) && !(isPermissionError(error) && existsSync(lockDir))) {
        throw error;
      }

      const analysis = analyzeSessionRegistryWriteLock({
        lockDir,
        now,
        staleAfterMs,
        isProcessAlive: defaultIsProcessAlive
      });
      if (analysis.stale) {
        if (analysis.ownerFilePath) {
          const displacedOwnerFilePath = `${analysis.ownerFilePath}.stale.${now()}.${process.pid}`;
          try {
            renameSync(analysis.ownerFilePath, displacedOwnerFilePath);
          } catch (renameError) {
            if (isMissingError(renameError) || isAlreadyExistsError(renameError)) {
              continue;
            }
            throw renameError;
          }
          rmSync(displacedOwnerFilePath, { force: true });
        }
        try {
          rmdirSync(lockDir);
        } catch (cleanupError) {
          if (isMissingError(cleanupError)) {
            continue;
          }
          throw cleanupError;
        }
        continue;
      }

      if (now() - waitStartedAt >= timeoutMs) {
        const ownerSummary = analysis.owner
          ? `PID ${analysis.owner.pid} (startedAt=${analysis.owner.startedAt}, acquiredAt=${analysis.owner.acquiredAt})`
          : 'unknown owner';
        throw new Error(`Session registry write lock timed out; owner=${ownerSummary}; lockDir=${lockDir}`);
      }
      sleepSync(retryDelayMs);
    }
  }

  return {
    release(): void {
      if (released) return;
      released = true;
      cleanupSessionRegistryWriteLockOwner(ownerFilePath, lockDir);
    }
  };
}

export function createSessionRegistry(input: CreateSessionRegistryInput = {}) {
  const registryPath = input.registryPath ?? DEFAULT_SESSION_REGISTRY_PATH;
  let state = loadStateFromDisk(registryPath, input.warn);

  function refreshStateFromDisk(): SessionRegistryState {
    state = loadStateFromDisk(registryPath);
    return state;
  }

  function mutateStateAtomically<T>(
    mutate: (current: SessionRegistryState) => SessionRegistryMutationResult<T>
  ): T {
    const lock = acquireSessionRegistryWriteLock(registryPath);
    try {
      const current = loadStateFromDisk(registryPath, input.warn);
      const outcome = mutate(current);
      if (outcome.changed) {
        writeStateToDisk(registryPath, outcome.nextState);
      }
      state = cloneState(outcome.nextState);
      return outcome.result;
    } finally {
      lock.release();
    }
  }

  return {
    load(): SessionRegistryState {
      return cloneState(refreshStateFromDisk());
    },

    getLastActiveFeishuThreadId(): string | undefined {
      return refreshStateFromDisk().lastActiveFeishuThreadId;
    },

    setLastActiveFeishuThreadId(feishuThreadId: string): void {
      mutateStateAtomically((current) => {
        const normalized = normalizeLastActiveFeishuThreadId(feishuThreadId);
        if (current.lastActiveFeishuThreadId === normalized) {
          return { nextState: current, result: undefined, changed: false };
        }
        return {
          nextState: {
            ...current,
            lastActiveFeishuThreadId: normalized
          },
          result: undefined,
          changed: true
        };
      });
    },

    getLastActiveFeishuUserOpenId(): string | undefined {
      return refreshStateFromDisk().lastActiveFeishuUserOpenId;
    },

    setLastActiveFeishuUserOpenId(openId: string): void {
      mutateStateAtomically((current) => {
        const normalized = normalizeLastActiveFeishuUserOpenId(openId);
        if (current.lastActiveFeishuUserOpenId === normalized) {
          return { nextState: current, result: undefined, changed: false };
        }
        return {
          nextState: {
            ...current,
            lastActiveFeishuUserOpenId: normalized
          },
          result: undefined,
          changed: true
        };
      });
    },

    getRecentProjectDirs(): string[] {
      return [...refreshStateFromDisk().recentProjectDirs];
    },

    replaceRecentProjectDirs(dirs: string[]): string[] {
      return mutateStateAtomically((current) => {
        const recentProjectDirs = normalizeRecentProjectDirs(dirs);
        const unchanged =
          recentProjectDirs.length === current.recentProjectDirs.length &&
          recentProjectDirs.every((value, index) => value === current.recentProjectDirs[index]);
        if (unchanged) {
          return {
            nextState: current,
            result: [...recentProjectDirs],
            changed: false
          };
        }
        return {
          nextState: {
            ...current,
            recentProjectDirs
          },
          result: [...recentProjectDirs],
          changed: true
        };
      });
    },

    recomputeNextTaskId(): number {
      return mutateStateAtomically((current) => {
        const nextTaskId = deriveNextTaskIdFromSessions(current.sessions);
        if (current.nextTaskId === nextTaskId) {
          return {
            nextState: current,
            result: nextTaskId,
            changed: false
          };
        }
        return {
          nextState: {
            ...current,
            nextTaskId
          },
          result: nextTaskId,
          changed: true
        };
      });
    },

    reserveNextTaskId(): CommunicateTaskId {
      return mutateStateAtomically((current) => {
        const taskId = `T${current.nextTaskId}` as CommunicateTaskId;
        return {
          nextState: {
            ...current,
            nextTaskId: current.nextTaskId + 1
          },
          result: taskId,
          changed: true
        };
      });
    },

    upsertSessionRecord(record: SessionRegistryRecordPatch): SessionRegistryRecord {
      return mutateStateAtomically((current) => {
        const existing = current.sessions[record.taskId];
        const nextRecord: SessionRegistryRecord = {
          ...(existing ?? { taskId: record.taskId }),
          ...record,
          taskId: record.taskId,
          runtimeWarnings: Object.prototype.hasOwnProperty.call(record, 'runtimeWarnings')
            ? cloneCommunicateRuntimeWarnings(record.runtimeWarnings)
            : cloneCommunicateRuntimeWarnings(existing?.runtimeWarnings)
        };
        return {
          nextState: {
            ...current,
            sessions: {
              ...current.sessions,
              [record.taskId]: nextRecord
            }
          },
          result: cloneRecord(nextRecord),
          changed: true
        };
      });
    },

    markClosed(taskId: CommunicateTaskId, patch: Partial<SessionRegistryRecord> = {}): SessionRegistryRecord | undefined {
      return mutateStateAtomically((current) => {
        const existing = current.sessions[taskId];
        if (!existing) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        const updated: SessionRegistryRecord = {
          ...existing,
          ...patch,
          taskId,
          sessionLifecycle: 'CLOSED',
          runtimeWarnings: Object.prototype.hasOwnProperty.call(patch, 'runtimeWarnings')
            ? cloneCommunicateRuntimeWarnings(patch.runtimeWarnings)
            : cloneCommunicateRuntimeWarnings(existing.runtimeWarnings)
        };
        return {
          nextState: {
            ...current,
            sessions: {
              ...current.sessions,
              [taskId]: updated
            }
          },
          result: cloneRecord(updated),
          changed: true
        };
      });
    },

    getSessionRecord(taskId: CommunicateTaskId): SessionRegistryRecord | undefined {
      const record = refreshStateFromDisk().sessions[taskId];
      return record ? cloneRecord(record) : undefined;
    },

    listSessionRecords(): SessionRegistryRecord[] {
      return Object.values(refreshStateFromDisk().sessions)
        .sort((left, right) => Number.parseInt(left.taskId.slice(1), 10) - Number.parseInt(right.taskId.slice(1), 10))
        .map((record) => cloneRecord(record));
    },

    deleteSessionRecord(taskId: CommunicateTaskId): SessionRegistryRecord | undefined {
      return mutateStateAtomically((current) => {
        const existing = current.sessions[taskId];
        if (!existing) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        const nextSessions = { ...current.sessions };
        delete nextSessions[taskId];
        return {
          nextState: {
            ...current,
            sessions: nextSessions
          },
          result: cloneRecord(existing),
          changed: true
        };
      });
    },

    upsertThreadBinding(record: SessionThreadBindingRecord): SessionThreadBindingRecord {
      return mutateStateAtomically((current) => {
        const nextRecord: SessionThreadBindingRecord = {
          feishuThreadId: record.feishuThreadId,
          assistantTaskId: record.assistantTaskId
        };
        return {
          nextState: {
            ...current,
            threadBindings: {
              ...current.threadBindings,
              [record.feishuThreadId]: nextRecord
            }
          },
          result: cloneThreadBinding(nextRecord),
          changed: true
        };
      });
    },

    getThreadBinding(feishuThreadId: string): SessionThreadBindingRecord | undefined {
      const record = refreshStateFromDisk().threadBindings[feishuThreadId];
      return record ? cloneThreadBinding(record) : undefined;
    },

    upsertThreadUiState(record: SessionThreadUiStateRecord): SessionThreadUiStateRecord {
      return mutateStateAtomically((current) => {
        const nextRecord: SessionThreadUiStateRecord = {
          ...(current.threadUiStates[record.feishuThreadId] ?? { feishuThreadId: record.feishuThreadId }),
          ...record,
          feishuThreadId: record.feishuThreadId
        };
        return {
          nextState: {
            ...current,
            threadUiStates: {
              ...current.threadUiStates,
              [record.feishuThreadId]: nextRecord
            }
          },
          result: cloneThreadUiState(nextRecord),
          changed: true
        };
      });
    },

    getThreadUiState(feishuThreadId: string): SessionThreadUiStateRecord | undefined {
      const record = refreshStateFromDisk().threadUiStates[feishuThreadId];
      return record ? cloneThreadUiState(record) : undefined;
    },

    clearThreadUiState(feishuThreadId: string): void {
      mutateStateAtomically((current) => {
        if (!(feishuThreadId in current.threadUiStates)) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        const threadUiStates = { ...current.threadUiStates };
        delete threadUiStates[feishuThreadId];
        return {
          nextState: {
            ...current,
            threadUiStates
          },
          result: undefined,
          changed: true
        };
      });
    },

    getInboundMessages(): Record<string, number> {
      return { ...refreshStateFromDisk().inboundMessages };
    },

    markInboundMessage(messageId: string, seenAt: number): void {
      mutateStateAtomically((current) => {
        const trimmed = messageId.trim();
        const normalizedSeenAt = normalizeInboundMessageSeenAt(seenAt);
        if (!trimmed || normalizedSeenAt === undefined) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        if (current.inboundMessages[trimmed] === normalizedSeenAt) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        return {
          nextState: {
            ...current,
            inboundMessages: {
              ...current.inboundMessages,
              [trimmed]: normalizedSeenAt
            }
          },
          result: undefined,
          changed: true
        };
      });
    },

    pruneInboundMessages(cutoffMs: number): void {
      mutateStateAtomically((current) => {
        const normalizedCutoff = normalizeInboundMessageSeenAt(cutoffMs);
        if (normalizedCutoff === undefined) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        const inboundMessages = Object.fromEntries(
          Object.entries(current.inboundMessages).filter(([, seenAt]) => seenAt >= normalizedCutoff)
        );
        if (Object.keys(inboundMessages).length === Object.keys(current.inboundMessages).length) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        return {
          nextState: {
            ...current,
            inboundMessages
          },
          result: undefined,
          changed: true
        };
      });
    },

    clearThreadBinding(feishuThreadId: string): void {
      mutateStateAtomically((current) => {
        if (!(feishuThreadId in current.threadBindings)) {
          return {
            nextState: current,
            result: undefined,
            changed: false
          };
        }
        const threadBindings = { ...current.threadBindings };
        delete threadBindings[feishuThreadId];
        return {
          nextState: {
            ...current,
            threadBindings
          },
          result: undefined,
          changed: true
        };
      });
    }
  };
}

function loadStateFromDisk(
  registryPath: string,
  warn?: (message: string, error?: unknown) => void
): SessionRegistryState {
  try {
    const content = readFileSync(registryPath, 'utf8');
    return normalizeState(JSON.parse(content));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warn?.(`Failed to load session registry from ${registryPath}, starting with an empty registry.`, error);
    }
    return createEmptyState();
  }
}
