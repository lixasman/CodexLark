import { spawn } from 'node:child_process';
import { createCodexAppSession } from './app-session';
import { detectWaitState } from './output-parser';
import { prepareCodexSpawnCommand } from './spawn-command';
import {
  createKnownBadCodexVersionWarning,
  formatKnownBadCodexVersionBlockMessage,
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
  type SpawnedCodexChild,
  type CodexWorkerEvent
} from './types';
import { mergeCommunicateRuntimeWarnings } from '../../protocol/task-types';
import { type CommunicateWaitKind } from '../../protocol/wait-kinds';

const MIN_COMPATIBLE_STRUCTURED_CLI_VERSION = '0.111.0';
const STRUCTURED_CLI_PROBE_TIMEOUT_MS = 1_500;
const structuredCliSupportCache = new Map<string, StructuredCliSupport>();
const structuredCliSupportPending = new Map<string, Promise<StructuredCliSupport>>();

type ParsedVersionToken = {
  raw: string;
  release: number[];
  prerelease: Array<number | string> | null;
  prereleaseRaw: string | null;
};

type StructuredCliSupport = {
  supported: boolean;
  reason: string;
  version?: string | null;
  output?: string;
};

type StructuredFallbackMode = 'auto' | 'disabled';
type StructuredCliSupportProbeMode = 'full' | 'version_only';

type CodexStructuredCapabilityProbe = (input: {
  cwd: string;
  command: string[];
  mode?: StructuredCliSupportProbeMode;
  allowKnownBadVersion?: boolean;
}) =>
  StructuredCliSupport | boolean | Promise<StructuredCliSupport | boolean>;

type CodexSessionImplementation = {
  start: () => void | Promise<void>;
  sendReply: (reply: CodexReplyPayload) => void;
  getSnapshot: () => CodexSessionSnapshot;
  close?: () => Promise<CodexSessionCloseResult> | CodexSessionCloseResult;
  interruptCurrentTurn?: () => Promise<CodexSessionInterruptResult> | CodexSessionInterruptResult;
  recordStallDiagnostic?: (input: CodexSessionStallDiagnosticInput) => void;
  getLogPath?: () => string | undefined;
};

export type CreateCodexSessionInput = {
  taskId: string;
  cwd: string;
  command: string[];
  mode?: 'new' | 'resume';
  resumeThreadId?: string;
  resumeContext?: CodexSessionResumeContext;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string;
  allowKnownBadCodexVersion?: boolean;
  interruptedByRestart?: boolean;
  spawnFactory?: CodexSpawnFactory;
  onEvent?: (event: CodexWorkerEvent) => void | Promise<void>;
  structuredFallback?: StructuredFallbackMode;
  structuredCapabilityProbe?: CodexStructuredCapabilityProbe;
  structuredSessionFactory?: (input: CodexSessionImplementationInput) => CodexSessionImplementation;
  textSessionFactory?: (input: CodexSessionImplementationInput) => CodexSessionImplementation;
} & CodexSessionPersonaConfig;

type CodexSessionImplementationInput = Omit<
  CreateCodexSessionInput,
  'structuredFallback' | 'structuredCapabilityProbe' | 'structuredSessionFactory' | 'textSessionFactory'
>;

type ProbeCommandResult = {
  ok: boolean;
  output: string;
};

export function createCodexSession(input: CreateCodexSessionInput) {
  const implementationInput: CodexSessionImplementationInput = {
    taskId: input.taskId,
    cwd: input.cwd,
    command: [...input.command],
    mode: input.mode,
    resumeThreadId: input.resumeThreadId,
    resumeContext: input.resumeContext,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    model: input.model,
    allowKnownBadCodexVersion: input.allowKnownBadCodexVersion,
    interruptedByRestart: input.interruptedByRestart,
    spawnFactory: input.spawnFactory,
    onEvent: input.onEvent,
    developerInstructions: input.developerInstructions,
    baseInstructions: input.baseInstructions,
    personality: input.personality
  };
  const structuredFallback = input.structuredFallback ?? 'auto';
  const allowKnownBadCodexVersion = input.allowKnownBadCodexVersion === true;
  const textSessionFactory = input.textSessionFactory ?? createInteractiveTextCodexSession;
  const structuredSessionFactory =
    input.structuredSessionFactory
    ?? ((sessionInput: CodexSessionImplementationInput) =>
      createCodexAppSession({
        taskId: sessionInput.taskId,
        cwd: sessionInput.cwd,
        command: sessionInput.command,
        mode: sessionInput.mode,
        resumeThreadId: sessionInput.resumeThreadId,
        resumeContext: sessionInput.resumeContext,
        approvalPolicy: sessionInput.approvalPolicy,
        sandbox: sessionInput.sandbox,
        model: sessionInput.model,
        allowKnownBadCodexVersion: sessionInput.allowKnownBadCodexVersion,
        interruptedByRestart: sessionInput.interruptedByRestart,
        spawnFactory: sessionInput.spawnFactory,
        developerInstructions: sessionInput.developerInstructions,
        baseInstructions: sessionInput.baseInstructions,
        personality: sessionInput.personality,
        onEvent: sessionInput.onEvent
      }));
  const structuredCapabilityProbe = input.structuredCapabilityProbe ?? probeCodexStructuredCliSupport;
  const sessionInstanceId = `${String(input.taskId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const initialSnapshot: CodexSessionSnapshot = {
    taskId: input.taskId,
    lifecycle: 'CREATED',
    liveBuffer: '',
    model: input.model,
    sessionInstanceId
  };

  let activeSession: CodexSessionImplementation | null = null;
  let selectedMode: 'structured' | 'text' | null = null;
  let closeRequested = false;
  let startPromise: Promise<void> | null = null;
  let structuredStartupBufferedEvents: CodexWorkerEvent[] = [];
  let structuredStartupReady = false;
  let preflightFailureSnapshot: CodexSessionSnapshot | null = null;
  let runtimeWarnings = mergeCommunicateRuntimeWarnings();

  function rememberKnownBadVersionWarning(version: string | null | undefined): void {
    if (!allowKnownBadCodexVersion) return;
    const warning = createKnownBadCodexVersionWarning(version, true);
    if (!warning) return;
    runtimeWarnings = mergeCommunicateRuntimeWarnings(runtimeWarnings, [warning]);
  }

  function emitStructuredEvent(event: CodexWorkerEvent): void {
    if (selectedMode !== 'structured') {
      return;
    }
    if (!structuredStartupReady) {
      structuredStartupBufferedEvents.push(event);
      return;
    }
    void input.onEvent?.(event);
  }

  function flushStructuredStartupEvents(): void {
    structuredStartupReady = true;
    const pending = structuredStartupBufferedEvents;
    structuredStartupBufferedEvents = [];
    for (const event of pending) {
      void input.onEvent?.(event);
    }
  }

  function selectSession(forceText = false): CodexSessionImplementation {
    if (activeSession) return activeSession;
    if (!forceText && structuredFallback !== 'disabled') {
      try {
        activeSession = structuredSessionFactory({
          ...implementationInput,
          onEvent: emitStructuredEvent
        });
        selectedMode = 'structured';
        structuredStartupReady = false;
        structuredStartupBufferedEvents = [];
        return activeSession;
      } catch {
        // Fall back to the legacy text parser below.
      }
    }
    activeSession = textSessionFactory(implementationInput);
    selectedMode = 'text';
    structuredStartupReady = false;
    structuredStartupBufferedEvents = [];
    return activeSession;
  }

  async function fallBackToTextSession(): Promise<void> {
    activeSession = textSessionFactory(implementationInput);
    selectedMode = 'text';
    structuredStartupReady = false;
    structuredStartupBufferedEvents = [];
    await Promise.resolve(activeSession.start());
  }

  function recordPreflightFailure(output: string): void {
    preflightFailureSnapshot = {
      ...initialSnapshot,
      lifecycle: 'FAILED',
      checkpointOutput: output
    };
    void input.onEvent?.({
      type: 'task_failed',
      taskId: input.taskId as `T${number}`,
      output,
      interruptionKind: 'version_incompatible'
    });
  }

  function normalizeProbeFailure(error: unknown): StructuredCliSupport {
    return {
      supported: false,
      reason: 'probe_failed',
      output: String(error)
    };
  }

  function finalizeStartedSession(session: CodexSessionImplementation): void | Promise<void> {
    if (closeRequested) {
      activeSession = null;
      selectedMode = null;
      return;
    }
    if (selectedMode === 'structured') {
      const snapshot = session.getSnapshot();
      if (snapshot.lifecycle === 'FAILED') {
        return fallBackToTextSession();
      }
      flushStructuredStartupEvents();
    }
  }

  function startSelectedSession(session: CodexSessionImplementation): void | Promise<void> {
    if (closeRequested) {
      activeSession = null;
      selectedMode = null;
      return;
    }
    try {
      const startResult = session.start();
      if (isPromiseLike(startResult)) {
        return Promise.resolve(startResult).then(
          () => finalizeStartedSession(session),
          (error) => {
            if (closeRequested) {
              activeSession = null;
              selectedMode = null;
              return;
            }
            if (selectedMode === 'structured') {
              return fallBackToTextSession();
            }
            throw error;
          }
        );
      }
    } catch (error) {
      if (closeRequested) {
        activeSession = null;
        selectedMode = null;
        return;
      }
      if (selectedMode === 'structured') {
        return fallBackToTextSession();
      }
      throw error;
    }
    return finalizeStartedSession(session);
  }

  function continueStartupWithSupport(support: StructuredCliSupport): void | Promise<void> {
    if (closeRequested) return;
    const knownBadVersionPolicy = getKnownBadCodexVersionPolicy(support.version);
    if (knownBadVersionPolicy && !allowKnownBadCodexVersion) {
      recordPreflightFailure(formatKnownBadCodexVersionBlockMessage({ version: knownBadVersionPolicy.version }));
      return;
    }
    rememberKnownBadVersionWarning(support.version);
    const session = selectSession(structuredFallback === 'disabled' || !support.supported);
    return startSelectedSession(session);
  }

  return {
    start() {
      if (startPromise) return startPromise;
      if (closeRequested) return;
      try {
        const probeResult = structuredCapabilityProbe({
          cwd: implementationInput.cwd,
          command: implementationInput.command,
          mode: structuredFallback === 'disabled' ? 'version_only' : 'full',
          allowKnownBadVersion: allowKnownBadCodexVersion
        });
        if (isPromiseLike(probeResult)) {
          startPromise = Promise.resolve(probeResult)
            .then(normalizeStructuredCliSupport, normalizeProbeFailure)
            .then((support) => continueStartupWithSupport(support));
          return startPromise;
        }
        const started = continueStartupWithSupport(normalizeStructuredCliSupport(probeResult));
        startPromise = Promise.resolve(started);
      } catch (error) {
        const started = continueStartupWithSupport(normalizeProbeFailure(error));
        startPromise = Promise.resolve(started);
      }
      return startPromise;
    },

    sendReply(reply: CodexReplyPayload) {
      if (closeRequested) throw new Error('Codex session is already closed.');
      if (!activeSession) throw new Error('Codex session has not started.');
      activeSession.sendReply(reply);
    },

    async close() {
      closeRequested = true;
      if (!activeSession) {
        return { forced: false };
      }
      return await Promise.resolve(activeSession.close?.() ?? { forced: false });
    },

    interruptCurrentTurn() {
      return activeSession?.interruptCurrentTurn?.() ?? { interrupted: false, turnId: null };
    },

    recordStallDiagnostic(diagInput: CodexSessionStallDiagnosticInput) {
      activeSession?.recordStallDiagnostic?.(diagInput);
    },

    getLogPath() {
      return activeSession?.getLogPath?.();
    },

    getSnapshot(): CodexSessionSnapshot {
      if (!activeSession) {
        const baseSnapshot = preflightFailureSnapshot ?? initialSnapshot;
        return {
          ...baseSnapshot,
          lifecycle: closeRequested ? 'CLOSED' : baseSnapshot.lifecycle,
          runtimeWarnings: mergeCommunicateRuntimeWarnings(baseSnapshot.runtimeWarnings, runtimeWarnings),
          waitOptions: baseSnapshot.waitOptions ? [...baseSnapshot.waitOptions] : undefined
        };
      }
      const snapshot = activeSession.getSnapshot();
      return {
        ...snapshot,
        runtimeWarnings: mergeCommunicateRuntimeWarnings(snapshot.runtimeWarnings, runtimeWarnings),
        waitOptions: snapshot.waitOptions ? [...snapshot.waitOptions] : undefined
      };
    }
  };
}

function createInteractiveTextCodexSession(input: CodexSessionImplementationInput): CodexSessionImplementation {
  let child: SpawnedCodexChild | null = null;
  let terminalEventEmitted = false;
  const sessionInstanceId = `${String(input.taskId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let snapshot: CodexSessionSnapshot = {
    taskId: input.taskId,
    lifecycle: 'CREATED',
    liveBuffer: '',
    model: input.model,
    sessionInstanceId
  };

  const spawnFactory: CodexSpawnFactory = input.spawnFactory ?? ((command, args, options) => {
    const spawned = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: options.shell
    });
    return spawned as unknown as SpawnedCodexChild;
  });

  function appendOutput(chunk: Buffer | string) {
    const previousLifecycle = snapshot.lifecycle;
    snapshot = {
      ...snapshot,
      lifecycle: snapshot.lifecycle === 'CREATED' ? 'RUNNING' : snapshot.lifecycle,
      liveBuffer: snapshot.liveBuffer + String(chunk)
    };
    const wait = detectWaitState(snapshot.liveBuffer);
    if (wait) {
      snapshot = {
        ...snapshot,
        lifecycle: 'WAITING_USER',
        waitKind: wait.waitKind,
        waitOptions: wait.waitOptions,
        checkpointOutput: snapshot.liveBuffer
      };
      if (previousLifecycle !== 'WAITING_USER') {
        void input.onEvent?.({
          type: 'task_waiting_user',
          taskId: input.taskId as `T${number}`,
          waitKind: wait.waitKind,
          waitOptions: wait.waitOptions,
          output: snapshot.checkpointOutput ?? snapshot.liveBuffer,
          waitHint: defaultWaitHint(input.taskId as `T${number}`, wait.waitKind)
        });
      }
    }
  }

  return {
    start() {
      const [rawCommand, ...rawArgs] = input.command;
      const preparedCommand = prepareCodexSpawnCommand(rawCommand ?? 'codex', rawArgs);
      try {
        child = spawnFactory(preparedCommand.command, preparedCommand.args, {
          cwd: input.cwd,
          shell: preparedCommand.shell
        });
      } catch (error) {
        const failureOutput = [snapshot.liveBuffer, String(error)].filter(Boolean).join('\n');
        snapshot = {
          ...snapshot,
          lifecycle: 'FAILED',
          exitCode: null,
          checkpointOutput: failureOutput
        };
        terminalEventEmitted = true;
        void input.onEvent?.({
          type: 'task_failed',
          taskId: input.taskId as `T${number}`,
          output: snapshot.checkpointOutput ?? snapshot.liveBuffer,
          interruptionKind: 'unknown'
        });
        return;
      }
      snapshot = { ...snapshot, lifecycle: 'RUNNING' };
      child.stdout.on('data', appendOutput);
      child.stderr.on('data', appendOutput);
      child.on('error', (error: Error) => {
        if (terminalEventEmitted) return;
        terminalEventEmitted = true;
        const failureOutput = [snapshot.liveBuffer, String(error)].filter(Boolean).join('\n');
        snapshot = {
          ...snapshot,
          lifecycle: 'FAILED',
          exitCode: null,
          checkpointOutput: failureOutput
        };
        void input.onEvent?.({
          type: 'task_failed',
          taskId: input.taskId as `T${number}`,
          output: snapshot.checkpointOutput ?? snapshot.liveBuffer,
          interruptionKind: 'unknown'
        });
      });
      child.on('exit', (code: number | null) => {
        if (terminalEventEmitted) return;
        terminalEventEmitted = true;
        snapshot = {
          ...snapshot,
          lifecycle: code === 0 ? 'FINISHED' : 'FAILED',
          exitCode: code,
          checkpointOutput: snapshot.liveBuffer
        };
        if (code === 0) {
          void input.onEvent?.({
            type: 'task_finished',
            taskId: input.taskId as `T${number}`,
            output: snapshot.checkpointOutput ?? snapshot.liveBuffer
          });
          return;
        }
        void input.onEvent?.({
          type: 'task_failed',
          taskId: input.taskId as `T${number}`,
          output: snapshot.checkpointOutput ?? snapshot.liveBuffer,
          interruptionKind: 'unknown'
        });
      });
    },

    sendReply(reply: CodexReplyPayload) {
      if (!child) throw new Error('Codex session has not started.');
      const line =
        reply.action === 'input_text' || reply.action === 'free_text'
          ? reply.text
          : reply.action === 'choose_index'
            ? String(reply.index)
            : reply.value;
      child.stdin.write(`${line}\n`);
      snapshot = {
        ...snapshot,
        lifecycle: 'RUNNING',
        waitKind: undefined,
        waitOptions: undefined
      };
    },

    getSnapshot(): CodexSessionSnapshot {
      return {
        ...snapshot,
        waitOptions: snapshot.waitOptions ? [...snapshot.waitOptions] : undefined
      };
    }
  };
}

function defaultWaitHint(taskId: `T${number}`, waitKind: CommunicateWaitKind): string {
  if (waitKind === 'choice') return `对 ${taskId} 选择第一个`;
  if (waitKind === 'confirm') return `对 ${taskId} 允许`;
  if (waitKind === 'text_input') return `对 ${taskId} 输入: xxx`;
  return `对 ${taskId} 确认发送`;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value != null && typeof (value as Promise<T>).then === 'function';
}

function normalizeStructuredCliSupport(input: StructuredCliSupport | boolean): StructuredCliSupport {
  if (typeof input === 'boolean') {
    return input ? { supported: true, reason: 'supported' } : { supported: false, reason: 'unsupported' };
  }
  return {
    supported: Boolean(input.supported),
    reason: typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : input.supported
        ? 'supported'
        : 'unsupported',
    version: input.version,
    output: input.output
  };
}

async function probeCodexStructuredCliSupport(input: {
  cwd: string;
  command: string[];
  mode?: StructuredCliSupportProbeMode;
  allowKnownBadVersion?: boolean;
}): Promise<StructuredCliSupport> {
  const mode = input.mode ?? 'full';
  const cacheKey = buildStructuredCliSupportCacheKey(input.command, mode, input.allowKnownBadVersion === true);
  const cached = structuredCliSupportCache.get(cacheKey);
  if (cached) return cached;
  const pending = structuredCliSupportPending.get(cacheKey);
  if (pending) return await pending;

  const probePromise = (async () => {
    const [rawCommand, ...rawArgs] = input.command;
    const preparedCommand = prepareCodexSpawnCommand(rawCommand ?? 'codex', rawArgs);
    const versionProbe = await runCodexProbe(preparedCommand, input.cwd, ['--version']);
    const version = extractVersionToken(versionProbe.output);
    if (!versionProbe.ok || !version) {
      return {
        supported: false,
        reason: 'version_probe_failed',
        output: versionProbe.output
      } satisfies StructuredCliSupport;
    }
    const knownBadVersionPolicy = getKnownBadCodexVersionPolicy(version);
    if (knownBadVersionPolicy && input.allowKnownBadVersion !== true) {
      return {
        supported: false,
        reason: 'known_bad_version',
        version,
        output: versionProbe.output
      } satisfies StructuredCliSupport;
    }

    const versionCompare = compareVersionTokens(version, MIN_COMPATIBLE_STRUCTURED_CLI_VERSION);
    if (versionCompare == null) {
      return {
        supported: false,
        reason: 'version_unparseable',
        version,
        output: versionProbe.output
      } satisfies StructuredCliSupport;
    }
    if (versionCompare < 0) {
      return {
        supported: false,
        reason: 'version_too_old',
        version,
        output: versionProbe.output
      } satisfies StructuredCliSupport;
    }
    if (mode === 'version_only') {
      return {
        supported: versionCompare >= 0,
        reason: versionCompare >= 0 ? 'version_checked' : 'version_too_old',
        version,
        output: versionProbe.output
      } satisfies StructuredCliSupport;
    }

    const appServerHelpProbe = await runCodexProbe(preparedCommand, input.cwd, ['app-server', '--help']);
    const helpLooksCompatible = /\bUsage:\s+codex app-server\b/i.test(appServerHelpProbe.output)
      || /Run the app server/i.test(appServerHelpProbe.output);
    return helpLooksCompatible && appServerHelpProbe.ok
      ? ({ supported: true, reason: 'supported', version, output: appServerHelpProbe.output } satisfies StructuredCliSupport)
      : ({ supported: false, reason: 'app_server_help_missing', version, output: appServerHelpProbe.output } satisfies StructuredCliSupport);
  })();
  structuredCliSupportPending.set(cacheKey, probePromise);
  try {
    const result = await probePromise;
    if (shouldCacheStructuredCliSupport(result)) {
      structuredCliSupportCache.set(cacheKey, result);
    }
    return result;
  } finally {
    structuredCliSupportPending.delete(cacheKey);
  }
}

function buildStructuredCliSupportCacheKey(
  command: string[],
  mode: StructuredCliSupportProbeMode,
  allowKnownBadVersion: boolean
): string {
  const [rawCommand, ...rawArgs] = command;
  const preparedCommand = prepareCodexSpawnCommand(rawCommand ?? 'codex', rawArgs);
  return JSON.stringify({
    command: preparedCommand.command,
    args: preparedCommand.args,
    shell: preparedCommand.shell,
    mode,
    allowKnownBadVersion
  });
}

function runCodexProbe(
  preparedCommand: ReturnType<typeof prepareCodexSpawnCommand>,
  cwd: string,
  extraArgs: string[]
): Promise<ProbeCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(preparedCommand.command, [...preparedCommand.args, ...extraArgs], {
      cwd,
      shell: preparedCommand.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finalize = (result: ProbeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore timeout cleanup failures
      }
      finalize({
        ok: false,
        output: [stdout, stderr, `Probe timed out after ${STRUCTURED_CLI_PROBE_TIMEOUT_MS}ms.`]
          .filter((value) => value.trim().length > 0)
          .join('\n')
      });
    }, STRUCTURED_CLI_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finalize({
        ok: false,
        output: [stdout, stderr, String(error.message ?? error)]
          .filter((value) => value.trim().length > 0)
          .join('\n')
      });
    });
    child.on('exit', (code) => {
      finalize({
        ok: code === 0,
        output: [stdout, stderr].filter((value) => value.trim().length > 0).join('\n')
      });
    });
  });
}

function shouldCacheStructuredCliSupport(result: StructuredCliSupport): boolean {
  if (result.supported) return true;
  return result.reason === 'known_bad_version' || result.reason === 'version_too_old' || result.reason === 'version_unparseable';
}

function extractVersionToken(input: string): string | null {
  const patterns = [
    /\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i,
    /\bcodex(?:-[A-Za-z0-9_-]+)?\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i,
    /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
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
