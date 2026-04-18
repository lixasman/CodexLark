import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createSessionLog, type SessionLogWriter } from '../../logging/session-log';
import { buildSessionLogWindowLauncherArgs, createSessionLogWindow, type SessionLogWindow } from '../../logging/session-log-window';
import {
  normalizeTaskInterruptionKind,
  type CommunicateTaskInterruptionKind
} from '../../protocol/task-events';
import {
  cloneCommunicateRuntimeWarnings,
  mergeCommunicateRuntimeWarnings,
  normalizeCommunicateTaskModel
} from '../../protocol/task-types';
import { detectWaitState } from './output-parser';
import { prepareCodexSpawnCommand } from './spawn-command';
import { startSocketTapProxy, type SocketTapProxyHandle } from './socket-tap-proxy';
import {
  createKnownBadCodexVersionWarning,
  formatKnownBadCodexVersionFailureReason,
  getKnownBadCodexVersionPolicy
} from './version-policy';
import {
  type CodexReplyPayload,
  type CodexSessionCloseResult,
  type CodexSessionInterruptResult,
  type CodexSessionPersonaConfig,
  type CodexSessionResumeContext,
  type CodexSessionSnapshot,
  type CodexSessionStallDiagnosticInput,
  type CodexSpawnFactory,
  type CodexWorkerEvent,
  type SpawnedCodexChild
} from './types';
import { type CommunicateWaitKind } from '../../protocol/wait-kinds';

type RpcId = string | number;

type CodexAppWebSocketLike = {
  binaryType?: BinaryType;
  readyState: number;
  bufferedAmount?: number;
  addEventListener: (type: string, listener: (event: any) => void) => void;
  removeEventListener?: (type: string, listener: (event: any) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

type ServerRequestState =
  | {
      id: RpcId;
      kind: 'approval';
      requestType: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
      params: Record<string, unknown>;
    }
  | {
      id: RpcId;
      kind: 'user_input';
      params: {
        questions?: Array<{
          id?: string;
          header?: string;
          question?: string;
          options?: Array<{ label?: string; description?: string }> | null;
        }>;
      };
    };

type AssistantDeltaSource = 'item' | 'content' | 'legacy';

type AssistantDeltaEvent = {
  source: AssistantDeltaSource;
  turnId: string | null;
  itemId: string | null;
  delta: string;
};

type AssistantDeltaWindow = AssistantDeltaEvent & {
  seenAtMs: number;
  seenSources: Set<AssistantDeltaSource>;
};

type FailureClassificationInput = {
  localComm?: boolean;
  upstreamExecution?: boolean;
  versionIncompatible?: boolean;
  capabilityMissing?: boolean;
};

type StartupChildExitDiagnostics = {
  code: number | null;
  summary: string;
  afterMs: number | null;
};

type StartupFailureDiagnostics = {
  attempts: number;
  maxAttempts: number;
  childPid: number | null;
  lastSocketError: string | null;
  childExit: StartupChildExitDiagnostics | null;
  childError: string | null;
  elapsedMs: number | null;
  compatibility: CodexAppServerCompatibilityReport | null;
};

type StartupFailurePhase = 'websocket/open' | 'initialize' | 'thread/start' | 'thread/resume';

type CompatibilityFailureKind = 'version_incompatible' | 'capability_missing';

type AppServerCapabilityName =
  | 'initialize'
  | 'thread/start'
  | 'thread/resume'
  | 'turn/start'
  | 'turn/started'
  | 'item/tool/requestUserInput'
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval';

type CodexAppServerCompatibilityReport = {
  compatible: boolean;
  initializeHasUserAgent: boolean;
  startupMethod: 'thread/start' | 'thread/resume' | null;
  startupMethodHasThreadId: boolean;
  startupMethodHasCliVersion: boolean;
  userAgent: string | null;
  version: string | null;
  versionSource: 'thread.cliVersion' | 'userAgent' | null;
  threadCliVersion: string | null;
  requiredMinVersion: string;
  observedCapabilities: AppServerCapabilityName[];
  versionGatedCapabilities: AppServerCapabilityName[];
  missingCapabilities: AppServerCapabilityName[];
  missingMetadata: string[];
  versionWarnings: string[];
  failureKind: CompatibilityFailureKind | null;
  failureReason: string | null;
  suggestedAction: string;
};

type ParsedVersionToken = {
  raw: string;
  release: number[];
  prerelease: Array<number | string> | null;
  prereleaseRaw: string | null;
};

class CodexAppServerCompatibilityError extends Error {
  readonly kind: CompatibilityFailureKind;
  readonly report: CodexAppServerCompatibilityReport;

  constructor(kind: CompatibilityFailureKind, summary: string, report: CodexAppServerCompatibilityReport) {
    super(summary);
    this.name = 'CodexAppServerCompatibilityError';
    this.kind = kind;
    this.report = report;
  }
}
class CodexRpcResponseError extends Error {
  readonly code: number | string | null;
  readonly data: unknown;
  readonly method: string | null;

  constructor(message: string, input?: { code?: number | string | null; data?: unknown; method?: string | null }) {
    super(message);
    this.name = 'CodexRpcResponseError';
    this.code = input?.code ?? null;
    this.data = input?.data;
    this.method = input?.method ?? null;
  }
}

type SystemErrorReconcileReadState = {
  turnId: string | null;
  statusType: string;
  turnStatus: string;
  errorText: string;
  finalText: string;
  lastText: string;
  output: string;
};

type TerminalNotificationObservation = {
  rawMethod: string;
  turnId: string | null;
  status: string;
  errorText: string | null;
  socketGenerationAtReceive: number;
  activeTurnId: string | null;
  pendingRpcCount: number;
  recoveryInFlight: boolean;
  observedAt: string;
  observedAtMs: number;
};

type TerminalNotificationObservationStore = {
  byTurnId: Map<string, TerminalNotificationObservation>;
  nullTurnObservation: TerminalNotificationObservation | null;
  maxEntries: number;
};

type TurnStartRequestSource =
  | 'user_reply'
  | 'concurrent_user_reply'
  | 'bootstrap_reply'
  | 'system_error_auto_continue';

type TurnInterruptSource = 'manual_interrupt' | 'close';

type CleanupTransportSource = 'close' | 'fail';

type PendingRpcEntry = {
  requestId: RpcId;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
  startedAtMs: number;
  threadIdAtSend: string | null;
  turnIdAtSend: string | null;
  turnRequestSerialAtSend: number;
  socketGenerationAtSend: number;
  diagReqKey: string;
  payloadBytes: number;
  diagnosticTimer?: ReturnType<typeof setTimeout> | null;
  longPendingLogged?: boolean;
};

const INTERESTING_IGNORED_SOCKET_METHODS = new Set<string>([
  'item/completed',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'codex/event/task_complete',
  'turn/completed',
  'turn_aborted',
  'turn/aborted'
]);

const BLOCKED_APP_SERVER_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

const MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION = '0.111.0';
const VERSION_GATED_APP_SERVER_CAPABILITIES: AppServerCapabilityName[] = [
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/started',
  'item/tool/requestUserInput',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval'
];

function createTerminalNotificationObservationStore(maxEntries = 32): TerminalNotificationObservationStore {
  return {
    byTurnId: new Map<string, TerminalNotificationObservation>(),
    nullTurnObservation: null,
    maxEntries: Math.max(1, Math.floor(maxEntries))
  };
}

function recordTerminalNotificationObservation(
  store: TerminalNotificationObservationStore,
  observation: TerminalNotificationObservation
): void {
  if (observation.turnId == null) {
    store.nullTurnObservation = observation;
    return;
  }
  store.byTurnId.set(observation.turnId, observation);
  while (store.byTurnId.size > store.maxEntries) {
    const oldestTurnId = store.byTurnId.keys().next().value;
    if (typeof oldestTurnId !== 'string') break;
    store.byTurnId.delete(oldestTurnId);
  }
}

function getRelevantTerminalNotificationObservationFromStore(
  store: TerminalNotificationObservationStore,
  turnId: string | null
): TerminalNotificationObservation | null {
  if (turnId == null) {
    return store.nullTurnObservation;
  }
  return store.byTurnId.get(turnId) ?? null;
}

function shouldLogInterruptedDiscoveredViaThreadReadOnlyFromStore(
  store: TerminalNotificationObservationStore,
  turnId: string | null
): boolean {
  return getRelevantTerminalNotificationObservationFromStore(store, turnId) == null;
}

export const __testOnlyCodexAppSession = {
  createTerminalNotificationObservationStore,
  recordTerminalNotificationObservation,
  getRelevantTerminalNotificationObservation: getRelevantTerminalNotificationObservationFromStore,
  shouldLogInterruptedDiscoveredViaThreadReadOnly: shouldLogInterruptedDiscoveredViaThreadReadOnlyFromStore
};

function isTcpProxyDiagEnabled(): boolean {
  return process.env.COMMUNICATE_CODEX_TCP_PROXY_DIAG === '1';
}

export function createCodexAppSession(input: {
  taskId: string;
  cwd: string;
  command: string[];
  mode?: 'new' | 'resume';
  resumeThreadId?: string;
  resumeContext?: CodexSessionResumeContext;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string;
  ephemeral?: boolean;
  allowKnownBadCodexVersion?: boolean;
  interruptedByRestart?: boolean;
  spawnFactory?: CodexSpawnFactory;
  createWebSocket?: (url: string) => CodexAppWebSocketLike;
  allocatePort?: () => Promise<number>;
  socketOpenTimeoutMs?: number;
  socketRetryDelayMs?: number;
  socketRetryLimit?: number;
  onEvent?: (event: CodexWorkerEvent) => void | Promise<void>;
  enableLogWindow?: boolean;
  logRootDir?: string;
  closeTimeoutMs?: number;
  createLog?: (options: { taskId: `T${number}` | string; cwd: string; rootDir?: string }) => SessionLogWriter;
  openLogWindow?: (options: { taskId: string; cwd: string; logPath: string }) => SessionLogWindow;
  threadReadPollDelayMs?: number;
  rpcLongPendingThresholdMs?: number;
  systemErrorReconcileDelayMs?: number;
  systemErrorReconcileRetryDelayMs?: number;
  systemErrorReconcileMaxAttempts?: number;
  systemErrorAutoContinueTimeoutMs?: number;
  killProcessTree?: (pid: number) => void;
} & CodexSessionPersonaConfig) {
  const allowKnownBadCodexVersion = input.allowKnownBadCodexVersion === true;
  let child: SpawnedCodexChild | null = null;
  let socket: CodexAppWebSocketLike | null = null;
  let startPromise: Promise<void> | null = null;
  let rpcId = 1;
  let threadId: string | null = null;
  let activeTurnId: string | null = null;
  let pendingRequest: ServerRequestState | null = null;
  let queuedBootstrapReply: CodexReplyPayload | null = null;
  let shuttingDown = false;
  let processLogBuffer = '';
  let startupInFlight = false;
  let startupStartedAtMs = 0;
  let startupSocketAttempts = 0;
  let startupSocketMaxAttempts = 0;
  let startupLastSocketError: string | null = null;
  let startupChildPid: number | null = null;
  let startupChildExit: StartupChildExitDiagnostics | null = null;
  let startupChildError: string | null = null;
  let appServerCompatibility: CodexAppServerCompatibilityReport | null = null;
  let initializeResultForCompatibility: unknown = null;
  let turnStartPending = false;
  const seenUnhandledMethods = new Set<string>();
  const threadReadPollDelayMs = input.threadReadPollDelayMs ?? 2_500;
  const rpcLongPendingThresholdMs = input.rpcLongPendingThresholdMs ?? 10_000;
  const systemErrorReconcileDelayMs = Math.max(0, input.systemErrorReconcileDelayMs ?? 400);
  const systemErrorReconcileRetryDelayMs = Math.max(0, input.systemErrorReconcileRetryDelayMs ?? 200);
  const systemErrorReconcileMaxAttempts = Math.max(1, input.systemErrorReconcileMaxAttempts ?? 3);
  const systemErrorAutoContinueTimeoutMs = Math.max(1, input.systemErrorAutoContinueTimeoutMs ?? 60_000);
  const diagWsRawEnabled = readTruthyEnvFlag('COMMUNICATE_DIAG_WS_RAW');
  const diagThreadReadIncludeTurns = !readTruthyEnvFlag('COMMUNICATE_DIAG_THREAD_READ_NO_TURNS');
  const diagSkipOutputDeltaRawLog = readTruthyEnvFlag('COMMUNICATE_DIAG_SKIP_OUTPUT_DELTA_RAW_LOG');
  let threadReadPollTimer: ReturnType<typeof setTimeout> | null = null;
  let systemErrorReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let systemErrorAutoContinueTimer: ReturnType<typeof setTimeout> | null = null;
  let systemErrorReconcileInFlight = false;
  let systemErrorReconcileGeneration = 0;
  let systemErrorAutoContinueAttempted = false;
  let systemErrorAutoContinueRecovered = false;
  let systemErrorAutoContinueSourceTurnId: string | null = null;
  let systemErrorAutoContinueStartedAtMs = 0;
  let systemErrorAutoContinueSeedOutput = '';
  let socketUrl: string | null = null;
  let transportProxy: SocketTapProxyHandle | null = null;
  let socketRecoveryInFlight = false;
  let nextSocketGeneration = 1;
  let activeSocketGeneration = 0;
  const socketGenerationBySocket = new WeakMap<object, number>();
  let lastAssistantDeltaWindow: AssistantDeltaWindow | null = null;
  let lastFinishedTurnId: string | null = null;
  let currentTurnRequestSerial = 0;
  let activeTurnRequestSerial = 0;
  let lastSocketInboundAtMs = 0;
  let lastSocketInboundAt: string | null = null;
  let lastSocketInboundKind: string | null = null;
  let lastSocketInboundMethod: string | null = null;
  let lastSocketInboundId: string | number | null = null;
  let lastSocketOutboundAtMs = 0;
  let lastSocketOutboundAt: string | null = null;
  let lastSocketOutboundMethod: string | null = null;
  let lastSocketOutboundId: string | number | null = null;
  let lastRpcSettleAtMs = 0;
  let lastRpcSettleAt: string | null = null;
  let lastRpcSettleMethod: string | null = null;
  let lastRpcSettleOutcome: 'resolve' | 'reject' | null = null;
  let lastOrphanResponseAtMs = 0;
  let lastOrphanResponseAt: string | null = null;
  let lastOrphanResponseId: string | number | null = null;
  let lastChildOutputAtMs = 0;
  let lastChildOutputAt: string | null = null;
  let lastChildOutputSource: 'stdout' | 'stderr' | null = null;
  let lastChildExitAtMs = 0;
  let lastChildExitAt: string | null = null;
  let lastChildExitCode: number | null = null;
  const terminalNotificationObservationStore = createTerminalNotificationObservationStore();
  const completedTurnIds = new Set<string>();
  const retiredTurnIds = new Set<string>();
  const expectedInterruptedTurnIds = new Set<string>();
  let approvalDeniedPendingFailure = false;
  const startupMode = input.mode ?? 'new';
  const approvalPolicy = input.approvalPolicy ?? 'on-request';
  const sandbox = input.sandbox ?? 'danger-full-access';
  const initialModel = normalizeCommunicateTaskModel(input.model);
  const assistantPersonaParams = {
    ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
    ...(input.baseInstructions ? { baseInstructions: input.baseInstructions } : {}),
    ...(input.personality ? { personality: input.personality } : {})
  };
  const assistantDeltaDedupWindowMs = 250;
  const sessionInstanceId = `${String(input.taskId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const log = (input.createLog ?? createSessionLog)({
    taskId: input.taskId as `T${number}`,
    cwd: input.cwd,
    rootDir: input.logRootDir
  });
  let logWindow: SessionLogWindow | null = null;
  if (resolveLogWindowEnabled(input.enableLogWindow)) {
    try {
      logWindow = (input.openLogWindow ?? createSessionLogWindow)({
        taskId: input.taskId,
        cwd: input.cwd,
        logPath: log.path
      });
    } catch (error) {
      log.appendEvent('WINDOW_START_FAILED', formatSpawnError(error, { command: 'powershell.exe', args: buildSessionLogWindowLauncherArgs({ taskId: input.taskId, cwd: input.cwd, logPath: log.path }), cwd: input.cwd, shell: false }));
    }
  }

  const pendingRpc = new Map<string, PendingRpcEntry>();

  let snapshot: CodexSessionSnapshot = {
    taskId: input.taskId,
    cwd: input.cwd,
    lifecycle: 'STARTING',
    liveBuffer: '',
    sessionInstanceId,
    logPath: log.path,
    codexThreadId: input.resumeThreadId,
    model: initialModel,
    windowPid: logWindow?.pid,
    interruptedByRestart: input.interruptedByRestart
  };

  log.appendEvent('SESSION OPEN', {
    taskId: input.taskId,
    cwd: input.cwd,
    windowPid: logWindow?.pid ?? null
  });
  log.appendEvent('BUILD_FINGERPRINT', buildRuntimeArtifactFingerprint());
  if (startupMode === 'resume') {
    log.appendEvent('SESSION_RESUME_CONTEXT', {
      resumeThreadId: input.resumeThreadId ?? null,
      interruptedByRestart: Boolean(input.interruptedByRestart),
      ...summarizeResumeContext(input.resumeContext)
    });
  }

  const spawnFactory: CodexSpawnFactory = input.spawnFactory ?? ((command, args, options) => {
    const spawned = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell
    });
    return spawned as unknown as SpawnedCodexChild;
  });

  const createWebSocket = input.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as CodexAppWebSocketLike);
  const allocatePort = input.allocatePort ?? defaultAllocatePort;
  const socketOpenTimeoutMs = input.socketOpenTimeoutMs ?? 2000;
  const socketRetryDelayMs = input.socketRetryDelayMs ?? 100;
  const socketRetryLimit = input.socketRetryLimit ?? 50;
  const closeTimeoutMs = input.closeTimeoutMs ?? 1_500;
  const killProcessTree = input.killProcessTree ?? defaultKillProcessTree;

  function emit(event: CodexWorkerEvent): void {
    void input.onEvent?.(event);
  }

  async function allocateStartupPort(maxAttempts = 25): Promise<number> {
    const skippedPorts: number[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const port = await allocatePort();
      if (!isBlockedAppServerPort(port)) {
        if (skippedPorts.length > 0) {
          log.appendEvent('STARTUP_PORT_SKIPPED', {
            skippedPorts,
            selectedPort: port,
            reason: 'blocked_bad_port'
          });
        }
        return port;
      }
      skippedPorts.push(port);
    }
    throw new Error('Failed to allocate a safe Codex app-server port after ' + maxAttempts + ' attempts.');
  }

  function appendProcessLog(chunk: Buffer | string, source: 'stdout' | 'stderr' = 'stdout'): void {
    processLogBuffer += String(chunk);
    const nowMs = Date.now();
    lastChildOutputAtMs = nowMs;
    lastChildOutputAt = new Date(nowMs).toISOString();
    lastChildOutputSource = source;
  }

  function beginStartupDiagnostics(maxAttempts: number): void {
    startupInFlight = true;
    startupStartedAtMs = Date.now();
    startupSocketAttempts = 0;
    startupSocketMaxAttempts = maxAttempts;
    startupLastSocketError = null;
    startupChildPid = null;
    startupChildExit = null;
    startupChildError = null;
    appServerCompatibility = null;
    initializeResultForCompatibility = null;
  }

  function completeStartupDiagnostics(): void {
    startupInFlight = false;
  }

  function noteStartupSocketFailure(attempt: number, error: unknown): void {
    startupSocketAttempts = Math.max(startupSocketAttempts, attempt);
    startupLastSocketError = describeStartupUnknownError(error);
  }

  function noteStartupChildSpawned(pid: number | undefined): void {
    startupChildPid = typeof pid === 'number' && Number.isFinite(pid) ? pid : null;
  }

  function noteStartupChildExit(code: number | null, summary: string): void {
    if (!startupInFlight) return;
    const afterMs = startupStartedAtMs > 0 ? Math.max(0, Date.now() - startupStartedAtMs) : null;
    startupChildExit = {
      code,
      summary,
      afterMs
    };
  }

  function buildStartupFailureDiagnostics(): StartupFailureDiagnostics {
    const elapsedMs = startupStartedAtMs > 0 ? Math.max(0, Date.now() - startupStartedAtMs) : null;
    return {
      attempts: startupSocketAttempts,
      maxAttempts: startupSocketMaxAttempts,
      childPid: startupChildPid,
      lastSocketError: startupLastSocketError,
      childExit: startupChildExit,
      childError: startupChildError,
      elapsedMs,
      compatibility: appServerCompatibility
    };
  }

  function failStartup(
    error: unknown,
    listenUrl: string,
    phase: StartupFailurePhase,
    evidence?: FailureClassificationInput
  ): void {
    const diagnostics = buildStartupFailureDiagnostics();
    log.appendEvent('STARTUP_FAILURE', {
      phase,
      listenUrl,
      error: describeStartupUnknownError(error),
      ...diagnostics
    });
    completeStartupDiagnostics();
    fail(wrapStartupError(error, { listenUrl, phase, diagnostics }), evidence);
  }

  function hasRunningTurn(): boolean {
    return Boolean(activeTurnId || turnStartPending || snapshot.lifecycle === 'RUNNING_TURN');
  }

  function cancelSystemErrorAutoContinueTimer(): void {
    if (!systemErrorAutoContinueTimer) return;
    clearTimeout(systemErrorAutoContinueTimer);
    systemErrorAutoContinueTimer = null;
  }

  function clearSystemErrorAutoContinueState(options?: { keepAttempted?: boolean; keepSeedOutput?: boolean }): void {
    cancelSystemErrorAutoContinueTimer();
    if (!options?.keepAttempted) {
      systemErrorAutoContinueAttempted = false;
    }
    systemErrorAutoContinueRecovered = false;
    systemErrorAutoContinueSourceTurnId = null;
    systemErrorAutoContinueStartedAtMs = 0;
    if (!options?.keepSeedOutput) {
      systemErrorAutoContinueSeedOutput = '';
    }
  }

  function clearActiveTurnTracking(options?: { preserveFailureSeed?: boolean }): void {
    cancelSystemErrorReconcile();
    clearSystemErrorAutoContinueState({
      keepSeedOutput: options?.preserveFailureSeed
    });
    activeTurnId = null;
    turnStartPending = false;
    activeTurnRequestSerial = 0;
  }

  function beginTurnTracking(): number {
    currentTurnRequestSerial += 1;
    activeTurnRequestSerial = currentTurnRequestSerial;
    return activeTurnRequestSerial;
  }

  function isSessionInactiveForAsyncWork(): boolean {
    return shuttingDown || snapshot.lifecycle === 'FAILED' || snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'CLOSING';
  }

  function cancelThreadReadPoll(): void {
    if (!threadReadPollTimer) return;
    clearTimeout(threadReadPollTimer);
    threadReadPollTimer = null;
  }

  function cancelSystemErrorReconcile(): void {
    systemErrorReconcileGeneration += 1;
    systemErrorReconcileInFlight = false;
    if (!systemErrorReconcileTimer) return;
    clearTimeout(systemErrorReconcileTimer);
    systemErrorReconcileTimer = null;
  }

  function buildCurrentTaskOutputSeed(): string {
    const currentOutput = snapshot.liveBuffer || snapshot.checkpointOutput || '';
    const seedOutput = systemErrorAutoContinueSeedOutput;
    if (!seedOutput) return currentOutput;
    const trimmedSeed = seedOutput.trim();
    const trimmedCurrent = currentOutput.trim();
    if (!trimmedSeed) return currentOutput;
    if (!trimmedCurrent) return seedOutput;
    if (trimmedCurrent.startsWith(trimmedSeed)) return currentOutput;
    if (trimmedSeed.startsWith(trimmedCurrent)) return seedOutput;
    return mergeOutput(seedOutput, currentOutput);
  }

  function buildFailureMessage(error: unknown): string {
    const currentOutput = snapshot.liveBuffer || snapshot.checkpointOutput || '';
    const seedOutput = systemErrorAutoContinueSeedOutput;
    const errorText = error instanceof CodexAppServerCompatibilityError ? formatCompatibilityErrorMessage(error) : String(error);
    const trimmedSeed = seedOutput.trim();
    const trimmedCurrent = currentOutput.trim();
    const trimmedError = errorText.trim();
    const parts: string[] = [];
    if (trimmedSeed && !trimmedError.startsWith(trimmedSeed)) {
      parts.push(seedOutput);
    }
    if (trimmedCurrent && !trimmedError.startsWith(trimmedCurrent) && (!trimmedSeed || trimmedCurrent !== trimmedSeed)) {
      parts.push(currentOutput);
    }
    parts.push(processLogBuffer, errorText);
    return parts.filter(Boolean).join('\n');
  }

  function markSystemErrorAutoContinueRecovered(turnId: string | null, source: string): void {
    if (!systemErrorAutoContinueAttempted || systemErrorAutoContinueRecovered || !turnId) return;
    const sourceTurnId = systemErrorAutoContinueSourceTurnId;
    if (sourceTurnId && turnId === sourceTurnId) return;
    systemErrorAutoContinueRecovered = true;
    cancelSystemErrorAutoContinueTimer();
    log.appendEvent('SYSTEM_ERROR_AUTO_CONTINUE_RECOVERED', {
      source,
      sourceTurnId,
      rescueTurnId: turnId,
      elapsedMs: ageFromMs(systemErrorAutoContinueStartedAtMs),
      seedOutputLength: systemErrorAutoContinueSeedOutput.length
    });
  }

  function maybeAdoptAutoContinueTurnFromThreadRead(turnId: string | null, source: string): void {
    if (!turnId || !systemErrorAutoContinueAttempted || systemErrorAutoContinueRecovered) return;
    const sourceTurnId = systemErrorAutoContinueSourceTurnId;
    if (sourceTurnId && turnId === sourceTurnId) return;
    activeTurnId = turnId;
    turnStartPending = false;
    markSystemErrorAutoContinueRecovered(turnId, source);
  }

  function attemptSystemErrorAutoContinue(source: string, state: SystemErrorReconcileReadState): boolean {
    if (!threadId || !hasRunningTurn()) return false;
    if (systemErrorAutoContinueAttempted) {
      log.appendEvent('SYSTEM_ERROR_AUTO_CONTINUE_SKIPPED', {
        source,
        reason: 'already_attempted',
        sourceTurnId: systemErrorAutoContinueSourceTurnId,
        activeTurnId
      });
      return false;
    }
    if (turnStartPending && !activeTurnId) {
      log.appendEvent('SYSTEM_ERROR_AUTO_CONTINUE_SKIPPED', {
        source,
        reason: 'source_turn_not_adopted',
        observedTurnId: state.turnId,
        activeTurnId
      });
      return false;
    }
    const sourceTurnId = state.turnId ?? activeTurnId;
    if (!sourceTurnId) {
      log.appendEvent('SYSTEM_ERROR_AUTO_CONTINUE_SKIPPED', {
        source,
        reason: 'missing_source_turn_id',
        activeTurnId
      });
      return false;
    }
    const seedOutput = state.output || snapshot.liveBuffer || snapshot.checkpointOutput || '';
    systemErrorAutoContinueAttempted = true;
    systemErrorAutoContinueRecovered = false;
    systemErrorAutoContinueSourceTurnId = sourceTurnId;
    systemErrorAutoContinueStartedAtMs = Date.now();
    systemErrorAutoContinueSeedOutput = seedOutput;
    rememberRetiredTurn(sourceTurnId);
    cancelSystemErrorAutoContinueTimer();
    systemErrorAutoContinueTimer = setTimeout(() => {
      systemErrorAutoContinueTimer = null;
      if (isSessionInactiveForAsyncWork() || !hasRunningTurn() || systemErrorAutoContinueRecovered) {
        return;
      }
      const detail = [
        'Codex 自动恢复已尝试补发“继续”，但在观察窗口内没有确认新的 rescue turn。',
        state.errorText ? `上游错误: ${state.errorText}` : '',
        `诊断: sourceTurnId=${sourceTurnId}, activeTurnId=${activeTurnId || 'unknown'}, timeoutMs=${systemErrorAutoContinueTimeoutMs}`
      ]
        .filter(Boolean)
        .join('\n');
      log.appendEvent('SYSTEM_ERROR_AUTO_CONTINUE_TIMEOUT', {
        source,
        sourceTurnId,
        activeTurnId,
        timeoutMs: systemErrorAutoContinueTimeoutMs,
        seedOutputLength: systemErrorAutoContinueSeedOutput.length
      });
      fail(mergeOutput(buildCurrentTaskOutputSeed(), detail), {
        upstreamExecution: true
      });
    }, systemErrorAutoContinueTimeoutMs);
    systemErrorAutoContinueTimer.unref?.();
    log.appendEvent('SYSTEM_ERROR_AUTO_CONTINUE_START', {
      source,
      sourceTurnId,
      errorText: state.errorText || null,
      statusType: state.statusType,
      turnStatus: state.turnStatus,
      seedOutputLength: seedOutput.length,
      timeoutMs: systemErrorAutoContinueTimeoutMs
    });
    startTurnFromReply(
      { action: 'input_text', text: '继续' },
      { allowConcurrent: true, logInput: false, source: 'system_error_auto_continue' }
    );
    return true;
  }

  function setThreadId(nextThreadId: string | null): void {
    threadId = nextThreadId;
    snapshot = {
      ...snapshot,
      codexThreadId: nextThreadId ?? undefined,
      logPath: log.path
    };
  }

  function setModel(nextModel: string | undefined): void {
    const normalized = normalizeCommunicateTaskModel(nextModel);
    if (!normalized) return;
    snapshot = {
      ...snapshot,
      model: normalized,
      logPath: log.path
    };
  }

  function recordAppServerCompatibility(report: CodexAppServerCompatibilityReport): void {
    appServerCompatibility = report;
    const warning = allowKnownBadCodexVersion ? createKnownBadCodexVersionWarning(report.version, true) : undefined;
    snapshot = {
      ...snapshot,
      runtimeWarnings: warning
        ? mergeCommunicateRuntimeWarnings(snapshot.runtimeWarnings, [warning])
        : snapshot.runtimeWarnings,
      logPath: log.path
    };
    log.appendEvent('APP_SERVER_COMPATIBILITY', {
      compatible: report.compatible,
      startupMethod: report.startupMethod,
      userAgent: report.userAgent,
      version: report.version,
      versionSource: report.versionSource,
      threadCliVersion: report.threadCliVersion,
      requiredMinVersion: report.requiredMinVersion,
      observedCapabilities: report.observedCapabilities,
      versionGatedCapabilities: report.versionGatedCapabilities,
      missingCapabilities: report.missingCapabilities,
      missingMetadata: report.missingMetadata,
      versionWarnings: report.versionWarnings,
      failureKind: report.failureKind,
      failureReason: report.failureReason,
      suggestedAction: report.suggestedAction
    });
  }

  function ensureInitializeCompatibility(result: unknown): void {
    const report = buildCodexAppServerCompatibilityReport({
      initializeResult: result,
      allowKnownBadCodexVersion
    });
    if (!report.initializeHasUserAgent) {
      recordAppServerCompatibility(report);
      throw createCodexAppServerCompatibilityError(report);
    }
    initializeResultForCompatibility = result;
    appServerCompatibility = report;
  }

  function ensureStartupCompatibility(result: unknown, startupMethod: 'thread/start' | 'thread/resume'): CodexAppServerCompatibilityReport {
    const report = buildCodexAppServerCompatibilityReport({
      initializeResult: initializeResultForCompatibility,
      startupMethod,
      startupResult: result,
      allowKnownBadCodexVersion
    });
    if (!report.compatible) {
      recordAppServerCompatibility(report);
      throw createCodexAppServerCompatibilityError(report);
    }
    recordAppServerCompatibility(report);
    return report;
  }

  function maybePromoteStartupRpcFailure(
    error: unknown,
    startupMethod: 'thread/start' | 'thread/resume'
  ): unknown {
    if (error instanceof CodexAppServerCompatibilityError || isLocalTransportError(error)) {
      return error;
    }
    const message = describeStartupUnknownError(error);
    const baseReport =
      appServerCompatibility ??
      buildCodexAppServerCompatibilityReport({
        initializeResult: initializeResultForCompatibility,
        allowKnownBadCodexVersion
      });
    const knownBadVersionPolicy = getKnownBadCodexVersionPolicy(baseReport.version);
    const versionCompare =
      baseReport.version != null ? compareVersionTokens(baseReport.version, MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION) : null;
    const failureKind: CompatibilityFailureKind | null =
      !allowKnownBadCodexVersion && knownBadVersionPolicy != null
        ? 'version_incompatible'
        : versionCompare != null && versionCompare < 0
        ? 'version_incompatible'
        : isRpcMethodNotFoundError(error, startupMethod)
          ? 'capability_missing'
        : looksLikeMissingRpcMethodError(message, startupMethod)
          ? 'capability_missing'
          : null;
    if (failureKind == null) {
      return error;
    }
    const report = buildStartupRpcFailureCompatibilityReport({
      baseReport,
      startupMethod,
      failureKind,
      errorMessage: message
    });
    recordAppServerCompatibility(report);
    return createCodexAppServerCompatibilityError(report);
  }

  function maybePromoteInitializeRpcFailure(error: unknown): unknown {
    if (error instanceof CodexAppServerCompatibilityError || isLocalTransportError(error)) {
      return error;
    }
    const message = describeStartupUnknownError(error);
    if (!isRpcMethodNotFoundError(error, 'initialize') && !looksLikeMissingRpcMethodError(message, 'initialize')) {
      return error;
    }
    const report = buildInitializeRpcFailureCompatibilityReport(message);
    recordAppServerCompatibility(report);
    return createCodexAppServerCompatibilityError(report);
  }

  function maybePromoteTurnStartRpcFailure(error: unknown): unknown {
    if (error instanceof CodexAppServerCompatibilityError || isLocalTransportError(error)) {
      return error;
    }
    const message = describeStartupUnknownError(error);
    if (!isRpcMethodNotFoundError(error, 'turn/start') && !looksLikeMissingRpcMethodError(message, 'turn/start')) {
      return error;
    }
    const baseReport =
      appServerCompatibility ??
      buildCodexAppServerCompatibilityReport({
        initializeResult: initializeResultForCompatibility,
        allowKnownBadCodexVersion
      });
    const report = buildRuntimeRpcFailureCompatibilityReport({
      baseReport,
      capability: 'turn/start',
      errorMessage: message
    });
    recordAppServerCompatibility(report);
    return createCodexAppServerCompatibilityError(report);
  }

  function resetAssistantDeltaDedup(): void {
    lastAssistantDeltaWindow = null;
  }

  function touchProgress(now = new Date().toISOString()): string {
    snapshot = {
      ...snapshot,
      lastProgressAt: now,
      logPath: log.path
    };
    return now;
  }

  function markCommandStarted(commandText?: string): string {
    const now = touchProgress();
    snapshot = {
      ...snapshot,
      activeCommand: true,
      activeCommandCommand: commandText ?? snapshot.activeCommandCommand,
      activeCommandStartedAt: snapshot.activeCommandStartedAt ?? now,
      lastCommandProgressAt: now,
      logPath: log.path
    };
    return now;
  }

  function markCommandProgress(): string {
    const now = touchProgress();
    snapshot = {
      ...snapshot,
      activeCommand: true,
      activeCommandStartedAt: snapshot.activeCommandStartedAt ?? now,
      lastCommandProgressAt: now,
      logPath: log.path
    };
    return now;
  }

  function clearActiveCommand(): void {
    if (!snapshot.activeCommand && !snapshot.activeCommandCommand && !snapshot.activeCommandStartedAt && !snapshot.lastCommandProgressAt) {
      return;
    }
    snapshot = {
      ...snapshot,
      activeCommand: false,
      activeCommandCommand: undefined,
      activeCommandStartedAt: undefined,
      lastCommandProgressAt: undefined,
      logPath: log.path
    };
  }

  function recordStallDiagnostic(input: CodexSessionStallDiagnosticInput): void {
    const quietMs =
      typeof input.quietMs === 'number' && Number.isFinite(input.quietMs) ? Math.max(0, Math.floor(input.quietMs)) : null;
    const diagnosticEntry = resolvePrimaryDiagnosticEntry();
    log.appendEvent('STALL_DIAGNOSTIC', {
      trigger: input.trigger,
      feishuThreadId: input.threadId ?? null,
      replyStatusCardMessageId: input.replyStatusCardMessageId ?? null,
      quietMs,
      quietMinutes: quietMs != null ? Math.floor(quietMs / 60_000) : null,
      stallConfirmations:
        typeof input.stallConfirmations === 'number' && Number.isFinite(input.stallConfirmations)
          ? Math.max(0, Math.floor(input.stallConfirmations))
          : null,
      lifecycle: snapshot.lifecycle,
      hasRunningTurn: hasRunningTurn(),
      turnStartPending,
      activeTurnId,
      codexThreadId: threadId,
      activeCommand: snapshot.activeCommand === true,
      activeCommandCommand: snapshot.activeCommandCommand ?? null,
      activeCommandStartedAt: snapshot.activeCommandStartedAt ?? null,
      lastCommandProgressAt: snapshot.lastCommandProgressAt ?? null,
      lastProgressAt: snapshot.lastProgressAt ?? null,
      waitKind: snapshot.waitKind ?? null,
      pendingRequestKind: pendingRequest?.kind ?? null,
      pendingRpcCount: pendingRpc.size,
      pendingMethods: listPendingRpcMethods(8),
      pendingRpcSummary: listPendingRpcSummary(8),
      currentTurnRequestSerial,
      activeTurnRequestSerial,
      threadReadInFlight: Boolean(getBlockingThreadReadEntry()),
      anyThreadReadPending: hasAnyThreadReadInFlight(),
      staleThreadReadPendingCount: countStaleThreadReadEntries(),
      threadReadTimerActive: Boolean(threadReadPollTimer),
      socketRecoveryInFlight,
      socketConnected: Boolean(socket && socket.readyState === 1),
      socketReadyState: socket?.readyState ?? null,
      socketUrl: socketUrl || null,
      diagnosticRequestMethod: diagnosticEntry?.method ?? null,
      diagnosticRequestId: diagnosticEntry?.requestId ?? null,
      diagnosticHint: diagnosticEntry ? resolveLongPendingDiagnosticHint(diagnosticEntry) : null,
      lastSocketInboundAt,
      lastSocketInboundAgeMs: ageFromMs(lastSocketInboundAtMs),
      lastSocketInboundKind,
      lastSocketInboundMethod,
      lastSocketInboundId,
      lastRpcSendAt: lastSocketOutboundAt,
      lastRpcSendAgeMs: ageFromMs(lastSocketOutboundAtMs),
      lastRpcSendMethod: lastSocketOutboundMethod,
      lastRpcSendId: lastSocketOutboundId,
      lastRpcSettleAt,
      lastRpcSettleAgeMs: ageFromMs(lastRpcSettleAtMs),
      lastRpcSettleMethod,
      lastRpcSettleOutcome,
      lastOrphanResponseAt,
      lastOrphanResponseAgeMs: ageFromMs(lastOrphanResponseAtMs),
      lastOrphanResponseId,
      lastChildOutputAt,
      lastChildOutputAgeMs: ageFromMs(lastChildOutputAtMs),
      lastChildOutputSource,
      lastChildExitAt,
      lastChildExitAgeMs: ageFromMs(lastChildExitAtMs),
      lastChildExitCode,
      childPid: child?.pid ?? startupChildPid ?? null,
      startupInFlight,
      liveBufferLength: snapshot.liveBuffer.length,
      checkpointLength: snapshot.checkpointOutput?.length ?? 0
    });
  }

  function consumeExpectedInterruptedTurn(turnId: string | null): boolean {
    if (!turnId || !expectedInterruptedTurnIds.has(turnId)) return false;
    expectedInterruptedTurnIds.delete(turnId);
    return true;
  }

  function rememberRetiredTurn(turnId: string | null | undefined, completed = false): void {
    if (!turnId) return;
    retiredTurnIds.add(turnId);
    if (completed) {
      lastFinishedTurnId = turnId;
      completedTurnIds.add(turnId);
    }
  }

  function shouldIgnoreTurnScopedEvent(turnId: string | null, source: string): boolean {
    if (!turnId) return false;
    if (retiredTurnIds.has(turnId)) {
      log.appendEvent('TURN_EVENT_IGNORED', {
        source,
        turnId,
        reason: 'retired',
        activeTurnId,
        turnStartPending,
        lastFinishedTurnId
      });
      return true;
    }
    if (activeTurnId && turnId !== activeTurnId) {
      log.appendEvent('TURN_EVENT_IGNORED', {
        source,
        turnId,
        reason: 'active_turn_mismatch',
        activeTurnId,
        turnStartPending,
        lastFinishedTurnId
      });
      return true;
    }
    return false;
  }

  function isStaleCompletedTurn(
    turnId: string | null,
    finalText: string,
    turnStatus: string,
    statusType: string
  ): boolean {
    if (!turnId) return false;
    const looksCompleted = Boolean(finalText) || turnStatus === 'completed' || statusType === 'idle';
    if (!looksCompleted) return false;
    const isKnownCompleted = completedTurnIds.has(turnId) || (lastFinishedTurnId != null && turnId === lastFinishedTurnId);
    if (!isKnownCompleted) return false;
    return turnStartPending || !activeTurnId || activeTurnId !== turnId;
  }

  function isSameAssistantDelta(left: AssistantDeltaWindow, right: AssistantDeltaEvent): boolean {
    if (!left.turnId || !right.turnId) return false;
    if (left.turnId !== right.turnId || left.delta !== right.delta) return false;
    if (left.itemId && right.itemId) return left.itemId === right.itemId;
    return true;
  }

  function shouldSkipAssistantDelta(event: AssistantDeltaEvent): boolean {
    const now = Date.now();
    const current = lastAssistantDeltaWindow;
    if (!current || now - current.seenAtMs > assistantDeltaDedupWindowMs || !isSameAssistantDelta(current, event)) {
      lastAssistantDeltaWindow = {
        ...event,
        seenAtMs: now,
        seenSources: new Set([event.source])
      };
      return false;
    }
    if (current.seenSources.has(event.source)) {
      lastAssistantDeltaWindow = {
        ...event,
        seenAtMs: now,
        seenSources: new Set([event.source])
      };
      return false;
    }
    current.seenAtMs = now;
    current.seenSources.add(event.source);
    return true;
  }

  function createSocketDisconnectedError(reason: string): Error {
    const error = new Error('Codex app session socket disconnected (' + reason + ').');
    error.name = 'CodexSocketDisconnectedError';
    return error;
  }

  function ageFromMs(value: number): number | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.max(0, Date.now() - value);
  }

  function noteSocketInbound(input: { kind: string; method?: string | null; id?: string | number | null }): void {
    const nowMs = Date.now();
    lastSocketInboundAtMs = nowMs;
    lastSocketInboundAt = new Date(nowMs).toISOString();
    lastSocketInboundKind = input.kind;
    lastSocketInboundMethod = input.method ?? null;
    lastSocketInboundId = input.id ?? null;
  }

  function noteSocketOutbound(method: string, id: RpcId): void {
    const nowMs = Date.now();
    lastSocketOutboundAtMs = nowMs;
    lastSocketOutboundAt = new Date(nowMs).toISOString();
    lastSocketOutboundMethod = method;
    lastSocketOutboundId = typeof id === 'string' || typeof id === 'number' ? id : String(id);
  }

  function noteTerminalNotificationObservation(input: {
    rawMethod: string;
    turnId: string | null;
    status: string;
    errorText: string | null;
  }): void {
    const nowMs = Date.now();
    const observation: TerminalNotificationObservation = {
      rawMethod: input.rawMethod,
      turnId: input.turnId,
      status: input.status,
      errorText: input.errorText,
      socketGenerationAtReceive: activeSocketGeneration,
      activeTurnId,
      pendingRpcCount: pendingRpc.size,
      recoveryInFlight: socketRecoveryInFlight,
      observedAt: new Date(nowMs).toISOString(),
      observedAtMs: nowMs
    };
    recordTerminalNotificationObservation(terminalNotificationObservationStore, observation);
    log.appendEvent('TURN_TERMINAL_NOTIFY_OBSERVED', observation);
  }

  function getRelevantTerminalNotificationObservation(turnId: string | null): TerminalNotificationObservation | null {
    return getRelevantTerminalNotificationObservationFromStore(terminalNotificationObservationStore, turnId);
  }

  function summarizeRelevantTerminalNotificationObservation(turnId: string | null): Record<string, unknown> {
    const observation = getRelevantTerminalNotificationObservation(turnId);
    return {
      lastTerminalNotificationMethod: observation?.rawMethod ?? null,
      lastTerminalNotificationTurnId: observation?.turnId ?? null,
      lastTerminalNotificationStatus: observation?.status ?? null,
      lastTerminalNotificationErrorText: observation?.errorText ?? null,
      lastTerminalNotificationSocketGeneration: observation?.socketGenerationAtReceive ?? null,
      lastTerminalNotificationAt: observation?.observedAt ?? null,
      lastTerminalNotificationAgeMs: observation ? Math.max(0, Date.now() - observation.observedAtMs) : null
    };
  }

  function buildSessionDiagnosticContext(): Record<string, unknown> {
    return {
      sessionInstanceId,
      threadId,
      activeTurnId,
      lifecycle: snapshot.lifecycle,
      turnStartPending,
      activeTurnRequestSerial,
      lastFinishedTurnId,
      activeSocketGeneration,
      pendingRpcCount: pendingRpc.size,
      pendingRequestKind: pendingRequest?.kind ?? null,
      recoveryInFlight: socketRecoveryInFlight,
      shuttingDown
    };
  }

  function buildTransportActivityDiagnosticContext(): Record<string, unknown> {
    return {
      socketConnected: Boolean(socket && socket.readyState === 1),
      socketReadyState: socket?.readyState ?? null,
      socketBufferedAmount: resolveSocketBufferedAmount(socket),
      lastSocketInboundAt,
      lastSocketInboundAgeMs: ageFromMs(lastSocketInboundAtMs),
      lastSocketInboundKind,
      lastSocketInboundMethod,
      lastSocketInboundId,
      lastRpcSendAt: lastSocketOutboundAt,
      lastRpcSendAgeMs: ageFromMs(lastSocketOutboundAtMs),
      lastRpcSendMethod: lastSocketOutboundMethod,
      lastRpcSendId: lastSocketOutboundId,
      lastRpcSettleAt,
      lastRpcSettleAgeMs: ageFromMs(lastRpcSettleAtMs),
      lastRpcSettleMethod,
      lastRpcSettleOutcome,
      lastOrphanResponseAt,
      lastOrphanResponseAgeMs: ageFromMs(lastOrphanResponseAtMs),
      lastOrphanResponseId
    };
  }

  function resolveSocketGeneration(targetSocket: CodexAppWebSocketLike | null | undefined): number | null {
    if (!targetSocket || typeof targetSocket !== 'object') {
      return null;
    }
    return socketGenerationBySocket.get(targetSocket as object) ?? null;
  }

  function shouldLogIgnoredSocketFrame(frameSummary: Record<string, unknown>): boolean {
    if (frameSummary.parseFailed === true) {
      return true;
    }
    if (frameSummary.hasResult === true || frameSummary.hasError === true) {
      return true;
    }
    return typeof frameSummary.method === 'string' && INTERESTING_IGNORED_SOCKET_METHODS.has(frameSummary.method);
  }

  function logIgnoredSocketFrame(
    reason: 'stale_socket',
    sourceSocket: CodexAppWebSocketLike,
    frameSummary: Record<string, unknown>
  ): void {
    if (!shouldLogIgnoredSocketFrame(frameSummary)) {
      return;
    }
    log.appendEvent('IGNORED_SOCKET_FRAME_OBSERVED', {
      reason,
      ...buildSessionDiagnosticContext(),
      ...buildTransportActivityDiagnosticContext(),
      ...summarizeRelevantTerminalNotificationObservation(activeTurnId ?? lastFinishedTurnId ?? null),
      sourceSocketGeneration: resolveSocketGeneration(sourceSocket),
      sourceSocketReadyState: sourceSocket.readyState,
      sourceSocketBufferedAmount: resolveSocketBufferedAmount(sourceSocket),
      activeSocketReadyState: socket?.readyState ?? null,
      activeSocketBufferedAmount: resolveSocketBufferedAmount(socket),
      ...frameSummary
    });
  }

  function noteInterruptedDiscoveredViaThreadReadOnly(input: {
    reason: string;
    turnId: string | null;
    statusType: string;
    errorText: string | null;
    socketGenerationAtSend: number;
  }): void {
    if (!shouldLogInterruptedDiscoveredViaThreadReadOnlyFromStore(terminalNotificationObservationStore, input.turnId)) {
      return;
    }
    log.appendEvent('INTERRUPTED_DISCOVERED_VIA_THREAD_READ_ONLY', {
      reason: input.reason,
      turnId: input.turnId,
      statusType: input.statusType,
      errorText: input.errorText,
      socketGenerationAtSend: input.socketGenerationAtSend,
      ...buildSessionDiagnosticContext(),
      ...summarizeRelevantTerminalNotificationObservation(input.turnId)
    });
  }

  function logRawSocketFrame(direction: 'in' | 'out', raw: unknown, message?: Record<string, unknown> | null): void {
    if (!diagWsRawEnabled) return;
    const frameSummary = summarizeRawSocketFrame(raw, message ?? null);
    if (direction === 'in') {
      log.appendEvent('WS_RAW_IN', frameSummary);
      return;
    }
    log.appendEvent('WS_RAW_OUT', frameSummary);
  }

  function noteRpcSettled(method: string, outcome: 'resolve' | 'reject'): void {
    const nowMs = Date.now();
    lastRpcSettleAtMs = nowMs;
    lastRpcSettleAt = new Date(nowMs).toISOString();
    lastRpcSettleMethod = method;
    lastRpcSettleOutcome = outcome;
  }

  function noteOrphanResponse(id: RpcId): void {
    const nowMs = Date.now();
    lastOrphanResponseAtMs = nowMs;
    lastOrphanResponseAt = new Date(nowMs).toISOString();
    lastOrphanResponseId = typeof id === 'string' || typeof id === 'number' ? id : String(id);
  }

  function resolveSocketBufferedAmount(targetSocket: CodexAppWebSocketLike | null | undefined): number | null {
    const amount = targetSocket?.bufferedAmount;
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  function setActiveSocket(nextSocket: CodexAppWebSocketLike | null): void {
    socket = nextSocket;
    if (!nextSocket) {
      activeSocketGeneration = 0;
      return;
    }
    const nextGeneration = nextSocketGeneration++;
    activeSocketGeneration = nextGeneration;
    socketGenerationBySocket.set(nextSocket as object, nextGeneration);
  }

  function buildRpcDiagKey(input: {
    threadId: string | null;
    requestId: RpcId;
    turnIdAtSend: string | null;
    turnRequestSerialAtSend: number;
    socketGenerationAtSend: number;
  }): string {
    return `tr:${input.threadId ?? 'null'}:rpc:${String(input.requestId)}:turn:${input.turnIdAtSend ?? 'null'}:serial:${input.turnRequestSerialAtSend}:socket:${input.socketGenerationAtSend}`;
  }

  function buildRpcSendDiagnosticPayload(
    entry: Pick<
      PendingRpcEntry,
      'requestId' | 'method' | 'threadIdAtSend' | 'turnIdAtSend' | 'turnRequestSerialAtSend' | 'socketGenerationAtSend' | 'diagReqKey' | 'payloadBytes'
    >,
    targetSocket: CodexAppWebSocketLike
  ): Record<string, unknown> {
    return {
      id: entry.requestId,
      method: entry.method,
      diagReqKey: entry.diagReqKey,
      threadIdAtSend: entry.threadIdAtSend,
      turnIdAtSend: entry.turnIdAtSend,
      turnRequestSerialAtSend: entry.turnRequestSerialAtSend,
      socketGenerationAtSend: entry.socketGenerationAtSend,
      socketReadyState: targetSocket.readyState,
      socketBufferedAmount: resolveSocketBufferedAmount(targetSocket),
      payloadBytes: entry.payloadBytes,
      pendingRpcCount: pendingRpc.size
    };
  }

  function buildRpcResponseObservedPayload(input: {
    message: Record<string, unknown>;
    responseIdKey: string | null;
    matchedEntry?: PendingRpcEntry;
    payloadBytes: number | null;
  }): Record<string, unknown> {
    return {
      rawId: input.message.id as RpcId,
      rawIdType: typeof input.message.id,
      normalizedId: input.responseIdKey,
      hasResult: Object.prototype.hasOwnProperty.call(input.message, 'result'),
      hasError: Object.prototype.hasOwnProperty.call(input.message, 'error'),
      matched: Boolean(input.matchedEntry),
      matchedMethod: input.matchedEntry?.method ?? null,
      matchedThreadIdAtSend: input.matchedEntry?.threadIdAtSend ?? null,
      matchedTurnIdAtSend: input.matchedEntry?.turnIdAtSend ?? null,
      matchedTurnRequestSerialAtSend: input.matchedEntry?.turnRequestSerialAtSend ?? null,
      matchedSocketGenerationAtSend: input.matchedEntry?.socketGenerationAtSend ?? null,
      matchedDiagReqKey: input.matchedEntry?.diagReqKey ?? null,
      pendingRpcCount: pendingRpc.size,
      pendingRpcKeys: listPendingRpcKeys(8),
      payloadBytes: input.payloadBytes
    };
  }

  function isSocketDisconnectedError(error: unknown): boolean {
    return error instanceof Error && error.name === 'CodexSocketDisconnectedError';
  }

  function isSocketOpenFailureError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (
        error.name === 'CodexSocketOpenError' ||
        error.name === 'CodexSocketClosedBeforeOpenError' ||
        error.name === 'CodexSocketOpenTimeoutError'
      )
    );
  }

  function createSocketSendError(error: Error): Error {
    const wrapped = new Error(error.message);
    wrapped.name = 'CodexSocketSendError';
    return wrapped;
  }

  function isSocketSendError(error: unknown): boolean {
    return error instanceof Error && error.name === 'CodexSocketSendError';
  }

  function isLocalTransportError(error: unknown): boolean {
    return isSocketDisconnectedError(error) || isSocketSendError(error) || isSocketOpenFailureError(error);
  }

  function rejectPendingRpc(error: Error): void {
    for (const entry of pendingRpc.values()) {
      clearPendingRpcDiagnosticTimer(entry);
      log.appendEvent('RPC_REJECT', {
        id: entry.requestId,
        method: entry.method,
        durationMs: Math.max(0, Date.now() - entry.startedAtMs),
        error: error.message
      });
      noteRpcSettled(entry.method, 'reject');
      entry.reject(error);
    }
    pendingRpc.clear();
  }

  function listPendingRpcMethods(limit = 4): string[] {
    const methods: string[] = [];
    for (const entry of pendingRpc.values()) {
      methods.push(entry.method);
      if (methods.length >= limit) break;
    }
    return methods;
  }

  function listPendingRpcKeys(limit = 4): string[] {
    const keys: string[] = [];
    for (const key of pendingRpc.keys()) {
      keys.push(key);
      if (keys.length >= limit) break;
    }
    return keys;
  }

  function listPendingRpcSummary(
    limit = 4
  ): Array<{
    id: RpcId;
    method: string;
    ageMs: number;
    turnIdAtSend: string | null;
    turnRequestSerialAtSend: number;
    staleForCurrentTurn: boolean;
  }> {
    const summary: Array<{
      id: RpcId;
      method: string;
      ageMs: number;
      turnIdAtSend: string | null;
      turnRequestSerialAtSend: number;
      staleForCurrentTurn: boolean;
    }> = [];
    for (const entry of pendingRpc.values()) {
      summary.push({
        id: entry.requestId,
        method: entry.method,
        ageMs: Math.max(0, Date.now() - entry.startedAtMs),
        turnIdAtSend: entry.turnIdAtSend,
        turnRequestSerialAtSend: entry.turnRequestSerialAtSend,
        staleForCurrentTurn:
          entry.turnRequestSerialAtSend > 0 && entry.turnRequestSerialAtSend !== activeTurnRequestSerial
      });
      if (summary.length >= limit) break;
    }
    return summary;
  }

  function findOldestPendingRpc(
    predicate?: (entry: {
      requestId: RpcId;
      method: string;
      startedAtMs: number;
      turnIdAtSend: string | null;
      turnRequestSerialAtSend: number;
    }) => boolean
  ) {
    let oldestEntry: ReturnType<typeof getBlockingThreadReadEntry> = null;
    for (const entry of pendingRpc.values()) {
      if (predicate && !predicate(entry)) continue;
      if (!oldestEntry || entry.startedAtMs < oldestEntry.startedAtMs) {
        oldestEntry = entry;
      }
    }
    return oldestEntry;
  }

  function countStaleThreadReadEntries(): number {
    let count = 0;
    for (const entry of pendingRpc.values()) {
      if (entry.method !== 'thread/read') continue;
      if (activeTurnRequestSerial > 0) {
        if (entry.turnRequestSerialAtSend !== activeTurnRequestSerial) {
          count += 1;
        }
        continue;
      }
      count += 1;
    }
    return count;
  }

  function hasAnyThreadReadInFlight(): boolean {
    for (const entry of pendingRpc.values()) {
      if (entry.method === 'thread/read') return true;
    }
    return false;
  }

  function getBlockingThreadReadEntry() {
    for (const entry of pendingRpc.values()) {
      if (entry.method === 'thread/read' && entry.turnRequestSerialAtSend === activeTurnRequestSerial) {
        return entry;
      }
    }
    return null;
  }

  function resolvePrimaryDiagnosticEntry() {
    const blockingThreadRead = getBlockingThreadReadEntry();
    if (blockingThreadRead) return blockingThreadRead;
    const currentTurnEntry = findOldestPendingRpc(
      (entry) => entry.turnRequestSerialAtSend > 0 && entry.turnRequestSerialAtSend === activeTurnRequestSerial
    );
    if (currentTurnEntry) return currentTurnEntry;
    return findOldestPendingRpc();
  }

  function resolveLongPendingDiagnosticHint(entry: {
    method: string;
    startedAtMs: number;
    turnIdAtSend?: string | null;
    turnRequestSerialAtSend?: number;
  }): string {
    if (
      typeof entry.turnRequestSerialAtSend === 'number' &&
      entry.turnRequestSerialAtSend > 0 &&
      entry.turnRequestSerialAtSend !== activeTurnRequestSerial
    ) {
      return 'stale_turn_request_after_turn_switch';
    }
    if (entry.turnIdAtSend && activeTurnId && entry.turnIdAtSend !== activeTurnId) {
      return 'stale_turn_request_after_turn_switch';
    }
    if (lastChildExitAtMs > 0 && lastChildExitAtMs >= entry.startedAtMs) {
      return 'child_exited_before_request_resolved';
    }
    if (lastOrphanResponseAtMs > 0 && lastOrphanResponseAtMs >= entry.startedAtMs) {
      return 'orphan_response_after_request';
    }
    if (socketRecoveryInFlight) {
      return 'socket_recovering';
    }
    if (!socket || socket.readyState !== 1) {
      return 'socket_not_open';
    }
    if (lastSocketInboundAtMs > 0 && lastSocketInboundAtMs >= entry.startedAtMs) {
      return 'other_socket_messages_arrived_while_request_pending';
    }
    return 'socket_open_but_no_inbound_after_request';
  }

  function buildLongPendingRpcPayload(entry: {
    requestId: RpcId;
    method: string;
    startedAtMs: number;
    turnIdAtSend?: string | null;
    turnRequestSerialAtSend?: number;
  }): Record<string, unknown> {
    return {
      id: entry.requestId,
      method: entry.method,
      turnIdAtSend: entry.turnIdAtSend ?? null,
      turnRequestSerialAtSend: entry.turnRequestSerialAtSend ?? null,
      ageMs: Math.max(0, Date.now() - entry.startedAtMs),
      diagnosticHint: resolveLongPendingDiagnosticHint(entry),
      lifecycle: snapshot.lifecycle,
      activeTurnId,
      codexThreadId: threadId,
      pendingRpcCount: pendingRpc.size,
      pendingMethods: listPendingRpcMethods(8),
      pendingRpcSummary: listPendingRpcSummary(8),
      currentTurnRequestSerial,
      activeTurnRequestSerial,
      threadReadInFlight: Boolean(getBlockingThreadReadEntry()),
      anyThreadReadPending: hasAnyThreadReadInFlight(),
      staleThreadReadPendingCount: countStaleThreadReadEntries(),
      socketConnected: Boolean(socket && socket.readyState === 1),
      socketReadyState: socket?.readyState ?? null,
      socketRecoveryInFlight,
      lastSocketInboundAt,
      lastSocketInboundAgeMs: ageFromMs(lastSocketInboundAtMs),
      lastSocketInboundKind,
      lastSocketInboundMethod,
      lastSocketInboundId,
      lastRpcSendAt: lastSocketOutboundAt,
      lastRpcSendAgeMs: ageFromMs(lastSocketOutboundAtMs),
      lastRpcSendMethod: lastSocketOutboundMethod,
      lastRpcSendId: lastSocketOutboundId,
      lastRpcSettleAt,
      lastRpcSettleAgeMs: ageFromMs(lastRpcSettleAtMs),
      lastRpcSettleMethod,
      lastRpcSettleOutcome,
      lastOrphanResponseAt,
      lastOrphanResponseAgeMs: ageFromMs(lastOrphanResponseAtMs),
      lastOrphanResponseId,
      lastChildOutputAt,
      lastChildOutputAgeMs: ageFromMs(lastChildOutputAtMs),
      lastChildOutputSource,
      lastChildExitAt,
      lastChildExitAgeMs: ageFromMs(lastChildExitAtMs),
      lastChildExitCode,
      ...summarizeRelevantTerminalNotificationObservation(entry.turnIdAtSend ?? activeTurnId ?? null),
      childPid: child?.pid ?? startupChildPid ?? null
    };
  }

  function clearPendingRpcDiagnosticTimer(entry: { diagnosticTimer?: ReturnType<typeof setTimeout> | null }): void {
    if (!entry.diagnosticTimer) return;
    clearTimeout(entry.diagnosticTimer);
    entry.diagnosticTimer = null;
  }

  function schedulePendingRpcDiagnostic(entryKey: string): void {
    if (!(rpcLongPendingThresholdMs > 0)) return;
    const entry = pendingRpc.get(entryKey);
    if (!entry) return;
    clearPendingRpcDiagnosticTimer(entry);
    entry.diagnosticTimer = setTimeout(() => {
      const current = pendingRpc.get(entryKey);
      if (!current || current.longPendingLogged) return;
      current.longPendingLogged = true;
      const payload = buildLongPendingRpcPayload(current);
      log.appendEvent('RPC_LONG_PENDING', payload);
      if (shouldRecoverPoisonedThreadRead(current, payload.diagnosticHint)) {
        log.appendEvent('POISONED_THREAD_READ_RECOVERY_TRIGGER', payload);
        void recoverSocket('thread_read_long_pending_no_inbound', { poisonCurrentSocket: true });
      }
    }, rpcLongPendingThresholdMs);
    entry.diagnosticTimer.unref?.();
  }

  function shouldRecoverPoisonedThreadRead(
    entry: Pick<PendingRpcEntry, 'method' | 'turnIdAtSend' | 'turnRequestSerialAtSend'>,
    diagnosticHint?: unknown
  ): boolean {
    if (entry.method !== 'thread/read') return false;
    if (diagnosticHint !== 'socket_open_but_no_inbound_after_request') return false;
    if (!threadId || shuttingDown || pendingRequest || socketRecoveryInFlight || !hasRunningTurn()) return false;
    if (turnStartPending || !activeTurnId) return false;
    if (entry.turnRequestSerialAtSend !== activeTurnRequestSerial) return false;
    if (entry.turnIdAtSend && activeTurnId && entry.turnIdAtSend !== activeTurnId) return false;
    return true;
  }

  function summarizeRpcParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      paramKeys: Object.keys(params).sort()
    };
    if (typeof params.threadId === 'string') {
      summary.threadId = params.threadId;
    }
    if (typeof params.turnId === 'string') {
      summary.turnId = params.turnId;
    }
    if (params.includeTurns === true) {
      summary.includeTurns = true;
    }
    if (Array.isArray(params.input)) {
      summary.inputCount = params.input.length;
      const firstInput = params.input[0];
      if (isRecord(firstInput) && typeof firstInput.text === 'string') {
        summary.inputTextLength = firstInput.text.length;
      }
    }
    if (method === 'thread/resume' || method === 'thread/start') {
      if (typeof params.approvalPolicy === 'string') {
        summary.approvalPolicy = params.approvalPolicy;
      }
      if (typeof params.sandbox === 'string') {
        summary.sandbox = params.sandbox;
      }
      if (typeof params.model === 'string') {
        summary.model = params.model;
      }
    }
    return summary;
  }

  function summarizeRpcResult(result: unknown): Record<string, unknown> {
    if (!isRecord(result)) {
      return { resultType: typeof result };
    }
    const summary: Record<string, unknown> = {
      resultKeys: Object.keys(result).sort()
    };
    const thread = isRecord(result.thread) ? result.thread : undefined;
    if (thread) {
      if (typeof thread.id === 'string') {
        summary.threadId = thread.id;
      }
      const status = isRecord(thread.status) ? thread.status : undefined;
      if (typeof status?.type === 'string') {
        summary.threadStatus = status.type;
      }
      if (Array.isArray(thread.turns)) {
        summary.turnCount = thread.turns.length;
      }
    }
    const turn = isRecord(result.turn) ? result.turn : undefined;
    if (turn) {
      if (typeof turn.id === 'string') {
        summary.turnId = turn.id;
      }
      if (typeof turn.status === 'string') {
        summary.turnStatus = turn.status;
      }
    }
    if (typeof result.userAgent === 'string') {
      summary.userAgent = result.userAgent;
    }
    if (typeof result.model === 'string') {
      summary.model = result.model;
    }
    return summary;
  }

  function summarizeSocketNotification(params: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      paramKeys: Object.keys(params).sort()
    };
    const msg = isRecord(params.msg) ? params.msg : undefined;
    const item = isRecord(params.item) ? params.item : undefined;
    const thread = isRecord(params.thread) ? params.thread : undefined;
    const turn = isRecord(params.turn) ? params.turn : undefined;
    const status = isRecord(params.status) ? params.status : undefined;
    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : typeof msg?.thread_id === 'string'
          ? msg.thread_id
          : typeof thread?.id === 'string'
            ? thread.id
            : null;
    if (threadId) {
      summary.threadId = threadId;
    }
    const turnId =
      typeof params.turnId === 'string'
        ? params.turnId
        : typeof params.id === 'string'
          ? params.id
          : typeof msg?.turn_id === 'string'
            ? msg.turn_id
            : typeof turn?.id === 'string'
              ? turn.id
              : null;
    if (turnId) {
      summary.turnId = turnId;
    }
    const itemId =
      typeof params.itemId === 'string'
        ? params.itemId
        : typeof msg?.item_id === 'string'
          ? msg.item_id
          : typeof item?.id === 'string'
            ? item.id
            : null;
    if (itemId) {
      summary.itemId = itemId;
    }
    const delta =
      typeof params.delta === 'string' ? params.delta : typeof msg?.delta === 'string' ? msg.delta : '';
    if (delta) {
      summary.deltaLength = delta.length;
    }
    if (typeof msg?.type === 'string') {
      summary.msgType = msg.type;
    }
    if (typeof status?.type === 'string') {
      summary.statusType = status.type;
    }
    if (typeof item?.type === 'string') {
      summary.itemType = item.type;
    }
    if (typeof item?.phase === 'string') {
      summary.itemPhase = item.phase;
    }
    if (typeof turn?.status === 'string') {
      summary.turnStatus = turn.status;
    }
    if (typeof msg?.command === 'string') {
      summary.commandLength = msg.command.length;
    }
    return summary;
  }

  function summarizeResumeContext(context?: CodexSessionResumeContext): Record<string, unknown> {
    if (!context) return {};
    const summary: Record<string, unknown> = {};
    if (typeof context.sourceSessionLifecycle === 'string' && context.sourceSessionLifecycle) {
      summary.sourceSessionLifecycle = context.sourceSessionLifecycle;
    }
    if (typeof context.sourceLastEventAt === 'string' && context.sourceLastEventAt) {
      summary.sourceLastEventAt = context.sourceLastEventAt;
    }
    if (typeof context.sourceCreatedAt === 'string' && context.sourceCreatedAt) {
      summary.sourceCreatedAt = context.sourceCreatedAt;
    }
    if (typeof context.sourceIdleMs === 'number' && Number.isFinite(context.sourceIdleMs) && context.sourceIdleMs >= 0) {
      summary.sourceIdleMs = Math.floor(context.sourceIdleMs);
    }
    if (typeof context.sourceAgeMs === 'number' && Number.isFinite(context.sourceAgeMs) && context.sourceAgeMs >= 0) {
      summary.sourceAgeMs = Math.floor(context.sourceAgeMs);
    }
    return summary;
  }

  function attachRuntimeSocketListeners(nextSocket: CodexAppWebSocketLike): void {
    nextSocket.addEventListener('close', () => {
      handleSocketDisconnected(nextSocket, 'close');
    });
    nextSocket.addEventListener('error', () => {
      if (nextSocket.readyState === 1) {
        handleSocketDisconnected(nextSocket, 'error');
      }
    });
  }

  function handleSocketDisconnected(disconnectedSocket: CodexAppWebSocketLike, reason: 'close' | 'error'): void {
    if (socket !== disconnectedSocket) return;
    setActiveSocket(null);
    rejectPendingRpc(createSocketDisconnectedError(reason));
    if (isSessionInactiveForAsyncWork()) {
      return;
    }
    log.appendEvent('SOCKET_DISCONNECTED', reason);
    if (!threadId || !socketUrl) {
      fail(createSocketDisconnectedError(reason), { localComm: true });
      return;
    }
    void recoverSocket(reason);
  }

  async function recoverSocket(reason: string, options?: { poisonCurrentSocket?: boolean }): Promise<void> {
    if (socketRecoveryInFlight || !socketUrl || shuttingDown || snapshot.lifecycle === 'FAILED' || snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'CLOSING') {
      return;
    }
    socketRecoveryInFlight = true;
    cancelThreadReadPoll();
    if (options?.poisonCurrentSocket && socket) {
      const poisonedSocket = socket;
      setActiveSocket(null);
      rejectPendingRpc(createSocketDisconnectedError(reason));
      safeClose(poisonedSocket);
    }
    log.appendEvent('SOCKET_RECOVER_START', reason);
    let recoveryPhase: 'websocket/open' | 'initialize' | 'thread/resume' | 'thread/read' = 'websocket/open';
    try {
      const recoveredSocket = await connectWebSocketWithRetry(socketUrl, createWebSocket, (payload, sourceSocket) => handleSocketMessage(payload, sourceSocket), {
        maxAttempts: socketRetryLimit,
        retryDelayMs: socketRetryDelayMs,
        openTimeoutMs: socketOpenTimeoutMs
      });
      setActiveSocket(recoveredSocket);
      attachRuntimeSocketListeners(recoveredSocket);
      recoveryPhase = 'initialize';
      const initializeResult = await request('initialize', {
        clientInfo: { name: 'communicate-feishu', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      });
      ensureInitializeCompatibility(initializeResult);
      if (threadId) {
        recoveryPhase = 'thread/resume';
        const threadResume = await request('thread/resume', {
          threadId,
          cwd: input.cwd,
          approvalPolicy,
          sandbox,
          ...(snapshot.model ? { model: snapshot.model } : {}),
          ...assistantPersonaParams
        });
        ensureStartupCompatibility(threadResume, 'thread/resume');
        setModel(isRecord(threadResume) ? (threadResume.model as string | undefined) : undefined);
        const thread = isRecord(threadResume?.thread) ? threadResume.thread : undefined;
        setThreadId(typeof thread?.id === 'string' ? thread.id : threadId);
      }
      log.appendEvent('SOCKET_RECOVERED');
      if (socketRecoveryInFlight) { socketRecoveryInFlight = false; }
      if (threadId && hasRunningTurn()) {
        recoveryPhase = 'thread/read';
        await pollThreadRead('socket/recovered', { finalizeOnReadFailure: true });
      }
    } catch (error) {
      const recoveryError =
        recoveryPhase === 'initialize'
          ? maybePromoteInitializeRpcFailure(error)
          : recoveryPhase === 'thread/resume'
          ? maybePromoteStartupRpcFailure(error, 'thread/resume')
          : error;
      const failureEvidence = resolveRpcFailureEvidence(recoveryError);
      const detail = formatCompatibilityErrorMessage(recoveryError);
      fail(
        mergeOutput(
          snapshot.liveBuffer,
          failureEvidence.localComm ? 'Codex app-server socket disconnected and reconnect failed.\\n\\n' + detail : detail
        ),
        failureEvidence
      );
    } finally {
      socketRecoveryInFlight = false;
      if (threadId && hasRunningTurn() && !shuttingDown) {
        scheduleThreadReadPoll();
      }
    }
  }

  function findRelevantTurn(thread: Record<string, unknown>): Record<string, unknown> | null {
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isRecord) : [];
    if (turns.length === 0) return null;
    if (activeTurnId) {
      const matchedTurnIndex = turns.findIndex((turn) => turn.id === activeTurnId);
      const matchedTurn = matchedTurnIndex >= 0 ? turns[matchedTurnIndex] : null;
      if (matchedTurn && !retiredTurnIds.has(activeTurnId)) return matchedTurn;
      if (matchedTurn) {
        for (let index = turns.length - 1; index > matchedTurnIndex; index -= 1) {
          const candidate = turns[index];
          const candidateTurnId = typeof candidate?.id === 'string' ? candidate.id : null;
          if (!candidateTurnId || retiredTurnIds.has(candidateTurnId)) continue;
          return candidate;
        }
        return matchedTurn;
      }
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const candidate = turns[index];
      const candidateTurnId = typeof candidate?.id === 'string' ? candidate.id : null;
      if (!candidateTurnId || retiredTurnIds.has(candidateTurnId)) continue;
      return candidate;
    }
    return turns[turns.length - 1] ?? null;
  }

  function extractTurnMessages(turn: Record<string, unknown> | null): {
    finalText: string;
    lastText: string;
    turnStatus: string;
    errorText: string;
  } {
    const turnStatus = typeof turn?.status === 'string' ? turn.status : '';
    const errorText = extractTurnError(turn?.error);
    const items = Array.isArray(turn?.items) ? turn.items.filter(isRecord) : [];
    let finalText = '';
    let lastText = '';
    for (const item of items) {
      if (item.type !== 'agentMessage') continue;
      const text = extractAgentMessageText(item);
      if (!text) continue;
      lastText = text;
      if (item.phase === 'final_answer') {
        finalText = text;
      }
    }
    return { finalText, lastText, turnStatus, errorText };
  }

  function buildSystemErrorReconcileReadState(result: unknown): SystemErrorReconcileReadState {
    const record = isRecord(result) ? result : undefined;
    const thread = isRecord(record?.thread) ? record.thread : undefined;
    const status = isRecord(thread?.status) ? thread.status : undefined;
    const statusType = typeof status?.type === 'string' ? status.type : '';
    const turn = thread ? findRelevantTurn(thread) : null;
    const turnId = typeof turn?.id === 'string' ? turn.id : null;
    const { finalText, lastText, turnStatus, errorText } = extractTurnMessages(turn);
    const output = finalText || lastText || snapshot.liveBuffer || snapshot.checkpointOutput || '';
    return {
      turnId,
      statusType,
      turnStatus,
      errorText,
      finalText,
      lastText,
      output
    };
  }

  function buildRecoverableSystemErrorMessage(input: {
    output: string;
    errorText?: string;
    statusType?: string;
    turnStatus?: string;
    attempts: number;
    maxAttempts: number;
  }): string {
    const details = [
      'Codex 线程在收尾阶段进入 systemError，补偿轮询后仍未确认最终完成。',
      '这是一次可恢复失败；你可以直接重试，或结合会话日志继续排查。',
      input.errorText ? `上游错误: ${input.errorText}` : '',
      `诊断: thread.status=${input.statusType || 'unknown'}, turn.status=${input.turnStatus || 'unknown'}, reconcileAttempts=${input.attempts}/${input.maxAttempts}`
    ]
      .filter(Boolean)
      .join('\n');
    return mergeOutput(input.output, details);
  }

  async function reconcileSystemErrorTurn(source: string): Promise<void> {
    if (isSessionInactiveForAsyncWork() || !hasRunningTurn()) {
      return;
    }
    if (systemErrorReconcileInFlight || systemErrorReconcileTimer) {
      log.appendEvent('SYSTEM_ERROR_RECONCILE_SKIPPED', {
        source,
        reason: systemErrorReconcileInFlight ? 'in_flight' : 'scheduled',
        activeTurnId,
        turnStartPending,
        pendingRequestKind: pendingRequest?.kind ?? null
      });
      return;
    }

    const generation = ++systemErrorReconcileGeneration;
    const run = async (): Promise<void> => {
      if (generation !== systemErrorReconcileGeneration || isSessionInactiveForAsyncWork() || !hasRunningTurn()) {
        if (generation === systemErrorReconcileGeneration) {
          systemErrorReconcileTimer = null;
          systemErrorReconcileInFlight = false;
        }
        return;
      }
      systemErrorReconcileTimer = null;
      systemErrorReconcileInFlight = true;

      let lastObserved: SystemErrorReconcileReadState = {
        turnId: activeTurnId,
        statusType: 'systemError',
        turnStatus: '',
        errorText: '',
        finalText: '',
        lastText: '',
        output: snapshot.liveBuffer || snapshot.checkpointOutput || ''
      };

      try {
        for (let attempt = 1; attempt <= systemErrorReconcileMaxAttempts; attempt += 1) {
          if (generation !== systemErrorReconcileGeneration || isSessionInactiveForAsyncWork() || !hasRunningTurn()) {
            return;
          }
          if (attempt > 1 && systemErrorReconcileRetryDelayMs > 0) {
            await delay(systemErrorReconcileRetryDelayMs);
            if (generation !== systemErrorReconcileGeneration || isSessionInactiveForAsyncWork() || !hasRunningTurn()) {
              return;
            }
          }

          const blockingThreadRead = getBlockingThreadReadEntry();
          if (blockingThreadRead) {
            log.appendEvent('SYSTEM_ERROR_RECONCILE_DEFER_TO_PENDING_THREAD_READ', {
              source,
              attempt,
              maxAttempts: systemErrorReconcileMaxAttempts,
              activeTurnId,
              blockingRequestId: blockingThreadRead.requestId,
              blockingTurnIdAtSend: blockingThreadRead.turnIdAtSend,
              blockingTurnRequestSerialAtSend: blockingThreadRead.turnRequestSerialAtSend
            });
            return;
          }

          if (!threadId) {
            break;
          }

          log.appendEvent('SYSTEM_ERROR_RECONCILE_ATTEMPT', {
            source,
            attempt,
            maxAttempts: systemErrorReconcileMaxAttempts,
            activeTurnId,
            codexThreadId: threadId,
            liveBufferLength: snapshot.liveBuffer.length,
            checkpointLength: snapshot.checkpointOutput?.length ?? 0,
            pendingRpcCount: pendingRpc.size,
            pendingMethods: listPendingRpcMethods(8)
          });

          try {
            const result = await request('thread/read', { threadId, includeTurns: diagThreadReadIncludeTurns });
            if (generation !== systemErrorReconcileGeneration || isSessionInactiveForAsyncWork() || !hasRunningTurn()) {
              return;
            }

            const state = buildSystemErrorReconcileReadState(result);
            lastObserved = {
              ...lastObserved,
              ...state,
              output: state.output || lastObserved.output
            };
            maybeAdoptAutoContinueTurnFromThreadRead(state.turnId, 'system_error_reconcile_thread_read');
            log.appendEvent('SYSTEM_ERROR_RECONCILE_SNAPSHOT', {
              source,
              attempt,
              maxAttempts: systemErrorReconcileMaxAttempts,
              turnId: state.turnId,
              statusType: state.statusType,
              turnStatus: state.turnStatus,
              errorText: state.errorText || null,
              finalTextLength: state.finalText.length,
              lastTextLength: state.lastText.length,
              outputLength: state.output.length,
              activeTurnId,
              lastFinishedTurnId
            });

            if (shouldIgnoreTurnScopedEvent(state.turnId, 'system_error_reconcile_thread_read')) {
              continue;
            }

            if (isStaleCompletedTurn(state.turnId, state.finalText, state.turnStatus, state.statusType)) {
              continue;
            }

            if (state.finalText) {
              syncAssistantMessage(state.finalText);
              log.appendEvent('SYSTEM_ERROR_RECONCILE_RECOVERED', {
                source,
                attempt,
                turnId: state.turnId,
                reason: 'final_answer',
                outputLength: state.finalText.length
              });
              finalizeRunningTurn(state.finalText, state.turnId);
              return;
            }

            if (state.turnStatus === 'interrupted') {
              fail(mergeOutput(snapshot.liveBuffer, state.errorText || 'Turn completed with status: interrupted'), {
                upstreamExecution: true
              });
              return;
            }

            if (state.statusType === 'idle' || state.turnStatus === 'completed') {
              const output = state.lastText || state.output;
              if (state.lastText) {
                syncAssistantMessage(state.lastText);
              }
              log.appendEvent('SYSTEM_ERROR_RECONCILE_RECOVERED', {
                source,
                attempt,
                turnId: state.turnId,
                reason: 'idle_or_completed',
                outputLength: output.length
              });
              finalizeRunningTurn(output, state.turnId);
              return;
            }

            if (state.turnStatus === 'failed' && !state.output) {
              log.appendEvent('SYSTEM_ERROR_RECONCILE_CONFIRMED_FAIL', {
                source,
                attempt,
                turnId: state.turnId,
                statusType: state.statusType,
                turnStatus: state.turnStatus,
                errorText: state.errorText || null
              });
              fail(mergeOutput(snapshot.liveBuffer, state.errorText || 'Codex 线程在 thread/read 中返回失败状态。'), {
                upstreamExecution: true
              });
              return;
            }
          } catch (error) {
            if (isLocalTransportError(error)) {
              log.appendEvent('SYSTEM_ERROR_RECONCILE_LOCAL_COMM_FAIL', {
                source,
                attempt,
                maxAttempts: systemErrorReconcileMaxAttempts,
                error: String(error),
                activeTurnId,
                codexThreadId: threadId
              });
              fail(mergeOutput(snapshot.liveBuffer, String(error)), {
                localComm: true
              });
              return;
            }
            lastObserved = {
              ...lastObserved,
              errorText: String(error)
            };
            log.appendEvent('SYSTEM_ERROR_RECONCILE_THREAD_READ_FAILED', {
              source,
              attempt,
              maxAttempts: systemErrorReconcileMaxAttempts,
              error: String(error),
              activeTurnId,
              codexThreadId: threadId
            });
          }
        }

        if (generation !== systemErrorReconcileGeneration || isSessionInactiveForAsyncWork() || !hasRunningTurn()) {
          return;
        }

        const message = buildRecoverableSystemErrorMessage({
          output: lastObserved.output || snapshot.liveBuffer || snapshot.checkpointOutput || '',
          errorText: lastObserved.errorText,
          statusType: lastObserved.statusType,
          turnStatus: lastObserved.turnStatus,
          attempts: systemErrorReconcileMaxAttempts,
          maxAttempts: systemErrorReconcileMaxAttempts
        });
        log.appendEvent('SYSTEM_ERROR_RECONCILE_RECOVERABLE_FAIL', {
          source,
          turnId: lastObserved.turnId,
          statusType: lastObserved.statusType,
          turnStatus: lastObserved.turnStatus,
          errorText: lastObserved.errorText || null,
          outputLength: (lastObserved.output || snapshot.liveBuffer || snapshot.checkpointOutput || '').length,
          activeTurnId,
          maxAttempts: systemErrorReconcileMaxAttempts
        });
        if (attemptSystemErrorAutoContinue(source, {
          ...lastObserved,
          output: lastObserved.output || snapshot.liveBuffer || snapshot.checkpointOutput || ''
        })) {
          return;
        }
        fail(message, {
          upstreamExecution: lastObserved.turnStatus === 'failed' || lastObserved.turnStatus === 'interrupted'
        });
      } finally {
        if (generation === systemErrorReconcileGeneration) {
          systemErrorReconcileInFlight = false;
          systemErrorReconcileTimer = null;
        }
      }
    };

    log.appendEvent('SYSTEM_ERROR_RECONCILE_START', {
      source,
      activeTurnId,
      turnStartPending,
      codexThreadId: threadId,
      liveBufferLength: snapshot.liveBuffer.length,
      checkpointLength: snapshot.checkpointOutput?.length ?? 0,
      delayMs: systemErrorReconcileDelayMs,
      retryDelayMs: systemErrorReconcileRetryDelayMs,
      maxAttempts: systemErrorReconcileMaxAttempts,
      pendingRequestKind: pendingRequest?.kind ?? null
    });
    cancelThreadReadPoll();

    if (systemErrorReconcileDelayMs > 0) {
      systemErrorReconcileTimer = setTimeout(() => {
        void run();
      }, systemErrorReconcileDelayMs);
      systemErrorReconcileTimer.unref?.();
      return;
    }

    void run();
  }

  function scheduleThreadReadPoll(delayMs = threadReadPollDelayMs): void {
    if (!threadId || shuttingDown || pendingRequest || socketRecoveryInFlight || systemErrorReconcileInFlight || systemErrorReconcileTimer || !hasRunningTurn()) return;
    cancelThreadReadPoll();
    threadReadPollTimer = setTimeout(() => {
      threadReadPollTimer = null;
      void pollThreadRead('inactivity');
    }, delayMs);
    threadReadPollTimer.unref?.();
  }

  async function pollThreadRead(reason: string, options?: { finalizeOnReadFailure?: boolean }): Promise<void> {
    const blockingThreadRead = getBlockingThreadReadEntry();
    if (blockingThreadRead) {
      log.appendEvent('THREAD_READ_SKIPPED_INFLIGHT', {
        reason,
        activeTurnId,
        turnStartPending,
        blockingRequestId: blockingThreadRead.requestId,
        blockingTurnIdAtSend: blockingThreadRead.turnIdAtSend,
        blockingTurnRequestSerialAtSend: blockingThreadRead.turnRequestSerialAtSend,
        pendingRpcCount: pendingRpc.size,
        pendingMethods: listPendingRpcMethods()
      });
      return;
    }
    if (!threadId || shuttingDown || pendingRequest || socketRecoveryInFlight || !hasRunningTurn()) return;
    const pollTurnRequestSerial = activeTurnRequestSerial;
    const socketGenerationAtSend = activeSocketGeneration;
    try {
      log.appendEvent('THREAD_READ_POLL', reason);
      const result = await request('thread/read', { threadId, includeTurns: diagThreadReadIncludeTurns });
      const pendingRequestKind = pendingRequest != null ? (pendingRequest as { kind: string }).kind : null;
      if (shuttingDown || pendingRequest || !hasRunningTurn()) {
        log.appendEvent('THREAD_READ_STALE_RESPONSE', {
          reason: 'no_running_turn',
          trigger: reason,
          pollTurnRequestSerial,
          activeTurnRequestSerial,
          activeTurnId,
          pendingRequestKind
        });
        return;
      }
      if (pollTurnRequestSerial !== activeTurnRequestSerial) {
        log.appendEvent('THREAD_READ_STALE_RESPONSE', {
          reason: 'turn_request_serial_mismatch',
          trigger: reason,
          pollTurnRequestSerial,
          activeTurnRequestSerial,
          activeTurnId,
          lastFinishedTurnId
        });
        scheduleThreadReadPoll();
        return;
      }
      const thread = isRecord(result?.thread) ? result.thread : undefined;
      const status = isRecord(thread?.status) ? thread.status : undefined;
      const statusType = typeof status?.type === 'string' ? status.type : '';
      const turn = thread ? findRelevantTurn(thread) : null;
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      maybeAdoptAutoContinueTurnFromThreadRead(turnId, 'thread_read');
      const { finalText, lastText, turnStatus, errorText } = extractTurnMessages(turn);

      if (shouldIgnoreTurnScopedEvent(turnId, 'thread_read')) {
        log.appendEvent('THREAD_READ_STALE_TURN', {
          turnId: turnId || 'unknown',
          reason: 'turn_scope_ignored',
          turnStatus,
          statusType,
          finalTextLength: finalText.length,
          lastTextLength: lastText.length,
          activeTurnId,
          lastFinishedTurnId,
          completedCount: completedTurnIds.size,
          hasRunningTurn: hasRunningTurn()
        });
        scheduleThreadReadPoll();
        return;
      }

      if (isStaleCompletedTurn(turnId, finalText, turnStatus, statusType)) {
        log.appendEvent('THREAD_READ_STALE_TURN', {
          turnId: turnId || 'unknown',
          reason: 'stale_completed_turn',
          turnStatus,
          statusType,
          finalTextLength: finalText.length,
          lastTextLength: lastText.length,
          activeTurnId,
          lastFinishedTurnId,
          completedCount: completedTurnIds.size,
          hasRunningTurn: hasRunningTurn()
        });
        scheduleThreadReadPoll();
        return;
      }

      if (finalText) {
        log.appendEvent('THREAD_READ_FINAL_ANSWER', {
          turnId,
          finalTextLength: finalText.length,
          activeTurnId,
          lastFinishedTurnId
        });
        syncAssistantMessage(finalText);
        finalizeRunningTurn(finalText, turnId);
        return;
      }

      if (statusType === 'systemError') {
        log.appendEvent('THREAD_READ_SYSTEM_ERROR', {
          reason,
          turnId,
          turnStatus,
          errorText: errorText || null,
          lastTextLength: lastText.length,
          activeTurnId,
          lastFinishedTurnId
        });
        void reconcileSystemErrorTurn(`thread/read:${reason}`);
        return;
      }

      if (turnStatus === 'failed') {
        log.appendEvent('THREAD_READ_TERMINAL_TURN_OBSERVED', {
          reason,
          turnId,
          turnStatus,
          statusType,
          errorText: errorText || null,
          socketGenerationAtSend,
          activeTurnId,
          lastFinishedTurnId,
          ...summarizeRelevantTerminalNotificationObservation(turnId)
        });
        fail(mergeOutput(snapshot.liveBuffer, errorText || 'Codex 线程在 thread/read 中返回失败状态。'));
        return;
      }

      if (turnStatus === 'interrupted') {
        if (consumeExpectedInterruptedTurn(turnId)) {
          log.appendEvent('THREAD_READ_EXPECTED_INTERRUPT', {
            turnId,
            statusType,
            activeTurnId,
            lastFinishedTurnId
          });
          return;
        }
        log.appendEvent('THREAD_READ_TERMINAL_TURN_OBSERVED', {
          reason,
          turnId,
          turnStatus,
          statusType,
          errorText: errorText || null,
          socketGenerationAtSend,
          activeTurnId,
          lastFinishedTurnId,
          ...summarizeRelevantTerminalNotificationObservation(turnId)
        });
        noteInterruptedDiscoveredViaThreadReadOnly({
          reason,
          turnId,
          statusType,
          errorText: errorText || null,
          socketGenerationAtSend
        });
        fail(mergeOutput(snapshot.liveBuffer, errorText || 'Turn completed with status: interrupted'), {
          upstreamExecution: true
        });
        return;
      }

      if (statusType === 'idle' || turnStatus === 'completed') {
        const output = lastText || snapshot.liveBuffer || snapshot.checkpointOutput || '';
        if (lastText) {
          syncAssistantMessage(lastText);
        }
        log.appendEvent('THREAD_READ_IDLE_FINALIZE', {
          turnId,
          turnStatus,
          statusType,
          lastTextLength: lastText.length,
          activeTurnId,
          lastFinishedTurnId
        });
        finalizeRunningTurn(output, turnId);
        return;
      }

      scheduleThreadReadPoll();
    } catch (error) {
      if (shuttingDown || snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'CLOSING') return;
      if (isSocketDisconnectedError(error)) return;
      log.appendEvent('THREAD_READ_FAILED', {
        error: String(error),
        activeTurnId,
        lastFinishedTurnId,
        hasRunningTurn: hasRunningTurn()
      });
      if (options?.finalizeOnReadFailure && hasRunningTurn()) {
        finalizeRunningTurn(snapshot.liveBuffer || snapshot.checkpointOutput || '');
        return;
      }
      scheduleThreadReadPoll();
    }
  }

  function appendAssistantDelta(delta: string): void {
    const lastProgressAt = new Date().toISOString();
    snapshot = {
      ...snapshot,
      lifecycle: 'RUNNING_TURN',
      liveBuffer: snapshot.liveBuffer + delta,
      checkpointOutput: undefined,
      waitKind: undefined,
      waitOptions: undefined,
      lastProgressAt,
      logPath: log.path
    };
    log.appendRaw(delta);
    scheduleThreadReadPoll();
  }

  function handleAssistantDelta(event: AssistantDeltaEvent): void {
    if (!event.delta) return;
    if (shouldIgnoreTurnScopedEvent(event.turnId, 'assistant_delta')) return;
    if (shouldSkipAssistantDelta(event)) return;
    appendAssistantDelta(event.delta);
  }

  function syncAssistantMessage(text: string): void {
    if (!text) return;
    resetAssistantDeltaDedup();
    const current = snapshot.liveBuffer;
    if (text === current) return;
    if (text.startsWith(current)) {
      appendAssistantDelta(text.slice(current.length));
      return;
    }
    snapshot = {
      ...snapshot,
      lifecycle: 'RUNNING_TURN',
      liveBuffer: text,
      checkpointOutput: undefined,
      waitKind: undefined,
      waitOptions: undefined,
      lastProgressAt: new Date().toISOString(),
      logPath: log.path
    };
    if (current) {
      log.appendEvent('AGENT_MESSAGE_RESYNC', {
        currentLength: current.length,
        nextLength: text.length,
        activeTurnId,
        lastFinishedTurnId
      });
      if (!current.endsWith('\n') && !text.startsWith('\n')) {
        log.appendRaw('\n');
      }
    }
    log.appendRaw(text);
    scheduleThreadReadPoll();
  }

  function finalizeRunningTurn(output?: string, completedTurnId?: string | null): void {
    const finalizedTurnId = completedTurnId != null ? completedTurnId : activeTurnId != null ? activeTurnId : null;
    if (completedTurnId && shouldIgnoreTurnScopedEvent(completedTurnId, 'finalize_running_turn')) {
      return;
    }
    if (completedTurnId && completedTurnIds.has(completedTurnId)) {
      log.appendEvent('TURN_FINALIZE_SKIPPED', {
        reason: 'completed',
        completedTurnId,
        activeTurnId,
        lastFinishedTurnId
      });
      return;
    }
    if (finalizedTurnId && finalizedTurnId === lastFinishedTurnId) {
      log.appendEvent('TURN_FINALIZE_SKIPPED', {
        reason: 'last_finished',
        completedTurnId: finalizedTurnId,
        activeTurnId,
        lastFinishedTurnId
      });
      return;
    }
    if (!hasRunningTurn()) {
      log.appendEvent('TURN_FINALIZE_SKIPPED', {
        reason: 'no_running_turn',
        completedTurnId: finalizedTurnId,
        activeTurnId,
        lastFinishedTurnId,
        lifecycle: snapshot.lifecycle
      });
      return;
    }
    cancelThreadReadPoll();
    clearActiveTurnTracking();
    pendingRequest = null;
    const finalOutput = output != null ? output : snapshot.liveBuffer != null ? snapshot.liveBuffer : '';
    const naturalWait = detectWaitState(finalOutput);
    if (naturalWait) {
      rememberRetiredTurn(finalizedTurnId, true);
      snapshot = {
        ...snapshot,
        liveBuffer: finalOutput,
        checkpointOutput: undefined,
        logPath: log.path
      };
      setWaitingState(naturalWait.waitKind, finalOutput, naturalWait.waitOptions, finalizedTurnId);
      return;
    }
    finishTurn(finalOutput, finalizedTurnId);
  }

  function logUnhandledMethod(method: string): void {
    if (!/^(thread\/|turn\/|item\/|codex\/event\/)/.test(method)) return;
    if (seenUnhandledMethods.has(method)) return;
    seenUnhandledMethods.add(method);
    log.appendEvent('UNHANDLED_EVENT', method);
  }

  function setIdleState(output?: string): void {
    resetAssistantDeltaDedup();
    snapshot = {
      ...snapshot,
      lifecycle: 'IDLE',
      liveBuffer: '',
      checkpointOutput: output,
      waitKind: undefined,
      waitOptions: undefined,
      activeCommand: false,
      activeCommandCommand: undefined,
      activeCommandStartedAt: undefined,
      lastCommandProgressAt: undefined,
      lastProgressAt: new Date().toISOString(),
      logPath: log.path
    };
  }

  function clearFailureClassificationState(): void {
    approvalDeniedPendingFailure = false;
  }

  function resolveTaskFailureInterruptionKind(input?: FailureClassificationInput): CommunicateTaskInterruptionKind {
    const localComm = Boolean(input?.localComm);
    const approvalDenied = approvalDeniedPendingFailure;
    const upstreamExecution = Boolean(input?.upstreamExecution);
    const versionIncompatible = Boolean(input?.versionIncompatible);
    const capabilityMissing = Boolean(input?.capabilityMissing);
    if (versionIncompatible) return 'version_incompatible';
    if (capabilityMissing) return 'capability_missing';
    if (localComm && approvalDenied) return 'unknown';
    if (localComm) return 'local_comm';
    if (approvalDenied) return 'approval_denied';
    if (upstreamExecution) return 'upstream_execution';
    return 'unknown';
  }

  function setWaitingState(waitKind: CommunicateWaitKind, output: string, waitOptions?: string[], turnId?: string | null): void {
    cancelThreadReadPoll();
    snapshot = {
      ...snapshot,
      lifecycle: 'WAITING_USER',
      waitKind,
      waitOptions,
      checkpointOutput: output,
      activeCommand: false,
      activeCommandCommand: undefined,
      activeCommandStartedAt: undefined,
      lastCommandProgressAt: undefined,
      lastProgressAt: new Date().toISOString(),
      logPath: log.path
    };
    log.appendEvent('WAITING_USER', waitKind);
    emit({
      type: 'task_waiting_user',
      taskId: input.taskId as `T${number}`,
      turnId: turnId ?? activeTurnId ?? undefined,
      waitKind,
      waitOptions,
      output,
      waitHint: defaultWaitHint(input.taskId as `T${number}`, waitKind)
    });
  }
  function finishTurn(output: string, completedTurnId?: string | null): void {
    cancelThreadReadPoll();
    clearFailureClassificationState();
    rememberRetiredTurn(completedTurnId, true);
    setIdleState(output);
    log.appendEvent('TURN DONE', {
      completedTurnId,
      outputLength: output.length,
      lastFinishedTurnId
    });
    emit({
      type: 'task_finished',
      taskId: input.taskId as `T${number}`,
      turnId: completedTurnId ?? activeTurnId ?? undefined,
      output
    });
  }
  function fail(error: unknown, evidence?: FailureClassificationInput, turnId?: string | null): void {
    if (snapshot.lifecycle === 'FAILED' || snapshot.lifecycle === 'CLOSED') return;
    resetAssistantDeltaDedup();
    cancelThreadReadPoll();
    cancelSystemErrorReconcile();
    const message = buildFailureMessage(error);
    const interruptionKind = normalizeTaskInterruptionKind(resolveTaskFailureInterruptionKind(evidence));
    snapshot = {
      ...snapshot,
      lifecycle: 'FAILED',
      checkpointOutput: message || 'Codex app session failed.',
      waitKind: undefined,
      waitOptions: undefined,
      activeCommand: false,
      activeCommandCommand: undefined,
      activeCommandStartedAt: undefined,
      lastCommandProgressAt: undefined,
      lastProgressAt: new Date().toISOString(),
      logPath: log.path
    };
    log.appendEvent('TURN FAILED', snapshot.checkpointOutput ?? 'Codex app session failed.');
    emit({
      type: 'task_failed',
      taskId: input.taskId as `T${number}`,
      turnId: turnId ?? activeTurnId ?? undefined,
      output: snapshot.checkpointOutput ?? 'Codex app session failed.',
      interruptionKind
    });
    clearFailureClassificationState();
    void cleanupTransport('fail', turnId ?? activeTurnId ?? lastFinishedTurnId ?? null);
  }

  async function cleanupTransport(
    source: CleanupTransportSource,
    diagnosticTurnId: string | null = activeTurnId ?? lastFinishedTurnId ?? null
  ): Promise<void> {
    log.appendEvent('TRANSPORT_CLEANUP_REQUESTED', {
      source,
      hadSocket: Boolean(socket),
      hadTransportProxy: Boolean(transportProxy),
      hadChild: Boolean(child),
      terminalLookupTurnId: diagnosticTurnId,
      ...buildSessionDiagnosticContext(),
      ...summarizeRelevantTerminalNotificationObservation(diagnosticTurnId)
    });
    cancelThreadReadPoll();
    cancelSystemErrorReconcile();
    shuttingDown = true;
    pendingRequest = null;
    clearActiveTurnTracking();
    queuedBootstrapReply = null;
    for (const entry of pendingRpc.values()) {
      clearPendingRpcDiagnosticTimer(entry);
      entry.reject(new Error('Codex app session closed.'));
    }
    pendingRpc.clear();
    if (socket) {
      safeClose(socket);
      setActiveSocket(null);
    }
    let proxyClosePromise: Promise<void> | null = null;
    if (transportProxy) {
      const proxyToClose = transportProxy;
      transportProxy = null;
      proxyClosePromise = proxyToClose.close().catch(() => {
        // Best-effort cleanup for the diagnostic proxy.
      });
    }
    if (!child) {
      if (proxyClosePromise) {
        await proxyClosePromise;
      }
      return;
    }
    if (process.platform === 'win32' && typeof child.pid === 'number' && Number.isFinite(child.pid)) {
      log.appendEvent('CHILD_KILL_REQUESTED', {
        source,
        strategy: 'kill_process_tree',
        childPid: child.pid,
        ...buildSessionDiagnosticContext()
      });
      try {
        killProcessTree(child.pid);
        if (proxyClosePromise) {
          await proxyClosePromise;
        }
        return;
      } catch {
      }
    }
    if (child.kill) {
      log.appendEvent('CHILD_KILL_REQUESTED', {
        source,
        strategy: 'child.kill',
        childPid: child.pid ?? null,
        ...buildSessionDiagnosticContext()
      });
      try {
        child.kill();
      } catch {
      }
    }
    if (proxyClosePromise) {
      await proxyClosePromise;
    }
  }

  function handleChildExit(code: number | null): void {
    const exitSummary = code == null ? 'Codex app-server exited unexpectedly.' : `Codex app-server exited with code ${code}.`;
    const duringStartup = startupInFlight;
    const nowMs = Date.now();
    lastChildExitAtMs = nowMs;
    lastChildExitAt = new Date(nowMs).toISOString();
    lastChildExitCode = code;
    if (!shuttingDown && snapshot.lifecycle !== 'CLOSED') {
      noteStartupChildExit(code, exitSummary);
      log.appendEvent('CHILD_EXIT', {
        code,
        summary: exitSummary,
        duringStartup,
        childPid: startupChildPid,
        afterMs: startupChildExit?.afterMs ?? null,
        ...buildSessionDiagnosticContext(),
        ...buildTransportActivityDiagnosticContext(),
        ...summarizeRelevantTerminalNotificationObservation(activeTurnId ?? lastFinishedTurnId ?? null)
      });
    }
    if (shuttingDown || snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'FAILED') return;
    fail(exitSummary, { localComm: true });
  }

  function handleSocketMessage(raw: unknown, sourceSocket?: CodexAppWebSocketLike): void {
    const message = parseRpcMessage(raw);
    const frameSummary = summarizeRawSocketFrame(raw, message);
    if (sourceSocket && socket !== sourceSocket) {
      logIgnoredSocketFrame('stale_socket', sourceSocket, frameSummary);
      return;
    }
    if (snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'FAILED' || shuttingDown) {
      return;
    }
    logRawSocketFrame('in', raw, message);
    if (!message) return;

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const responseIdKey = hasId ? toPendingRpcKey(message.id) : null;
    const isRpcResponseLike =
      hasId &&
      (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
    const matchedEntry = responseIdKey ? pendingRpc.get(responseIdKey) : undefined;
    if (isRpcResponseLike) {
      log.appendEvent(
        'RPC_RESPONSE_OBSERVED',
        buildRpcResponseObservedPayload({
          message,
          responseIdKey,
          matchedEntry,
          payloadBytes: typeof frameSummary.payloadBytes === 'number' ? frameSummary.payloadBytes : null
        })
      );
      log.appendEvent('RPC_MATCH_DECISION', {
        rawId: message.id as RpcId,
        rawIdType: typeof message.id,
        normalizedId: responseIdKey,
        matched: Boolean(matchedEntry),
        method: matchedEntry?.method ?? null,
        matchedThreadIdAtSend: matchedEntry?.threadIdAtSend ?? null,
        matchedTurnIdAtSend: matchedEntry?.turnIdAtSend ?? null,
        matchedTurnRequestSerialAtSend: matchedEntry?.turnRequestSerialAtSend ?? null,
        matchedSocketGenerationAtSend: matchedEntry?.socketGenerationAtSend ?? null,
        matchedDiagReqKey: matchedEntry?.diagReqKey ?? null,
        pendingRpcCount: pendingRpc.size,
        pendingRpcKeys: listPendingRpcKeys(8)
      });
    }

    if (responseIdKey && pendingRpc.has(responseIdKey)) {
      const entry = matchedEntry;
      pendingRpc.delete(responseIdKey);
      if (entry) {
        clearPendingRpcDiagnosticTimer(entry);
        noteSocketInbound({
          kind: 'rpc_response',
          method: entry.method,
          id: entry.requestId
        });
      }
      if (message.error) {
        const rpcError = createRpcResponseError(message.error, entry?.method ?? null);
        log.appendEvent('RPC_REJECT', {
          id: entry?.requestId ?? (message.id as RpcId),
          method: entry?.method ?? 'unknown',
          durationMs: entry ? Math.max(0, Date.now() - entry.startedAtMs) : undefined,
          error: rpcError.message,
          errorCode: rpcError.code
        });
        noteRpcSettled(entry?.method ?? 'unknown', 'reject');
        entry?.reject(rpcError);
        return;
      }
      log.appendEvent('RPC_RESOLVE', {
        id: entry?.requestId ?? (message.id as RpcId),
        method: entry?.method ?? 'unknown',
        durationMs: entry ? Math.max(0, Date.now() - entry.startedAtMs) : undefined,
        ...summarizeRpcResult(message.result)
      });
      noteRpcSettled(entry?.method ?? 'unknown', 'resolve');
      entry?.resolve(message.result);
      return;
    }

    if (isRpcResponseLike) {
      noteSocketInbound({
        kind: 'orphan_rpc_response',
        id: (message.id as RpcId) ?? null
      });
      noteOrphanResponse(message.id as RpcId);
      log.appendEvent('RPC_ORPHAN_RESPONSE', {
        id: message.id as RpcId,
        normalizedId: responseIdKey,
        rawIdType: typeof message.id,
        payloadBytes: typeof frameSummary.payloadBytes === 'number' ? frameSummary.payloadBytes : null,
        pendingRpcCount: pendingRpc.size,
        pendingMethods: listPendingRpcMethods(8),
        ...(message.error
          ? {
              error: String(
                isRecord(message.error)
                  ? (message.error.message ?? JSON.stringify(message.error))
                  : message.error
              )
            }
          : summarizeRpcResult(message.result))
      });
      return;
    }

    if (typeof message.method !== 'string') return;
    noteSocketInbound({
      kind: 'notification',
      method: message.method,
      id: responseIdKey ?? null
    });
    const params = isRecord(message.params) ? message.params : {};
    if (pendingRpc.size > 0) {
      log.appendEvent('SOCKET_NOTIFY_PENDING_RPC', {
        method: message.method,
        activeTurnId,
        pendingRpcCount: pendingRpc.size,
        pendingMethods: listPendingRpcMethods(),
        ...summarizeSocketNotification(params)
      });
    }

    if (message.method === 'thread/started') {
      const thread = isRecord(params.thread) ? params.thread : undefined;
      const nextThreadId = typeof thread?.id === 'string' ? thread.id : null;
      if (nextThreadId) setThreadId(nextThreadId);
      return;
    }

    if (message.method === 'thread/status/changed') {
      const status = isRecord(params.status) ? params.status : undefined;
      const statusType = typeof status?.type === 'string' ? status.type : '';
      const runningTurn = hasRunningTurn();
      const action =
        statusType === 'idle' && runningTurn
          ? 'poll_thread_read'
          : statusType === 'systemError'
            ? 'reconcile_system_error'
            : 'none';
      if (statusType === 'idle' || statusType === 'systemError') {
        log.appendEvent('THREAD_STATUS_CHANGED', {
          statusType,
          action,
          hasRunningTurn: runningTurn,
          ...buildSessionDiagnosticContext()
        });
      }
      if (statusType === 'idle' && hasRunningTurn()) {
        void pollThreadRead('thread/status/changed:idle', { finalizeOnReadFailure: true });
        return;
      }
      if (statusType === 'systemError') {
        void reconcileSystemErrorTurn('thread/status/changed:systemError');
        return;
      }
      return;
    }

    if (message.method === 'turn/started') {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      const nextTurnId = typeof turn?.id === 'string' ? turn.id : null;
      if (!hasRunningTurn()) {
        log.appendEvent('TURN_STARTED_IGNORED', {
          nextTurnId,
          activeTurnId,
          turnStartPending,
          activeTurnRequestSerial,
          reason: 'no_running_turn'
        });
        return;
      }
      const shouldAdoptTurnId = Boolean(nextTurnId) && (turnStartPending || !activeTurnId || nextTurnId === activeTurnId);
      if (nextTurnId && !shouldAdoptTurnId) {
        log.appendEvent('TURN_STARTED_IGNORED', {
          nextTurnId,
          activeTurnId,
          turnStartPending,
          activeTurnRequestSerial,
          reason: 'turn_id_mismatch'
        });
        return;
      }
      turnStartPending = false;
      if (nextTurnId) activeTurnId = nextTurnId;
      markSystemErrorAutoContinueRecovered(nextTurnId, 'turn/started');
      resetAssistantDeltaDedup();
      snapshot = {
        ...snapshot,
        lifecycle: 'RUNNING_TURN',
        checkpointOutput: undefined,
        waitKind: undefined,
        waitOptions: undefined,
        lastProgressAt: new Date().toISOString(),
        logPath: log.path
      };
      scheduleThreadReadPoll();
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      handleAssistantDelta({
        source: 'item',
        turnId: typeof params.turnId === 'string' ? params.turnId : null,
        itemId: typeof params.itemId === 'string' ? params.itemId : null,
        delta: typeof params.delta === 'string' ? params.delta : ''
      });
      return;
    }

    if (message.method === 'codex/event/agent_message_content_delta') {
      const msg = isRecord(params.msg) ? params.msg : undefined;
      handleAssistantDelta({
        source: 'content',
        turnId: typeof msg?.turn_id === 'string' ? msg.turn_id : null,
        itemId: typeof msg?.item_id === 'string' ? msg.item_id : null,
        delta: typeof msg?.delta === 'string' ? msg.delta : ''
      });
      return;
    }

    if (message.method === 'codex/event/agent_message_delta') {
      const msg = isRecord(params.msg) ? params.msg : undefined;
      handleAssistantDelta({
        source: 'legacy',
        turnId: typeof params.id === 'string' ? params.id : null,
        itemId: null,
        delta: typeof msg?.delta === 'string' ? msg.delta : ''
      });
      return;
    }

    if (message.method === 'item/commandExecution/outputDelta' || message.method === 'item/fileChange/outputDelta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        markCommandProgress();
        if (!diagSkipOutputDeltaRawLog) {
          log.appendRaw(delta);
        }
        scheduleThreadReadPoll();
      }
      return;
    }

    if (message.method === 'codex/event/exec_command_output_delta') {
      const msg = isRecord(params.msg) ? params.msg : undefined;
      const delta = typeof msg?.delta === 'string' ? msg.delta : '';
      if (delta) {
        markCommandProgress();
        if (!diagSkipOutputDeltaRawLog) {
          log.appendRaw(delta);
        }
        scheduleThreadReadPoll();
      }
      return;
    }

    if (message.method === 'codex/event/exec_command_begin') {
      const msg = isRecord(params.msg) ? params.msg : undefined;
      const commandText = typeof msg?.command === 'string' ? msg.command : '';
      if (commandText) {
        markCommandStarted(commandText);
        log.appendEvent('COMMAND BEGIN', commandText);
        scheduleThreadReadPoll();
      }
      return;
    }

    if (message.method === 'item/completed') {
      const item = isRecord(params.item) ? params.item : undefined;
      if (typeof item?.type === 'string' && (item.type === 'commandExecution' || item.type === 'fileChange')) {
        touchProgress();
        clearActiveCommand();
        log.appendEvent('COMMAND COMPLETED', {
          turnId: typeof params.turnId === 'string' ? params.turnId : null,
          itemType: item.type
        });
        scheduleThreadReadPoll();
        return;
      }
      if (typeof item?.type === 'string' && item.type === 'agentMessage') {
        const phase = typeof item.phase === 'string' ? item.phase : '';
        const nextText = extractAgentMessageText(item);
        const completedTurnId = typeof params.turnId === 'string' ? params.turnId : null;
        log.appendEvent('ITEM_COMPLETED', {
          turnId: completedTurnId,
          phase,
          textLength: nextText.length
        });
        if (shouldIgnoreTurnScopedEvent(completedTurnId, 'item_completed_agent_message')) {
          return;
        }
        if (phase === 'final_answer' && nextText) {
          finalizeRunningTurn(nextText, completedTurnId);
          return;
        }
        if (nextText) syncAssistantMessage(nextText);
        scheduleThreadReadPoll();
      }
      return;
    }

    if (message.method === 'codex/event/agent_message') {
      const msg = isRecord(params.msg) ? params.msg : undefined;
      const phase = typeof msg?.phase === 'string' ? msg.phase : '';
      const nextText = typeof msg?.message === 'string' ? msg.message : '';
      const messageTurnId = typeof msg?.turn_id === 'string' ? msg.turn_id : null;
      log.appendEvent('AGENT_MESSAGE', {
        turnId: messageTurnId,
        phase,
        textLength: nextText.length
      });
      if (shouldIgnoreTurnScopedEvent(messageTurnId, 'agent_message')) {
        return;
      }
      if (phase === 'final_answer' && nextText) {
        finalizeRunningTurn(nextText, messageTurnId);
        return;
      }
      if (nextText) syncAssistantMessage(nextText);
      return;
    }

    if (message.method === 'codex/event/task_complete') {
      const msg = isRecord(params.msg) ? params.msg : undefined;
      const lastAgentMessage = typeof msg?.last_agent_message === 'string' ? msg.last_agent_message : '';
      const completedTurnId = typeof msg?.turn_id === 'string' ? msg.turn_id : null;
      log.appendEvent('TASK_COMPLETE_EVENT', {
        turnId: completedTurnId,
        lastTextLength: lastAgentMessage.length
      });
      if (shouldIgnoreTurnScopedEvent(completedTurnId, 'task_complete')) {
        return;
      }
      finalizeRunningTurn(
        lastAgentMessage || snapshot.liveBuffer || snapshot.checkpointOutput || '',
        completedTurnId
      );
      return;
    }

    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      pendingRequest = {
        id: message.id as RpcId,
        kind: 'approval',
        requestType: message.method,
        params
      };
      const prompt =
        message.method === 'item/commandExecution/requestApproval'
          ? formatCommandApprovalPrompt(params)
          : formatFileChangeApprovalPrompt(params);
      log.appendEvent('APPROVAL_REQUESTED', message.method);
      const requestTurnId = typeof params.turnId === 'string' ? params.turnId : activeTurnId;
      setWaitingState('confirm', mergeOutput(snapshot.liveBuffer, prompt), undefined, requestTurnId);
      return;
    }

    if (message.method === 'item/tool/requestUserInput') {
      pendingRequest = {
        id: message.id as RpcId,
        kind: 'user_input',
        params: {
          questions: Array.isArray(params.questions) ? (params.questions as Array<any>) : []
        }
      };
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const waitOptions = collectWaitOptions(questions);
      const waitKind: CommunicateWaitKind = waitOptions.length > 0 ? 'choice' : 'text_input';
      const requestTurnId = typeof params.turnId === 'string' ? params.turnId : activeTurnId;
      setWaitingState(
        waitKind,
        mergeOutput(snapshot.liveBuffer, formatUserInputPrompt(questions)),
        waitOptions.length > 0 ? waitOptions : undefined,
        requestTurnId
      );
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : undefined;
      const status = typeof turn?.status === 'string' ? turn.status : 'completed';
      const errorText = extractTurnError(turn?.error);
      const completedTurnId = typeof turn?.id === 'string' ? turn.id : null;
      log.appendEvent('TURN_COMPLETED_EVENT', {
        turnId: completedTurnId,
        status,
        error: errorText
      });
      if (status === 'interrupted' && consumeExpectedInterruptedTurn(completedTurnId)) {
        log.appendEvent('TURN_COMPLETED_EXPECTED_INTERRUPT', {
          turnId: completedTurnId
        });
        return;
      }
      if (shouldIgnoreTurnScopedEvent(completedTurnId, 'turn_completed')) {
        return;
      }
      noteTerminalNotificationObservation({
        rawMethod: 'turn/completed',
        turnId: completedTurnId,
        status,
        errorText: errorText || null
      });
      if (status === 'completed' && !errorText) {
        finalizeRunningTurn(snapshot.liveBuffer, completedTurnId);
        return;
      }
      clearActiveTurnTracking({ preserveFailureSeed: true });
      pendingRequest = null;
      fail(
        mergeOutput(snapshot.liveBuffer, errorText || `Turn completed with status: ${status}`),
        {
          upstreamExecution: status === 'interrupted'
        },
        completedTurnId
      );
      return;
    }

    if (message.method === 'turn_aborted' || message.method === 'turn/aborted') {
      const abortedTurnId = typeof params.turnId === 'string' ? params.turnId : null;
      const errorText = typeof params.error === 'string' ? params.error : '';
      if (consumeExpectedInterruptedTurn(abortedTurnId)) {
        log.appendEvent('TURN_ABORTED_EXPECTED_INTERRUPT', {
          turnId: abortedTurnId
        });
        return;
      }
      if (shouldIgnoreTurnScopedEvent(abortedTurnId, 'turn_aborted')) {
        return;
      }
      noteTerminalNotificationObservation({
        rawMethod: message.method,
        turnId: abortedTurnId,
        status: 'aborted',
        errorText: errorText || null
      });
      clearActiveTurnTracking({ preserveFailureSeed: true });
      pendingRequest = null;
      fail(
        mergeOutput(snapshot.liveBuffer, errorText || 'Turn aborted.'),
        {
          upstreamExecution: true
        },
        abortedTurnId
      );
      return;
    }

    logUnhandledMethod(message.method);
  }

  async function request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!socket || socket.readyState !== 1) {
      throw createSocketDisconnectedError(socketRecoveryInFlight ? 'recovering' : 'not_connected');
    }
    const activeSocket = socket;
    const id = rpcId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return await new Promise((resolve, reject) => {
      const entryKey = toPendingRpcKey(id) ?? String(id);
      const threadIdAtSend =
        typeof params.threadId === 'string' ? params.threadId : typeof threadId === 'string' ? threadId : null;
      const rawPayload = JSON.stringify(payload);
      const entry = {
        requestId: id,
        resolve,
        reject,
        method,
        startedAtMs: Date.now(),
        threadIdAtSend,
        turnIdAtSend: activeTurnId,
        turnRequestSerialAtSend: activeTurnRequestSerial,
        socketGenerationAtSend: activeSocketGeneration,
        diagReqKey: buildRpcDiagKey({
          threadId: threadIdAtSend,
          requestId: id,
          turnIdAtSend: activeTurnId,
          turnRequestSerialAtSend: activeTurnRequestSerial,
          socketGenerationAtSend: activeSocketGeneration
        }),
        payloadBytes: Buffer.byteLength(rawPayload, 'utf8'),
        diagnosticTimer: null,
        longPendingLogged: false
      };
      pendingRpc.set(entryKey, entry);
      log.appendEvent('RPC_SEND', {
        id,
        method,
        pendingRpcCount: pendingRpc.size,
        ...summarizeRpcParams(method, params)
      });
      if (method === 'thread/read') {
        log.appendEvent('RPC_SEND_ATTEMPT', buildRpcSendDiagnosticPayload(entry, activeSocket));
      }
      logRawSocketFrame('out', rawPayload, payload);
      try {
        activeSocket.send(rawPayload);
        noteSocketOutbound(method, id);
        if (method === 'thread/read') {
          log.appendEvent('RPC_SEND_SYNC_OK', buildRpcSendDiagnosticPayload(entry, activeSocket));
        }
        schedulePendingRpcDiagnostic(entryKey);
      } catch (error) {
        pendingRpc.delete(entryKey);
        clearPendingRpcDiagnosticTimer(entry);
        const baseError = error instanceof Error ? error : new Error(String(error));
        const normalizedError = createSocketSendError(baseError);
        if (method === 'thread/read') {
          log.appendEvent('RPC_SEND_SYNC_THROW', {
            ...buildRpcSendDiagnosticPayload(entry, activeSocket),
            error: normalizedError.message
          });
        }
        log.appendEvent('RPC_REJECT', {
          id,
          method,
          durationMs: Math.max(0, Date.now() - entry.startedAtMs),
          error: normalizedError.message
        });
        noteRpcSettled(method, 'reject');
        reject(normalizedError);
      }
    });
  }

  function respond(id: RpcId, result: Record<string, unknown>): void {
    if (!socket || socket.readyState !== 1) {
      throw createSocketDisconnectedError(socketRecoveryInFlight ? 'recovering' : 'not_connected');
    }
    const payload = { jsonrpc: '2.0', id, result };
    const rawPayload = JSON.stringify(payload);
    logRawSocketFrame('out', rawPayload, payload);
    socket.send(rawPayload);
  }

  async function interruptCurrentTurn(): Promise<CodexSessionInterruptResult> {
    if (snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'CLOSING') {
      throw new Error('Codex app session is already closed.');
    }
    if (snapshot.lifecycle === 'FAILED') {
      throw new Error('Codex app session has already failed.');
    }
    if (!threadId || (!activeTurnId && !turnStartPending && snapshot.lifecycle !== 'RUNNING_TURN')) {
      return { interrupted: false, turnId: activeTurnId };
    }
    if (!activeTurnId) {
      log.appendEvent('TURN INTERRUPT SKIPPED', 'turn id unavailable');
      return { interrupted: false, turnId: null };
    }
    const turnIdToInterrupt = activeTurnId;
    const interruptSource: TurnInterruptSource = 'manual_interrupt';
    log.appendEvent('TURN_INTERRUPT_REQUESTED', {
      source: interruptSource,
      turnId: turnIdToInterrupt,
      ...buildSessionDiagnosticContext()
    });
    await Promise.race([
      request('turn/interrupt', { threadId, turnId: turnIdToInterrupt }),
      delay(closeTimeoutMs).then(() => {
        throw new Error('turn/interrupt timed out');
      })
    ]);
    expectedInterruptedTurnIds.add(turnIdToInterrupt);
    rememberRetiredTurn(turnIdToInterrupt);
    clearActiveTurnTracking();
    pendingRequest = null;
    clearFailureClassificationState();
    setIdleState('当前运行已打断，等待下一步指令。');
    log.appendEvent('TURN INTERRUPTED', turnIdToInterrupt);
    return { interrupted: true, turnId: turnIdToInterrupt };
  }

  async function startAsync(): Promise<void> {
    beginStartupDiagnostics(socketRetryLimit);
    let listenUrl = '';
    let connectUrl = '';
    let preparedCommand: ReturnType<typeof prepareCodexSpawnCommand> | null = null;
    try {
      const port = await allocateStartupPort();
      listenUrl = `ws://127.0.0.1:${port}`;
      connectUrl = listenUrl;
      if (isTcpProxyDiagEnabled()) {
        let proxyPort = await allocateStartupPort();
        while (proxyPort === port) {
          proxyPort = await allocateStartupPort();
        }
        transportProxy = await startSocketTapProxy({
          listenPort: proxyPort,
          targetPort: port,
          log: (event, detail) => log.appendEvent(event, detail)
        });
        connectUrl = `ws://127.0.0.1:${proxyPort}`;
        log.appendEvent('TCP_PROXY_ENABLED', {
          upstreamUrl: listenUrl,
          connectUrl,
          proxyListenPort: proxyPort,
          upstreamPort: port
        });
      }
      socketUrl = connectUrl;
      const [rawCommand, ...rawCommandArgs] = input.command;
      preparedCommand = prepareCodexSpawnCommand(rawCommand ?? 'codex', rawCommandArgs);
    } catch (error) {
      fail(error, { localComm: true });
      return;
    }

    if (!preparedCommand) {
      fail(new Error('Codex app-server spawn command was not prepared.'), { localComm: true });
      return;
    }
    try {
      child = spawnFactory(preparedCommand.command, [...preparedCommand.args, 'app-server', '--listen', listenUrl], {
        cwd: input.cwd,
        shell: preparedCommand.shell
      });
      noteStartupChildSpawned(child.pid);
      log.appendEvent('CHILD_SPAWNED', {
        pid: startupChildPid,
        duringStartup: true,
        listenUrl
      });
    } catch (error) {
      log.appendEvent('SPAWN_FAILED', formatSpawnError(error, {
        command: preparedCommand.command,
        args: [...preparedCommand.args, 'app-server', '--listen', listenUrl],
        cwd: input.cwd,
        shell: preparedCommand.shell
      }));
      fail(error, { localComm: true });
      return;
    }

    child.stdout.on('data', (chunk) => appendProcessLog(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => appendProcessLog(chunk, 'stderr'));
    child.on('error', (error: Error) => {
      if (!shuttingDown && snapshot.lifecycle !== 'CLOSED') {
        startupChildError = describeStartupUnknownError(error);
        log.appendEvent('CHILD_ERROR', {
          message: startupChildError,
          duringStartup: startupInFlight,
          childPid: startupChildPid,
          ...buildSessionDiagnosticContext(),
          ...buildTransportActivityDiagnosticContext(),
          ...summarizeRelevantTerminalNotificationObservation(activeTurnId ?? lastFinishedTurnId ?? null)
        });
      }
      if (shuttingDown || snapshot.lifecycle === 'FAILED' || snapshot.lifecycle === 'CLOSED') return;
      fail(error, { localComm: true });
    });
    child.on('exit', handleChildExit);

    let startupPhase: StartupFailurePhase = 'websocket/open';
    try {
      const connectedSocket = await connectWebSocketWithRetry(connectUrl, createWebSocket, (payload, sourceSocket) => handleSocketMessage(payload, sourceSocket), {
        maxAttempts: socketRetryLimit,
        retryDelayMs: socketRetryDelayMs,
        openTimeoutMs: socketOpenTimeoutMs,
        onAttemptFailure: ({ attempt, error }) => {
          noteStartupSocketFailure(attempt, error);
        }
      });
      setActiveSocket(connectedSocket);
      if (isSessionInactiveForAsyncWork()) {
        safeClose(connectedSocket);
        setActiveSocket(null);
        return;
      }
      attachRuntimeSocketListeners(connectedSocket);
      startupPhase = 'initialize';
      const initializeResult = await request('initialize', {
        clientInfo: { name: 'communicate-feishu', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      });
      ensureInitializeCompatibility(initializeResult);
    } catch (error) {
      if (isSessionInactiveForAsyncWork()) {
        return;
      }
      const startupError = startupPhase === 'initialize' ? maybePromoteInitializeRpcFailure(error) : error;
      failStartup(startupError, listenUrl, startupPhase, resolveRpcFailureEvidence(startupError));
      return;
    }

    try {
      if (startupMode === 'resume') {
        if (!input.resumeThreadId) {
          throw new Error('Codex app session resume requires a thread ID.');
        }
        const threadResume = await request('thread/resume', {
          threadId: input.resumeThreadId,
          cwd: input.cwd,
          approvalPolicy,
          sandbox,
          ...(initialModel ? { model: initialModel } : {}),
          ...assistantPersonaParams
        });
        ensureStartupCompatibility(threadResume, 'thread/resume');
        setModel(isRecord(threadResume) ? (threadResume.model as string | undefined) : undefined);
        const thread = isRecord(threadResume?.thread) ? threadResume.thread : undefined;
        setThreadId(typeof thread?.id === 'string' ? thread.id : input.resumeThreadId);
      } else {
        const threadStart = await request('thread/start', {
          cwd: input.cwd,
          approvalPolicy,
          sandbox,
          ...(initialModel ? { model: initialModel } : {}),
          ...(input.ephemeral ? { ephemeral: true } : {}),
          ...assistantPersonaParams
        });
        ensureStartupCompatibility(threadStart, 'thread/start');
        setModel(isRecord(threadStart) ? (threadStart.model as string | undefined) : undefined);
        const thread = isRecord(threadStart?.thread) ? threadStart.thread : undefined;
        setThreadId(typeof thread?.id === 'string' ? thread.id : null);
      }
      if (isSessionInactiveForAsyncWork()) {
        return;
      }
      completeStartupDiagnostics();
      if (queuedBootstrapReply) {
        const bootstrapReply = queuedBootstrapReply;
        queuedBootstrapReply = null;
        startTurnFromReply(bootstrapReply, { logInput: false, source: 'bootstrap_reply' });
      } else {
        setIdleState(startupMode === 'resume' ? 'Codex 会话已恢复，等待你的任务描述。' : 'Codex 会话已启动，等待你的任务描述。');
        log.appendEvent(startupMode === 'resume' ? 'SESSION RESUMED' : 'SESSION READY');
      }
    } catch (error) {
      if (isSessionInactiveForAsyncWork()) {
        return;
      }
      const startupError = maybePromoteStartupRpcFailure(
        error,
        startupMode === 'resume' ? 'thread/resume' : 'thread/start'
      );
      failStartup(
        startupError,
        listenUrl,
        startupMode === 'resume' ? 'thread/resume' : 'thread/start',
        resolveRpcFailureEvidence(startupError)
      );
    }
  }

  function startTurnFromReply(
    reply: CodexReplyPayload,
    options?: { logInput?: boolean; allowConcurrent?: boolean; source?: TurnStartRequestSource }
  ): void {
    if (!threadId) {
      throw new Error('Codex app session has not finished initialization.');
    }
    if ((activeTurnId || turnStartPending) && !options?.allowConcurrent) {
      throw new Error('Codex app session already has a running turn.');
    }
    const text = replyToText(reply);
    resetAssistantDeltaDedup();
    clearFailureClassificationState();
    if (options?.logInput !== false) {
      log.appendEvent('FEISHU IN', text);
    }
    log.appendEvent('TURN START');
    const activeTurnIdBeforeStart = activeTurnId;
    const turnStartPendingBeforeStart = turnStartPending;
    const turnRequestSerial = beginTurnTracking();
    log.appendEvent('TURN_START_REQUESTED', {
      source: options?.source ?? 'user_reply',
      turnRequestSerial,
      replyAction: reply.action,
      inputLength: text.length,
      allowConcurrent: Boolean(options?.allowConcurrent),
      logInput: options?.logInput !== false,
      activeTurnIdBeforeStart,
      turnStartPendingBeforeStart,
      ...buildSessionDiagnosticContext()
    });
    turnStartPending = true;
    snapshot = {
      ...snapshot,
      lifecycle: 'RUNNING_TURN',
      liveBuffer: '',
      checkpointOutput: undefined,
      waitKind: undefined,
      waitOptions: undefined,
      logPath: log.path
    };
    scheduleThreadReadPoll();
    void request('turn/start', {
      threadId,
      input: [{ type: 'text', text }]
    })
      .then((result) => {
        if (isSessionInactiveForAsyncWork()) {
          return;
        }
        if (turnRequestSerial !== activeTurnRequestSerial || !hasRunningTurn()) {
          log.appendEvent('TURN_START_RESULT_IGNORED', {
            reason: turnRequestSerial !== activeTurnRequestSerial ? 'turn_request_serial_mismatch' : 'no_running_turn',
            turnRequestSerial,
            activeTurnRequestSerial,
            activeTurnId,
            lifecycle: snapshot.lifecycle
          });
          return;
        }
        const turn = isRecord(result?.turn) ? result.turn : undefined;
        activeTurnId = typeof turn?.id === 'string' ? turn.id : activeTurnId;
        turnStartPending = false;
        markSystemErrorAutoContinueRecovered(activeTurnId, 'turn/start_result');
        scheduleThreadReadPoll();
      })
      .catch((error) => {
        if (isSessionInactiveForAsyncWork()) {
          return;
        }
        if (turnRequestSerial !== activeTurnRequestSerial || !hasRunningTurn()) {
          log.appendEvent('TURN_START_RESULT_IGNORED', {
            reason: turnRequestSerial !== activeTurnRequestSerial ? 'turn_request_serial_mismatch' : 'no_running_turn',
            turnRequestSerial,
            activeTurnRequestSerial,
            activeTurnId,
            lifecycle: snapshot.lifecycle,
            error: String(error)
          });
          return;
        }
        if (isSocketDisconnectedError(error)) {
          log.appendEvent('TURN_START_WAIT_FOR_SOCKET_RECOVERY');
          return;
        }
        turnStartPending = false;
        const turnStartError = maybePromoteTurnStartRpcFailure(error);
        fail(turnStartError, resolveRpcFailureEvidence(turnStartError));
      });
  }

  async function close(): Promise<CodexSessionCloseResult> {
    if (snapshot.lifecycle === 'CLOSED') {
      return { forced: false };
    }

    snapshot = {
      ...snapshot,
      lifecycle: 'CLOSING',
      waitKind: undefined,
      waitOptions: undefined,
      logPath: log.path
    };
    log.appendEvent('SESSION CLOSING');

    let forced = false;
    if ((activeTurnId || turnStartPending) && threadId) {
      if (activeTurnId) {
        const turnIdToInterrupt = activeTurnId;
        const interruptSource: TurnInterruptSource = 'close';
        log.appendEvent('TURN_INTERRUPT_REQUESTED', {
          source: interruptSource,
          turnId: turnIdToInterrupt,
          ...buildSessionDiagnosticContext()
        });
        try {
          await Promise.race([
            request('turn/interrupt', { threadId, turnId: turnIdToInterrupt }),
            delay(closeTimeoutMs).then(() => {
              throw new Error('turn/interrupt timed out');
            })
          ]);
          log.appendEvent('TURN INTERRUPTED', turnIdToInterrupt);
        } catch (error) {
          forced = true;
          log.appendEvent('TURN INTERRUPT FAILED', String(error));
        }
      } else {
        forced = true;
        log.appendEvent('TURN INTERRUPT SKIPPED', 'turn id unavailable');
      }
    }

    await cleanupTransport('close', activeTurnId ?? lastFinishedTurnId ?? null);
    clearActiveTurnTracking();
    pendingRequest = null;
    snapshot = {
      ...snapshot,
      lifecycle: 'CLOSED',
      liveBuffer: '',
      waitKind: undefined,
      waitOptions: undefined,
      checkpointOutput: snapshot.checkpointOutput ?? 'Codex 会话已关闭。',
      logPath: log.path
    };
    log.appendEvent(forced ? 'SESSION FORCE_CLOSED' : 'SESSION CLOSED');
    logWindow?.close();
    log.close();
    return { forced };
  }

  return {
    start() {
      if (!startPromise) {
        startPromise = startAsync();
      }
      return startPromise;
    },

    sendReply(reply: CodexReplyPayload) {
      if (snapshot.lifecycle === 'CLOSED' || snapshot.lifecycle === 'CLOSING') {
        throw new Error('Codex app session is already closed.');
      }
      if (snapshot.lifecycle === 'FAILED') {
        throw new Error('Codex app session has already failed.');
      }
      if (pendingRequest) {
        const current = pendingRequest;
        pendingRequest = null;
        snapshot = {
          ...snapshot,
          lifecycle: 'RUNNING_TURN',
          checkpointOutput: undefined,
          waitKind: undefined,
          waitOptions: undefined,
          logPath: log.path
        };
        log.appendEvent('FEISHU IN', replyToText(reply));
        if (current.kind === 'approval') {
          approvalDeniedPendingFailure = reply.action === 'confirm' && reply.value === 'deny';
          respond(current.id, {
            decision: reply.action === 'confirm' && reply.value === 'deny' ? 'decline' : 'accept'
          });
          scheduleThreadReadPoll();
          return;
        }
        clearFailureClassificationState();
        respond(current.id, buildUserInputResponse(current.params.questions ?? [], reply));
        scheduleThreadReadPoll();
        return;
      }
      if (activeTurnId || turnStartPending) {
        log.appendEvent('TURN CONCURRENT_INPUT', replyToText(reply));
        startTurnFromReply(reply, { allowConcurrent: true, source: 'concurrent_user_reply' });
        return;
      }

      if (!threadId) {
        if (queuedBootstrapReply) {
          throw new Error('Codex 会话仍在启动中，请稍后再试。');
        }
        queuedBootstrapReply = reply;
        snapshot = {
          ...snapshot,
          lifecycle: 'STARTING',
          checkpointOutput: undefined,
          waitKind: undefined,
          waitOptions: undefined,
          logPath: log.path
        };
        log.appendEvent('FEISHU IN', replyToText(reply));
        return;
      }

      startTurnFromReply(reply);
    },

    close,

    interruptCurrentTurn,

    recordStallDiagnostic,

    getLogPath() {
      return log.path;
    },

    getSnapshot(): CodexSessionSnapshot {
      return {
        ...snapshot,
        activeTurnId: activeTurnId ?? undefined,
        runtimeWarnings: cloneCommunicateRuntimeWarnings(snapshot.runtimeWarnings),
        waitOptions: snapshot.waitOptions ? [...snapshot.waitOptions] : undefined,
        logPath: log.path
      };
    }
  };
}

async function connectWebSocketWithRetry(
  url: string,
  createWebSocket: (url: string) => CodexAppWebSocketLike,
  onMessage: (payload: unknown, sourceSocket: CodexAppWebSocketLike) => void,
  options?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    openTimeoutMs?: number;
    onAttemptFailure?: (detail: { attempt: number; maxAttempts: number; error: unknown }) => void;
  }
): Promise<CodexAppWebSocketLike> {
  let lastError: unknown;
  const maxAttempts = options?.maxAttempts ?? 50;
  const retryDelayMs = options?.retryDelayMs ?? 100;
  const openTimeoutMs = options?.openTimeoutMs ?? 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await openWebSocket(url, createWebSocket, onMessage, { openTimeoutMs });
    } catch (error) {
      lastError = error;
      options?.onAttemptFailure?.({
        attempt: attempt + 1,
        maxAttempts,
        error
      });
      await delay(retryDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to connect to Codex app-server WebSocket.');
}

async function openWebSocket(
  url: string,
  createWebSocket: (url: string) => CodexAppWebSocketLike,
  onMessage: (payload: unknown, sourceSocket: CodexAppWebSocketLike) => void,
  options?: { openTimeoutMs?: number }
): Promise<CodexAppWebSocketLike> {
  const socket = createWebSocket(url);
  const openTimeoutMs = options?.openTimeoutMs ?? 2000;
  return await new Promise((resolve, reject) => {
    let opened = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanupOpenListeners = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      socket.removeEventListener?.('open', onOpen);
      socket.removeEventListener?.('error', onError);
      socket.removeEventListener?.('close', onClose);
    };
    const onOpen = () => {
      opened = true;
      cleanupOpenListeners();
      socket.addEventListener('message', (event: { data: unknown }) => {
        onMessage(event.data, socket);
      });
      socket.addEventListener('error', () => undefined);
      socket.addEventListener('close', () => undefined);
      resolve(socket);
    };
    const onError = (event: unknown) => {
      cleanupOpenListeners();
      safeClose(socket);
      reject(createWebSocketOpenError(event, url));
    };
    const onClose = () => {
      if (opened) return;
      cleanupOpenListeners();
      reject(createNamedError('CodexSocketClosedBeforeOpenError', 'Codex app-server WebSocket closed before open.'));
    };
    timeout = setTimeout(() => {
      cleanupOpenListeners();
      safeClose(socket);
      reject(createNamedError('CodexSocketOpenTimeoutError', 'Codex app-server WebSocket open timed out after ' + openTimeoutMs + 'ms.'));
    }, openTimeoutMs);
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function extractAgentMessageText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string' && item.text.trim() !== '') {
    return item.text;
  }
  const content = Array.isArray(item.content) ? item.content : [];
  const texts = content
    .map((entry) => {
      if (!isRecord(entry)) return '';
      if (typeof entry.text === 'string') return entry.text;
      return '';
    })
    .filter((entry) => entry !== '');
  return texts.join('');
}

function parseRpcMessage(raw: unknown): Record<string, unknown> | null {
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
    if (raw instanceof ArrayBuffer) return JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
    if (ArrayBuffer.isView(raw)) {
      return JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function buildRuntimeArtifactFingerprint(): Record<string, unknown> {
  const fingerprint: Record<string, unknown> = {
    runtimeArtifactPath: __filename
  };
  try {
    const stats = statSync(__filename);
    fingerprint.runtimeArtifactMtimeMs = Math.trunc(stats.mtimeMs);
    fingerprint.runtimeArtifactSize = stats.size;
  } catch (error) {
    fingerprint.runtimeArtifactStatError = error instanceof Error ? error.message : String(error);
  }
  return fingerprint;
}

function summarizeRawSocketFrame(raw: unknown, message: Record<string, unknown> | null): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    transportType: resolveSocketPayloadType(raw),
    payloadBytes: measureSocketPayloadBytes(raw)
  };
  if (!message) {
    summary.parseFailed = true;
    return summary;
  }
  if (typeof message.method === 'string') {
    summary.method = message.method;
  }
  summary.hasMethod = typeof message.method === 'string';
  summary.hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
  summary.hasError = Object.prototype.hasOwnProperty.call(message, 'error');
  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    summary.rawId = message.id as RpcId;
    summary.rawIdType = typeof message.id;
    summary.normalizedId = toPendingRpcKey(message.id);
  }
  return summary;
}

function resolveSocketPayloadType(raw: unknown): string {
  if (typeof raw === 'string') return 'string';
  if (raw instanceof ArrayBuffer) return 'arraybuffer';
  if (ArrayBuffer.isView(raw)) return 'arraybufferview';
  return typeof raw;
}

function measureSocketPayloadBytes(raw: unknown): number | null {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return null;
}

function toPendingRpcKey(id: unknown): string | null {
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

function buildUserInputResponse(
  questions: Array<{ id?: string; options?: Array<{ label?: string }> | null }>,
  reply: CodexReplyPayload
): { answers: Record<string, { answers: string[] }> } {
  const entries = questions.map((question, index) => {
    const questionId = typeof question.id === 'string' && question.id.length > 0 ? question.id : `q${index + 1}`;
    return [questionId, { answers: [resolveQuestionAnswer(question.options ?? null, reply)] }];
  });
  return { answers: Object.fromEntries(entries) as Record<string, { answers: string[] }> };
}

function resolveQuestionAnswer(options: Array<{ label?: string }> | null, reply: CodexReplyPayload): string {
  if (reply.action === 'choose_index') {
    const selected = options?.[reply.index - 1]?.label;
    return typeof selected === 'string' && selected.length > 0 ? selected : String(reply.index);
  }
  if (reply.action === 'confirm') {
    return reply.value === 'deny' ? 'deny' : 'allow';
  }
  return reply.text;
}

function collectWaitOptions(questions: Array<any>): string[] {
  return questions.flatMap((question) => {
    const options = Array.isArray(question?.options) ? question.options : [];
    return options
      .map((option: any) => (typeof option?.label === 'string' ? option.label : ''))
      .filter((label: string) => label.length > 0);
  });
}

function formatCommandApprovalPrompt(params: Record<string, unknown>): string {
  const parts = ['Codex 请求执行命令审批。'];
  if (typeof params.command === 'string' && params.command.trim().length > 0) {
    parts.push(`命令: ${params.command.trim()}`);
  }
  if (typeof params.cwd === 'string' && params.cwd.trim().length > 0) {
    parts.push(`目录: ${params.cwd.trim()}`);
  }
  if (typeof params.reason === 'string' && params.reason.trim().length > 0) {
    parts.push(`原因: ${params.reason.trim()}`);
  }
  parts.push('如需继续，请回复“对任务号 允许”或“对任务号 拒绝”。');
  return parts.join('\n');
}

function formatFileChangeApprovalPrompt(params: Record<string, unknown>): string {
  const parts = ['Codex 请求文件改动审批。'];
  if (typeof params.reason === 'string' && params.reason.trim().length > 0) {
    parts.push(`原因: ${params.reason.trim()}`);
  }
  if (typeof params.grantRoot === 'string' && params.grantRoot.trim().length > 0) {
    parts.push(`范围: ${params.grantRoot.trim()}`);
  }
  parts.push('如需继续，请回复“对任务号 允许”或“对任务号 拒绝”。');
  return parts.join('\n');
}

function formatUserInputPrompt(questions: Array<any>): string {
  const lines = ['Codex 正在等待更多输入。'];
  questions.forEach((question, index) => {
    const header = typeof question?.header === 'string' && question.header.trim().length > 0 ? question.header.trim() : `问题 ${index + 1}`;
    const prompt = typeof question?.question === 'string' && question.question.trim().length > 0 ? question.question.trim() : '请补充输入。';
    lines.push(`${header}: ${prompt}`);
    const options = Array.isArray(question?.options) ? question.options : [];
    options.forEach((option: any, optionIndex: number) => {
      const label = typeof option?.label === 'string' ? option.label.trim() : '';
      const description = typeof option?.description === 'string' ? option.description.trim() : '';
      if (!label) return;
      lines.push(`${optionIndex + 1}. ${label}${description ? ` - ${description}` : ''}`);
    });
  });
  return lines.join('\n');
}

function mergeOutput(current: string, extra: string): string {
  const parts = [current.trim(), extra.trim()].filter((part) => part.length > 0);
  return parts.join('\n\n');
}


function formatSpawnError(error: unknown, context: { command?: string; args?: string[]; cwd?: string; shell?: boolean }): string {
  if (!error) {
    return JSON.stringify({ message: "unknown spawn error", ...context });
  }
  if (typeof error === "string") {
    return JSON.stringify({ message: error, ...context });
  }
  if (isRecord(error)) {
    const record = error as Record<string, unknown>;
    return JSON.stringify({
      message: typeof record.message === "string" ? record.message : String(error),
      code: record.code,
      errno: record.errno,
      syscall: record.syscall,
      path: record.path,
      spawnargs: record.spawnargs,
      ...context
    });
  }
  return JSON.stringify({ message: String(error), ...context });
}

function extractTurnError(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message;
    return JSON.stringify(error);
  }
  return String(error);
}

function replyToText(reply: CodexReplyPayload): string {
  if (reply.action === 'choose_index') return String(reply.index);
  if (reply.action === 'confirm') return reply.value === 'deny' ? 'deny' : 'allow';
  return reply.text;
}

function defaultWaitHint(taskId: `T${number}`, waitKind: CommunicateWaitKind): string {
  if (waitKind === 'choice') return `对 ${taskId} 选择第一个`;
  if (waitKind === 'confirm') return `对 ${taskId} 允许`;
  if (waitKind === 'text_input') return `对 ${taskId} 输入: xxx`;
  return `对 ${taskId} 确认发送`;
}

function isBlockedAppServerPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && BLOCKED_APP_SERVER_PORTS.has(port);
}

function wrapStartupError(
  error: unknown,
  input: { listenUrl: string; phase: StartupFailurePhase; diagnostics?: StartupFailureDiagnostics }
): Error {
  const lines: string[] = [];
  if (error instanceof Error) {
    if (/Codex app-server WebSocket open failed/i.test(error.message) && !error.message.includes(input.listenUrl)) {
      lines.push(`${error.message} (${input.listenUrl})`);
    } else {
      lines.push(error.message);
    }
  } else {
    lines.push(`Codex app session startup failed for ${input.listenUrl}: ${String(error)}`);
  }
  for (const line of formatStartupFailureDiagnosticLines({
    diagnostics: input.diagnostics,
    baseMessage: lines[0] ?? '',
    listenUrl: input.listenUrl,
    phase: input.phase
  })) {
    lines.push(line);
  }
  return new Error(lines.join('\n'));
}

function createNamedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function createWebSocketOpenError(event: unknown, url: string): Error {
  const detail = describeWebSocketOpenFailure(event);
  return createNamedError(
    'CodexSocketOpenError',
    detail ? `Codex app-server WebSocket open failed for ${url}: ${detail}` : `Codex app-server WebSocket open failed for ${url}.`
  );
}

function describeWebSocketOpenFailure(event: unknown): string {
  if (event instanceof Error) {
    const cause = extractNestedErrorMessage(event.cause);
    return cause ? `${event.message} (cause: ${cause})` : event.message;
  }
  if (isRecord(event)) {
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
    const code = typeof event.code === 'string' || typeof event.code === 'number' ? String(event.code) : '';
    const parts = [message, reason, code].filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join(' | ');
    }
  }
  if (typeof event === 'string') {
    return event;
  }
  return '';
}

function createRpcResponseError(error: unknown, method: string | null): CodexRpcResponseError {
  const detail = isRecord(error) ? error : { message: String(error) };
  const message = typeof detail.message === 'string' && detail.message.trim().length > 0 ? detail.message : JSON.stringify(detail);
  const code =
    typeof detail.code === 'number' || typeof detail.code === 'string'
      ? detail.code
      : null;
  const data = Object.prototype.hasOwnProperty.call(detail, 'data') ? detail.data : undefined;
  return new CodexRpcResponseError(message, { code, data, method });
}

function extractNestedErrorMessage(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (isRecord(input) && typeof input.message === 'string') return input.message;
  return '';
}

function describeStartupUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function isKnownLocalTransportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (
      error.name === 'CodexSocketDisconnectedError' ||
      error.name === 'CodexSocketSendError' ||
      error.name === 'CodexSocketOpenError' ||
      error.name === 'CodexSocketClosedBeforeOpenError' ||
      error.name === 'CodexSocketOpenTimeoutError'
    )
  );
}

function isRpcMethodNotFoundError(
  error: unknown,
  expectedMethod: 'initialize' | 'thread/start' | 'thread/resume' | 'turn/start'
): boolean {
  return error instanceof CodexRpcResponseError && error.code === -32601 && error.method === expectedMethod;
}

function resolveFailureEvidenceFromCompatibilityError(error: unknown): FailureClassificationInput | null {
  if (!(error instanceof CodexAppServerCompatibilityError)) {
    return null;
  }
  return error.kind === 'version_incompatible' ? { versionIncompatible: true } : { capabilityMissing: true };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeMissingRpcMethodError(
  message: string,
  method: 'initialize' | 'thread/start' | 'thread/resume' | 'turn/start'
): boolean {
  const escapedMethod = escapeRegExp(method);
  const patterns = [
    new RegExp(`\\b(?:method\\s+not\\s+found|unknown\\s+method|unsupported\\s+method|not\\s+implemented)\\b[^\\n]*${escapedMethod}`, 'i'),
    new RegExp(`(?:^|\\b)(?:rpc\\s+method|method)\\s+${escapedMethod}\\s*:?(?:\\s+is)?\\s+(?:unsupported|not\\s+supported|not\\s+implemented)\\b`, 'i'),
    new RegExp(`(?:^|\\b)${escapedMethod}\\s+(?:method|rpc)\\s*:?(?:\\s+is)?\\s+(?:unsupported|not\\s+supported|not\\s+implemented)\\b`, 'i'),
    new RegExp(`\\bno\\s+handler\\b[^\\n]*${escapedMethod}`, 'i')
  ];
  return patterns.some((pattern) => pattern.test(message));
}

function resolveRpcFailureEvidence(error: unknown): FailureClassificationInput {
  const compatibilityEvidence = resolveFailureEvidenceFromCompatibilityError(error);
  if (compatibilityEvidence) return compatibilityEvidence;
  if (isKnownLocalTransportError(error)) {
    return { localComm: true };
  }
  return { upstreamExecution: true };
}

function formatCompatibilityErrorMessage(error: unknown): string {
  if (!(error instanceof CodexAppServerCompatibilityError)) {
    return String(error);
  }
  return [error.message, ...formatCompatibilityDiagnosticLines(error.report)].join('\n');
}

function formatStartupFailureDiagnosticLines(input: {
  diagnostics?: StartupFailureDiagnostics;
  baseMessage: string;
  listenUrl: string;
  phase: StartupFailurePhase;
}): string[] {
  const lines: string[] = [`startup phase: ${input.phase}`];
  if (input.listenUrl && !input.baseMessage.includes(input.listenUrl)) {
    lines.push(`startup listen url: ${input.listenUrl}`);
  }
  if (!input.diagnostics) return lines;
  if (input.diagnostics.maxAttempts > 0) {
    lines.push(`startup websocket attempts: ${input.diagnostics.attempts}/${input.diagnostics.maxAttempts}`);
  }
  if (input.diagnostics.childPid != null) {
    lines.push(`startup child pid: ${input.diagnostics.childPid}`);
  }
  if (input.diagnostics.lastSocketError && input.diagnostics.lastSocketError !== input.baseMessage) {
    lines.push(`startup last websocket error: ${input.diagnostics.lastSocketError}`);
  }
  if (input.diagnostics.childExit) {
    const afterText = input.diagnostics.childExit.afterMs != null ? ` after ${input.diagnostics.childExit.afterMs}ms` : '';
    lines.push(`startup child exit: ${input.diagnostics.childExit.summary}${afterText}`);
  }
  if (input.diagnostics.childError) {
    lines.push(`startup child error: ${input.diagnostics.childError}`);
  }
  if (input.diagnostics.elapsedMs != null) {
    lines.push(`startup elapsed: ${input.diagnostics.elapsedMs}ms`);
  }
  if (input.diagnostics.compatibility) {
    lines.push(...formatCompatibilityDiagnosticLines(input.diagnostics.compatibility));
  }
  return lines;
}

function formatCompatibilityDiagnosticLines(report: CodexAppServerCompatibilityReport): string[] {
  const lines: string[] = [];
  if (report.userAgent) {
    lines.push(`app-server userAgent: ${report.userAgent}`);
  }
  lines.push(`current version: ${report.version ?? 'unknown'}`);
  if (report.versionSource) {
    lines.push(`version source: ${report.versionSource}`);
  }
  if (report.threadCliVersion) {
    lines.push(`thread cliVersion: ${report.threadCliVersion}`);
  }
  lines.push(`required minimum version: ${report.requiredMinVersion}`);
  lines.push(`observed capabilities: ${report.observedCapabilities.length > 0 ? report.observedCapabilities.join(', ') : 'none'}`);
  lines.push(`version-gated capabilities: ${report.versionGatedCapabilities.length > 0 ? report.versionGatedCapabilities.join(', ') : 'none'}`);
  if (report.missingCapabilities.length > 0) {
    lines.push(`missing capabilities: ${report.missingCapabilities.join(', ')}`);
  }
  if (report.missingMetadata.length > 0) {
    lines.push(`missing metadata: ${report.missingMetadata.join(', ')}`);
  }
  if (report.versionWarnings.length > 0) {
    lines.push(`version warnings: ${report.versionWarnings.join(' | ')}`);
  }
  if (report.failureReason) {
    lines.push(`compatibility failure: ${report.failureReason}`);
  }
  lines.push(`建议动作: ${report.suggestedAction}`);
  return lines;
}

function createCodexAppServerCompatibilityError(report: CodexAppServerCompatibilityReport): CodexAppServerCompatibilityError {
  const kind = report.failureKind ?? 'capability_missing';
  const summary = report.failureReason ?? 'Codex app-server compatibility check failed.';
  return new CodexAppServerCompatibilityError(kind, `Codex app-server compatibility check failed: ${summary}`, report);
}

function buildInitializeRpcFailureCompatibilityReport(errorMessage: string): CodexAppServerCompatibilityReport {
  return {
    compatible: false,
    initializeHasUserAgent: false,
    startupMethod: null,
    startupMethodHasThreadId: false,
    startupMethodHasCliVersion: false,
    userAgent: null,
    version: null,
    versionSource: null,
    threadCliVersion: null,
    requiredMinVersion: MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION,
    observedCapabilities: [],
    versionGatedCapabilities: [],
    missingCapabilities: ['initialize'],
    missingMetadata: ['initialize.userAgent'],
    versionWarnings: [],
    failureKind: 'capability_missing',
    failureReason: `initialize RPC failed before returning required metadata: ${errorMessage}`,
    suggestedAction:
      `Check whether initialize is supported by the local Codex CLI/app-server, then upgrade to >= ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION} if needed.`
  };
}

function buildStartupRpcFailureCompatibilityReport(input: {
  baseReport: CodexAppServerCompatibilityReport;
  startupMethod: 'thread/start' | 'thread/resume';
  failureKind: CompatibilityFailureKind;
  errorMessage: string;
}): CodexAppServerCompatibilityReport {
  const knownBadVersionPolicy = getKnownBadCodexVersionPolicy(input.baseReport.version);
  const versionCompare =
    input.baseReport.version != null ? compareVersionTokens(input.baseReport.version, MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION) : null;
  const observedCapabilities = new Set<AppServerCapabilityName>(input.baseReport.initializeHasUserAgent ? ['initialize'] : []);
  const missingCapabilities = new Set<AppServerCapabilityName>([input.startupMethod]);
  const versionGatedCapabilities = new Set<AppServerCapabilityName>();

  if (input.failureKind === 'version_incompatible') {
    for (const capability of VERSION_GATED_APP_SERVER_CAPABILITIES) {
      missingCapabilities.add(capability);
    }
  } else if (versionCompare != null && versionCompare >= 0) {
    for (const capability of VERSION_GATED_APP_SERVER_CAPABILITIES) {
      if (capability === input.startupMethod) continue;
      versionGatedCapabilities.add(capability);
    }
  }

  return {
    compatible: false,
    initializeHasUserAgent: input.baseReport.initializeHasUserAgent,
    startupMethod: input.startupMethod,
    startupMethodHasThreadId: false,
    startupMethodHasCliVersion: false,
    userAgent: input.baseReport.userAgent,
    version: input.baseReport.version,
    versionSource: input.baseReport.versionSource,
    threadCliVersion: input.baseReport.threadCliVersion,
    requiredMinVersion: MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION,
    observedCapabilities: Array.from(observedCapabilities).sort(),
    versionGatedCapabilities: Array.from(versionGatedCapabilities).sort(),
    missingCapabilities: Array.from(missingCapabilities).sort(),
    missingMetadata: [],
    versionWarnings: [...input.baseReport.versionWarnings],
    failureKind: input.failureKind,
    failureReason:
      input.failureKind === 'version_incompatible'
        ? `${
          knownBadVersionPolicy != null
            ? formatKnownBadCodexVersionFailureReason(knownBadVersionPolicy.version)
            : `current version ${input.baseReport.version ?? 'unknown'} is below required minimum ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION}.`
        } ${input.startupMethod} RPC failed before returning a compatible result: ${input.errorMessage}`
        : `${input.startupMethod} RPC failed before returning a compatible result: ${input.errorMessage}`,
    suggestedAction:
      input.failureKind === 'version_incompatible'
        ? knownBadVersionPolicy?.suggestedAction ?? `Upgrade the local Codex CLI/app-server to >= ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION}, then retry ${input.startupMethod}.`
        : `Check whether ${input.startupMethod} is supported by the local Codex CLI/app-server, then upgrade to >= ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION} if needed.`
  };
}

function buildRuntimeRpcFailureCompatibilityReport(input: {
  baseReport: CodexAppServerCompatibilityReport;
  capability: 'turn/start';
  errorMessage: string;
}): CodexAppServerCompatibilityReport {
  const observedCapabilities = new Set<AppServerCapabilityName>(input.baseReport.observedCapabilities);
  const missingCapabilities = new Set<AppServerCapabilityName>(input.baseReport.missingCapabilities);
  const versionGatedCapabilities = new Set<AppServerCapabilityName>(input.baseReport.versionGatedCapabilities);

  observedCapabilities.delete(input.capability);
  missingCapabilities.add(input.capability);
  versionGatedCapabilities.delete(input.capability);

  return {
    compatible: false,
    initializeHasUserAgent: input.baseReport.initializeHasUserAgent,
    startupMethod: input.baseReport.startupMethod,
    startupMethodHasThreadId: input.baseReport.startupMethodHasThreadId,
    startupMethodHasCliVersion: input.baseReport.startupMethodHasCliVersion,
    userAgent: input.baseReport.userAgent,
    version: input.baseReport.version,
    versionSource: input.baseReport.versionSource,
    threadCliVersion: input.baseReport.threadCliVersion,
    requiredMinVersion: MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION,
    observedCapabilities: Array.from(observedCapabilities).sort(),
    versionGatedCapabilities: Array.from(versionGatedCapabilities).sort(),
    missingCapabilities: Array.from(missingCapabilities).sort(),
    missingMetadata: [...input.baseReport.missingMetadata],
    versionWarnings: [...input.baseReport.versionWarnings],
    failureKind: 'capability_missing',
    failureReason: `${input.capability} RPC failed during runtime: ${input.errorMessage}`,
    suggestedAction:
      `Check whether ${input.capability} is supported by the local Codex CLI/app-server, then upgrade to >= ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION} if needed.`
  };
}

function buildCodexAppServerCompatibilityReport(input: {
  initializeResult?: unknown;
  startupMethod?: 'thread/start' | 'thread/resume';
  startupResult?: unknown;
  allowKnownBadCodexVersion?: boolean;
}): CodexAppServerCompatibilityReport {
  const initializeRecord = isRecord(input.initializeResult) ? input.initializeResult : undefined;
  const startupRecord = isRecord(input.startupResult) ? input.startupResult : undefined;
  const thread = isRecord(startupRecord?.thread) ? startupRecord.thread : undefined;
  const userAgent = typeof initializeRecord?.userAgent === 'string' && initializeRecord.userAgent.trim().length > 0 ? initializeRecord.userAgent.trim() : null;
  const threadId = typeof thread?.id === 'string' && thread.id.trim().length > 0 ? thread.id.trim() : null;
  const threadCliVersion = typeof thread?.cliVersion === 'string' && thread.cliVersion.trim().length > 0 ? thread.cliVersion.trim() : null;
  const userAgentVersion = extractVersionToken(userAgent);
  const parsedUserAgentVersion = userAgentVersion ? parseVersionToken(userAgentVersion) : null;
  const parsedThreadCliVersion = threadCliVersion ? parseVersionToken(threadCliVersion) : null;

  const versionWarnings: string[] = [];
  if (threadCliVersion && !parsedThreadCliVersion) {
    versionWarnings.push(`thread.cliVersion is present but not parseable: ${threadCliVersion}`);
  }
  if (threadCliVersion && userAgentVersion && parsedThreadCliVersion && parsedUserAgentVersion && compareParsedVersionTokens(parsedThreadCliVersion, parsedUserAgentVersion) !== 0) {
    versionWarnings.push(`thread.cliVersion (${threadCliVersion}) differs from userAgent version (${userAgentVersion}); using thread.cliVersion`);
  }

  let version: string | null = null;
  let versionSource: CodexAppServerCompatibilityReport['versionSource'] = null;
  if (parsedThreadCliVersion) {
    version = parsedThreadCliVersion.raw;
    versionSource = 'thread.cliVersion';
  } else if (parsedUserAgentVersion) {
    version = parsedUserAgentVersion.raw;
    versionSource = 'userAgent';
  }
  const knownBadVersionPolicy = getKnownBadCodexVersionPolicy(version);
  if (knownBadVersionPolicy) {
    versionWarnings.push(knownBadVersionPolicy.summary);
  }

  const observedCapabilities = new Set<AppServerCapabilityName>();
  const missingCapabilities = new Set<AppServerCapabilityName>();
  const versionGatedCapabilities = new Set<AppServerCapabilityName>();
  const missingMetadata = new Set<string>();
  if (userAgent) {
    observedCapabilities.add('initialize');
  } else {
    missingCapabilities.add('initialize');
    missingMetadata.add('initialize.userAgent');
  }
  if (input.startupMethod) {
    if (threadId) {
      observedCapabilities.add(input.startupMethod);
    } else {
      missingCapabilities.add(input.startupMethod);
      missingMetadata.add('thread.id');
    }
  }

  let failureKind: CompatibilityFailureKind | null = null;
  let failureReason: string | null = null;

  if (!userAgent) {
    failureKind = 'capability_missing';
    failureReason = 'initialize returned unexpected metadata: missing result.userAgent.';
  }

  if (!failureReason && input.startupMethod && !threadId) {
    failureKind = 'capability_missing';
    failureReason = `${input.startupMethod} returned unexpected metadata: missing result.thread.id.`;
  }

  const canEvaluateVersionGate = input.startupMethod != null;
  if (!failureReason && canEvaluateVersionGate && !threadCliVersion) {
    missingMetadata.add('thread.cliVersion');
    failureKind = 'capability_missing';
    failureReason = `${input.startupMethod} returned unexpected metadata: missing result.thread.cliVersion.`;
  }

  if (!failureReason && canEvaluateVersionGate && version == null) {
    failureKind = 'capability_missing';
    failureReason = 'Unable to determine Codex app-server version from result.userAgent or result.thread.cliVersion.';
  }

  let versionCompare: number | null = null;
  if (version != null && canEvaluateVersionGate) {
    versionCompare = compareVersionTokens(version, MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION);
    if (!failureReason && versionCompare == null) {
      failureKind = 'capability_missing';
      failureReason = `Unable to compare Codex app-server version ${version}.`;
    }
  }

  if (!failureReason && canEvaluateVersionGate && versionCompare != null && versionCompare < 0) {
    failureKind = 'version_incompatible';
    failureReason = `current version ${version} is below required minimum ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION}.`;
  }

  if (!failureReason && canEvaluateVersionGate && knownBadVersionPolicy && input.allowKnownBadCodexVersion !== true) {
    failureKind = 'version_incompatible';
    failureReason = formatKnownBadCodexVersionFailureReason(knownBadVersionPolicy.version);
  }

  const versionGateSatisfied = canEvaluateVersionGate && versionCompare != null && versionCompare >= 0;
  for (const capability of VERSION_GATED_APP_SERVER_CAPABILITIES) {
    if (versionGateSatisfied) {
      if (!observedCapabilities.has(capability)) {
        versionGatedCapabilities.add(capability);
      }
      missingCapabilities.delete(capability);
    } else if (!observedCapabilities.has(capability)) {
      missingCapabilities.add(capability);
    }
  }

  return {
    compatible: failureKind == null,
    initializeHasUserAgent: userAgent != null,
    startupMethod: input.startupMethod ?? null,
    startupMethodHasThreadId: threadId != null,
    startupMethodHasCliVersion: threadCliVersion != null,
    userAgent,
    version,
    versionSource,
    threadCliVersion,
    requiredMinVersion: MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION,
    observedCapabilities: Array.from(observedCapabilities).sort(),
    versionGatedCapabilities: Array.from(versionGatedCapabilities).sort(),
    missingCapabilities: Array.from(missingCapabilities).sort(),
    missingMetadata: Array.from(missingMetadata).sort(),
    versionWarnings,
    failureKind,
    failureReason,
    suggestedAction:
      failureKind === 'version_incompatible'
        ? knownBadVersionPolicy?.suggestedAction ?? `Upgrade the local Codex CLI/app-server to >= ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION}, then retry.`
        : `Check the app-server protocol metadata, then upgrade the local Codex CLI/app-server to >= ${MIN_COMPATIBLE_CODEX_APP_SERVER_VERSION} if needed.`
  };
}

function extractVersionToken(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const semverPattern = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';
  const explicitProductPatterns = [
    new RegExp(`\\bcommunicate-feishu/${semverPattern}\\b`, 'i'),
    new RegExp(`\\bcodex(?:-[A-Za-z0-9_-]+)?/${semverPattern}\\b`, 'i'),
    new RegExp(`\\bcodex\\s+(?:cli|app-server)\\s+${semverPattern}\\b`, 'i'),
  ];
  for (const pattern of explicitProductPatterns) {
    const match = input.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  const genericProductMatches = Array.from(input.matchAll(new RegExp(`\\b[A-Za-z][A-Za-z0-9_-]*/${semverPattern}\\b`, 'gi')));
  const genericProductVersion = genericProductMatches.at(-1)?.[1];
  if (genericProductVersion) {
    return genericProductVersion;
  }
  const match = input.match(new RegExp(`\\b${semverPattern}\\b`));
  return match?.[1] ?? null;
}

function compareVersionTokens(left: string, right: string): number | null {
  const leftParts = parseVersionToken(left);
  const rightParts = parseVersionToken(right);
  if (!leftParts || !rightParts) return null;
  return compareParsedVersionTokens(leftParts, rightParts);
}

function compareParsedVersionTokens(left: ParsedVersionToken, right: ParsedVersionToken): number {
  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left.release[index] ?? 0;
    const rightValue = right.release[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  if (left.prerelease == null && right.prerelease == null) return 0;
  if (left.prerelease == null) return 1;
  if (right.prerelease == null) return -1;
  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftIsNumber = typeof leftIdentifier === 'number';
    const rightIsNumber = typeof rightIdentifier === 'number';
    if (leftIsNumber && rightIsNumber) {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return String(leftIdentifier).localeCompare(String(rightIdentifier));
  }
  return 0;
}

function parseVersionToken(input: string): ParsedVersionToken | null {
  const cleaned = input.trim();
  const match = cleaned.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const release = match[1]!.split('.').map((part) => Number.parseInt(part, 10));
  if (!release.every((part) => Number.isFinite(part))) return null;
  const prereleaseRaw = match[2] ?? null;
  const prerelease = prereleaseRaw
    ? prereleaseRaw.split('.').map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part))
    : null;
  return {
    raw: cleaned,
    release,
    prerelease,
    prereleaseRaw
  };
}

async function defaultAllocatePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function safeClose(target: { close: () => void }): void {
  try {
    target.close();
  } catch {
    // ignore close failures
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLogWindowEnabled(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return readTruthyEnvFlag('COMMUNICATE_CODEX_LOG_WINDOW');
}

function readTruthyEnvFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}



















function defaultKillProcessTree(pid: number): void {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true
  });
}
