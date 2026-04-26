import {
  formatCheckpointDelivery,
  formatPolishCandidateDelivery,
  formatStatusQueryDelivery,
  formatTakeoverList,
  formatTaskProgressDelivery
} from '../delivery/checkpoint-format';
import { segmentText } from '../delivery/segmenter';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { routeUserMessage } from '../control/router';
import {
  scanCodexCliSessions,
  scanCodexCliSessionsResult,
  type CodexCliScanResult,
  type CodexCliSessionInfo
} from '../control/codex-cli-scan';
import { filterCodexCliProcesses, listCodexCliProcesses, terminateCodexCliProcesses, type CodexProcessInfo } from '../control/codex-cli-process';
import { validateReplyCommand } from '../control/validator';
import {
  normalizeTaskInterruptionKind,
  type CommunicateTaskInterruptionKind
} from '../protocol/task-events';
import {
  cloneCommunicateRuntimeWarnings,
  describeCommunicateTaskModel,
  mergeCommunicateRuntimeWarnings,
  normalizeCommunicateTaskModel,
  type CommunicateAssistantPersonality,
  type CommunicateRuntimeWarning,
  type CommunicateTaskRecord
} from '../protocol/task-types';
import {
  createSessionRegistry,
  type SessionRegistryRecord,
  type SessionThreadUiStateRecord
} from '../storage/session-registry';
import { createTaskIdGenerator, createTaskStore } from '../storage/task-store';
import { type TaskGoalSummaryGenerator } from '../summary/task-goal-summary';
import { confirmPolishCandidate, preparePolishCandidateTask } from '../workers/chat/polish';
import {
  type CodexReplyPayload,
  type CodexSessionResumeContext,
  type CodexSessionStallDiagnosticInput
} from '../workers/codex/types';
import { type FeishuChannel } from './feishu-client';
import { type FeishuCardActionEvent } from './feishu-message';
import {
  renderFeishuApprovalCard,
  renderFeishuAssistantReplyReceiptCard,
  renderFeishuModeStatusCard,
  renderFeishuReplyStatusCard,
  type FeishuApprovalCardState
} from './feishu-status-card';

const MAX_SEGMENT_CHARS = 6000;
const DEFAULT_CODEX_APPROVAL_POLICY = 'on-request';
const DEFAULT_CODEX_SANDBOX = 'danger-full-access';
const DEFAULT_ASSISTANT_CWD = (process.env.COMMUNICATE_ASSISTANT_CWD ?? '').trim() || process.cwd();
const DEFAULT_ASSISTANT_PROFILE_ID = 'research-assistant-v1';
const DEFAULT_ASSISTANT_PERSONALITY: CommunicateAssistantPersonality = 'pragmatic';
const DEFAULT_ASSISTANT_BASE_INSTRUCTIONS = '默认使用简体中文回答，除非用户明确要求英文。先给结论，再给理由；必要时补风险与验证建议。';
const DEFAULT_ASSISTANT_DEVELOPER_INSTRUCTIONS = `你是长期科研助理，你的首要目标不是陪聊，也不是讨好用户，而是帮助用户严肃、准确、高质量地推进科研与技术问题。

角色定位：
- 你是高智商、强分析、强批判性的研究助理
- 你不是附和型助手
- 你不是用户说什么都对的执行器
- 你要像一个严谨的合作者，而不是顺从的聊天机器人

工作原则：
1. 对科研、技术、方法、实验、方案设计问题，严禁靠模糊经验随意猜测。
2. 当用户表达不清、约束不足、目标不明确时，优先提出关键澄清问题，而不是自行脑补。
3. 当你对事实、参数、论文结论、软件行为、实验条件、工程细节没有足够把握时，应主动搜索，而不是凭印象推断。
4. 你必须具备批判性思维，要主动发现方案中的漏洞、隐含假设、潜在风险、边界条件、失败模式和验证缺口。
5. 当提出方案时，不仅要给出推荐方案，还要说明为什么推荐、依赖前提、可能失败点，以及如何验证。
6. 如果用户的判断、方案、假设存在问题，应直接指出并说明理由。
7. 不要输出空泛鼓励、套话、无信息安慰。`;

const DEFAULT_TAKEOVER_LIST_LIMIT = 5;
const TAKEOVER_PICKER_PAGE_SIZE = 5;
const TAKEOVER_PICKER_SUMMARY_MAX_CHARS = 36;
const DEFAULT_REPLY_STATUS_REFRESH_MS = 10_000;
const DEFAULT_ASSISTANT_REPLY_RECEIPT_REFRESH_MS = 2_000;
const DEFAULT_REPLY_STATUS_STALL_THRESHOLD_MS = 120_000;
const DEFAULT_REPLY_STATUS_STALL_CONFIRMATIONS = 1;
const STALL_RECOVERY_CONSTRAINT =
  '如需执行 shell/test/build 命令，请优先加入命令级硬超时或其它防卡死措施，避免发生卡死。';
const STALL_RECOVERY_SUMMARY_PROMPT = '请总结当前进展。';

const FEISHU_DEBUG = process.env.COMMUNICATE_FEISHU_DEBUG === '1';
function logFeishuDebug(message: string, extra?: Record<string, unknown>): void {
  if (!FEISHU_DEBUG) return;
  if (extra) {
    try {
      console.log(`[feishu-service] ${message} ${JSON.stringify(extra)}`);
      return;
    } catch {
      console.log(`[feishu-service] ${message}`);
      return;
    }
  }
  console.log(`[feishu-service] ${message}`);
}

type CodexSessionLike = {
  start: () => void | Promise<void>;
  sendReply: (reply: CodexReplyPayload) => void;
  interruptCurrentTurn?: () => Promise<{ interrupted: boolean; turnId?: string | null }> | { interrupted: boolean; turnId?: string | null };
  recordStallDiagnostic?: (input: CodexSessionStallDiagnosticInput) => void;
  close?: () => Promise<{ forced: boolean }> | { forced: boolean };
  getSnapshot?: () => {
    lifecycle: string;
    liveBuffer: string;
    checkpointOutput?: string;
    waitKind?: string;
    waitOptions?: string[];
    activeTurnId?: string;
    sessionInstanceId?: string;
    logPath?: string;
    codexThreadId?: string;
    model?: string;
    windowPid?: number;
    interruptedByRestart?: boolean;
    runtimeWarnings?: CommunicateRuntimeWarning[];
    lastProgressAt?: string;
    activeCommand?: boolean;
    activeCommandCommand?: string;
    activeCommandStartedAt?: string;
    lastCommandProgressAt?: string;
  };
  getLogPath?: () => string | undefined;
};

function describeSessionSnapshot(session?: CodexSessionLike) {
  const snapshot = session?.getSnapshot?.();
  if (!snapshot) return undefined;
  return {
    lifecycle: snapshot.lifecycle,
    waitKind: snapshot.waitKind,
    waitOptions: snapshot.waitOptions ? snapshot.waitOptions.length : 0,
    activeTurnId: snapshot.activeTurnId,
    sessionInstanceId: snapshot.sessionInstanceId,
    liveBufferLength: snapshot.liveBuffer.length,
    checkpointLength: snapshot.checkpointOutput ? snapshot.checkpointOutput.length : 0,
    codexThreadId: snapshot.codexThreadId,
    model: snapshot.model,
    windowPid: snapshot.windowPid,
    interruptedByRestart: snapshot.interruptedByRestart
  };
}

function debugSessionSnapshot(session?: CodexSessionLike) {
  if (!FEISHU_DEBUG) return undefined;
  return describeSessionSnapshot(session);
}

function parseIsoAgeMs(value: string | undefined, nowMs: number): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, nowMs - parsed);
}

function parseIsoTimestampMs(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pickTaskModel(...candidates: Array<string | null | undefined>): string | null | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function formatTaskModelLabel(model: string | null | undefined): string {
  return describeCommunicateTaskModel(model);
}


type FeishuSessionFactoryOptions = {
  taskId: `T${number}`;
  cwd: string;
  threadId: string;
  mode?: 'new' | 'resume';
  resumeThreadId?: string;
  resumeContext?: CodexSessionResumeContext;
  approvalPolicy?: string;
  sandbox?: string;
  model?: string | null;
  interruptedByRestart?: boolean;
  developerInstructions?: string;
  baseInstructions?: string;
  personality?: CommunicateAssistantPersonality;
};

type FeishuSessionFactory = (options: FeishuSessionFactoryOptions) => CodexSessionLike;

type SessionRegistryLike = ReturnType<typeof createSessionRegistry>;

type AssistantProfileConfig = {
  cwd: string;
  approvalPolicy: string;
  sandbox: string;
  assistantProfileId: string;
  developerInstructions: string;
  baseInstructions: string;
  personality: CommunicateAssistantPersonality;
};

type PendingImage = { path: string; receivedAt: number };
type HiddenModeCommand =
  | { kind: 'status' }
  | { kind: 'assistant' }
  | { kind: 'coding' }
  | { kind: 'task'; taskId: `T${number}` };

type DeliveryPrefixMode =
  | { kind: 'thread' }
  | { kind: 'assistant' }
  | { kind: 'coding'; taskId: `T${number}` };

type DeliveryFailureContext = {
  taskId?: `T${number}`;
  sessionKind?: 'assistant' | 'coding';
};

type ReplyStatusCardState = 'running' | 'suspected_stalled' | 'interrupting' | 'completed' | 'interrupted';

type ReplyStatusCardRecord = {
  taskId: `T${number}`;
  messageId: string;
  state: ReplyStatusCardState;
  lastKnownPhase?: string;
  lastKnownActivity?: string;
  lastProgressAtMs?: number;
};

type ReplyStatusCardViewModel = {
  status: ReplyStatusCardState;
  displayTitle: string;
  phaseLabel: string;
  activityLabel: string;
  updatedLabel: string;
  allowInterrupt: boolean;
  lastProgressAtMs: number;
  persistPhase?: string;
  persistActivity?: string;
  model?: CommunicateTaskRecord['model'];
  sandbox?: CommunicateTaskRecord['sandbox'] | null;
  approvalPolicy?: CommunicateTaskRecord['approvalPolicy'] | null;
  sessionKind?: CommunicateTaskRecord['sessionKind'] | null;
  startupMode?: CommunicateTaskRecord['startupMode'] | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
};

type AssistantReplyReceiptRecord = {
  taskId: `T${number}`;
  threadId: string;
  turnSequence: number;
  turnId?: string;
  messageId: string;
  state: ReplyStatusCardState;
  lifecycle: CommunicateTaskRecord['lifecycle'];
  checkpointOutput?: string;
  latestWaitPrompt?: string;
  lastKnownPhase?: string;
  lastKnownActivity?: string;
  lastProgressAtMs?: number;
};

type AssistantReplyCurrentTurn = {
  turnSequence: number;
  turnId?: string;
};

type AssistantReplyReceiptViewModel = {
  status: ReplyStatusCardState;
  displayTitle: string;
  phaseLabel: string;
  activityLabel: string;
  updatedLabel: string;
  lastProgressAtMs: number;
  persistPhase?: string;
  persistActivity?: string;
  model?: CommunicateTaskRecord['model'];
  sandbox?: CommunicateTaskRecord['sandbox'] | null;
  approvalPolicy?: CommunicateTaskRecord['approvalPolicy'] | null;
  sessionKind?: CommunicateTaskRecord['sessionKind'] | null;
  startupMode?: CommunicateTaskRecord['startupMode'] | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
};

type AssistantReplyReceiptCardAction = {
  threadId: string;
  messageId?: string;
  kind: 'query_current_task';
  cardSource: 'assistant_reply_receipt';
  turnId: string;
};

type ApprovalCardPrompt = {
  kind: 'command' | 'file_change';
  content: string;
  previewLines: string[];
  reason?: string;
  detailLabel?: string;
  detailValue?: string;
};

type ApprovalCardRecord = {
  taskId: `T${number}`;
  threadId: string;
  messageId: string;
  state: FeishuApprovalCardState;
  prompt: ApprovalCardPrompt;
};

type ReplyStatusStallRecord = {
  taskId: `T${number}`;
  confirmations: number;
};

type ReplyStatusScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

type TakeoverPickerSnapshotRecord = {
  sessions: CodexCliSessionInfo[];
  snapshotUpdatedAt: string;
  totalPages: number;
};

export type FeishuServiceWorkerEvent =
  | {
      type: 'task_waiting_user';
      taskId: `T${number}`;
      turnId?: string;
      waitKind: 'choice' | 'confirm' | 'text_input' | 'polish_confirm';
      output: string;
      waitHint?: string;
      waitOptions?: string[];
    }
  | {
      type: 'task_finished';
      taskId: `T${number}`;
      turnId?: string;
      output: string;
    }
  | {
      type: 'task_failed';
      taskId: `T${number}`;
      turnId?: string;
      output: string;
      interruptionKind?: CommunicateTaskInterruptionKind;
    };

export function createFeishuService(input: {
  channel: FeishuChannel;
  sessionFactory: FeishuSessionFactory;
  assistantSessionFactory?: FeishuSessionFactory;
  codingSessionFactory?: FeishuSessionFactory;
  polishRewrite?: (text: string) => Promise<string> | string;
  cliScanner?: () => CodexCliSessionInfo[];
  cliScannerResult?: () => CodexCliScanResult;
  cliProcess?: {
    list: () => CodexProcessInfo[];
    kill: (processes: CodexProcessInfo[]) => { killed: number; failed: number; errors: string[] };
  };
  sessionRegistry?: SessionRegistryLike;
  takeoverListLimit?: number;
  defaultModel?: string;
  assistantProfile?: Partial<AssistantProfileConfig>;
  goalSummaryGenerator?: TaskGoalSummaryGenerator;
  replyStatusScheduler?: ReplyStatusScheduler;
  replyStatusRefreshMs?: number;
}) {
  const sessionRegistry = input.sessionRegistry ?? createSessionRegistry();
  const registryState = sessionRegistry.load();
  const defaultModel = input.defaultModel?.trim() ? input.defaultModel.trim() : undefined;
  const assistantProfile = resolveAssistantProfile(input.assistantProfile);

  function resolveTaskRuntimeConfigDefaults(task?: Pick<CommunicateTaskRecord, 'taskType' | 'sessionKind'>): {
    defaultApprovalPolicy?: string;
    defaultSandbox?: string;
  } {
    if (!task || task.taskType !== 'codex_session') return {};
    if (task.sessionKind === 'assistant') {
      return {
        defaultApprovalPolicy: assistantProfile.approvalPolicy,
        defaultSandbox: assistantProfile.sandbox
      };
    }
    return {
      defaultApprovalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
      defaultSandbox: DEFAULT_CODEX_SANDBOX
    };
  }

  function buildTaskRuntimeConfigView(
    task?: Pick<CommunicateTaskRecord, 'taskType' | 'model' | 'approvalPolicy' | 'sandbox' | 'sessionKind' | 'startupMode' | 'interruptedByRestart'>,
    snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>
  ): {
    model?: string | null;
    sandbox?: string | null;
    approvalPolicy?: string | null;
    sessionKind?: CommunicateTaskRecord['sessionKind'] | null;
    startupMode?: CommunicateTaskRecord['startupMode'] | null;
    interruptedByRestart?: boolean | null;
    defaultSandbox?: string;
    defaultApprovalPolicy?: string;
  } {
    // Legacy registry records predate startupMode; surface them as "unknown" in the UI, not "unset".
    const startupMode = task?.taskType === 'codex_session' && task?.startupMode === undefined ? null : task?.startupMode;
    return {
      model: pickTaskModel(snapshot?.model, task?.model),
      sandbox: task?.sandbox,
      approvalPolicy: task?.approvalPolicy,
      sessionKind: task?.sessionKind,
      startupMode,
      interruptedByRestart: snapshot?.interruptedByRestart ?? task?.interruptedByRestart,
      ...resolveTaskRuntimeConfigDefaults(task)
    };
  }

  const store = createTaskStore(createTaskIdGenerator(registryState.nextTaskId));
  const sessions = new Map<`T${number}`, CodexSessionLike>();
  const recoveredTasks = new Map<`T${number}`, CommunicateTaskRecord>();
  const assistantBindings = new Map<string, `T${number}`>();
  const threadUiStates = new Map<string, SessionThreadUiStateRecord>();
  const takeoverPickerSnapshots = new Map<string, TakeoverPickerSnapshotRecord>();
  const pendingAssistantThreads = new Map<string, Promise<void>>();
  const pendingClarifications = new Map<string, { kind: 'codex_cwd' }>();
  const pendingGoalSummaryJobs = new Map<`T${number}`, Promise<void>>();
  const polishRewrite = input.polishRewrite ?? ((text: string) => text);
  const assistantSessionFactory = input.assistantSessionFactory ?? input.sessionFactory;
  const codingSessionFactory = input.codingSessionFactory ?? input.sessionFactory;
  const pendingImages = new Map<string, PendingImage[]>();
  const imageRetentionMs = 5 * 60_000;
  const replyStatusCards = new Map<string, ReplyStatusCardRecord>();
  const assistantReplyReceiptsByTask = new Map<`T${number}`, AssistantReplyReceiptRecord>();
  const assistantReplyReceiptsByTurn = new Map<string, AssistantReplyReceiptRecord>();
  const assistantReplyCurrentTurns = new Map<`T${number}`, AssistantReplyCurrentTurn>();
  const assistantReplyReceiptMessageIdsByThread = new Map<string, Set<string>>();
  const pendingAssistantReplyReceipts = new Set<`T${number}`>();
  const assistantReplyReceiptFlushInFlight = new Set<`T${number}`>();
  const assistantReplyReceiptRetryTurnIds = new Map<`T${number}`, string>();
  const assistantReplyReceiptRefreshHandles = new Map<`T${number}`, unknown>();
  const assistantReplyReceiptRefreshInFlight = new Set<`T${number}`>();
  const replyStatusCardMessageIds = new Map<string, Set<string>>();
  const replyStatusRefreshHandles = new Map<string, unknown>();
  const replyStatusRefreshInFlight = new Set<string>();
  const replyStatusStallRecords = new Map<string, ReplyStatusStallRecord>();
  const replyStatusInterruptingTasks = new Set<`T${number}`>();
  const approvalCards = new Map<`T${number}`, ApprovalCardRecord>();
  const stallRecoveryTasks = new Set<`T${number}`>();
  const replyStatusRefreshMs =
    typeof input.replyStatusRefreshMs === 'number' &&
    Number.isFinite(input.replyStatusRefreshMs) &&
    input.replyStatusRefreshMs > 0
      ? Math.floor(input.replyStatusRefreshMs)
      : DEFAULT_REPLY_STATUS_REFRESH_MS;
  const replyStatusScheduler: ReplyStatusScheduler = input.replyStatusScheduler ?? {
    setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
  };

  function pruneRecentImages(threadId: string, now: number): PendingImage[] {
    const queue = pendingImages.get(threadId);
    if (!queue || queue.length === 0) {
      pendingImages.delete(threadId);
      return [];
    }
    const recent = queue.filter((item) => now - item.receivedAt <= imageRetentionMs);
    if (recent.length !== queue.length) {
      logFeishuDebug('image pruned', {
        threadId,
        dropped: queue.length - recent.length,
        retained: recent.length
      });
    }
    if (recent.length > 0) {
      pendingImages.set(threadId, recent);
    } else {
      pendingImages.delete(threadId);
    }
    return recent;
  }

  async function handleInboundImage(message: { threadId: string; imagePath: string; receivedAt?: number }): Promise<void> {
    rememberInboundDeliveryTarget(message.threadId);
    const receivedAt = message.receivedAt ?? Date.now();
    const queue = pendingImages.get(message.threadId);
    if (queue) {
      queue.push({ path: message.imagePath, receivedAt });
      logFeishuDebug('image queued', {
        threadId: message.threadId,
        path: message.imagePath,
        queueLength: queue.length
      });
      return;
    }
    pendingImages.set(message.threadId, [{ path: message.imagePath, receivedAt }]);
    logFeishuDebug('image queued', {
      threadId: message.threadId,
      path: message.imagePath,
      queueLength: 1
    });
  }

  const recoveredSessionRecords = sessionRegistry.listSessionRecords();
  for (const record of recoveredSessionRecords) {
    recoveredTasks.set(record.taskId, taskRecordFromSessionRegistry(record));
  }
  for (const binding of Object.values(registryState.threadBindings)) {
    assistantBindings.set(binding.feishuThreadId, binding.assistantTaskId);
  }
  for (const record of Object.values(registryState.threadUiStates ?? {})) {
    threadUiStates.set(record.feishuThreadId, { ...record });
  }
  if (FEISHU_DEBUG) {
    logRecoveredCodexThreadConflicts(recoveredSessionRecords);
  }
  pruneRecoveredImportedTakeoverPlaceholderTasks();
  pruneRecoveredAbandonedEmptyCodingTasks();

  function summarizeRegistryCodexThreadOwners(
    codexThreadId: string,
    currentTaskId?: `T${number}` | string
  ): Array<Record<string, unknown>> {
    return sessionRegistry
      .listSessionRecords()
      .filter((record) => record.codexThreadId === codexThreadId && record.taskId !== currentTaskId)
      .map((record) => ({
        taskId: record.taskId,
        feishuThreadId: record.feishuThreadId ?? null,
        sessionLifecycle: record.sessionLifecycle ?? null,
        sessionKind: record.sessionKind ?? null,
        interruptedByRestart: record.interruptedByRestart ?? null
      }));
  }

  function debugRegistryCodexThreadOwners(
    codexThreadId: string,
    currentTaskId?: `T${number}` | string
  ): Array<Record<string, unknown>> {
    if (!FEISHU_DEBUG) return [];
    return summarizeRegistryCodexThreadOwners(codexThreadId, currentTaskId);
  }

  function logRecoveredCodexThreadConflicts(records: SessionRegistryRecord[]): void {
    const ownersByThread = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      if (!record.codexThreadId) continue;
      const owners = ownersByThread.get(record.codexThreadId) ?? [];
      owners.push({
        taskId: record.taskId,
        feishuThreadId: record.feishuThreadId ?? null,
        sessionLifecycle: record.sessionLifecycle ?? null,
        sessionKind: record.sessionKind ?? null,
        interruptedByRestart: record.interruptedByRestart ?? null
      });
      ownersByThread.set(record.codexThreadId, owners);
    }
    for (const [codexThreadId, owners] of ownersByThread) {
      if (owners.length < 2) continue;
      logFeishuDebug('recovered task codex thread conflict', {
        codexThreadId,
        owners
      });
    }
  }

  function summarizeCliProcessesForLog(processes: CodexProcessInfo[]): Array<Record<string, unknown>> {
    return processes.map((proc) => ({
      pid: proc.pid,
      commandLineLength: typeof proc.commandLine === 'string' ? proc.commandLine.length : 0,
      hasUser: Boolean(proc.user)
    }));
  }

  function debugCliProcessesForLog(processes: CodexProcessInfo[]): Array<Record<string, unknown>> | undefined {
    if (!FEISHU_DEBUG) return undefined;
    return summarizeCliProcessesForLog(processes);
  }

  function getThreadUiState(threadId: string): SessionThreadUiStateRecord {
    return {
      feishuThreadId: threadId,
      displayMode: 'assistant',
      ...(threadUiStates.get(threadId) ?? {})
    };
  }

  function setThreadUiState(
    threadId: string,
    patch: Partial<Omit<SessionThreadUiStateRecord, 'feishuThreadId'>>
  ): SessionThreadUiStateRecord {
    const normalizedPatch =
      patch.statusCardMode && patch.statusCardMode !== 'takeover_picker'
        ? {
            ...patch,
            takeoverPickerTaskIds: undefined,
            takeoverPickerPage: undefined,
            takeoverPickerTotalPages: undefined,
            takeoverPickerSelectedTaskId: undefined,
            takeoverPickerSnapshotUpdatedAt: undefined,
            takeoverPickerError: undefined
          }
        : patch;
    const nextRecord: SessionThreadUiStateRecord = {
      ...getThreadUiState(threadId),
      ...normalizedPatch,
      feishuThreadId: threadId
    };
    threadUiStates.set(threadId, nextRecord);
    sessionRegistry.upsertThreadUiState(nextRecord);
    return { ...nextRecord };
  }

  function supportsReplyStatusCards(): boolean {
    return Boolean(input.channel.sendCard && input.channel.updateCard);
  }

  function supportsApprovalCards(): boolean {
    return Boolean(input.channel.sendCard);
  }

  function resolveReplyStatusCardState(task: Pick<CommunicateTaskRecord, 'lifecycle'>): ReplyStatusCardState {
    return task.lifecycle === 'FAILED'
      ? 'interrupted'
      : task.lifecycle === 'CLOSED'
        ? 'interrupted'
        : task.lifecycle === 'IDLE'
          ? 'completed'
          : 'running';
  }

  function isTerminalReplyStatusCardState(state: ReplyStatusCardState): boolean {
    return state === 'completed' || state === 'interrupted';
  }

  function clearReplyStatusStallRecord(threadId: string, taskId?: `T${number}`): void {
    const current = replyStatusStallRecords.get(threadId);
    if (!current) return;
    if (taskId && current.taskId !== taskId) return;
    replyStatusStallRecords.delete(threadId);
  }

  function markReplyStatusStallConfirmation(threadId: string, taskId: `T${number}`): number {
    const current = replyStatusStallRecords.get(threadId);
    const confirmations = current && current.taskId === taskId ? current.confirmations + 1 : 1;
    replyStatusStallRecords.set(threadId, { taskId, confirmations });
    return confirmations;
  }

  function clearTaskScopedRecoveryState(taskId: `T${number}`): void {
    replyStatusInterruptingTasks.delete(taskId);
    stallRecoveryTasks.delete(taskId);
  }

  function resolveSnapshotQuietMs(snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>): number | undefined {
    const nowMs = Date.now();
    return snapshot?.activeCommand
      ? parseIsoAgeMs(snapshot.lastCommandProgressAt ?? snapshot.activeCommandStartedAt, nowMs) ??
        parseIsoAgeMs(snapshot.lastProgressAt, nowMs)
      : parseIsoAgeMs(snapshot?.lastProgressAt, nowMs) ??
        parseIsoAgeMs(snapshot?.lastCommandProgressAt, nowMs) ??
        parseIsoAgeMs(snapshot?.activeCommandStartedAt, nowMs);
  }

  function resolveSnapshotQuietMinutes(snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>): number {
    const quietMs = resolveSnapshotQuietMs(snapshot);
    if (quietMs === undefined) return 0;
    return Math.max(0, Math.floor(quietMs / 60_000));
  }

  function isReplyStatusStallCandidate(
    task: CommunicateTaskRecord,
    snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>
  ): boolean {
    if (task.taskType !== 'codex_session' || task.sessionKind !== 'coding') return false;
    const effectiveLifecycle = String(snapshot?.lifecycle ?? task.lifecycle);
    if (effectiveLifecycle !== 'RUNNING_TURN') return false;
    if (!snapshot?.activeCommand) return false;
    const quietMs = parseIsoAgeMs(snapshot.lastCommandProgressAt ?? snapshot.activeCommandStartedAt, Date.now());
    return quietMs !== undefined && quietMs >= DEFAULT_REPLY_STATUS_STALL_THRESHOLD_MS;
  }

  function resolveLiveReplyStatusCardState(
    threadId: string,
    task: CommunicateTaskRecord,
    snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>
  ): ReplyStatusCardState {
    if (replyStatusInterruptingTasks.has(task.id)) {
      clearReplyStatusStallRecord(threadId, task.id);
      return 'interrupting';
    }
    const baseState = resolveReplyStatusCardState(task);
    if (baseState !== 'running') {
      clearReplyStatusStallRecord(threadId, task.id);
      return baseState;
    }
    if (!isReplyStatusStallCandidate(task, snapshot)) {
      clearReplyStatusStallRecord(threadId, task.id);
      return 'running';
    }
    const confirmations = markReplyStatusStallConfirmation(threadId, task.id);
    return confirmations >= DEFAULT_REPLY_STATUS_STALL_CONFIRMATIONS ? 'suspected_stalled' : 'running';
  }

  function resolveSnapshotProgressAtMs(
    snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>
  ): number | undefined {
    const candidates = [
      parseIsoTimestampMs(snapshot?.lastCommandProgressAt),
      parseIsoTimestampMs(snapshot?.lastProgressAt),
      parseIsoTimestampMs(snapshot?.activeCommandStartedAt)
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (candidates.length === 0) return undefined;
    return Math.max(...candidates);
  }

  function formatReplyStatusUpdatedLabel(ageMs: number): string {
    if (ageMs >= 60 * 60_000) {
      return `${Math.max(1, Math.floor(ageMs / (60 * 60_000)))} 小时前`;
    }
    if (ageMs >= 60_000) {
      return `${Math.max(1, Math.floor(ageMs / 60_000))} 分钟前`;
    }
    return `${Math.max(0, Math.floor(ageMs / 1000))} 秒前`;
  }

  function resolveReplyStatusWaitKind(
    task: Pick<CommunicateTaskRecord, 'waitKind'>,
    snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>
  ): string | undefined {
    return snapshot?.waitKind ?? task.waitKind;
  }

  function classifyReplyStatusCommandActivity(commandText?: string): 'scan' | 'read' | 'write' | 'validate' | 'unknown' {
    const normalized = commandText?.trim();
    if (!normalized) return 'unknown';
    if (
      /\b(tsc|test|build|verify|doctor|pytest|vitest|jest|cargo test|go test|dotnet test|npm test|npm run build)\b/i.test(
        normalized
      )
    ) {
      return 'validate';
    }
    if (/\b(get-content|cat|type)\b/i.test(normalized)) {
      return 'read';
    }
    if (/\b(rg|ripgrep|select-string|get-childitem|findstr|dir|ls)\b/i.test(normalized)) {
      return 'scan';
    }
    if (/\b(apply_patch|set-content|out-file|copy-item|move-item|new-item|remove-item)\b/i.test(normalized)) {
      return 'write';
    }
    return 'unknown';
  }

  function resolveReplyStatusActivityLabels(
    commandText: string | undefined,
    previous?: Pick<ReplyStatusCardRecord, 'lastKnownPhase' | 'lastKnownActivity'>
  ): { phaseLabel: string; activityLabel: string; persistPhase?: string; persistActivity?: string } {
    const category = classifyReplyStatusCommandActivity(commandText);
    if (category === 'scan') {
      return {
        phaseLabel: '分析中',
        activityLabel: '正在查看项目文件',
        persistPhase: '分析中',
        persistActivity: '正在查看项目文件'
      };
    }
    if (category === 'read') {
      return {
        phaseLabel: '分析中',
        activityLabel: '正在阅读相关代码',
        persistPhase: '分析中',
        persistActivity: '正在阅读相关代码'
      };
    }
    if (category === 'write') {
      return {
        phaseLabel: '执行中',
        activityLabel: '正在修改代码',
        persistPhase: '执行中',
        persistActivity: '正在修改代码'
      };
    }
    if (category === 'validate') {
      return {
        phaseLabel: '验证中',
        activityLabel: '正在验证修改',
        persistPhase: '验证中',
        persistActivity: '正在验证修改'
      };
    }
    if (previous?.lastKnownPhase && previous.lastKnownActivity && previous.lastKnownPhase !== '准备中') {
      return {
        phaseLabel: previous.lastKnownPhase,
        activityLabel: previous.lastKnownActivity,
        persistPhase: previous.lastKnownPhase,
        persistActivity: previous.lastKnownActivity
      };
    }
    return {
      phaseLabel: '执行中',
      activityLabel: '正在推进当前任务',
      persistPhase: '执行中',
      persistActivity: '正在推进当前任务'
    };
  }

  function buildReplyStatusCardViewModel(
    threadId: string,
    task: CommunicateTaskRecord,
    snapshot: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>> | undefined,
    tracked?: ReplyStatusCardRecord
  ): ReplyStatusCardViewModel {
    const status = resolveLiveReplyStatusCardState(threadId, task, snapshot);
    const nowMs = Date.now();
    const lastProgressAtMs = resolveSnapshotProgressAtMs(snapshot) ?? tracked?.lastProgressAtMs ?? nowMs;
    const quietMs = Math.max(0, nowMs - lastProgressAtMs);
    const effectiveLifecycle =
      task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED' || task.lifecycle === 'CLOSED'
        ? task.lifecycle
        : String(snapshot?.lifecycle ?? task.lifecycle);
    const waitKind = resolveReplyStatusWaitKind(task, snapshot);
    const runtimeConfig = buildTaskRuntimeConfigView(task, snapshot);
    let phaseLabel = '执行中';
    let activityLabel = tracked?.lastKnownActivity ?? '正在推进当前任务';
    let persistPhase = tracked?.lastKnownPhase;
    let persistActivity = tracked?.lastKnownActivity;

    if (status === 'interrupting') {
      phaseLabel = '打断中';
      activityLabel = '正在停止当前任务';
    } else if (task.lifecycle === 'FAILED') {
      phaseLabel = '执行失败';
      activityLabel = tracked?.lastKnownActivity ?? '当前任务执行失败';
    } else if (task.lifecycle === 'CLOSED') {
      phaseLabel = '已中断';
      activityLabel = tracked?.lastKnownActivity ?? '当前任务已关闭';
    } else if (effectiveLifecycle === 'WAITING_USER' && waitKind === 'confirm') {
      phaseLabel = '等待你确认';
      activityLabel = 'Codex 请求执行一项需要你确认的操作';
    } else if (effectiveLifecycle === 'WAITING_USER') {
      phaseLabel = '等待你补充信息';
      activityLabel = 'Codex 正在等待你补充信息';
    } else if (status === 'completed') {
      phaseLabel = '已完成';
      activityLabel = tracked?.lastKnownActivity ?? '当前轮已完成';
    } else if (status === 'suspected_stalled' || quietMs >= DEFAULT_REPLY_STATUS_STALL_THRESHOLD_MS) {
      phaseLabel = '暂时无新进展';
      activityLabel = tracked?.lastKnownActivity ?? resolveReplyStatusActivityLabels(snapshot?.activeCommandCommand, tracked).activityLabel;
    } else if (effectiveLifecycle === 'STARTING' || task.lifecycle === 'STARTING') {
      phaseLabel = '准备中';
      activityLabel = '正在准备当前任务';
      persistPhase = '准备中';
      persistActivity = '正在准备当前任务';
    } else {
      const labels = resolveReplyStatusActivityLabels(snapshot?.activeCommandCommand, tracked);
      phaseLabel = labels.phaseLabel;
      activityLabel = labels.activityLabel;
      persistPhase = labels.persistPhase;
      persistActivity = labels.persistActivity;
    }

    return {
      status,
      displayTitle: `${task.id} · ${phaseLabel}`,
      phaseLabel,
      activityLabel,
      updatedLabel: formatReplyStatusUpdatedLabel(quietMs),
      allowInterrupt: status === 'suspected_stalled',
      lastProgressAtMs,
      persistPhase,
      persistActivity,
      ...runtimeConfig
    };
  }

  function buildAssistantReplyReceiptViewModel(
    task: CommunicateTaskRecord,
    snapshot: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>> | undefined,
    tracked?: AssistantReplyReceiptRecord
  ): AssistantReplyReceiptViewModel {
    const baseView = buildReplyStatusCardViewModel(
      task.threadId,
      task,
      snapshot,
      tracked
        ? {
            taskId: tracked.taskId,
            messageId: tracked.messageId,
            state: tracked.state,
            lastKnownPhase: tracked.lastKnownPhase,
            lastKnownActivity: tracked.lastKnownActivity,
            lastProgressAtMs: tracked.lastProgressAtMs
          }
        : undefined
    );
    return {
      status: baseView.status,
      displayTitle: `助手 · ${baseView.phaseLabel}`,
      phaseLabel: baseView.phaseLabel,
      activityLabel: baseView.activityLabel,
      updatedLabel: baseView.updatedLabel,
      lastProgressAtMs: baseView.lastProgressAtMs,
      persistPhase: baseView.persistPhase,
      persistActivity: baseView.persistActivity,
      model: baseView.model,
      sandbox: baseView.sandbox,
      approvalPolicy: baseView.approvalPolicy,
      sessionKind: baseView.sessionKind,
      startupMode: baseView.startupMode,
      interruptedByRestart: baseView.interruptedByRestart,
      defaultSandbox: baseView.defaultSandbox,
      defaultApprovalPolicy: baseView.defaultApprovalPolicy
    };
  }

  function collapseInitialReplyStatusStallView(
    taskId: `T${number}`,
    view: ReplyStatusCardViewModel,
    snapshot: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>> | undefined
  ): ReplyStatusCardViewModel {
    if (view.status !== 'suspected_stalled') {
      return view;
    }
    const labels = resolveReplyStatusActivityLabels(snapshot?.activeCommandCommand);
    return {
      ...view,
      status: 'running',
      displayTitle: `${taskId} · ${labels.phaseLabel}`,
      phaseLabel: labels.phaseLabel,
      activityLabel: labels.activityLabel,
      allowInterrupt: false,
      persistPhase: labels.persistPhase,
      persistActivity: labels.persistActivity
    };
  }

  function maybeRecordReplyStatusStallDiagnostic(
    threadId: string,
    task: CommunicateTaskRecord,
    snapshot: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>> | undefined,
    nextState: ReplyStatusCardState
  ): void {
    if (nextState !== 'suspected_stalled') return;
    const tracked = replyStatusCards.get(threadId);
    if (!tracked || tracked.taskId !== task.id || tracked.state === 'suspected_stalled') return;
    const session = sessions.get(task.id);
    session?.recordStallDiagnostic?.({
      trigger: 'reply_status_suspected_stalled',
      threadId,
      quietMs: resolveSnapshotQuietMs(snapshot),
      stallConfirmations:
        replyStatusStallRecords.get(threadId)?.taskId === task.id ? replyStatusStallRecords.get(threadId)?.confirmations : undefined,
      replyStatusCardMessageId: tracked.messageId
    });
  }

  function withStallRecoveryConstraint(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return STALL_RECOVERY_CONSTRAINT;
    if (trimmed.includes(STALL_RECOVERY_CONSTRAINT)) return trimmed;
    return `${trimmed}\n\n${STALL_RECOVERY_CONSTRAINT}`;
  }

  function applyTaskScopedReplyGuardrails(
    taskId: `T${number}`,
    reply: CodexReplyPayload,
    options: { skipStallRecoveryConstraint?: boolean } = {}
  ): CodexReplyPayload {
    if (options.skipStallRecoveryConstraint || !stallRecoveryTasks.has(taskId)) {
      return reply;
    }
    if (reply.action !== 'input_text' && reply.action !== 'free_text') {
      return reply;
    }
    return {
      ...reply,
      text: withStallRecoveryConstraint(reply.text)
    };
  }

  function clearReplyStatusRefresh(threadId: string): void {
    const handle = replyStatusRefreshHandles.get(threadId);
    if (handle !== undefined) {
      replyStatusScheduler.clearInterval(handle);
      replyStatusRefreshHandles.delete(threadId);
    }
    replyStatusRefreshInFlight.delete(threadId);
  }

  function clearAssistantReplyReceiptRefresh(taskId: `T${number}`): void {
    const handle = assistantReplyReceiptRefreshHandles.get(taskId);
    if (handle !== undefined) {
      replyStatusScheduler.clearInterval(handle);
      assistantReplyReceiptRefreshHandles.delete(taskId);
    }
    assistantReplyReceiptRefreshInFlight.delete(taskId);
  }

  function forgetReplyStatusCard(threadId: string): void {
    clearReplyStatusRefresh(threadId);
    clearReplyStatusStallRecord(threadId);
    replyStatusCards.delete(threadId);
  }

  function rememberReplyStatusCardMessageId(threadId: string, messageId: string): void {
    const known = replyStatusCardMessageIds.get(threadId) ?? new Set<string>();
    known.add(messageId);
    replyStatusCardMessageIds.set(threadId, known);
  }

  function rememberAssistantReplyReceiptMessageId(threadId: string, messageId: string): void {
    const known = assistantReplyReceiptMessageIdsByThread.get(threadId) ?? new Set<string>();
    known.add(messageId);
    assistantReplyReceiptMessageIdsByThread.set(threadId, known);
  }

  function clearAssistantReplyReceiptPendingState(taskId: `T${number}`): void {
    pendingAssistantReplyReceipts.delete(taskId);
    assistantReplyReceiptFlushInFlight.delete(taskId);
    assistantReplyReceiptRetryTurnIds.delete(taskId);
  }

  function shouldRefreshAssistantReplyReceipt(
    record?: Pick<AssistantReplyReceiptRecord, 'state' | 'lifecycle'>
  ): boolean {
    return (
      record?.state === 'running' &&
      (record.lifecycle === 'STARTING' || record.lifecycle === 'RUNNING_TURN')
    );
  }

  function beginAssistantReplyTurn(taskId: `T${number}`, turnId?: string): AssistantReplyCurrentTurn {
    const currentSequence = assistantReplyCurrentTurns.get(taskId)?.turnSequence ?? 0;
    const nextTurn = {
      turnSequence: currentSequence + 1,
      turnId
    };
    assistantReplyCurrentTurns.set(taskId, nextTurn);
    return nextTurn;
  }

  function rememberAssistantReplyCurrentTurnId(taskId: `T${number}`, turnId?: string): void {
    const normalizedTurnId = typeof turnId === 'string' && turnId.trim() ? turnId.trim() : undefined;
    if (!normalizedTurnId) return;
    const current = assistantReplyCurrentTurns.get(taskId);
    if (!current) {
      assistantReplyCurrentTurns.set(taskId, { turnSequence: 1, turnId: normalizedTurnId });
      return;
    }
    if (current.turnId === normalizedTurnId) return;
    assistantReplyCurrentTurns.set(taskId, {
      turnSequence: current.turnSequence,
      turnId: normalizedTurnId
    });
  }

  function selectAssistantReplyReceiptRecord(taskId: `T${number}`, turnId?: string): AssistantReplyReceiptRecord | undefined {
    const currentTurn = assistantReplyCurrentTurns.get(taskId);
    const current = assistantReplyReceiptsByTask.get(taskId);
    if (turnId) {
      const trackedByTurn = assistantReplyReceiptsByTurn.get(turnId);
      if (trackedByTurn) return trackedByTurn;
      if (
        current &&
        (!currentTurn || current.turnSequence === currentTurn.turnSequence) &&
        (!current.turnId || current.turnId === turnId)
      ) {
        return current;
      }
      return undefined;
    }
    if (current && (!currentTurn || current.turnSequence === currentTurn.turnSequence)) {
      return current;
    }
    return undefined;
  }

  function rememberAssistantReplyReceiptRecord(
    record: AssistantReplyReceiptRecord,
    options: { makeCurrent?: boolean } = {}
  ): void {
    const currentTurn = assistantReplyCurrentTurns.get(record.taskId);
    if (currentTurn && record.turnSequence === currentTurn.turnSequence && record.turnId) {
      rememberAssistantReplyCurrentTurnId(record.taskId, record.turnId);
    }
    if (record.turnId) {
      assistantReplyReceiptsByTurn.set(record.turnId, record);
    }
    if (options.makeCurrent !== false) {
      assistantReplyReceiptsByTask.set(record.taskId, record);
    }
  }

  function forgetAssistantReplyReceiptRecord(record: AssistantReplyReceiptRecord): void {
    if (record.turnId && assistantReplyReceiptsByTurn.get(record.turnId)?.messageId === record.messageId) {
      assistantReplyReceiptsByTurn.delete(record.turnId);
    }
    if (assistantReplyReceiptsByTask.get(record.taskId)?.messageId === record.messageId) {
      assistantReplyReceiptsByTask.delete(record.taskId);
      clearAssistantReplyReceiptRefresh(record.taskId);
    }
  }

  function snapshotMatchesAssistantWorkerEvent(
    snapshot: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>> | undefined,
    event: FeishuServiceWorkerEvent
  ): boolean {
    if (!snapshot) return false;
    if (event.type === 'task_waiting_user') {
      return (
        snapshot.lifecycle === 'WAITING_USER' &&
        snapshot.waitKind === event.waitKind &&
        snapshot.checkpointOutput === event.output
      );
    }
    if (event.type === 'task_finished') {
      return snapshot.lifecycle === 'IDLE' && snapshot.checkpointOutput === event.output;
    }
    return snapshot.lifecycle === 'FAILED' && snapshot.checkpointOutput === event.output;
  }

  function buildAssistantEventTaskRecord(
    task: CommunicateTaskRecord,
    event: FeishuServiceWorkerEvent
  ): CommunicateTaskRecord {
    if (event.type === 'task_waiting_user') {
      return {
        ...task,
        lifecycle: 'WAITING_USER',
        waitKind: event.waitKind,
        waitOptions: event.waitOptions,
        checkpointOutput: event.output,
        latestWaitPrompt: event.waitHint
      };
    }
    return {
      ...task,
      lifecycle: event.type === 'task_finished' ? 'IDLE' : 'FAILED',
      waitKind: undefined,
      waitOptions: undefined,
      checkpointOutput: event.output,
      latestWaitPrompt: undefined
    };
  }

  function resolveAssistantWorkerEventTurnId(
    task: CommunicateTaskRecord,
    event: FeishuServiceWorkerEvent
  ): { scope: 'current' | 'historical' | 'ignore'; turnId?: string } {
    const eventTurnId = typeof event.turnId === 'string' && event.turnId.trim() ? event.turnId.trim() : undefined;
    const snapshot = sessions.get(task.id)?.getSnapshot?.();
    const snapshotTurnId =
      typeof snapshot?.activeTurnId === 'string' && snapshot.activeTurnId.trim() ? snapshot.activeTurnId.trim() : undefined;
    const currentTurn = assistantReplyCurrentTurns.get(task.id);
    const currentRecord = assistantReplyReceiptsByTask.get(task.id);
    const snapshotMatches = snapshotMatchesAssistantWorkerEvent(snapshot, event);
    if (eventTurnId) {
      const trackedByTurn = assistantReplyReceiptsByTurn.get(eventTurnId);
      if (trackedByTurn && currentTurn && trackedByTurn.turnSequence < currentTurn.turnSequence) {
        return { scope: 'historical', turnId: eventTurnId };
      }
      if (snapshotTurnId === eventTurnId || snapshotMatches) {
        return { scope: 'current', turnId: eventTurnId };
      }
      if (
        currentTurn &&
        currentRecord &&
        currentRecord.turnSequence === currentTurn.turnSequence &&
        !currentRecord.turnId &&
        !trackedByTurn
      ) {
        return { scope: 'current', turnId: eventTurnId };
      }
      if (!currentTurn || currentTurn.turnSequence <= 1) {
        return { scope: 'current', turnId: eventTurnId };
      }
      return trackedByTurn ? { scope: 'historical', turnId: eventTurnId } : { scope: 'ignore' };
    }
    if (snapshotMatches) {
      return { scope: 'current', turnId: snapshotTurnId ?? currentTurn?.turnId ?? currentRecord?.turnId };
    }
    if ((currentTurn?.turnSequence ?? 0) > 1) {
      return { scope: 'ignore' };
    }
    return { scope: 'current', turnId: snapshotTurnId ?? currentTurn?.turnId ?? currentRecord?.turnId };
  }

  async function refreshAssistantReplyReceipt(taskId: `T${number}`): Promise<void> {
    const tracked = assistantReplyReceiptsByTask.get(taskId);
    if (!tracked || !shouldRefreshAssistantReplyReceipt(tracked) || !input.channel.updateCard) {
      clearAssistantReplyReceiptRefresh(taskId);
      return;
    }
    const snapshot = sessions.get(taskId)?.getSnapshot?.();
    if (!snapshot) {
      clearAssistantReplyReceiptRefresh(taskId);
      return;
    }
    if (snapshot.lifecycle === 'STARTING') {
      return;
    }
    const task = syncTaskFromSession(taskId) ?? getTaskRecord(taskId);
    if (!task) {
      clearAssistantReplyReceiptRefresh(taskId);
      return;
    }
    const snapshotTurnId =
      typeof snapshot.activeTurnId === 'string' && snapshot.activeTurnId.trim() ? snapshot.activeTurnId.trim() : undefined;
    const updated = await updateAssistantReplyReceipt(task, tracked.turnId ?? snapshotTurnId ?? assistantReplyCurrentTurns.get(taskId)?.turnId);
    if (!updated || !shouldRefreshAssistantReplyReceipt(updated)) {
      clearAssistantReplyReceiptRefresh(taskId);
    }
  }

  function syncAssistantReplyReceiptRefresh(taskId: `T${number}`): void {
    const tracked = assistantReplyReceiptsByTask.get(taskId);
    if (!tracked || !shouldRefreshAssistantReplyReceipt(tracked) || !input.channel.updateCard) {
      clearAssistantReplyReceiptRefresh(taskId);
      return;
    }
    if (assistantReplyReceiptRefreshHandles.has(taskId)) {
      return;
    }
    const handle = replyStatusScheduler.setInterval(() => {
      if (assistantReplyReceiptRefreshInFlight.has(taskId)) return;
      assistantReplyReceiptRefreshInFlight.add(taskId);
      return refreshAssistantReplyReceipt(taskId)
        .catch((error) => {
          logFeishuDebug('assistant reply receipt refresh failed', {
            taskId,
            error: String(error)
          });
        })
        .finally(() => {
          assistantReplyReceiptRefreshInFlight.delete(taskId);
        });
    }, DEFAULT_ASSISTANT_REPLY_RECEIPT_REFRESH_MS);
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    assistantReplyReceiptRefreshHandles.set(taskId, handle);
  }

  async function updateReplyStatusCard(threadId: string, nextView: ReplyStatusCardViewModel): Promise<void> {
    if (!supportsReplyStatusCards()) return;
    const tracked = replyStatusCards.get(threadId);
    if (!tracked) return;
    const card = renderFeishuReplyStatusCard({
      taskId: tracked.taskId,
      status: nextView.status,
      displayTitle: nextView.displayTitle,
      phaseLabel: nextView.phaseLabel,
      activityLabel: nextView.activityLabel,
      updatedLabel: nextView.updatedLabel,
      allowInterrupt: nextView.allowInterrupt,
      model: nextView.model,
      sandbox: nextView.sandbox,
      approvalPolicy: nextView.approvalPolicy,
      sessionKind: nextView.sessionKind,
      startupMode: nextView.startupMode,
      interruptedByRestart: nextView.interruptedByRestart,
      defaultSandbox: nextView.defaultSandbox,
      defaultApprovalPolicy: nextView.defaultApprovalPolicy
    });
    await input.channel.updateCard!(tracked.messageId, card);
    replyStatusCards.set(threadId, {
      ...tracked,
      state: nextView.status,
      lastKnownPhase: nextView.persistPhase ?? tracked.lastKnownPhase,
      lastKnownActivity: nextView.persistActivity ?? tracked.lastKnownActivity,
      lastProgressAtMs: nextView.lastProgressAtMs
    });
    logFeishuDebug('reply status card updated', {
      threadId,
      taskId: tracked.taskId,
      messageId: tracked.messageId,
      state: nextView.status,
      phaseLabel: nextView.phaseLabel,
      activityLabel: nextView.activityLabel
    });
    if (isTerminalReplyStatusCardState(nextView.status)) {
      clearReplyStatusRefresh(threadId);
    }
  }

  async function safeUpdateReplyStatusCard(threadId: string, nextView: ReplyStatusCardViewModel): Promise<void> {
    try {
      await updateReplyStatusCard(threadId, nextView);
    } catch (error) {
      logFeishuDebug('reply status card update failed', {
        threadId,
        error: String(error)
      });
      forgetReplyStatusCard(threadId);
    }
  }

  async function refreshReplyStatusCard(threadId: string): Promise<void> {
    const tracked = replyStatusCards.get(threadId);
    if (!tracked) {
      clearReplyStatusRefresh(threadId);
      return;
    }
    const task = syncTaskFromSession(tracked.taskId) ?? getTaskRecord(tracked.taskId);
    if (!task || task.threadId !== threadId) {
      forgetReplyStatusCard(threadId);
      return;
    }
    const snapshot = sessions.get(task.id)?.getSnapshot?.();
    const nextView = buildReplyStatusCardViewModel(threadId, task, snapshot, tracked);
    maybeRecordReplyStatusStallDiagnostic(threadId, task, snapshot, nextView.status);
    await safeUpdateReplyStatusCard(threadId, nextView);
  }

  function scheduleReplyStatusRefresh(threadId: string): void {
    if (!supportsReplyStatusCards()) return;
    clearReplyStatusRefresh(threadId);
    const handle = replyStatusScheduler.setInterval(() => {
      if (replyStatusRefreshInFlight.has(threadId)) return;
      replyStatusRefreshInFlight.add(threadId);
      return refreshReplyStatusCard(threadId)
        .catch((error) => {
          logFeishuDebug('reply status card refresh failed', {
            threadId,
            error: String(error)
          });
        })
        .finally(() => {
          replyStatusRefreshInFlight.delete(threadId);
        });
    }, replyStatusRefreshMs);
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    replyStatusRefreshHandles.set(threadId, handle);
  }

  async function sendReplyStatusCard(threadId: string, taskId: `T${number}`): Promise<boolean> {
    if (!supportsReplyStatusCards()) return false;
    try {
      clearReplyStatusRefresh(threadId);
      clearReplyStatusStallRecord(threadId);
      const task = syncTaskFromSession(taskId) ?? getTaskRecord(taskId);
      const snapshot = task ? sessions.get(task.id)?.getSnapshot?.() : undefined;
      const nextView = task
        ? buildReplyStatusCardViewModel(threadId, task, snapshot)
        : {
            status: 'running' as ReplyStatusCardState,
            displayTitle: `${taskId} · 执行中`,
            phaseLabel: '执行中',
            activityLabel: '正在推进当前任务',
            updatedLabel: '0 秒前',
            allowInterrupt: false,
            lastProgressAtMs: Date.now(),
            persistPhase: '执行中',
            persistActivity: '正在推进当前任务'
          };
      const initialView = collapseInitialReplyStatusStallView(taskId, nextView, snapshot);
      if (nextView.status === 'suspected_stalled') {
        clearReplyStatusStallRecord(threadId, taskId);
      }
      const card = renderFeishuReplyStatusCard({
        taskId,
        status: initialView.status,
        displayTitle: initialView.displayTitle,
        phaseLabel: initialView.phaseLabel,
        activityLabel: initialView.activityLabel,
        updatedLabel: initialView.updatedLabel,
        allowInterrupt: initialView.allowInterrupt,
        model: initialView.model,
        sandbox: initialView.sandbox,
        approvalPolicy: initialView.approvalPolicy,
        sessionKind: initialView.sessionKind,
        startupMode: initialView.startupMode,
        interruptedByRestart: initialView.interruptedByRestart,
        defaultSandbox: initialView.defaultSandbox,
        defaultApprovalPolicy: initialView.defaultApprovalPolicy
      });
      const messageId = await input.channel.sendCard!(threadId, card);
      rememberReplyStatusCardMessageId(threadId, messageId);
      replyStatusCards.set(threadId, {
        taskId,
        messageId,
        state: initialView.status,
        lastKnownPhase: initialView.persistPhase,
        lastKnownActivity: initialView.persistActivity,
        lastProgressAtMs: initialView.lastProgressAtMs
      });
      scheduleReplyStatusRefresh(threadId);
      logFeishuDebug('reply status card sent', {
        threadId,
        taskId,
        messageId
      });
      return true;
    } catch (error) {
      logFeishuDebug('reply status card send failed', {
        threadId,
        taskId,
        error: String(error)
      });
      forgetReplyStatusCard(threadId);
      return false;
    }
  }

  async function sendAssistantReplyReceipt(
    task: CommunicateTaskRecord,
    turnId?: string | null,
    options: { turnSequence?: number; useLiveSnapshot?: boolean } = {}
  ): Promise<boolean> {
    if (!input.channel.sendCard) return false;
    const normalizedTurnId = typeof turnId === 'string' && turnId.trim() ? turnId.trim() : undefined;
    try {
      const currentTurn = assistantReplyCurrentTurns.get(task.id);
      const tracked = selectAssistantReplyReceiptRecord(task.id, normalizedTurnId);
      const turnSequence =
        options.turnSequence ??
        tracked?.turnSequence ??
        currentTurn?.turnSequence ??
        assistantReplyReceiptsByTask.get(task.id)?.turnSequence ??
        1;
      const snapshot =
        options.useLiveSnapshot === false ? undefined : sessions.get(task.id)?.getSnapshot?.();
      const nextView = buildAssistantReplyReceiptViewModel(task, snapshot, tracked);
      const card = renderFeishuAssistantReplyReceiptCard({
        status: nextView.status,
        displayTitle: nextView.displayTitle,
        phaseLabel: nextView.phaseLabel,
        activityLabel: nextView.activityLabel,
        updatedLabel: nextView.updatedLabel,
        turnId: normalizedTurnId,
        model: nextView.model,
        sandbox: nextView.sandbox,
        approvalPolicy: nextView.approvalPolicy,
        sessionKind: nextView.sessionKind,
        startupMode: nextView.startupMode,
        interruptedByRestart: nextView.interruptedByRestart,
        defaultSandbox: nextView.defaultSandbox,
        defaultApprovalPolicy: nextView.defaultApprovalPolicy
      });
      const messageId = await input.channel.sendCard(task.threadId, card);
      rememberAssistantReplyReceiptMessageId(task.threadId, messageId);
      rememberAssistantReplyReceiptRecord({
        taskId: task.id,
        threadId: task.threadId,
        turnSequence,
        turnId: normalizedTurnId,
        messageId,
        state: nextView.status,
        lifecycle: task.lifecycle,
        checkpointOutput: task.checkpointOutput,
        latestWaitPrompt: task.latestWaitPrompt,
        lastKnownPhase: nextView.persistPhase,
        lastKnownActivity: nextView.persistActivity,
        lastProgressAtMs: nextView.lastProgressAtMs
      });
      syncAssistantReplyReceiptRefresh(task.id);
      logFeishuDebug('assistant reply receipt sent', {
        threadId: task.threadId,
        taskId: task.id,
        turnId: normalizedTurnId,
        messageId
      });
      return true;
    } catch (error) {
      logFeishuDebug('assistant reply receipt send failed', {
        threadId: task.threadId,
        taskId: task.id,
        turnId: normalizedTurnId,
        error: String(error)
      });
      return false;
    }
  }

  async function updateAssistantReplyReceipt(
    task: CommunicateTaskRecord,
    turnId?: string | null,
    options: { useLiveSnapshot?: boolean } = {}
  ): Promise<AssistantReplyReceiptRecord | undefined> {
    if (!input.channel.updateCard) return undefined;
    const requestedTurnId = typeof turnId === 'string' && turnId.trim() ? turnId.trim() : undefined;
    const tracked = selectAssistantReplyReceiptRecord(task.id, requestedTurnId);
    if (!tracked) return undefined;
    const normalizedTurnId =
      requestedTurnId ?? tracked.turnId;
    try {
      const snapshot =
        options.useLiveSnapshot === false ? undefined : sessions.get(task.id)?.getSnapshot?.();
      const nextView = buildAssistantReplyReceiptViewModel(task, snapshot, tracked);
      const card = renderFeishuAssistantReplyReceiptCard({
        status: nextView.status,
        displayTitle: nextView.displayTitle,
        phaseLabel: nextView.phaseLabel,
        activityLabel: nextView.activityLabel,
        updatedLabel: nextView.updatedLabel,
        turnId: normalizedTurnId,
        model: nextView.model,
        sandbox: nextView.sandbox,
        approvalPolicy: nextView.approvalPolicy,
        sessionKind: nextView.sessionKind,
        startupMode: nextView.startupMode,
        interruptedByRestart: nextView.interruptedByRestart,
        defaultSandbox: nextView.defaultSandbox,
        defaultApprovalPolicy: nextView.defaultApprovalPolicy
      });
      await input.channel.updateCard(tracked.messageId, card);
      const nextRecord: AssistantReplyReceiptRecord = {
        ...tracked,
        turnId: normalizedTurnId,
        state: nextView.status,
        lifecycle: task.lifecycle,
        checkpointOutput: task.checkpointOutput,
        latestWaitPrompt: task.latestWaitPrompt,
        lastKnownPhase: nextView.persistPhase ?? tracked.lastKnownPhase,
        lastKnownActivity: nextView.persistActivity ?? tracked.lastKnownActivity,
        lastProgressAtMs: nextView.lastProgressAtMs
      };
      const makeCurrent = assistantReplyReceiptsByTask.get(task.id)?.messageId === tracked.messageId;
      rememberAssistantReplyReceiptRecord(nextRecord, { makeCurrent });
      if (makeCurrent) {
        syncAssistantReplyReceiptRefresh(task.id);
      }
      logFeishuDebug('assistant reply receipt updated', {
        threadId: task.threadId,
        taskId: task.id,
        turnId: normalizedTurnId,
        messageId: tracked.messageId,
        state: nextView.status
      });
      return nextRecord;
    } catch (error) {
      logFeishuDebug('assistant reply receipt update failed', {
        threadId: task.threadId,
        taskId: task.id,
        turnId: normalizedTurnId,
        messageId: tracked.messageId,
        error: String(error)
      });
      forgetAssistantReplyReceiptRecord(tracked);
      return undefined;
    }
  }

  async function maybeFlushPendingAssistantReplyReceipt(task: CommunicateTaskRecord, turnId?: string | null): Promise<void> {
    if (!pendingAssistantReplyReceipts.has(task.id) || !input.channel.sendCard) return;
    const eventTurnId = typeof turnId === 'string' && turnId.trim() ? turnId.trim() : undefined;
    const snapshot = sessions.get(task.id)?.getSnapshot?.();
    const snapshotTurnId =
      typeof snapshot?.activeTurnId === 'string' && snapshot.activeTurnId.trim() ? snapshot.activeTurnId.trim() : undefined;
    const receiptTurnId = eventTurnId ?? snapshotTurnId;
    if (assistantReplyReceiptFlushInFlight.has(task.id)) {
      if (receiptTurnId) {
        assistantReplyReceiptRetryTurnIds.set(task.id, receiptTurnId);
      }
      return;
    }
    assistantReplyReceiptFlushInFlight.add(task.id);
    try {
      const delivered = await sendAssistantReplyReceipt(task, receiptTurnId);
      if (delivered) {
        clearAssistantReplyReceiptPendingState(task.id);
      }
    } finally {
      assistantReplyReceiptFlushInFlight.delete(task.id);
      const retryTurnId = assistantReplyReceiptRetryTurnIds.get(task.id);
      if (!pendingAssistantReplyReceipts.has(task.id)) {
        assistantReplyReceiptRetryTurnIds.delete(task.id);
      } else if (retryTurnId) {
        assistantReplyReceiptRetryTurnIds.delete(task.id);
        await maybeFlushPendingAssistantReplyReceipt(task, retryTurnId);
      }
    }
  }

  async function syncAssistantReplyReceiptForTask(
    task: CommunicateTaskRecord,
    turnId?: string | null,
    options: { allowPendingSend?: boolean; useLiveSnapshot?: boolean } = {}
  ): Promise<void> {
    const snapshot =
      options.useLiveSnapshot === false ? undefined : sessions.get(task.id)?.getSnapshot?.();
    const snapshotTurnId =
      typeof snapshot?.activeTurnId === 'string' && snapshot.activeTurnId.trim() ? snapshot.activeTurnId.trim() : undefined;
    const receiptTurnId =
      (typeof turnId === 'string' && turnId.trim() ? turnId.trim() : undefined) ??
      snapshotTurnId ??
      assistantReplyReceiptsByTask.get(task.id)?.turnId;
    if (assistantReplyReceiptsByTask.has(task.id) || selectAssistantReplyReceiptRecord(task.id, receiptTurnId)) {
      if (!input.channel.updateCard) {
        return;
      }
      const updated = await updateAssistantReplyReceipt(task, receiptTurnId, {
        useLiveSnapshot: options.useLiveSnapshot
      });
      if (updated) {
        if (assistantReplyReceiptsByTask.get(task.id)?.messageId === updated.messageId) {
          clearAssistantReplyReceiptPendingState(task.id);
        }
        return;
      }
      if (options.allowPendingSend !== false && input.channel.sendCard) {
        pendingAssistantReplyReceipts.add(task.id);
      }
    }
    if (options.allowPendingSend === false) {
      return;
    }
    await maybeFlushPendingAssistantReplyReceipt(task, receiptTurnId);
  }

  async function sendCodingReplyAcknowledgement(
    threadId: string,
    taskId: `T${number}`,
    fallbackText: string
  ): Promise<void> {
    const sentCard = await sendReplyStatusCard(threadId, taskId);
    if (sentCard) return;
    await sendPlainText(threadId, `任务 ${taskId} ${fallbackText}`);
  }

  async function syncReplyStatusCardForTask(task: CommunicateTaskRecord): Promise<void> {
    const tracked = replyStatusCards.get(task.threadId);
    if (!tracked || tracked.taskId !== task.id) return;
    const snapshot = sessions.get(task.id)?.getSnapshot?.();
    const nextView = buildReplyStatusCardViewModel(task.threadId, task, snapshot, tracked);
    maybeRecordReplyStatusStallDiagnostic(task.threadId, task, snapshot, nextView.status);
    await safeUpdateReplyStatusCard(task.threadId, nextView);
  }

  function isReplyStatusCardAction(action: Pick<FeishuCardActionEvent, 'threadId' | 'messageId'> & { cardSource?: string }): boolean {
    return action.cardSource === 'reply_status_card' || isKnownReplyStatusCardMessage(action.threadId, action.messageId);
  }

  function isAssistantReplyReceiptAction(
    action: FeishuCardActionEvent
  ): action is AssistantReplyReceiptCardAction {
    return (
      'cardSource' in action &&
      action.cardSource === 'assistant_reply_receipt' &&
      'turnId' in action &&
      typeof action.turnId === 'string'
    );
  }

  function isApprovalCardAction(action: FeishuCardActionEvent): action is Extract<FeishuCardActionEvent, { cardSource: 'approval_card' }> {
    return 'cardSource' in action && action.cardSource === 'approval_card';
  }

  function isKnownReplyStatusCardMessage(threadId: string, messageId?: string): boolean {
    if (!messageId) return false;
    return replyStatusCardMessageIds.get(threadId)?.has(messageId) === true;
  }

  function isKnownAssistantReplyReceiptMessage(threadId: string, messageId?: string): boolean {
    if (!messageId) return false;
    return assistantReplyReceiptMessageIdsByThread.get(threadId)?.has(messageId) === true;
  }

  function resolveTrackedReplyStatusTask(threadId: string): CommunicateTaskRecord | undefined {
    const tracked = replyStatusCards.get(threadId);
    if (!tracked) return undefined;
    const task = syncTaskFromSession(tracked.taskId) ?? getTaskRecord(tracked.taskId);
    if (!task || task.threadId !== threadId) return undefined;
    return task;
  }

  function resolveTrackedAssistantReplyReceipt(action: AssistantReplyReceiptCardAction): AssistantReplyReceiptRecord | undefined {
    const tracked = assistantReplyReceiptsByTurn.get(action.turnId);
    if (!tracked || tracked.threadId !== action.threadId) {
      if (action.messageId && isKnownAssistantReplyReceiptMessage(action.threadId, action.messageId)) {
        return undefined;
      }
      return undefined;
    }
    return tracked;
  }

  function resolveApprovalCardReplyState(
    task: Pick<CommunicateTaskRecord, 'id' | 'lifecycle' | 'waitKind'>,
    reply: CodexReplyPayload
  ): FeishuApprovalCardState | undefined {
    if (!approvalCards.has(task.id)) return undefined;
    if (task.lifecycle !== 'WAITING_USER' || task.waitKind !== 'confirm') {
      return 'unavailable';
    }
    if (reply.action !== 'confirm') return 'unavailable';
    return reply.value === 'deny' ? 'denied' : 'allowed';
  }

  function forgetApprovalCard(taskId: `T${number}`): void {
    approvalCards.delete(taskId);
  }

  async function sendOrUpdateApprovalCard(
    task: Pick<CommunicateTaskRecord, 'id' | 'threadId'>,
    prompt: ApprovalCardPrompt,
    state: FeishuApprovalCardState
  ): Promise<boolean> {
    if (!supportsApprovalCards()) return false;
    const card = renderFeishuApprovalCard({
      taskId: task.id,
      state,
      kind: prompt.kind,
      reason: prompt.reason,
      detailLabel: prompt.detailLabel,
      detailValue: prompt.detailValue,
      previewLines: prompt.previewLines,
      content: prompt.content,
      command: prompt.content
    });
    const tracked = approvalCards.get(task.id);
    if (tracked && input.channel.updateCard) {
      await input.channel.updateCard(tracked.messageId, card);
      approvalCards.set(task.id, {
        taskId: task.id,
        threadId: task.threadId,
        messageId: tracked.messageId,
        state,
        prompt
      });
      return true;
    }
    if (!input.channel.sendCard) return false;
    const messageId = await input.channel.sendCard(task.threadId, card);
    approvalCards.set(task.id, {
      taskId: task.id,
      threadId: task.threadId,
      messageId,
      state,
      prompt
    });
    return true;
  }

  async function safeUpdateApprovalCard(taskId: `T${number}`, nextState: FeishuApprovalCardState): Promise<void> {
    const tracked = approvalCards.get(taskId);
    if (!tracked) return;
    if (!input.channel.updateCard) {
      approvalCards.set(taskId, { ...tracked, state: nextState });
      return;
    }
    try {
      await input.channel.updateCard(
        tracked.messageId,
        renderFeishuApprovalCard({
          taskId,
          state: nextState,
          kind: tracked.prompt.kind,
          reason: tracked.prompt.reason,
          detailLabel: tracked.prompt.detailLabel,
          detailValue: tracked.prompt.detailValue,
          previewLines: tracked.prompt.previewLines,
          content: tracked.prompt.content,
          command: tracked.prompt.content
        })
      );
      approvalCards.set(taskId, { ...tracked, state: nextState });
    } catch (error) {
      logFeishuDebug('approval card update failed', {
        taskId,
        messageId: tracked.messageId,
        error: String(error)
      });
    }
  }

  async function maybeDeliverApprovalCard(task: CommunicateTaskRecord): Promise<boolean> {
    if (task.lifecycle !== 'WAITING_USER' || task.waitKind !== 'confirm') return false;
    const prompt = parseApprovalCardPrompt(task.checkpointOutput);
    if (!prompt) return false;
    try {
      return await sendOrUpdateApprovalCard(task, prompt, 'pending');
    } catch (error) {
      logFeishuDebug('approval card send failed', {
        taskId: task.id,
        threadId: task.threadId,
        error: String(error)
      });
      return false;
    }
  }

  async function syncApprovalCardForTask(task: CommunicateTaskRecord): Promise<void> {
    const tracked = approvalCards.get(task.id);
    if (!tracked) return;
    if (task.lifecycle === 'WAITING_USER' && task.waitKind === 'confirm') {
      const prompt = parseApprovalCardPrompt(task.checkpointOutput);
      if (!prompt) {
        if (tracked.state === 'pending') {
          await safeUpdateApprovalCard(task.id, 'unavailable');
        }
        return;
      }
      await sendOrUpdateApprovalCard(task, prompt, 'pending');
      return;
    }
    if (tracked.state === 'pending') {
      await safeUpdateApprovalCard(task.id, 'unavailable');
    }
  }

  function rememberStatusCardAction(
    threadId: string,
    action: Pick<FeishuCardActionEvent, 'kind' | 'messageId'>
  ): 'ignored' | 'bound' | 'matched' | 'mismatch' {
    if (!action.messageId) return 'ignored';
    const currentUi = getThreadUiState(threadId);
    if (!currentUi.statusCardMessageId) {
      logFeishuDebug('status card action without tracked message id', {
        threadId,
        kind: action.kind,
        actionMessageId: action.messageId
      });
      return 'ignored';
    }
    if (!currentUi.statusCardActionMessageId) {
      if (
        currentUi.statusCardMode === 'takeover_picker' &&
        isTakeoverPickerStatusCardAction(action) &&
        currentUi.statusCardMessageId !== action.messageId
      ) {
        setThreadUiState(threadId, {
          statusCardMessageId: undefined,
          statusCardActionMessageId: undefined
        });
        logFeishuDebug('takeover picker action message mismatch before alias bind; forcing fresh card send', {
          threadId,
          kind: action.kind,
          trackedMessageId: currentUi.statusCardMessageId,
          actionMessageId: action.messageId
        });
        return 'mismatch';
      }
      setThreadUiState(threadId, { statusCardActionMessageId: action.messageId });
      logFeishuDebug('status card action alias bound', {
        threadId,
        kind: action.kind,
        trackedMessageId: currentUi.statusCardMessageId,
        actionMessageId: action.messageId
      });
      return 'bound';
    }
    if (currentUi.statusCardActionMessageId !== action.messageId) {
      setThreadUiState(threadId, {
        statusCardMessageId: undefined,
        statusCardActionMessageId: undefined
      });
      logFeishuDebug('status card action message mismatch; forcing fresh card send', {
        threadId,
        kind: action.kind,
        trackedMessageId: currentUi.statusCardMessageId,
        trackedActionMessageId: currentUi.statusCardActionMessageId,
        actionMessageId: action.messageId
      });
      return 'mismatch';
    }
    logFeishuDebug('status card action matched tracked alias', {
      threadId,
      kind: action.kind,
      trackedMessageId: currentUi.statusCardMessageId,
      actionMessageId: action.messageId
    });
    return 'matched';
  }

  function isTakeoverPickerStatusCardAction(action: Pick<FeishuCardActionEvent, 'kind'>): boolean {
    return (
      action.kind === 'takeover_picker_next_page' ||
      action.kind === 'takeover_picker_prev_page' ||
      action.kind === 'refresh_takeover_picker' ||
      action.kind === 'pick_takeover_task' ||
      action.kind === 'confirm_takeover_task' ||
      action.kind === 'return_to_status'
    );
  }

  function getRecentProjectDirs(): string[] {
    return sessionRegistry.getRecentProjectDirs();
  }

  function rememberRecentProjectDir(cwd: string): string[] {
    return sessionRegistry.replaceRecentProjectDirs([
      cwd,
      ...getRecentProjectDirs().filter((item) => item !== cwd)
    ]);
  }

  function getLastActiveFeishuThreadId(): string | undefined {
    return sessionRegistry.getLastActiveFeishuThreadId();
  }

  function rememberLastActiveThread(threadId: string): void {
    sessionRegistry.setLastActiveFeishuThreadId(threadId);
  }

  function getLastActiveFeishuUserOpenId(): string | undefined {
    return sessionRegistry.getLastActiveFeishuUserOpenId?.();
  }

  function rememberLastActiveFeishuUserOpenId(openId?: string): void {
    const trimmed = typeof openId === 'string' ? openId.trim() : '';
    if (!trimmed) return;
    sessionRegistry.setLastActiveFeishuUserOpenId?.(trimmed);
  }

  function rememberInboundDeliveryTarget(threadId: string, openId?: string): void {
    rememberLastActiveThread(threadId);
    rememberLastActiveFeishuUserOpenId(openId);
  }

  function validateLauncherProjectDir(cwd: string): string | undefined {
    const trimmed = cwd.trim();
    if (!trimmed) return '请先输入或选择项目目录。';
    if (!/^[A-Za-z]:\\/.test(trimmed)) {
      return '项目目录必须是 Windows 绝对路径。';
    }
    if (!existsSync(trimmed)) {
      return '项目目录不存在。';
    }
    try {
      if (!statSync(trimmed).isDirectory()) {
        return '项目目录不是文件夹。';
      }
    } catch {
      return '项目目录无法访问。';
    }
    return undefined;
  }

  function ensureLauncherSelection(threadId: string): void {
    const ui = getThreadUiState(threadId);
    if (ui.launcherSelectedCwd || ui.launcherDraftCwd) return;
    const [firstRecentProjectDir] = getRecentProjectDirs();
    if (!firstRecentProjectDir) return;
    setThreadUiState(threadId, {
      launcherSelectedCwd: firstRecentProjectDir,
      launcherError: undefined
    });
  }

  function parseHiddenModeCommand(text: string): HiddenModeCommand | null {
    const trimmed = text.trim();
    if (/^\/mode\s+status$/i.test(trimmed)) return { kind: 'status' };
    if (/^\/mode\s+assistant$/i.test(trimmed)) return { kind: 'assistant' };
    if (/^\/mode\s+coding$/i.test(trimmed)) return { kind: 'coding' };
    const taskMatch = trimmed.match(/^\/mode\s+task\s+(T\d+)$/i);
    if (taskMatch) return { kind: 'task', taskId: taskMatch[1] as `T${number}` };
    return null;
  }

  function isProjectCardKeyword(text: string): boolean {
    return text.trim() === '项目卡';
  }

  function clearCurrentCodingTarget(threadId: string): void {
    setThreadUiState(threadId, {
      displayMode: 'assistant',
      currentCodingTaskId: undefined
    });
  }

  function prefixForThread(threadId: string): string {
    const ui = getThreadUiState(threadId);
    if (ui.displayMode === 'coding' && ui.currentCodingTaskId) {
      return `[模式: Coding | 当前任务: ${ui.currentCodingTaskId}] `;
    }
    return '[模式: 助手] ';
  }

  function prefixForDelivery(threadId: string, mode: DeliveryPrefixMode): string {
    if (mode.kind === 'assistant') {
      return '[模式: 助手] ';
    }
    if (mode.kind === 'coding') {
      return `[模式: Coding | 当前任务: ${mode.taskId}] `;
    }
    return prefixForThread(threadId);
  }

  function reportTextDeliveryFailure(
    threadId: string,
    mode: DeliveryPrefixMode,
    text: string,
    error: unknown,
    failureContext?: DeliveryFailureContext
  ): void {
    const boundAssistantTaskId = assistantBindings.get(threadId);
    const boundCurrentCodingTaskId = getThreadUiState(threadId).currentCodingTaskId;
    const taskId = failureContext?.taskId ?? (mode.kind === 'coding' ? mode.taskId : undefined);
    const assistantTaskId =
      failureContext?.sessionKind === 'assistant'
        ? failureContext.taskId ?? boundAssistantTaskId
        : boundAssistantTaskId;
    const detail = {
      threadId,
      deliveryMode: mode.kind,
      taskId,
      assistantTaskId,
      boundAssistantTaskId:
        failureContext?.sessionKind === 'assistant' && assistantTaskId !== boundAssistantTaskId
          ? boundAssistantTaskId
          : undefined,
      currentCodingTaskId:
        failureContext?.sessionKind === 'coding'
          ? failureContext.taskId ?? boundCurrentCodingTaskId
          : mode.kind === 'coding'
            ? mode.taskId
            : boundCurrentCodingTaskId,
      textLength: text.length,
      error: error instanceof Error ? error.message : String(error)
    };
    try {
      console.error(`[feishu-service] text delivery failed ${JSON.stringify(detail)}`);
    } catch {
      console.error('[feishu-service] text delivery failed');
    }
  }

  async function sendPrefixedText(
    threadId: string,
    text: string,
    mode: DeliveryPrefixMode = { kind: 'thread' },
    failureContext?: DeliveryFailureContext
  ): Promise<void> {
    try {
      await input.channel.sendText(threadId, `${prefixForDelivery(threadId, mode)}${text}`);
    } catch (error) {
      reportTextDeliveryFailure(threadId, mode, text, error, failureContext);
      throw error;
    }
  }

  function resolveAvailableCodingTask(
    threadId: string,
    taskId: `T${number}`,
    options?: { clearThreadUiOnInvalid?: boolean }
  ): CommunicateTaskRecord | undefined {
    const task = syncTaskFromSession(taskId) ?? getTaskRecord(taskId);
    if (
      !task ||
      task.threadId !== threadId ||
      !isRecoverableCodingTask(task)
    ) {
      if (options?.clearThreadUiOnInvalid) {
        clearCurrentCodingTarget(threadId);
      }
      return undefined;
    }
    return task;
  }

  function resolveCurrentCodingTask(threadId: string): CommunicateTaskRecord | undefined {
    const ui = getThreadUiState(threadId);
    if (!ui.currentCodingTaskId) return undefined;
    return resolveAvailableCodingTask(threadId, ui.currentCodingTaskId, { clearThreadUiOnInvalid: true });
  }

  function resolveCurrentCodingTaskSnapshot(threadId: string): CommunicateTaskRecord | undefined {
    const ui = getThreadUiState(threadId);
    if (!ui.currentCodingTaskId) return undefined;
    return resolveAvailableCodingTaskSnapshot(threadId, ui.currentCodingTaskId, { clearThreadUiOnInvalid: true });
  }

  function listActiveCodingTasks(threadId: string): CommunicateTaskRecord[] {
    const byId = new Map<`T${number}`, CommunicateTaskRecord>();
    for (const task of recoveredTasks.values()) {
      if (task.threadId !== threadId) continue;
      byId.set(task.id, cloneTaskRecord(task)!);
    }
    for (const task of store.listTasksByThread(threadId)) {
      byId.set(task.id, task);
    }
    return Array.from(byId.values())
      .map((task) => (sessions.has(task.id) ? syncTaskFromSession(task.id) ?? task : task))
      .filter(
        (task): task is CommunicateTaskRecord =>
          Boolean(task) && isRecoverableCodingTask(task)
      )
      .sort((left, right) => Number(right.id.slice(1)) - Number(left.id.slice(1)));
  }

  function listActiveCodingTasksSnapshot(threadId: string): CommunicateTaskRecord[] {
    const byId = new Map<`T${number}`, CommunicateTaskRecord>();
    for (const task of recoveredTasks.values()) {
      if (task.threadId !== threadId) continue;
      byId.set(task.id, cloneTaskRecord(task)!);
    }
    for (const task of store.listTasksByThread(threadId)) {
      byId.set(task.id, cloneTaskRecord(task)!);
    }
    return Array.from(byId.values())
      .filter(
        (task): task is CommunicateTaskRecord =>
          Boolean(task) && isRecoverableCodingTask(task)
      )
      .sort((left, right) => Number(right.id.slice(1)) - Number(left.id.slice(1)));
  }

  function normalizeGoalSummarySourceText(text: string | undefined): string | undefined {
    const trimmed = stripGoalSummaryTransportArtifacts(text)?.trim();
    return trimmed ? trimmed : undefined;
  }

  function normalizeFirstUserCodingText(text: string | undefined): string | undefined {
    return normalizeGoalSummarySourceText(text);
  }

  function stripGoalSummaryTransportArtifacts(text: string | undefined): string | undefined {
    if (typeof text !== 'string') return undefined;
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{2}\[图片\]\n(?:- .*(?:\n|$))*$/u, '')
      .trim();
  }

  function syncTaskGoalSummaryPatch(taskId: `T${number}`, patch: Partial<CommunicateTaskRecord>): CommunicateTaskRecord | undefined {
    const updated = updateKnownTask(taskId, patch);
    if (updated) {
      syncRegistryRecord(updated, sessions.get(taskId));
    }
    return updated;
  }

  function queueGoalSummaryGeneration(taskId: `T${number}`, sourceText: string | undefined): void {
    const normalizedSourceText = normalizeGoalSummarySourceText(sourceText);
    if (!normalizedSourceText) return;
    if (isInvalidGoalSummarySourceText(normalizedSourceText)) return;

    const current = getTaskRecord(taskId);
    if (!current || current.taskType !== 'codex_session' || current.sessionKind !== 'coding') return;
    if (current.goalSummary && current.goalSummaryStatus === 'ready') return;

    const updated =
      !current.goalSummarySourceText || (input.goalSummaryGenerator && current.goalSummaryStatus !== 'pending')
        ? syncTaskGoalSummaryPatch(taskId, {
            goalSummarySourceText: current.goalSummarySourceText ?? normalizedSourceText,
            ...(input.goalSummaryGenerator ? { goalSummaryStatus: 'pending' } : {})
          })
        : current;
    const latest = updated ?? getTaskRecord(taskId);
    if (!latest) return;

    if (!input.goalSummaryGenerator || pendingGoalSummaryJobs.has(taskId)) {
      return;
    }

    const job = (async () => {
      const summary = await input.goalSummaryGenerator!.summarize({
        sourceText: latest.goalSummarySourceText ?? normalizedSourceText,
        cwd: latest.cwd
      });
      if (normalizeGoalSummarySourceText(summary)) {
        syncTaskGoalSummaryPatch(taskId, {
          goalSummary: normalizeGoalSummarySourceText(summary),
          goalSummaryStatus: 'ready'
        });
        return;
      }
      syncTaskGoalSummaryPatch(taskId, { goalSummaryStatus: 'failed' });
    })().finally(() => {
      pendingGoalSummaryJobs.delete(taskId);
    });

    pendingGoalSummaryJobs.set(taskId, job);
    void job;
  }

  function rememberFirstUserCodingText(
    taskId: `T${number}`,
    text: string | undefined
  ): CommunicateTaskRecord | undefined {
    const normalized = normalizeFirstUserCodingText(text);
    if (!normalized) return getTaskRecord(taskId);
    const current = getTaskRecord(taskId);
    if (!current || current.taskType !== 'codex_session' || current.sessionKind !== 'coding') {
      return current;
    }
    if (current.firstUserCodingText) {
      return current;
    }
    return (
      syncTaskGoalSummaryPatch(taskId, {
        firstUserCodingText: normalized
      }) ?? getTaskRecord(taskId)
    );
  }

  function recordFirstUserCodingInput(taskId: `T${number}`, text: string | undefined): void {
    const latest = rememberFirstUserCodingText(taskId, text);
    queueGoalSummaryGeneration(taskId, latest?.firstUserCodingText ?? text);
  }

  function readFeishuInboundPayloadsFromLog(logFilePath: string | undefined): string[] {
    if (!logFilePath) return [];
    try {
      const payloads: string[] = [];
      const content = readFileSync(logFilePath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const withoutTimestamp = line.replace(/^\[[^\]]+\]\s*/, '');
        if (!withoutTimestamp.startsWith('FEISHU IN ')) continue;
        const payload = normalizeGoalSummarySourceText(withoutTimestamp.slice('FEISHU IN '.length));
        if (payload) {
          payloads.push(payload);
        }
      }
      return payloads;
    } catch {
      return [];
    }
  }

  function readFirstGoalSummarySourceFromLog(logFilePath: string | undefined): string | undefined {
    for (const payload of readFeishuInboundPayloadsFromLog(logFilePath)) {
      if (!isInvalidGoalSummarySourceText(payload)) {
        return payload;
      }
    }
    return undefined;
  }

  function readFirstUserCodingTextFromLog(logFilePath: string | undefined): string | undefined {
    for (const payload of readFeishuInboundPayloadsFromLog(logFilePath)) {
      if (!isLauncherStyleGoalSummarySourceText(payload)) {
        return payload;
      }
    }
    return undefined;
  }

  function resolveMeaningfulFirstUserCodingText(task: CommunicateTaskRecord): string | undefined {
    return (
      normalizeFirstUserCodingText(task.firstUserCodingText) ??
      normalizeFirstUserCodingText(task.goalSummarySourceText) ??
      normalizeFirstUserCodingText(task.goalSummary) ??
      readFirstUserCodingTextFromLog(task.logFilePath)
    );
  }

  function isEmptyCodingTaskLifecycle(
    lifecycle: CommunicateTaskRecord['lifecycle'],
    source: 'live' | 'recovered'
  ): boolean {
    if (source === 'recovered') {
      return lifecycle === 'STARTING' || lifecycle === 'IDLE';
    }
    return lifecycle === 'STARTING' || lifecycle === 'IDLE' || lifecycle === 'WAITING_USER' || lifecycle === 'FAILED';
  }

  function hasLegacyRecoveredCheckpointEvidence(task: CommunicateTaskRecord): boolean {
    const checkpointOutput = normalizeGoalSummarySourceText(task.checkpointOutput);
    return Boolean(checkpointOutput && !isIgnorableSummaryText(checkpointOutput));
  }

  function isRecoveredTaskKnownEmpty(task: CommunicateTaskRecord): boolean {
    if (resolveMeaningfulFirstUserCodingText(task)) return false;
    if (hasLegacyRecoveredCheckpointEvidence(task)) return false;
    if ((task.runtimeWarnings?.length ?? 0) > 0) return false;
    return true;
  }

  function isImportedTakeoverPlaceholderTask(
    task: Pick<
      CommunicateTaskRecord,
      'taskType' | 'sessionKind' | 'startupMode' | 'logFilePath' | 'codexThreadId' | 'id'
    > | undefined
  ): task is CommunicateTaskRecord {
    return Boolean(
      task &&
      task.taskType === 'codex_session' &&
      task.sessionKind === 'coding' &&
      task.startupMode === 'resume' &&
      !sessions.has(task.id) &&
      !(typeof task.logFilePath === 'string' && task.logFilePath.trim() !== '') &&
      Boolean(task.codexThreadId)
    );
  }

  function isAbandonedEmptyCodingTask(
    task: CommunicateTaskRecord | undefined,
    source: 'live' | 'recovered' = 'live'
  ): task is CommunicateTaskRecord {
    return Boolean(
      task &&
      task.taskType === 'codex_session' &&
      task.sessionKind === 'coding' &&
      (task.runtimeWarnings?.length ?? 0) === 0 &&
      isEmptyCodingTaskLifecycle(task.lifecycle, source) &&
      (source === 'live' ? !resolveMeaningfulFirstUserCodingText(task) : isRecoveredTaskKnownEmpty(task))
    );
  }

  function removeKnownTask(taskId: `T${number}`): CommunicateTaskRecord | undefined {
    const liveTask = store.deleteTask?.(taskId);
    if (liveTask) {
      return liveTask;
    }
    const recoveredTask = recoveredTasks.get(taskId);
    if (!recoveredTask) return undefined;
    recoveredTasks.delete(taskId);
    return cloneTaskRecord(recoveredTask);
  }

  function finalizeDiscardedTask(task: CommunicateTaskRecord): void {
    pendingGoalSummaryJobs.delete(task.id);
    clearTaskScopedRecoveryState(task.id);
    removeKnownTask(task.id);
    sessionRegistry.deleteSessionRecord?.(task.id);
    if (getThreadUiState(task.threadId).currentCodingTaskId === task.id) {
      clearCurrentCodingTarget(task.threadId);
    }
  }

  function pruneRecoveredAbandonedEmptyCodingTasks(): void {
    let discardedAny = false;
    for (const task of Array.from(recoveredTasks.values())) {
      if (!isAbandonedEmptyCodingTask(task, 'recovered')) continue;
      finalizeDiscardedTask(task);
      discardedAny = true;
    }
    if (discardedAny) {
      sessionRegistry.recomputeNextTaskId();
    }
  }

  function pruneRecoveredImportedTakeoverPlaceholderTasks(): void {
    let discardedAny = false;
    for (const task of Array.from(recoveredTasks.values())) {
      if (!isImportedTakeoverPlaceholderTask(task)) continue;
      finalizeDiscardedTask(task);
      discardedAny = true;
    }
    if (discardedAny) {
      sessionRegistry.recomputeNextTaskId();
    }
  }

  function pruneImportedTakeoverPlaceholdersForThread(
    threadId: string,
    retainedTaskIds: Iterable<`T${number}`> = []
  ): void {
    const retained = new Set(retainedTaskIds);
    const currentCodingTaskId = getThreadUiState(threadId).currentCodingTaskId;
    let discardedAny = false;
    for (const task of store.listTasksByThread(threadId)) {
      if (!isImportedTakeoverPlaceholderTask(task)) continue;
      if (retained.has(task.id) || currentCodingTaskId === task.id || sessions.has(task.id)) continue;
      finalizeDiscardedTask(task);
      discardedAny = true;
    }
    for (const task of Array.from(recoveredTasks.values())) {
      if (task.threadId !== threadId || !isImportedTakeoverPlaceholderTask(task)) continue;
      if (retained.has(task.id) || currentCodingTaskId === task.id || sessions.has(task.id)) continue;
      finalizeDiscardedTask(task);
      discardedAny = true;
    }
    if (discardedAny) {
      sessionRegistry.recomputeNextTaskId();
    }
  }

  function pruneImportedTakeoverPlaceholdersForThreadByCodexThreadIds(
    threadId: string,
    retainedCodexThreadIds: Iterable<string> = []
  ): void {
    const retained = new Set(
      Array.from(retainedCodexThreadIds)
        .map((codexThreadId) => codexThreadId.trim())
        .filter(Boolean)
    );
    const currentCodingTaskId = getThreadUiState(threadId).currentCodingTaskId;
    let discardedAny = false;
    for (const task of store.listTasksByThread(threadId)) {
      if (!isImportedTakeoverPlaceholderTask(task)) continue;
      if (retained.has(task.codexThreadId ?? '')) continue;
      if (currentCodingTaskId === task.id || sessions.has(task.id)) continue;
      finalizeDiscardedTask(task);
      discardedAny = true;
    }
    for (const task of Array.from(recoveredTasks.values())) {
      if (task.threadId !== threadId || !isImportedTakeoverPlaceholderTask(task)) continue;
      if (retained.has(task.codexThreadId ?? '')) continue;
      if (currentCodingTaskId === task.id || sessions.has(task.id)) continue;
      finalizeDiscardedTask(task);
      discardedAny = true;
    }
    if (discardedAny) {
      sessionRegistry.recomputeNextTaskId();
    }
  }

  async function pruneAbandonedEmptyCodingTasks(threadId: string): Promise<void> {
    const byId = new Map<`T${number}`, CommunicateTaskRecord>();
    let discardedAny = false;
    for (const task of recoveredTasks.values()) {
      if (task.threadId === threadId) {
        byId.set(task.id, cloneTaskRecord(task)!);
      }
    }
    for (const task of store.listTasksByThread(threadId)) {
      byId.set(task.id, task);
    }

    for (const task of byId.values()) {
      const source = store.getTask(task.id) ? 'live' : 'recovered';
      const latest = syncTaskFromSession(task.id) ?? task;
      if (!isAbandonedEmptyCodingTask(latest, source)) continue;
      const session = sessions.get(latest.id);
      if (session?.close) {
        logFeishuDebug('abandoned empty coding task close requested', {
          taskId: latest.id,
          threadId: latest.threadId,
          source,
          codexThreadId: latest.codexThreadId,
          session: debugSessionSnapshot(session)
        });
        try {
          await session.close();
          logFeishuDebug('abandoned empty coding task close completed', {
            taskId: latest.id,
            threadId: latest.threadId,
            source,
            codexThreadId: latest.codexThreadId
          });
        } catch {
          logFeishuDebug('abandoned empty coding task close failed', {
            taskId: latest.id,
            threadId: latest.threadId,
            source,
            codexThreadId: latest.codexThreadId
          });
          // Best effort only. The empty task record is still discarded locally.
        }
      }
      sessions.delete(latest.id);
      finalizeDiscardedTask(latest);
      discardedAny = true;
    }
    if (discardedAny) {
      sessionRegistry.recomputeNextTaskId();
    }
  }

  function restoreCurrentCodingTargetFromActiveTasks(
    threadId: string,
    options: {
      preferDisplayMode?: SessionThreadUiStateRecord['displayMode'];
      priorCurrentCodingTaskId?: `T${number}` | undefined;
    } = {}
  ): void {
    const ui = getThreadUiState(threadId);
    if (ui.currentCodingTaskId) return;
    if (!options.priorCurrentCodingTaskId) return;
    const fallbackTask = listActiveCodingTasks(threadId)[0];
    if (!fallbackTask) return;
    setThreadUiState(threadId, {
      currentCodingTaskId: fallbackTask.id,
      displayMode: options.preferDisplayMode ?? ui.displayMode
    });
  }

  async function pruneAbandonedEmptyCodingTasksForStatusCard(threadId: string): Promise<void> {
    const priorUi = getThreadUiState(threadId);
    await pruneAbandonedEmptyCodingTasks(threadId);
    restoreCurrentCodingTargetFromActiveTasks(threadId, {
      priorCurrentCodingTaskId: priorUi.currentCodingTaskId,
      preferDisplayMode: priorUi.displayMode === 'coding' ? 'coding' : undefined
    });
  }

  function queueLazyGoalSummaryBackfills(threadId: string): void {
    for (const task of listActiveCodingTasks(threadId)) {
      if (task.goalSummary && task.goalSummaryStatus === 'ready') continue;
      queueGoalSummaryGeneration(
        task.id,
        task.goalSummarySourceText ?? task.firstUserCodingText ?? readFirstGoalSummarySourceFromLog(task.logFilePath)
      );
    }
  }

  function formatTakeoverPickerSnapshotUpdatedAt(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  function describeTakeoverScanError(error: string): string {
    const trimmed = error.trim();
    return trimmed.startsWith('扫描本地 Codex 失败：') ? trimmed : `扫描本地 Codex 失败：${trimmed}`;
  }

  function resolveTakeoverPickerTotalPagesForCount(taskCount: number): number {
    return Math.max(1, Math.ceil(taskCount / TAKEOVER_PICKER_PAGE_SIZE));
  }

  function clampTakeoverPickerPage(page: number | undefined, totalPages: number): number {
    return Math.min(Math.max(0, page ?? 0), Math.max(1, totalPages) - 1);
  }

  function buildCliTakeoverScanResult(options: { lightweight?: boolean } = {}): CodexCliScanResult {
    if (input.cliScannerResult) {
      try {
        return input.cliScannerResult();
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    if (input.cliScanner) {
      try {
        return { ok: true, sessions: input.cliScanner() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    return scanCodexCliSessionsResult(options.lightweight ? { includeRolloutMetadata: false } : {});
  }

  function resolveTakeoverSummary(input: {
    goalSummary?: string;
    goalSummarySourceText?: string;
    threadName?: string;
    firstText?: string;
    lastText?: string;
    checkpointOutput?: string;
  }): string | undefined {
    const candidates = [
      input.goalSummary,
      input.goalSummarySourceText,
      input.threadName,
      input.firstText,
      input.lastText,
      input.checkpointOutput
    ];
    for (const item of candidates) {
      if (typeof item === 'string' && item.trim() !== '') return item;
    }
    return undefined;
  }

  function collectExistingCodexTasksByThread(threadId: string): Map<string, CommunicateTaskRecord> {
    const existingByThread = new Map<string, CommunicateTaskRecord>();
    for (const task of store.listTasksByThread(threadId)) {
      if (task.codexThreadId) {
        existingByThread.set(task.codexThreadId, task);
      }
    }
    for (const task of recoveredTasks.values()) {
      if (task.threadId !== threadId) continue;
      if (task.codexThreadId && !existingByThread.has(task.codexThreadId)) {
        existingByThread.set(task.codexThreadId, task);
      }
    }
    return existingByThread;
  }

  function collectManagedHotCodexThreadIds(): Set<string> {
    const hotCodexThreadIds = new Set<string>();
    for (const [taskId, session] of sessions) {
      const snapshot = session.getSnapshot?.();
      const codexThreadId = snapshot?.codexThreadId ?? getTaskRecord(taskId)?.codexThreadId;
      if (typeof codexThreadId === 'string' && codexThreadId.trim() !== '') {
        hotCodexThreadIds.add(codexThreadId);
      }
    }
    return hotCodexThreadIds;
  }

  function resolveHotManagedCodexThreadConflict(
    task: Pick<CommunicateTaskRecord, 'id' | 'threadId' | 'codexThreadId'>
  ): { taskId: `T${number}`; threadId?: string } | undefined {
    if (!task.codexThreadId) {
      return undefined;
    }
    for (const [taskId, session] of sessions) {
      if (taskId === task.id) continue;
      const snapshot = session.getSnapshot?.();
      const managedCodexThreadId = snapshot?.codexThreadId ?? getTaskRecord(taskId)?.codexThreadId;
      if (managedCodexThreadId !== task.codexThreadId) continue;
      return {
        taskId,
        threadId: getTaskRecord(taskId)?.threadId
      };
    }
    return undefined;
  }

  function describeHotManagedCodexThreadConflict(
    task: Pick<CommunicateTaskRecord, 'id' | 'threadId' | 'codexThreadId'>,
    conflict = resolveHotManagedCodexThreadConflict(task)
  ): string | undefined {
    if (!conflict) {
      return undefined;
    }
    if (conflict.threadId && conflict.threadId === task.threadId) {
      return `任务 ${task.id} 对应的本地 Codex 会话已被当前线程中的 ${conflict.taskId} 接管，请刷新后重试。`;
    }
    return `任务 ${task.id} 对应的本地 Codex 会话已被其它飞书线程接管，请刷新后重试。`;
  }

  function importScannedCliSessionsForThread(
    threadId: string,
    sessionsFound: CodexCliSessionInfo[]
  ): Map<string, CommunicateTaskRecord> {
    const existingByThread = collectExistingCodexTasksByThread(threadId);
    const hotManagedCodexThreadIds = collectManagedHotCodexThreadIds();
    const protectedModelsByTaskId = new Map<`T${number}`, string>();
    for (const task of existingByThread.values()) {
      const knownModel =
        normalizeCommunicateTaskModel(task.model) ??
        normalizeCommunicateTaskModel(sessionRegistry.getSessionRecord(task.id)?.model);
      if (knownModel) {
        protectedModelsByTaskId.set(task.id, knownModel);
      }
    }

    for (const session of sessionsFound) {
      if (!session.threadId) continue;
      if (hotManagedCodexThreadIds.has(session.threadId)) {
        existingByThread.delete(session.threadId);
        continue;
      }
      const existing = existingByThread.get(session.threadId);
      if (existing) {
        const nextPatch: Partial<CommunicateTaskRecord> = {};
        const persistedExistingModel = normalizeCommunicateTaskModel(sessionRegistry.getSessionRecord(existing.id)?.model);
        const knownExistingModel = normalizeCommunicateTaskModel(existing.model) ?? persistedExistingModel;
        if (!existing.cwd && session.cwd) {
          nextPatch.cwd = session.cwd;
        }
        if (!existing.goalSummarySourceText) {
          nextPatch.goalSummarySourceText = resolveTakeoverSummary({
            threadName: session.threadName,
            firstText: session.firstText,
            lastText: session.lastText
          });
        }
        if (!existing.firstUserCodingText && session.firstText) {
          nextPatch.firstUserCodingText = normalizeFirstUserCodingText(session.firstText);
        }
        if (!existing.checkpointOutput && session.lastText) {
          nextPatch.checkpointOutput = session.lastText;
        }
        const existingLastEventAtMs = parseIsoTimestampMs(existing.lastEventAt);
        const scannedUpdatedAtMs = parseIsoTimestampMs(session.updatedAt);
        if (
          session.updatedAt &&
          scannedUpdatedAtMs !== undefined &&
          (existingLastEventAtMs === undefined || scannedUpdatedAtMs >= existingLastEventAtMs)
        ) {
          nextPatch.lastEventAt = session.updatedAt;
        }
        if (knownExistingModel) {
          if (existing.model !== knownExistingModel) {
            nextPatch.model = knownExistingModel;
          }
        } else if (typeof session.model === 'string') {
          nextPatch.model = session.model;
        }
        if (Object.keys(nextPatch).length > 0) {
          const updated = updateKnownTask(existing.id, nextPatch);
          if (updated) {
            syncRegistryRecord(updated, sessions.get(updated.id));
            existingByThread.set(session.threadId, updated);
          }
        }
        continue;
      }

      const reservedTaskId = sessionRegistry.reserveNextTaskId();
      const created = store.createTask({
        id: reservedTaskId,
        taskType: 'codex_session',
        threadId,
        lifecycle: 'IDLE',
        codexThreadId: session.threadId,
        model: session.model,
        cwd: session.cwd,
        checkpointOutput: session.lastText,
        lastEventAt: session.updatedAt,
        approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
        sandbox: DEFAULT_CODEX_SANDBOX,
        sessionKind: 'coding',
        interruptedByRestart: true,
        startupMode: 'resume',
        goalSummarySourceText: normalizeGoalSummarySourceText(session.threadName) ?? normalizeGoalSummarySourceText(session.firstText),
        firstUserCodingText: normalizeFirstUserCodingText(session.firstText)
      });
      if (created.id !== reservedTaskId) {
        throw new Error(`Task ID registry desync: expected ${reservedTaskId}, received ${created.id}.`);
      }
      syncRegistryRecord(created);
      queueGoalSummaryGeneration(created.id, created.goalSummarySourceText);
      existingByThread.set(session.threadId, created);
    }

    for (const [taskId, protectedModel] of protectedModelsByTaskId) {
      const current = getTaskRecord(taskId);
      if (!current || current.model === protectedModel) continue;
      const updated = updateKnownTask(taskId, { model: protectedModel });
      if (!updated) continue;
      syncRegistryRecord(updated, sessions.get(updated.id));
      if (updated.codexThreadId) {
        existingByThread.set(updated.codexThreadId, updated);
      }
    }

    return existingByThread;
  }

  function isTakeoverPickerCandidate(task?: CommunicateTaskRecord): task is CommunicateTaskRecord {
    if (!task) return false;
    return (
      task.taskType === 'codex_session' &&
      task.sessionKind === 'coding' &&
      task.lifecycle !== 'CLOSED' &&
      Boolean(task.codexThreadId) &&
      !sessions.has(task.id) &&
      !resolveHotManagedCodexThreadConflict(task)
    );
  }

  function collectTakeoverCandidateSessionsForThread(
    threadId: string,
    sessionsFound: CodexCliSessionInfo[]
  ): CodexCliSessionInfo[] {
    const existingByThread = collectExistingCodexTasksByThread(threadId);
    const hotManagedCodexThreadIds = collectManagedHotCodexThreadIds();
    const candidates: CodexCliSessionInfo[] = [];
    for (const session of sessionsFound) {
      if (!session.threadId) continue;
      if (hotManagedCodexThreadIds.has(session.threadId)) {
        existingByThread.delete(session.threadId);
        continue;
      }
      const existing = existingByThread.get(session.threadId);
      if (existing && !isTakeoverPickerCandidate(existing)) {
        continue;
      }
      candidates.push(session);
    }
    return candidates;
  }

  function buildTakeoverPickerSnapshot(threadId: string):
    | { ok: true; snapshot: TakeoverPickerSnapshotRecord }
    | { ok: false; error: string } {
    const scanResult = buildCliTakeoverScanResult({ lightweight: true });
    if (!scanResult.ok) {
      return { ok: false, error: describeTakeoverScanError(scanResult.error) };
    }
    const candidateSessions = collectTakeoverCandidateSessionsForThread(threadId, scanResult.sessions);
    return {
      ok: true,
      snapshot: {
        sessions: candidateSessions,
        snapshotUpdatedAt: formatTakeoverPickerSnapshotUpdatedAt(),
        totalPages: resolveTakeoverPickerTotalPagesForCount(candidateSessions.length)
      }
    };
  }

  function hydrateTakeoverPickerSnapshotPage(
    threadId: string,
    snapshot: TakeoverPickerSnapshotRecord,
    page: number
  ): {
    page: number;
    taskIds: Array<`T${number}`>;
    totalPages: number;
    snapshotUpdatedAt: string;
  } {
    const nextPage = clampTakeoverPickerPage(page, snapshot.totalPages);
    const pageSessions = snapshot.sessions.slice(
      nextPage * TAKEOVER_PICKER_PAGE_SIZE,
      nextPage * TAKEOVER_PICKER_PAGE_SIZE + TAKEOVER_PICKER_PAGE_SIZE
    );
    const existingByThread = importScannedCliSessionsForThread(threadId, pageSessions);
    const taskIds: Array<`T${number}`> = [];
    for (const session of pageSessions) {
      const task = existingByThread.get(session.threadId);
      if (!isTakeoverPickerCandidate(task)) continue;
      taskIds.push(task.id);
    }
    return {
      page: nextPage,
      taskIds,
      totalPages: snapshot.totalPages,
      snapshotUpdatedAt: snapshot.snapshotUpdatedAt
    };
  }

  function applyTakeoverPickerSnapshotPage(
    threadId: string,
    snapshot: TakeoverPickerSnapshotRecord,
    page: number,
    options: { selectedTaskId?: `T${number}`; error?: string } = {}
  ): void {
    const hydrated = hydrateTakeoverPickerSnapshotPage(threadId, snapshot, page);
    const selectedTaskId =
      options.selectedTaskId && hydrated.taskIds.includes(options.selectedTaskId) ? options.selectedTaskId : undefined;
    setThreadUiState(threadId, {
      statusCardMode: 'takeover_picker',
      statusCardPickerOpen: false,
      takeoverPickerTaskIds: hydrated.taskIds,
      takeoverPickerPage: hydrated.page,
      takeoverPickerTotalPages: hydrated.totalPages,
      takeoverPickerSelectedTaskId: selectedTaskId,
      takeoverPickerSnapshotUpdatedAt: hydrated.snapshotUpdatedAt,
      takeoverPickerError: options.error
    });
  }

  function showTakeoverPickerPage(
    threadId: string,
    page: number,
    selectedTaskId?: `T${number}`
  ): void {
    const currentUi = getThreadUiState(threadId);
    if (currentUi.takeoverPickerTotalPages === undefined) {
      const totalPages = resolveTakeoverPickerTotalPagesForCount(currentUi.takeoverPickerTaskIds?.length ?? 0);
      const nextPage = clampTakeoverPickerPage(page, totalPages);
      const nextSelectedTaskId =
        selectedTaskId && (currentUi.takeoverPickerTaskIds?.includes(selectedTaskId) ?? false)
          ? selectedTaskId
          : undefined;
      setThreadUiState(threadId, {
        statusCardMode: 'takeover_picker',
        statusCardPickerOpen: false,
        takeoverPickerPage: nextPage,
        takeoverPickerSelectedTaskId: nextSelectedTaskId
      });
      return;
    }

    let snapshot = takeoverPickerSnapshots.get(threadId);
    if (!snapshot) {
      const rebuilt = buildTakeoverPickerSnapshot(threadId);
      if (!rebuilt.ok) {
        setThreadUiState(threadId, {
          statusCardMode: 'takeover_picker',
          statusCardPickerOpen: false,
          takeoverPickerSelectedTaskId: undefined,
          takeoverPickerError: rebuilt.error
        });
        return;
      }
      snapshot = rebuilt.snapshot;
      takeoverPickerSnapshots.set(threadId, snapshot);
      pruneImportedTakeoverPlaceholdersForThreadByCodexThreadIds(
        threadId,
        snapshot.sessions.map((session) => session.threadId)
      );
    }

    applyTakeoverPickerSnapshotPage(threadId, snapshot, page, { selectedTaskId });
  }

  function resolveTakeoverPickerTaskSnapshot(
    threadId: string,
    taskId: `T${number}`
  ): CommunicateTaskRecord | undefined {
    const task = getTaskRecord(taskId);
    if (!task || task.threadId !== threadId || !isTakeoverPickerCandidate(task)) {
      return undefined;
    }
    return task;
  }

  function resolveTakeoverPickerTaskSummary(task: CommunicateTaskRecord): string | undefined {
    const candidates = [
      task.firstUserCodingText,
      task.goalSummarySourceText,
      task.goalSummary,
      task.checkpointOutput
    ];
    for (const candidate of candidates) {
      const summary = formatTakeoverPickerSummary(candidate);
      if (summary) {
        return summary;
      }
    }
    return undefined;
  }

  function resolveTakeoverPickerUpdatedAtLabel(task: CommunicateTaskRecord): string | undefined {
    const parsed = parseIsoTimestampMs(task.lastEventAt);
    if (parsed === undefined) return undefined;
    return formatReplyStatusUpdatedLabel(Math.max(0, Date.now() - parsed));
  }

  function buildTakeoverPickerCardInput(
    threadId: string,
    ui: SessionThreadUiStateRecord
  ):
    | {
        fallbackToStatus: true;
      }
    | {
        fallbackToStatus: false;
        tasks: Array<{
          taskId: string;
          lifecycle: string;
          cwd?: string;
          summary?: string;
          updatedAtLabel?: string;
        }>;
        page: number;
        totalPages: number;
        selectedTaskId?: `T${number}`;
        snapshotUpdatedAt?: string;
        error?: string;
      } {
    const snapshotTaskIds = ui.takeoverPickerTaskIds ?? [];
    const snapshotTasks = snapshotTaskIds
      .map((taskId) => resolveTakeoverPickerTaskSnapshot(threadId, taskId))
      .filter((task): task is CommunicateTaskRecord => Boolean(task));
    if (snapshotTaskIds.length > 0 && snapshotTasks.length === 0) {
      if (ui.takeoverPickerError) {
        setThreadUiState(threadId, {
          statusCardMode: 'takeover_picker',
          takeoverPickerTaskIds: [],
          takeoverPickerPage: 0,
          takeoverPickerSelectedTaskId: undefined
        });
        return {
          fallbackToStatus: false,
          tasks: [],
          page: 0,
          totalPages: 1,
          selectedTaskId: undefined,
          snapshotUpdatedAt: ui.takeoverPickerSnapshotUpdatedAt,
          error: ui.takeoverPickerError
        };
      }
      setThreadUiState(threadId, {
        statusCardMode: 'status',
        takeoverPickerTaskIds: undefined,
        takeoverPickerPage: undefined,
        takeoverPickerSelectedTaskId: undefined,
        takeoverPickerSnapshotUpdatedAt: undefined,
        takeoverPickerError: undefined
      });
      return { fallbackToStatus: true };
    }

    const legacyInlineSnapshot = ui.takeoverPickerTotalPages === undefined;
    const totalPages = legacyInlineSnapshot
      ? resolveTakeoverPickerTotalPagesForCount(snapshotTasks.length)
      : Math.max(1, ui.takeoverPickerTotalPages ?? 1);
    const page = clampTakeoverPickerPage(ui.takeoverPickerPage, totalPages);
    const visibleTasks = legacyInlineSnapshot
      ? snapshotTasks.slice(page * TAKEOVER_PICKER_PAGE_SIZE, page * TAKEOVER_PICKER_PAGE_SIZE + TAKEOVER_PICKER_PAGE_SIZE)
      : snapshotTasks;
    const selectedTaskId =
      ui.takeoverPickerSelectedTaskId && visibleTasks.some((task) => task.id === ui.takeoverPickerSelectedTaskId)
        ? ui.takeoverPickerSelectedTaskId
        : undefined;
    return {
      fallbackToStatus: false,
      tasks: visibleTasks.map((task) => ({
        taskId: task.id,
        lifecycle: resolveTaskLifecycleFromSnapshot(task, sessions.get(task.id)?.getSnapshot?.()),
        cwd: task.cwd,
        summary: resolveTakeoverPickerTaskSummary(task),
        updatedAtLabel: resolveTakeoverPickerUpdatedAtLabel(task)
      })),
      page,
      totalPages,
      selectedTaskId,
      snapshotUpdatedAt: ui.takeoverPickerSnapshotUpdatedAt,
      error: ui.takeoverPickerError
    };
  }

  function openTakeoverPickerState(threadId: string): void {
    const currentUi = getThreadUiState(threadId);
    const collected = buildTakeoverPickerSnapshot(threadId);
    if (!collected.ok) {
      setThreadUiState(threadId, {
        statusCardMode: 'takeover_picker',
        statusCardPickerOpen: false,
        takeoverPickerTaskIds: currentUi.takeoverPickerTaskIds,
        takeoverPickerPage: currentUi.takeoverPickerPage ?? 0,
        takeoverPickerTotalPages: currentUi.takeoverPickerTotalPages,
        takeoverPickerSelectedTaskId: undefined,
        takeoverPickerSnapshotUpdatedAt: currentUi.takeoverPickerSnapshotUpdatedAt,
        takeoverPickerError: collected.error
      });
      return;
    }

    takeoverPickerSnapshots.set(threadId, collected.snapshot);
    pruneImportedTakeoverPlaceholdersForThreadByCodexThreadIds(
      threadId,
      collected.snapshot.sessions.map((session) => session.threadId)
    );
    applyTakeoverPickerSnapshotPage(threadId, collected.snapshot, 0);
  }

  function refreshTakeoverPickerState(threadId: string): void {
    const currentUi = getThreadUiState(threadId);
    const collected = buildTakeoverPickerSnapshot(threadId);
    if (!collected.ok) {
      setThreadUiState(threadId, {
        statusCardMode: 'takeover_picker',
        statusCardPickerOpen: false,
        takeoverPickerTaskIds: currentUi.takeoverPickerTaskIds,
        takeoverPickerPage: currentUi.takeoverPickerPage ?? 0,
        takeoverPickerTotalPages: currentUi.takeoverPickerTotalPages,
        takeoverPickerSelectedTaskId: undefined,
        takeoverPickerSnapshotUpdatedAt: currentUi.takeoverPickerSnapshotUpdatedAt,
        takeoverPickerError: collected.error
      });
      return;
    }

    takeoverPickerSnapshots.set(threadId, collected.snapshot);
    pruneImportedTakeoverPlaceholdersForThreadByCodexThreadIds(
      threadId,
      collected.snapshot.sessions.map((session) => session.threadId)
    );
    applyTakeoverPickerSnapshotPage(threadId, collected.snapshot, 0);
  }

  function isRecoverableCodingTask(task?: CommunicateTaskRecord): task is CommunicateTaskRecord {
    if (!task) return false;
    return (
      task.taskType === 'codex_session' &&
      task.sessionKind === 'coding' &&
      task.lifecycle !== 'CLOSED' &&
      (sessions.has(task.id) || Boolean(task.codexThreadId)) &&
      !isImportedTakeoverPlaceholderTask(task)
    );
  }

  function toPickerTaskCardInput(task: CommunicateTaskRecord) {
    const session = sessions.get(task.id);
    const snapshot = session?.getSnapshot?.();
    const lifecycle =
      task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED' || task.lifecycle === 'CLOSED'
        ? task.lifecycle
        : String(snapshot?.lifecycle ?? task.lifecycle);
    return {
      taskId: task.id,
      lifecycle,
      goalSummary: task.goalSummary,
      goalSummaryStatus: task.goalSummaryStatus,
      cwd: task.cwd
    };
  }

  function resolveTaskLifecycleFromSnapshot(
    task: CommunicateTaskRecord,
    snapshot?: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>>
  ): string {
    if (!snapshot?.lifecycle) return task.lifecycle;
    if (task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED' || task.lifecycle === 'CLOSED') {
      return task.lifecycle;
    }
    return String(snapshot.lifecycle);
  }

  function resolveStatusCardRenderMode(
    ui: SessionThreadUiStateRecord,
    pickerTasks: Array<NonNullable<ReturnType<typeof toPickerTaskCardInput>>>
  ): 'status' | 'launcher' | 'launcher_with_error' | 'takeover_picker' {
    if (ui.statusCardMode === 'takeover_picker') {
      return 'takeover_picker';
    }
    if (ui.statusCardMode === 'launcher') {
      return ui.launcherError ? 'launcher_with_error' : 'launcher';
    }
    return 'status';
  }

  function buildCurrentStatusCardSnapshot(
    threadId: string,
    options?: { assistantTaskResolver?: (threadId: string) => CommunicateTaskRecord | undefined }
  ): {
    ui: SessionThreadUiStateRecord;
    mode: 'status' | 'launcher' | 'launcher_with_error' | 'takeover_picker';
    pickerTasks: Array<NonNullable<ReturnType<typeof toPickerTaskCardInput>>>;
    launcherSelectedCwd?: string;
    card: Record<string, unknown>;
  } {
    resolveCurrentCodingTaskSnapshot(threadId);
    const ui = getThreadUiState(threadId);
    const pickerTasks = listActiveCodingTasksSnapshot(threadId)
      .map((task) => toPickerTaskCardInput(task))
      .filter((task): task is NonNullable<ReturnType<typeof toPickerTaskCardInput>> => Boolean(task))
      .slice(0, 5);
    const currentCodingTask = ui.currentCodingTaskId
      ? resolveAvailableCodingTaskSnapshot(threadId, ui.currentCodingTaskId)
      : undefined;
    const assistantTaskResolver = options?.assistantTaskResolver ?? resolveBoundAssistantTaskSnapshot;
    const currentTask =
      currentCodingTask ??
      (ui.displayMode === 'assistant'
        ? assistantTaskResolver(threadId)
        : undefined);
    const currentTaskSnapshot = currentTask ? sessions.get(currentTask.id)?.getSnapshot?.() : undefined;
    const currentTaskRuntimeConfig = currentTask ? buildTaskRuntimeConfigView(currentTask, currentTaskSnapshot) : undefined;
    const recentProjectDirs = getRecentProjectDirs();
    const [firstRecentProjectDir] = recentProjectDirs;
    const launcherSelectedCwd = ui.launcherSelectedCwd ?? firstRecentProjectDir;
    const mode = resolveStatusCardRenderMode(ui, pickerTasks);
    if (mode === 'takeover_picker') {
      const takeoverPicker = buildTakeoverPickerCardInput(threadId, ui);
      if (takeoverPicker.fallbackToStatus) {
        return buildCurrentStatusCardSnapshot(threadId, options);
      }
      const card = renderFeishuModeStatusCard({
        mode: 'takeover_picker',
        displayMode: ui.displayMode,
        currentCodingTaskId: ui.currentCodingTaskId,
        takeoverPickerTasks: takeoverPicker.tasks,
        takeoverPickerPage: takeoverPicker.page,
        takeoverPickerTotalPages: takeoverPicker.totalPages,
        takeoverPickerSelectedTaskId: takeoverPicker.selectedTaskId,
        takeoverPickerSnapshotUpdatedAt: takeoverPicker.snapshotUpdatedAt,
        takeoverPickerError: takeoverPicker.error
      });
      return {
        ui,
        mode,
        pickerTasks,
        launcherSelectedCwd,
        card
      };
    }
    const card = renderFeishuModeStatusCard({
      mode,
      displayMode: ui.displayMode,
      currentCodingTaskId: ui.currentCodingTaskId,
      currentTaskLifecycle: currentTask ? resolveTaskLifecycleFromSnapshot(currentTask, currentTaskSnapshot) : undefined,
      currentTaskModel: currentTaskRuntimeConfig?.model,
      currentTaskSandbox: currentTaskRuntimeConfig?.sandbox,
      currentTaskApprovalPolicy: currentTaskRuntimeConfig?.approvalPolicy,
      currentTaskSessionKind: currentTaskRuntimeConfig?.sessionKind,
      currentTaskStartupMode: currentTaskRuntimeConfig?.startupMode,
      currentTaskInterruptedByRestart: currentTaskRuntimeConfig?.interruptedByRestart,
      currentTaskDefaultSandbox: currentTaskRuntimeConfig?.defaultSandbox,
      currentTaskDefaultApprovalPolicy: currentTaskRuntimeConfig?.defaultApprovalPolicy,
      currentTaskRuntimeWarnings: currentTask
        ? resolveRetainedRuntimeWarnings(currentTask.runtimeWarnings, currentTaskSnapshot?.runtimeWarnings)
        : undefined,
      pickerOpen: ui.statusCardPickerOpen === true,
      pickerTasks,
      recentProjectDirs,
      launcherSelectedCwd,
      launcherDraftCwd: ui.launcherDraftCwd,
      launcherError: ui.launcherError
    });
    return {
      ui,
      mode,
      pickerTasks,
      launcherSelectedCwd,
      card
    };
  }

  async function refreshStatusCard(threadId: string): Promise<void> {
    if (!input.channel.sendCard && !input.channel.updateCard) return;
    ensureLauncherSelection(threadId);
    resolveCurrentCodingTask(threadId);
    const snapshot = buildCurrentStatusCardSnapshot(threadId, { assistantTaskResolver: resolveBoundAssistantTask });
    const ui = snapshot.ui;
    logFeishuDebug('status card refresh', {
      threadId,
      targetMessageId: ui.statusCardMessageId,
      targetActionMessageId: ui.statusCardActionMessageId,
      mode: snapshot.mode,
      displayMode: ui.displayMode,
      statusCardMode: ui.statusCardMode,
      pickerOpen: ui.statusCardPickerOpen === true,
      pickerTaskIds: snapshot.pickerTasks.map((task) => task.taskId),
      launcherSelectedCwd: snapshot.launcherSelectedCwd
    });
    if (!ui.statusCardMessageId) {
      if (!input.channel.sendCard) return;
      const messageId = await input.channel.sendCard(threadId, snapshot.card);
      setThreadUiState(threadId, {
        statusCardMessageId: messageId,
        statusCardActionMessageId: undefined
      });
      logFeishuDebug('status card sent', {
        threadId,
        messageId,
        mode: snapshot.mode,
        pickerTaskIds: snapshot.pickerTasks.map((task) => task.taskId)
      });
      return;
    }
    if (!input.channel.updateCard) {
      if (!input.channel.sendCard) return;
      const messageId = await input.channel.sendCard(threadId, snapshot.card);
      setThreadUiState(threadId, {
        statusCardMessageId: messageId,
        statusCardActionMessageId: undefined
      });
      logFeishuDebug('status card update unavailable; sent replacement', {
        threadId,
        previousMessageId: ui.statusCardMessageId,
        messageId,
        mode: snapshot.mode,
        pickerTaskIds: snapshot.pickerTasks.map((task) => task.taskId)
      });
      return;
    }
    try {
      await input.channel.updateCard(ui.statusCardMessageId, snapshot.card);
      logFeishuDebug('status card updated', {
        threadId,
        messageId: ui.statusCardMessageId,
        mode: snapshot.mode,
        pickerTaskIds: snapshot.pickerTasks.map((task) => task.taskId)
      });
    } catch (error) {
      logFeishuDebug('status card update failed; sending replacement', {
        threadId,
        messageId: ui.statusCardMessageId,
        targetActionMessageId: ui.statusCardActionMessageId,
        error: String(error)
      });
      if (!input.channel.sendCard) {
        await sendPlainText(threadId, '项目卡更新失败，请稍后重试。');
        return;
      }
      const messageId = await input.channel.sendCard(threadId, snapshot.card);
      setThreadUiState(threadId, {
        statusCardMessageId: messageId,
        statusCardActionMessageId: undefined
      });
      logFeishuDebug('status card replacement sent', {
        threadId,
        messageId,
        mode: snapshot.mode,
        pickerTaskIds: snapshot.pickerTasks.map((task) => task.taskId)
      });
    }
  }

  async function sendFreshStatusCard(threadId: string): Promise<void> {
    if (!input.channel.sendCard) {
      await sendPlainText(threadId, '项目卡暂不可用：当前通道不支持卡片发送。');
      return;
    }
    ensureLauncherSelection(threadId);
    resolveCurrentCodingTaskSnapshot(threadId);
    const snapshot = buildCurrentStatusCardSnapshot(threadId);
    try {
      const messageId = await input.channel.sendCard(threadId, snapshot.card);
      setThreadUiState(threadId, {
        statusCardMessageId: messageId,
        statusCardActionMessageId: undefined
      });
      logFeishuDebug('status card fresh copy sent', {
        threadId,
        previousMessageId: snapshot.ui.statusCardMessageId,
        previousActionMessageId: snapshot.ui.statusCardActionMessageId,
        messageId,
        mode: snapshot.mode,
        pickerTaskIds: snapshot.pickerTasks.map((task) => task.taskId),
        launcherSelectedCwd: snapshot.launcherSelectedCwd
      });
    } catch (error) {
      logFeishuDebug('status card fresh copy failed', {
        threadId,
        previousMessageId: snapshot.ui.statusCardMessageId,
        previousActionMessageId: snapshot.ui.statusCardActionMessageId,
        error: String(error)
      });
      await sendPlainText(threadId, '项目卡发送失败，请稍后重试。');
    }
  }

  async function sendStartupCardToLastActiveUser(): Promise<void> {
    if (!input.channel.sendCardToRecipient) return;
    const openId = getLastActiveFeishuUserOpenId();
    if (!openId) return;
    const threadId = getLastActiveFeishuThreadId();
    if (threadId) {
      ensureLauncherSelection(threadId);
    }
    const startupUi = threadId ? getThreadUiState(threadId) : undefined;
    const [firstRecentProjectDir] = getRecentProjectDirs();
    const card = renderFeishuModeStatusCard({
      mode: 'launcher',
      displayMode: 'assistant',
      currentCodingTaskId: undefined,
      currentTaskLifecycle: undefined,
      pickerOpen: false,
      pickerTasks: [],
      recentProjectDirs: getRecentProjectDirs(),
      launcherSelectedCwd: startupUi?.launcherSelectedCwd ?? firstRecentProjectDir,
      launcherDraftCwd: undefined,
      launcherError: undefined
    });
    const messageId = await input.channel.sendCardToRecipient({
      receiveId: openId,
      receiveIdType: 'open_id',
      card
    });
    if (!threadId) return;
    setThreadUiState(threadId, {
      displayMode: 'assistant',
      statusCardMode: 'launcher',
      currentCodingTaskId: undefined,
      statusCardMessageId: messageId,
      statusCardActionMessageId: undefined,
      statusCardPickerOpen: false,
      launcherDraftCwd: undefined,
      launcherError: undefined
    });
  }

  async function handleHiddenModeCommand(threadId: string, command: HiddenModeCommand): Promise<void> {
    if (command.kind === 'status') {
      setThreadUiState(threadId, { statusCardMode: 'status' });
      resolveCurrentCodingTask(threadId);
      const ui = getThreadUiState(threadId);
      const taskLabel = ui.currentCodingTaskId ?? '未绑定';
      await sendPlainText(threadId, `当前模式：${ui.displayMode === 'coding' ? 'Coding' : '助手'}\n当前 Coding 目标：${taskLabel}`);
      await refreshStatusCard(threadId);
      return;
    }

    if (command.kind === 'assistant') {
      setThreadUiState(threadId, { displayMode: 'assistant', statusCardMode: 'status' });
      await sendPlainText(threadId, '已切换到助手模式。');
      await refreshStatusCard(threadId);
      return;
    }

    if (command.kind === 'task') {
      const task = resolveAvailableCodingTask(threadId, command.taskId);
      if (!task) {
        await sendPlainText(threadId, `任务 ${command.taskId} 不是当前线程可用的 Coding 目标。`);
        return;
      }
      setThreadUiState(threadId, { currentCodingTaskId: task.id, statusCardMode: 'status' });
      await sendPlainText(threadId, `已将当前 Coding 目标切换为 ${task.id}。`);
      await refreshStatusCard(threadId);
      return;
    }

    const currentTask = resolveCurrentCodingTask(threadId);
    if (!currentTask) {
      await sendPlainText(threadId, '当前没有可用的 Coding 任务，已保持助手模式。');
      return;
    }
    setThreadUiState(threadId, {
      displayMode: 'coding',
      statusCardMode: 'status',
      currentCodingTaskId: currentTask.id
    });
    await sendPlainText(threadId, `已切换到 Coding 模式，后续普通文本将发送给 ${currentTask.id}。`);
    await refreshStatusCard(threadId);
  }

  async function sendImplicitCodingReply(threadId: string, text: string): Promise<void> {
    const task = resolveCurrentCodingTask(threadId);
    if (!task) {
      await handleAssistantMessage(threadId, text);
      return;
    }

    const hadExistingSession = sessions.has(task.id);
    const ensuredSession = await ensureReplySession(task, 'implicit_coding_reply');
    if (!ensuredSession.ok) {
      clearCurrentCodingTarget(threadId);
      await sendPlainText(
        threadId,
        `${ensuredSession.error} 已切回助手模式。如需继续旧任务，请显式发送“对 ${task.id} 输入: ...”或重新创建 Coding 任务。`
      );
      await handleAssistantMessage(threadId, text);
      return;
    }
    const session = ensuredSession.session;

    const rawReply: CodexReplyPayload = { action: 'free_text', text: text.trim() };
    const reply = applyTaskScopedReplyGuardrails(task.id, rawReply);
    try {
      session.sendReply(reply);
    } catch (error) {
      const message = String(error);
      if (/already failed|no rollout found|closed/i.test(message)) {
        clearCurrentCodingTarget(threadId);
        await handleAssistantMessage(threadId, text);
        return;
      }
      await sendPlainText(threadId, `任务 ${task.id} 暂时无法接收输入：${message}`);
      return;
    }

    recordFirstUserCodingInput(task.id, text);

    const snapshot = session.getSnapshot?.();
    const lifecycle =
      task.lifecycle === 'STARTING'
        ? 'STARTING'
        : snapshot?.lifecycle === 'STARTING'
          ? 'RUNNING_TURN'
          : snapshot?.lifecycle ?? 'RUNNING_TURN';
    const updated = updateKnownTask(task.id, {
      lifecycle: lifecycle as any,
      waitKind: undefined,
      waitOptions: undefined,
      checkpointOutput: resolveRetainedCheckpointOutput(task.checkpointOutput, snapshot?.checkpointOutput),
      logFilePath: session.getLogPath?.() ?? snapshot?.logPath ?? task.logFilePath,
      codexThreadId: snapshot?.codexThreadId ?? task.codexThreadId,
      model: pickTaskModel(snapshot?.model, task.model),
      interruptedByRestart: snapshot?.interruptedByRestart ?? task.interruptedByRestart
    });
    if (updated) {
      syncRegistryRecord(updated, session);
    }
    const approvalCardState = resolveApprovalCardReplyState(task, rawReply);
    if (approvalCardState) {
      await safeUpdateApprovalCard(task.id, approvalCardState);
    }

    const isRunning = task.lifecycle === 'RUNNING_TURN' || snapshot?.lifecycle === 'RUNNING_TURN';
    const ack =
      !hadExistingSession && task.interruptedByRestart
        ? '已恢复会话。上一轮因服务重启已中断，本次输入会作为新的继续指令执行。'
        : task.lifecycle === 'STARTING'
          ? '已接收输入，待会话就绪后自动执行。'
          : task.lifecycle === 'WAITING_USER'
            ? '已恢复执行。'
          : isRunning
            ? '正在运行，消息已送达。'
            : '已恢复执行。';
    await sendCodingReplyAcknowledgement(threadId, task.id, ack);
  }

  function resolveTaskForReplyValidation(taskId: `T${number}`): CommunicateTaskRecord | undefined {
    const current = getTaskRecord(taskId);
    if (current?.lifecycle === 'WAITING_USER') {
      return current;
    }
    return syncTaskFromSession(taskId) ?? current;
  }

  async function handleInboundMessage(message: {
    threadId: string;
    text: string;
    senderOpenId?: string;
    messageId?: string;
    traceId?: string;
    frameSeq?: string;
    frameSum?: string;
  }): Promise<void> {
    rememberInboundDeliveryTarget(message.threadId, message.senderOpenId);
    const now = Date.now();
    const recentImages = pruneRecentImages(message.threadId, now);
    let effectiveText = message.text;
    logFeishuDebug('text inbound', {
      threadId: message.threadId,
      messageId: message.messageId,
      traceId: message.traceId,
      frameSeq: message.frameSeq,
      frameSum: message.frameSum,
      textLength: message.text.length,
      pendingImages: recentImages.length
    });
    if (recentImages.length > 0) {
      const imageLines = recentImages.map((item) => `- ${item.path}`).join("\n");
      effectiveText = `${effectiveText}\n\n[图片]\n${imageLines}`;
      pendingImages.delete(message.threadId);
      logFeishuDebug('text augmented with images', {
        threadId: message.threadId,
        imageCount: recentImages.length,
        imagePaths: recentImages.map((item) => item.path)
      });
    }
    const hiddenModeCommand = parseHiddenModeCommand(message.text);
    if (hiddenModeCommand) {
      await handleHiddenModeCommand(message.threadId, hiddenModeCommand);
      return;
    }
    if (isProjectCardKeyword(effectiveText)) {
      await sendFreshStatusCard(message.threadId);
      return;
    }
    const waitingTasks = store.listWaitingTasksByThread(message.threadId);
    const routed = routeUserMessage({
      text: effectiveText,
      threadId: message.threadId,
      waitingTasks
    });
    logFeishuDebug('route result', {
      threadId: message.threadId,
      intent: routed.intent,
      taskId: routed.taskId,
      needsClarification: routed.needsClarification,
      reason: routed.reason,
      waitingTasks: waitingTasks.length
    });

    if (routed.intent === 'takeover_local_codex') {
      pendingClarifications.delete(message.threadId);
      const taskId = routed.taskId as `T${number}` | undefined;
      await handleTakeoverLocalCodex(message.threadId, taskId);
      return;
    }



    const pendingClarification = pendingClarifications.get(message.threadId);
    if (
      pendingClarification?.kind === 'codex_cwd' &&
      routed.intent === 'start_task' &&
      routed.taskType === 'chat_reply'
    ) {
      const cwd = extractWindowsPath(message.text);
      if (cwd) {
        pendingClarifications.delete(message.threadId);
        await startCodexTask(message.threadId, cwd);
        return;
      }
    }

    if (routed.needsClarification) {
      rememberClarification(message.threadId, routed.reason);
      await sendPlainText(message.threadId, routed.clarificationPrompt ?? '需要补充更多信息。');
      return;
    }

    if (routed.intent === 'start_task' && routed.taskType === 'codex_session') {
      pendingClarifications.delete(message.threadId);
      await startCodexTask(message.threadId, String(routed.params.cwd ?? ''));
      return;
    }

    if (routed.intent === 'start_task' && routed.taskType === 'chat_reply') {
      const threadUi = getThreadUiState(message.threadId);
      if (threadUi.displayMode === 'coding' && threadUi.currentCodingTaskId) {
        await sendImplicitCodingReply(message.threadId, String(routed.params.message ?? ''));
        return;
      }
      await handleAssistantMessage(message.threadId, String(routed.params.message ?? ''));
      return;
    }

    if (routed.intent === 'query_task') {
      const taskId = routed.taskId as `T${number}` | undefined;
      const syncedTask = taskId ? syncTaskFromSession(taskId) : undefined;
      const task = syncedTask ?? (taskId ? getTaskRecord(taskId) : undefined);
      if (!task) {
        await sendPlainText(message.threadId, `未找到任务 ${routed.taskId ?? ''}`.trim());
        return;
      }
      const view = routed.params.view === 'progress' ? 'progress' : 'status';
      const delivery =
        view === 'progress' && supportsTaskProgressDelivery(task)
          ? buildTaskProgressDelivery(task)
          : buildTaskStatusDelivery(task);
      if (view === 'progress' && supportsTaskProgressDelivery(task)) {
        await sendTaskText(message.threadId, task.id, delivery);
      } else {
        await sendPlainText(message.threadId, delivery);
      }
      return;
    }

    if (routed.intent === 'cancel_task') {
      const taskId = routed.taskId as `T${number}` | undefined;
      const task = taskId ? syncTaskFromSession(taskId) ?? getTaskRecord(taskId) : undefined;
      if (!task) {
        await sendPlainText(message.threadId, `未找到任务 ${routed.taskId ?? ''}`.trim());
        return;
      }
      if (task.threadId !== message.threadId) {
        await sendPlainText(message.threadId, `任务 ${task.id} 不属于当前会话线程。`);
        return;
      }

      const { forced, updated } = await closeTaskRecord(task);
      await sendPlainText(message.threadId, forced ? `任务 ${task.id} 已强制关闭。` : `任务 ${task.id} 已关闭。`);
      if (updated && !isAssistantTask(updated)) {
        await refreshStatusCard(updated.threadId);
      }
      return;
    }

    if (routed.intent === 'resume_task') {
      const taskId = routed.taskId as `T${number}` | undefined;
      const task = taskId ? syncTaskFromSession(taskId) ?? getTaskRecord(taskId) : undefined;
      if (!task) {
        await sendPlainText(message.threadId, `未找到任务 ${routed.taskId ?? ''}`.trim());
        return;
      }
      if (task.threadId !== message.threadId) {
        await sendPlainText(message.threadId, `任务 ${task.id} 不属于当前会话线程。`);
        return;
      }
      if (task.taskType !== 'codex_session') {
        await sendPlainText(message.threadId, `任务 ${task.id} 不是 Codex 会话，无法恢复。`);
        return;
      }
      if (task.lifecycle !== 'CLOSED') {
        await sendPlainText(message.threadId, `任务 ${task.id} 当前状态为 ${task.lifecycle}，无需恢复。`);
        return;
      }
      const ensuredSession = await ensureReplySession(task, 'resume_closed_task');
      if (!ensuredSession.ok) {
        await sendPlainText(message.threadId, ensuredSession.error);
        return;
      }
      const session = ensuredSession.session;
      await sendPlainText(message.threadId, `任务 ${task.id} 已重新打开，继续执行。`);
      return;
    }

    if (routed.intent === 'reply_task' && routed.params.action === 'polish_then_confirm') {
      const taskId = routed.taskId as `T${number}` | undefined;
      if (!taskId || !getTaskRecord(taskId)) {
        await sendPlainText(message.threadId, `未找到任务 ${taskId ?? ''}`.trim());
        return;
      }
      const updated = await preparePolishCandidateTask({
        store,
        taskId,
        originalText: String(routed.params.text ?? ''),
        rewrite: polishRewrite
      });
      await sendPlainText(
        message.threadId,
        formatPolishCandidateDelivery({
          taskId: updated.id,
          candidateText: updated.polishCandidateText ?? ''
        })
      );
      return;
    }

    if (routed.intent === 'reply_task') {
      const explicitTaskId = routed.taskId as `T${number}` | undefined;
      const explicitTask = explicitTaskId ? resolveTaskForReplyValidation(explicitTaskId) : undefined;
      const recoverableFailedCodingTask =
        explicitTask &&
        explicitTask.taskType === 'codex_session' &&
        explicitTask.sessionKind === 'coding' &&
        explicitTask.lifecycle === 'FAILED' &&
        explicitTask.codexThreadId &&
        (routed.params.action === 'input_text' || routed.params.action === 'free_text')
          ? explicitTask
          : undefined;

      const validation = validateReplyCommand({
        currentThreadId: message.threadId,
        store: {
          getTask: getTaskRecord,
          listWaitingTasksByThread: (threadId: string) => store.listWaitingTasksByThread(threadId)
        },
        command: routed
      });
      if (!validation.ok && !recoverableFailedCodingTask) {
        await sendPlainText(message.threadId, validation.error);
        return;
      }
      const replyTargetTask = validation.ok ? validation.task : recoverableFailedCodingTask!;
      const hadExistingSession = sessions.has(replyTargetTask.id);
      const ensuredSession = await ensureReplySession(replyTargetTask, 'explicit_task_reply');
      if (!ensuredSession.ok) {
        await sendPlainText(message.threadId, ensuredSession.error);
        return;
      }
      const session = ensuredSession.session;

      const rawReply =
        routed.params.action === 'confirm_polish_send'
          ? confirmPolishCandidate(replyTargetTask)
          : toCodexReplyPayload(routed.params);
      const reply =
        replyTargetTask.taskType === 'codex_session' &&
        replyTargetTask.sessionKind === 'coding' &&
        (routed.params.action === 'input_text' || routed.params.action === 'free_text')
          ? applyTaskScopedReplyGuardrails(replyTargetTask.id, rawReply)
          : rawReply;
      try {
        session.sendReply(reply);
        logFeishuDebug('assistant reply accepted', {
          threadId: message.threadId,
          taskId: replyTargetTask.id,
          snapshot: debugSessionSnapshot(session)
        });
      } catch (error) {
        logFeishuDebug('assistant reply rejected', {
          threadId: message.threadId,
          taskId: replyTargetTask.id,
          error: String(error),
          snapshot: debugSessionSnapshot(session)
        });
        await sendPlainText(message.threadId, `任务 ${replyTargetTask.id} 暂时无法接收输入：${String(error)}`);
        return;
      }

      if (
        replyTargetTask.taskType === 'codex_session' &&
        replyTargetTask.sessionKind === 'coding' &&
        ('text' in rawReply)
      ) {
        recordFirstUserCodingInput(replyTargetTask.id, rawReply.text);
      }

      const snapshot = session.getSnapshot?.();
      const lifecycle = replyTargetTask.lifecycle === 'STARTING' ? 'STARTING' : snapshot?.lifecycle === 'STARTING' ? 'RUNNING_TURN' : snapshot?.lifecycle ?? 'RUNNING_TURN';
      const updated = updateKnownTask(replyTargetTask.id, {
        lifecycle: lifecycle as any,
        waitKind: undefined,
        waitOptions: undefined,
        checkpointOutput: resolveRetainedCheckpointOutput(replyTargetTask.checkpointOutput, snapshot?.checkpointOutput),
        logFilePath: session.getLogPath?.() ?? snapshot?.logPath ?? replyTargetTask.logFilePath,
        codexThreadId: snapshot?.codexThreadId ?? replyTargetTask.codexThreadId,
        model: pickTaskModel(snapshot?.model, replyTargetTask.model),
        interruptedByRestart: snapshot?.interruptedByRestart ?? replyTargetTask.interruptedByRestart
      });
      if (updated) {
        syncRegistryRecord(updated, session);
      }
      const approvalCardState = resolveApprovalCardReplyState(replyTargetTask, rawReply);
      if (approvalCardState) {
        await safeUpdateApprovalCard(replyTargetTask.id, approvalCardState);
      }
      const isRunning = replyTargetTask.lifecycle === 'RUNNING_TURN' || snapshot?.lifecycle === 'RUNNING_TURN';
      const ack =
        !hadExistingSession && (replyTargetTask.interruptedByRestart || replyTargetTask.lifecycle === 'FAILED')
          ? '已恢复会话。上一轮会话已中断，本次输入会作为新的继续指令执行。'
          : replyTargetTask.lifecycle === 'STARTING'
            ? '已接收输入，待会话就绪后自动执行。'
            : replyTargetTask.lifecycle === 'WAITING_USER'
              ? '已恢复执行。'
            : isRunning
              ? '正在运行，消息已送达。'
              : '已恢复执行。';
      if (replyTargetTask.taskType === 'codex_session' && replyTargetTask.sessionKind === 'coding') {
        await sendCodingReplyAcknowledgement(message.threadId, replyTargetTask.id, ack);
      } else {
        await sendPlainText(message.threadId, `任务 ${replyTargetTask.id} ${ack}`);
      }
    }
  }

  async function handleTakeoverLocalCodex(threadId: string, taskId?: `T${number}`): Promise<void> {
    const scan = input.cliScanner ?? scanCodexCliSessions;
    let sessionsFound: CodexCliSessionInfo[] = [];
    try {
      sessionsFound = scan();
    } catch {
      sessionsFound = [];
    }

    const existingByThread = new Map<string, CommunicateTaskRecord>();
    const hotManagedCodexThreadIds = collectManagedHotCodexThreadIds();
    for (const task of store.listTasksByThread(threadId)) {
      if (task.codexThreadId) {
        existingByThread.set(task.codexThreadId, task);
      }
    }
    for (const task of recoveredTasks.values()) {
      if (task.threadId !== threadId) continue;
      if (task.codexThreadId && !existingByThread.has(task.codexThreadId)) {
        existingByThread.set(task.codexThreadId, task);
      }
    }
    const protectedModelsByTaskId = new Map<`T${number}`, string>();
    for (const task of existingByThread.values()) {
      const knownModel = normalizeCommunicateTaskModel(task.model) ?? normalizeCommunicateTaskModel(sessionRegistry.getSessionRecord(task.id)?.model);
      if (knownModel) {
        protectedModelsByTaskId.set(task.id, knownModel);
      }
    }

    for (const session of sessionsFound) {
      if (!session.threadId) continue;
      if (hotManagedCodexThreadIds.has(session.threadId)) {
        existingByThread.delete(session.threadId);
        continue;
      }
      const existing = existingByThread.get(session.threadId);
      if (existing) {
        const nextPatch: Partial<CommunicateTaskRecord> = {};
        const persistedExistingModel = normalizeCommunicateTaskModel(sessionRegistry.getSessionRecord(existing.id)?.model);
        const knownExistingModel = normalizeCommunicateTaskModel(existing.model) ?? persistedExistingModel;
        if (!existing.cwd && session.cwd) {
          nextPatch.cwd = session.cwd;
        }
        if (knownExistingModel) {
          if (existing.model !== knownExistingModel) {
            nextPatch.model = knownExistingModel;
          }
        } else if (typeof session.model === 'string') {
          nextPatch.model = session.model;
        }
        if (Object.keys(nextPatch).length > 0) {
          const updated = updateKnownTask(existing.id, nextPatch);
          if (updated) {
            syncRegistryRecord(updated, sessions.get(updated.id));
            existingByThread.set(session.threadId, updated);
          }
        }
        continue;
      }
      const reservedTaskId = sessionRegistry.reserveNextTaskId();
      const created = store.createTask({
        id: reservedTaskId,
        taskType: 'codex_session',
        threadId,
        lifecycle: 'IDLE',
        codexThreadId: session.threadId,
        model: session.model,
        cwd: session.cwd,
        checkpointOutput: session.lastText,
        approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
        sandbox: DEFAULT_CODEX_SANDBOX,
        sessionKind: 'coding',
        interruptedByRestart: true,
        startupMode: 'resume',
        goalSummarySourceText: normalizeGoalSummarySourceText(session.threadName) ?? normalizeGoalSummarySourceText(session.firstText),
        firstUserCodingText: normalizeFirstUserCodingText(session.firstText)
      });
      if (created.id !== reservedTaskId) {
        throw new Error('Task ID registry desync: expected ' + reservedTaskId + ', received ' + created.id + '.');
      }
      syncRegistryRecord(created);
      queueGoalSummaryGeneration(created.id, created.goalSummarySourceText);
      existingByThread.set(session.threadId, created);
    }
    for (const [taskId, protectedModel] of protectedModelsByTaskId) {
      const current = getTaskRecord(taskId);
      if (!current || current.model === protectedModel) continue;
      const updated = updateKnownTask(taskId, { model: protectedModel });
      if (!updated) continue;
      syncRegistryRecord(updated, sessions.get(updated.id));
      if (updated.codexThreadId) {
        existingByThread.set(updated.codexThreadId, updated);
      }
    }

    const rawLimit = input.takeoverListLimit;
    const listLimit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.floor(rawLimit)
        : DEFAULT_TAKEOVER_LIST_LIMIT;
    const listSessions = sessionsFound
      .filter((session) => session.threadId && !hotManagedCodexThreadIds.has(session.threadId))
      .slice(0, listLimit);
    const resolveTakeoverSummary = (input: {
      threadName?: string;
      firstText?: string;
      lastText?: string;
      checkpointOutput?: string;
    }): string | undefined => {
      const candidates = [input.threadName, input.firstText, input.lastText, input.checkpointOutput];
      for (const item of candidates) {
        if (typeof item === 'string' && item.trim() !== '') return item;
      }
      return undefined;
    };

    const listTasks = listSessions.map((session) => {
      const task = existingByThread.get(session.threadId);
      const runtimeConfig = task
        ? buildTaskRuntimeConfigView(task)
        : {
            model: session.model,
            sandbox: undefined,
            approvalPolicy: undefined,
            sessionKind: undefined,
            startupMode: undefined,
            interruptedByRestart: undefined,
            defaultSandbox: undefined,
            defaultApprovalPolicy: undefined
          };
      return {
        id: task?.id ?? 'unknown',
        origin: task ? 'cli' : 'unknown',
        lifecycle: String(task?.lifecycle ?? 'UNKNOWN'),
        model: runtimeConfig.model,
        sandbox: runtimeConfig.sandbox,
        approvalPolicy: runtimeConfig.approvalPolicy,
        sessionKind: runtimeConfig.sessionKind,
        startupMode: runtimeConfig.startupMode,
        interruptedByRestart: runtimeConfig.interruptedByRestart,
        defaultSandbox: runtimeConfig.defaultSandbox,
        defaultApprovalPolicy: runtimeConfig.defaultApprovalPolicy,
        codexThreadId: session.threadId,
        cwd: session.cwd ?? task?.cwd,
        summary: resolveTakeoverSummary({
          threadName: session.threadName,
          firstText: session.firstText,
          lastText: session.lastText,
          checkpointOutput: task?.checkpointOutput
        })
      };
    });

    if (!taskId) {
      const body = formatTakeoverList(listTasks);
      await sendPlainText(threadId, body + '\n\n如需接管指定会话，请发送：接管Tn');
      return;
    }

    const targetTask = getTaskRecord(taskId);
    if (!targetTask) {
      const body = formatTakeoverList(listTasks);
      await sendPlainText(threadId, body + `\n\n未找到任务 ${taskId}，请先发送“接管 codex”查看列表。`);
      return;
    }
    const takeover = await takeoverTaskById(threadId, taskId, 'takeover_local_codex');
    if (!takeover.ok) {
      await sendPlainText(threadId, takeover.error);
      return;
    }
    const warning = takeover.warning ? `\n提示：${takeover.warning}` : '';
    await sendPlainText(threadId, `已开始接管 ${taskId}。${warning}`);
  }

  async function takeoverTaskById(
    threadId: string,
    taskId: `T${number}`,
    caller = 'takeover_local_codex'
  ): Promise<
    | {
        ok: true;
        task: CommunicateTaskRecord;
        warning?: string;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    const targetTask = getTaskRecord(taskId);
    if (!targetTask || targetTask.threadId !== threadId) {
      return {
        ok: false,
        error: `任务 ${taskId} 已不可用，请刷新列表后重试。`
      };
    }
    if (!targetTask.codexThreadId) {
      return {
        ok: false,
        error: `任务 ${taskId} 缺少可恢复的 Codex 线程标识，请重新创建会话。`
      };
    }
    const hotConflictError = describeHotManagedCodexThreadConflict(targetTask);
    if (hotConflictError) {
      return {
        ok: false,
        error: hotConflictError
      };
    }
    if (sessions.has(targetTask.id)) {
      return {
        ok: true,
        task: getTaskRecord(taskId) ?? targetTask
      };
    }

    const processApi = input.cliProcess ?? {
      list: listCodexCliProcesses,
      kill: terminateCodexCliProcesses
    };
    let killResult = { killed: 0, failed: 0, errors: [] as string[] };
    let killTargets: CodexProcessInfo[] = [];
    try {
      const candidates = filterCodexCliProcesses(processApi.list());
      const needle = targetTask.codexThreadId.toLowerCase();
      killTargets = needle
        ? candidates.filter((proc) => (proc.commandLine ?? '').toLowerCase().includes(needle))
        : [];
      logFeishuDebug('takeover process kill scan', {
        targetTaskId: targetTask.id,
        targetCodexThreadId: targetTask.codexThreadId,
        candidateCount: candidates.length,
        matchedCount: killTargets.length,
        matchedProcesses: debugCliProcessesForLog(killTargets)
      });
      if (killTargets.length > 0) {
        killResult = processApi.kill(killTargets);
      }
    } catch (error) {
      killResult = { killed: 0, failed: 1, errors: [String(error)] };
    }
    logFeishuDebug('takeover process kill result', {
      targetTaskId: targetTask.id,
      targetCodexThreadId: targetTask.codexThreadId,
      matchedCount: killTargets.length,
      matchedProcesses: debugCliProcessesForLog(killTargets),
      killed: killResult.killed,
      failed: killResult.failed,
      errors: [...killResult.errors]
    });

    const ensuredSession = await ensureReplySession(targetTask, caller);
    if (!ensuredSession.ok) {
      return {
        ok: false,
        error: ensuredSession.error
      };
    }

    return {
      ok: true,
      task: getTaskRecord(taskId) ?? targetTask,
      warning: killResult.failed ? `未能终止 ${killResult.failed} 个 CLI 进程。` : undefined
    };
  }

  function rememberClarification(threadId: string, reason: string): void {
    if (reason === 'start_codex_session_missing_cwd') {
      pendingClarifications.set(threadId, { kind: 'codex_cwd' });
      return;
    }
    pendingClarifications.delete(threadId);
  }

  async function handleAssistantMessage(threadId: string, text: string): Promise<void> {
    await serializeAssistantThread(threadId, async () => {
      let task = resolveBoundAssistantTask(threadId);
      if (!task) {
        task = await createAssistantTask(threadId);
      }
      const ensuredSession = await ensureReplySession(task, 'assistant_message');
      if (!ensuredSession.ok) {
        if (!sessions.get(task.id) && !task.codexThreadId) {
          clearAssistantBinding(threadId);
          await sendPlainText(threadId, '助手会话恢复失败，已清理旧绑定。请重新发送刚才的问题。', {
            kind: 'assistant'
          }, { taskId: task.id, sessionKind: 'assistant' });
        } else {
          await sendPlainText(threadId, ensuredSession.error, {
            kind: 'assistant'
          }, { taskId: task.id, sessionKind: 'assistant' });
        }
        return;
      }
      const session = ensuredSession.session;

      const reply = toAssistantReplyPayload(task, text);
      logFeishuDebug('assistant reply inbound', {
        threadId,
        taskId: task.id,
        textLength: text.length,
        taskLifecycle: task.lifecycle,
        snapshot: debugSessionSnapshot(session)
      });
      try {
        session.sendReply(reply);
        logFeishuDebug('assistant reply accepted', {
          threadId,
          taskId: task.id,
          snapshot: debugSessionSnapshot(session)
        });
      } catch (error) {
        logFeishuDebug('assistant reply rejected', {
          threadId,
          taskId: task.id,
          error: String(error),
          snapshot: debugSessionSnapshot(session)
        });
        const message = String(error);
        if (/启动中|稍后/.test(message)) {
          await sendPlainText(threadId, '助手会话仍在启动中，请稍后重试。', { kind: 'assistant' });
          return;
        }
        if (/running turn/i.test(message) || /正在执行/.test(message)) {
          await sendPlainText(threadId, '助手还在处理上一条输入，请稍后再发下一条。', { kind: 'assistant' });
          return;
        }
        await sendPlainText(threadId, `助手暂时无法接收输入：${message}`, { kind: 'assistant' });
        return;
      }

      const snapshot = session.getSnapshot?.();
      const lifecycle =
        task.lifecycle === 'STARTING'
          ? 'STARTING'
          : snapshot?.lifecycle === 'STARTING'
            ? 'RUNNING_TURN'
            : snapshot?.lifecycle ?? 'RUNNING_TURN';
      const updated = updateKnownTask(task.id, {
        lifecycle: lifecycle as any,
        waitKind: undefined,
        waitOptions: undefined,
        checkpointOutput: resolveRetainedCheckpointOutput(task.checkpointOutput, snapshot?.checkpointOutput),
        logFilePath: session.getLogPath?.() ?? snapshot?.logPath ?? task.logFilePath,
        codexThreadId: snapshot?.codexThreadId ?? task.codexThreadId,
        model: pickTaskModel(snapshot?.model, task.model),
        interruptedByRestart: snapshot?.interruptedByRestart ?? task.interruptedByRestart
      });
      if (updated) {
        syncRegistryRecord(updated, session);
      }
      if (reply.action === 'input_text') {
        const receiptTask = updated ?? task;
        const initialReceiptTask =
          receiptTask.lifecycle === 'STARTING'
            ? {
                ...receiptTask,
                lifecycle: 'RUNNING_TURN' as const,
                waitKind: undefined,
                waitOptions: undefined
              }
            : receiptTask;
        const activeTurnId =
          typeof snapshot?.activeTurnId === 'string' && snapshot.activeTurnId.trim() ? snapshot.activeTurnId.trim() : undefined;
        const currentTurn = beginAssistantReplyTurn(receiptTask.id, activeTurnId);
        const delivered = input.channel.sendCard
          ? await sendAssistantReplyReceipt(initialReceiptTask, activeTurnId, {
              turnSequence: currentTurn.turnSequence
            })
          : false;
        if (delivered) {
          clearAssistantReplyReceiptPendingState(receiptTask.id);
        } else if (input.channel.sendCard) {
          pendingAssistantReplyReceipts.add(receiptTask.id);
          logFeishuDebug('assistant reply receipt deferred', {
            threadId,
            taskId: receiptTask.id,
            activeTurnId,
            lifecycle: snapshot?.lifecycle ?? (updated ?? task).lifecycle
          });
        }
      }
      const approvalCardState = resolveApprovalCardReplyState(task, reply);
      if (approvalCardState) {
        await safeUpdateApprovalCard(task.id, approvalCardState);
      }
    });
  }

  function serializeAssistantThread(threadId: string, action: () => Promise<void>): Promise<void> {
    const previous = pendingAssistantThreads.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const settled = next.then(() => undefined, () => undefined);
    pendingAssistantThreads.set(threadId, settled);
    return next.finally(() => {
      if (pendingAssistantThreads.get(threadId) === settled) {
        pendingAssistantThreads.delete(threadId);
      }
    });
  }

  async function createAssistantTask(threadId: string): Promise<CommunicateTaskRecord> {
    const reservedTaskId = sessionRegistry.reserveNextTaskId();
    const created = store.createTask({
      id: reservedTaskId,
      taskType: 'codex_session',
      threadId,
      lifecycle: 'STARTING',
      cwd: assistantProfile.cwd,
      model: defaultModel,
      approvalPolicy: assistantProfile.approvalPolicy,
      sandbox: assistantProfile.sandbox,
      interruptedByRestart: false,
      sessionKind: 'assistant',
      startupMode: 'new',
      assistantProfileId: assistantProfile.assistantProfileId,
      developerInstructions: assistantProfile.developerInstructions,
      baseInstructions: assistantProfile.baseInstructions,
      personality: assistantProfile.personality
    });
    if (created.id !== reservedTaskId) {
      throw new Error(`Task ID registry desync: expected ${reservedTaskId}, received ${created.id}.`);
    }
    const session = assistantSessionFactory({
      taskId: created.id,
      cwd: assistantProfile.cwd,
      threadId,
      mode: 'new',
      ...(defaultModel !== undefined ? { model: defaultModel } : {}),
      approvalPolicy: assistantProfile.approvalPolicy,
      sandbox: assistantProfile.sandbox,
      interruptedByRestart: false,
      developerInstructions: assistantProfile.developerInstructions,
      baseInstructions: assistantProfile.baseInstructions,
      personality: assistantProfile.personality
    });
    sessions.set(created.id, session);
    await session.start();
    const snapshot = session.getSnapshot?.();
    const updated = store.updateTask(created.id, {
      lifecycle: resolveStartupCompletionLifecycle(snapshot?.lifecycle),
      checkpointOutput: resolveStartupCompletionCheckpointOutput(created.checkpointOutput, snapshot),
      runtimeWarnings: resolveRetainedRuntimeWarnings(created.runtimeWarnings, snapshot?.runtimeWarnings),
      codexThreadId: snapshot?.codexThreadId,
      model: pickTaskModel(snapshot?.model, created.model),
      approvalPolicy: assistantProfile.approvalPolicy,
      sandbox: assistantProfile.sandbox,
      interruptedByRestart: snapshot?.interruptedByRestart ?? created.interruptedByRestart,
      startupMode: created.startupMode,
      logFilePath: session.getLogPath?.() ?? snapshot?.logPath,
      cwd: assistantProfile.cwd,
      sessionKind: 'assistant',
      assistantProfileId: assistantProfile.assistantProfileId,
      developerInstructions: assistantProfile.developerInstructions,
      baseInstructions: assistantProfile.baseInstructions,
      personality: assistantProfile.personality
    });
    syncRegistryRecord(updated, session);
    bindAssistantThread(threadId, updated.id);
    return updated;
  }

  function resolveBoundAssistantTaskSnapshot(threadId: string): CommunicateTaskRecord | undefined {
    const taskId = assistantBindings.get(threadId);
    if (!taskId) return undefined;
    const task = cloneTaskRecord(getTaskRecord(taskId));
    if (
      !task ||
      !isAssistantTask(task) ||
      task.threadId !== threadId ||
      task.lifecycle === 'CLOSED' ||
      task.lifecycle === 'FAILED'
    ) {
      return undefined;
    }
    return task;
  }

  function resolveAvailableCodingTaskSnapshot(
    threadId: string,
    taskId: `T${number}`,
    options?: { clearThreadUiOnInvalid?: boolean }
  ): CommunicateTaskRecord | undefined {
    const task = cloneTaskRecord(getTaskRecord(taskId));
    const snapshotLifecycle = sessions.get(taskId)?.getSnapshot?.().lifecycle;
    if (!task || task.threadId !== threadId || !isRecoverableCodingTask(task) || snapshotLifecycle === 'CLOSED') {
      if (options?.clearThreadUiOnInvalid) {
        clearCurrentCodingTarget(threadId);
      }
      return undefined;
    }
    return task;
  }

  function resolveBoundAssistantTask(threadId: string): CommunicateTaskRecord | undefined {
    const taskId = assistantBindings.get(threadId);
    if (!taskId) return undefined;
    const task = resolveBoundAssistantTaskSnapshot(threadId);
    if (!task) {
      clearAssistantBinding(threadId);
      return undefined;
    }
    return task;
  }

  function bindAssistantThread(threadId: string, taskId: `T${number}`): void {
    assistantBindings.set(threadId, taskId);
    sessionRegistry.upsertThreadBinding({
      feishuThreadId: threadId,
      assistantTaskId: taskId
    });
  }

  function clearAssistantBinding(threadId: string): void {
    assistantBindings.delete(threadId);
    sessionRegistry.clearThreadBinding(threadId);
  }

  async function syncStartupCardForLastActiveThread(): Promise<void> {
    const userOpenId = getLastActiveFeishuUserOpenId();
    if (userOpenId) {
      await sendStartupCardToLastActiveUser();
      return;
    }
    const threadId = getLastActiveFeishuThreadId();
    if (!threadId) return;
    ensureLauncherSelection(threadId);
    setThreadUiState(threadId, {
      displayMode: 'assistant',
      statusCardMode: 'launcher',
      currentCodingTaskId: undefined,
      statusCardMessageId: undefined,
      statusCardActionMessageId: undefined,
      statusCardPickerOpen: false,
      launcherDraftCwd: undefined,
      launcherError: undefined
    });
    await refreshStatusCard(threadId);
  }

  async function handleCardAction(action: FeishuCardActionEvent): Promise<void> {
    const statusCardActionState =
      !isReplyStatusCardAction(action) && !isApprovalCardAction(action) && !isAssistantReplyReceiptAction(action)
        ? rememberStatusCardAction(action.threadId, action)
        : 'ignored';
    logFeishuDebug('card action inbound', {
      threadId: action.threadId,
      kind: action.kind,
      actionMessageId: action.messageId,
      trackedMessageId: getThreadUiState(action.threadId).statusCardMessageId,
      trackedActionMessageId: getThreadUiState(action.threadId).statusCardActionMessageId
    });
    if (statusCardActionState === 'mismatch' && isTakeoverPickerStatusCardAction(action)) {
      await sendPlainText(action.threadId, '该接管卡已更新，请使用最新卡片操作。');
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'allow_waiting_task' || action.kind === 'deny_waiting_task') {
      const trackedApprovalCard = approvalCards.get(action.taskId);
      if (!trackedApprovalCard || trackedApprovalCard.threadId !== action.threadId) {
        await sendPlainText(action.threadId, '该审批卡已失效，请以最新审批提示为准。');
        return;
      }
      if (action.messageId && trackedApprovalCard.messageId !== action.messageId) {
        await sendPlainText(action.threadId, '该审批卡已更新，请使用最新卡片操作。');
        return;
      }
      const task = resolveTaskForReplyValidation(action.taskId);
      if (!task || task.threadId !== action.threadId || task.lifecycle !== 'WAITING_USER' || task.waitKind !== 'confirm') {
        await safeUpdateApprovalCard(action.taskId, 'unavailable');
        await sendPlainText(action.threadId, `任务 ${action.taskId} 当前不再等待审批。`);
        return;
      }
      const ensuredSession = await ensureReplySession(task, 'approval_card_action');
      if (!ensuredSession.ok) {
        await sendPlainText(action.threadId, ensuredSession.error);
        return;
      }
      const session = ensuredSession.session;
      const reply: CodexReplyPayload = {
        action: 'confirm',
        value: action.kind === 'deny_waiting_task' ? 'deny' : 'allow'
      };
      try {
        session.sendReply(reply);
      } catch (error) {
        await sendPlainText(action.threadId, `任务 ${task.id} 暂时无法接收审批结果：${String(error)}`);
        return;
      }
      const snapshot = session.getSnapshot?.();
      const lifecycle =
        snapshot?.lifecycle === 'STARTING'
          ? 'RUNNING_TURN'
          : snapshot?.lifecycle ?? 'RUNNING_TURN';
      const updated = updateKnownTask(task.id, {
        lifecycle: lifecycle as any,
        waitKind: undefined,
        waitOptions: undefined,
        checkpointOutput: resolveRetainedCheckpointOutput(task.checkpointOutput, snapshot?.checkpointOutput),
        logFilePath: session.getLogPath?.() ?? snapshot?.logPath ?? task.logFilePath,
        codexThreadId: snapshot?.codexThreadId ?? task.codexThreadId,
        model: pickTaskModel(snapshot?.model, task.model),
        interruptedByRestart: snapshot?.interruptedByRestart ?? task.interruptedByRestart
      });
      if (updated) {
        syncRegistryRecord(updated, session);
        if (!isAssistantTask(updated)) {
          await syncReplyStatusCardForTask(updated);
          if (getThreadUiState(updated.threadId).currentCodingTaskId === updated.id) {
            await refreshStatusCard(updated.threadId);
          }
        }
      }
      await safeUpdateApprovalCard(task.id, action.kind === 'deny_waiting_task' ? 'denied' : 'allowed');
      return;
    }

    if (action.kind === 'interrupt_stalled_task') {
      if (isReplyStatusCardAction(action)) {
        const trackedReplyStatusCard = replyStatusCards.get(action.threadId);
        if (!trackedReplyStatusCard) {
          await sendPlainText(action.threadId, '该回复状态卡已失效，请使用最新卡片操作。');
          await refreshStatusCard(action.threadId);
          return;
        }
      }
      const trackedCard = replyStatusCards.get(action.threadId);
      const task = resolveTrackedReplyStatusTask(action.threadId);
      if (!trackedCard || !task || task.taskType !== 'codex_session' || task.sessionKind !== 'coding') {
        await sendPlainText(action.threadId, '当前没有可打断的运行中任务。');
        return;
      }
      if (trackedCard.messageId !== action.messageId && trackedCard.state !== 'interrupting') {
        await sendPlainText(action.threadId, `任务 ${task.id} 的状态卡已更新，请使用最新卡片操作。`);
        return;
      }
      if (trackedCard.state !== 'suspected_stalled' && trackedCard.state !== 'interrupting') {
        await sendPlainText(action.threadId, `任务 ${task.id} 当前未处于疑似卡死状态。`);
        return;
      }
      if (replyStatusInterruptingTasks.has(task.id)) {
        await safeUpdateReplyStatusCard(
          action.threadId,
          buildReplyStatusCardViewModel(action.threadId, task, sessions.get(task.id)?.getSnapshot?.(), trackedCard)
        );
        return;
      }
      const ensuredSession = await ensureReplySession(task, 'interrupt_stalled_task');
      if (!ensuredSession.ok) {
        await sendPlainText(action.threadId, ensuredSession.error);
        return;
      }
      const session = ensuredSession.session;
      if (!session.interruptCurrentTurn) {
        await sendPlainText(action.threadId, `任务 ${task.id} 当前不支持打断。`);
        return;
      }

      replyStatusInterruptingTasks.add(task.id);
      clearReplyStatusStallRecord(action.threadId, task.id);
      session.recordStallDiagnostic?.({
        trigger: 'reply_status_interrupt_requested',
        threadId: action.threadId,
        quietMs: resolveSnapshotQuietMs(session.getSnapshot?.()),
        replyStatusCardMessageId: trackedCard.messageId
      });
      await safeUpdateReplyStatusCard(
        action.threadId,
        buildReplyStatusCardViewModel(action.threadId, task, session.getSnapshot?.(), trackedCard)
      );

      let interruptSucceeded = false;
      try {
        const interruptResult = await session.interruptCurrentTurn();
        if (!interruptResult?.interrupted) {
          throw new Error('任务未返回已打断状态。');
        }
        interruptSucceeded = true;
        session.sendReply({
          action: 'input_text',
          text: STALL_RECOVERY_SUMMARY_PROMPT
        });
        stallRecoveryTasks.add(task.id);
        const snapshot = session.getSnapshot?.();
        const updated = updateKnownTask(task.id, {
          lifecycle:
            (task.lifecycle === 'STARTING'
              ? 'STARTING'
              : snapshot?.lifecycle === 'STARTING'
                ? 'RUNNING_TURN'
                : snapshot?.lifecycle ?? 'RUNNING_TURN') as any,
          waitKind: undefined,
          waitOptions: undefined,
          checkpointOutput: resolveRetainedCheckpointOutput(task.checkpointOutput, snapshot?.checkpointOutput),
          logFilePath: session.getLogPath?.() ?? snapshot?.logPath ?? task.logFilePath,
          codexThreadId: snapshot?.codexThreadId ?? task.codexThreadId,
          model: pickTaskModel(snapshot?.model, task.model),
          interruptedByRestart: snapshot?.interruptedByRestart ?? task.interruptedByRestart
        });
        if (updated) {
          syncRegistryRecord(updated, session);
        }
        return;
      } catch (error) {
        replyStatusInterruptingTasks.delete(task.id);
        const latestTask = syncTaskFromSession(task.id) ?? getTaskRecord(task.id) ?? task;
        const snapshot = session.getSnapshot?.();
        if (!interruptSucceeded) {
          clearReplyStatusStallRecord(action.threadId, task.id);
          markReplyStatusStallConfirmation(action.threadId, task.id);
          markReplyStatusStallConfirmation(action.threadId, task.id);
        }
        await safeUpdateReplyStatusCard(
          action.threadId,
          buildReplyStatusCardViewModel(
            action.threadId,
            latestTask,
            snapshot,
            replyStatusCards.get(action.threadId)
          )
        );
        await sendPlainText(action.threadId, `任务 ${task.id} 打断失败：${String(error)}`);
        return;
      }
    }

    if (action.kind === 'select_recent_cwd') {
      setThreadUiState(action.threadId, {
        statusCardMode: 'launcher',
        launcherSelectedCwd: action.cwd,
        launcherDraftCwd: undefined,
        launcherError: undefined
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'submit_launch_coding') {
      const draftCwd = typeof action.cwd === 'string' ? action.cwd.trim() : '';
      const currentUi = getThreadUiState(action.threadId);
      const cwd = draftCwd || currentUi.launcherSelectedCwd?.trim() || '';
      const validationError = validateLauncherProjectDir(cwd);
      if (validationError) {
        setThreadUiState(action.threadId, {
          statusCardMode: 'launcher',
          launcherDraftCwd: draftCwd || undefined,
          launcherError: validationError
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      await startCodexTask(action.threadId, cwd, { preserveStatusCardMessageId: true });
      return;
    }

    if (action.kind === 'switch_mode_assistant') {
      setThreadUiState(action.threadId, {
        displayMode: 'assistant',
        statusCardMode: 'status',
        statusCardPickerOpen: false
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'return_to_launcher') {
      const currentUi = getThreadUiState(action.threadId);
      setThreadUiState(action.threadId, {
        displayMode: 'assistant',
        statusCardMode: 'launcher',
        currentCodingTaskId: undefined,
        statusCardPickerOpen: false,
        launcherSelectedCwd: currentUi.launcherSelectedCwd,
        launcherDraftCwd: undefined,
        launcherError: undefined
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'switch_mode_coding') {
      const currentTask = resolveCurrentCodingTask(action.threadId);
      if (!currentTask) {
        setThreadUiState(action.threadId, {
          displayMode: 'assistant',
          statusCardMode: 'status',
          statusCardPickerOpen: false
        });
        await sendPlainText(action.threadId, '当前没有可用的 Coding 任务，已保持助手模式。');
        await refreshStatusCard(action.threadId);
        return;
      }
      if (!sessions.has(currentTask.id)) {
        const ensuredSession = await ensureReplySession(currentTask, 'status_card_switch_current_task');
        if (!ensuredSession.ok) {
          setThreadUiState(action.threadId, {
            displayMode: 'assistant',
            statusCardMode: 'status',
            currentCodingTaskId: undefined,
            statusCardPickerOpen: false
          });
          await sendPlainText(action.threadId, `${ensuredSession.error} 已保持助手模式。`);
          await refreshStatusCard(action.threadId);
          return;
        }
      }
      setThreadUiState(action.threadId, {
        displayMode: 'coding',
        statusCardMode: 'status',
        currentCodingTaskId: currentTask.id,
        statusCardPickerOpen: false
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'open_task_picker') {
      await pruneAbandonedEmptyCodingTasksForStatusCard(action.threadId);
      setThreadUiState(action.threadId, {
        statusCardMode: 'status',
        statusCardPickerOpen: true
      });
      queueLazyGoalSummaryBackfills(action.threadId);
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'open_takeover_picker') {
      openTakeoverPickerState(action.threadId);
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'takeover_picker_next_page' || action.kind === 'takeover_picker_prev_page') {
      const currentUi = getThreadUiState(action.threadId);
      const totalPages =
        currentUi.takeoverPickerTotalPages === undefined
          ? resolveTakeoverPickerTotalPagesForCount(currentUi.takeoverPickerTaskIds?.length ?? 0)
          : Math.max(1, currentUi.takeoverPickerTotalPages ?? 1);
      const currentPage = clampTakeoverPickerPage(currentUi.takeoverPickerPage, totalPages);
      const delta = action.kind === 'takeover_picker_next_page' ? 1 : -1;
      const nextPage = clampTakeoverPickerPage(currentPage + delta, totalPages);
      showTakeoverPickerPage(action.threadId, nextPage, currentUi.takeoverPickerSelectedTaskId);
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'refresh_takeover_picker') {
      refreshTakeoverPickerState(action.threadId);
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'pick_takeover_task') {
      const currentUi = getThreadUiState(action.threadId);
      const isSelectable = currentUi.takeoverPickerTaskIds?.includes(action.taskId) ?? false;
      setThreadUiState(action.threadId, {
        statusCardMode: 'takeover_picker',
        statusCardPickerOpen: false,
        takeoverPickerSelectedTaskId: isSelectable ? action.taskId : undefined,
        takeoverPickerError: isSelectable ? undefined : '当前选择已失效，请刷新后重试。'
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'confirm_takeover_task') {
      const currentUi = getThreadUiState(action.threadId);
      if (!currentUi.takeoverPickerSelectedTaskId) {
        setThreadUiState(action.threadId, {
          statusCardMode: 'takeover_picker',
          statusCardPickerOpen: false,
          takeoverPickerError: '请先选择一个本地 Codex 任务。'
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      const selectedTask = getTaskRecord(currentUi.takeoverPickerSelectedTaskId);
      const selectedConflictError =
        selectedTask && selectedTask.threadId === action.threadId
          ? describeHotManagedCodexThreadConflict(selectedTask)
          : undefined;
      if (selectedConflictError) {
        setThreadUiState(action.threadId, {
          statusCardMode: 'takeover_picker',
          statusCardPickerOpen: false,
          takeoverPickerSelectedTaskId: undefined,
          takeoverPickerError: selectedConflictError
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      const isSelectedTaskStillVisible =
        currentUi.takeoverPickerTaskIds?.includes(currentUi.takeoverPickerSelectedTaskId) &&
        Boolean(resolveTakeoverPickerTaskSnapshot(action.threadId, currentUi.takeoverPickerSelectedTaskId));
      if (!isSelectedTaskStillVisible) {
        setThreadUiState(action.threadId, {
          statusCardMode: 'takeover_picker',
          statusCardPickerOpen: false,
          takeoverPickerSelectedTaskId: undefined,
          takeoverPickerError: '当前选择已失效，请刷新后重试。'
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      const takeover = await takeoverTaskById(
        action.threadId,
        currentUi.takeoverPickerSelectedTaskId,
        'status_card_confirm_takeover'
      );
      if (!takeover.ok) {
        setThreadUiState(action.threadId, {
          statusCardMode: 'takeover_picker',
          statusCardPickerOpen: false,
          takeoverPickerError: takeover.error
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      setThreadUiState(action.threadId, {
        displayMode: 'coding',
        statusCardMode: 'status',
        currentCodingTaskId: takeover.task.id,
        statusCardPickerOpen: false
      });
      takeoverPickerSnapshots.delete(action.threadId);
      pruneImportedTakeoverPlaceholdersForThread(action.threadId, [takeover.task.id]);
      await sendPlainText(
        action.threadId,
        takeover.warning ? `已开始接管 ${takeover.task.id}。\n提示：${takeover.warning}` : `已开始接管 ${takeover.task.id}。`
      );
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'return_to_status') {
      takeoverPickerSnapshots.delete(action.threadId);
      pruneImportedTakeoverPlaceholdersForThread(action.threadId);
      setThreadUiState(action.threadId, {
        statusCardMode: 'status',
        statusCardPickerOpen: false
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'create_new_task') {
      const currentTask = resolveCurrentCodingTask(action.threadId);
      const currentUi = getThreadUiState(action.threadId);
      const cwd = currentTask?.cwd?.trim() || currentUi.launcherSelectedCwd?.trim() || '';
      if (!cwd) {
        setThreadUiState(action.threadId, {
          displayMode: 'assistant',
          statusCardMode: 'launcher',
          currentCodingTaskId: undefined,
          statusCardPickerOpen: false,
          launcherDraftCwd: undefined,
          launcherError: '请先输入或选择项目目录。'
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      const validationError = validateLauncherProjectDir(cwd);
      if (validationError) {
        setThreadUiState(action.threadId, {
          displayMode: 'assistant',
          statusCardMode: 'launcher',
          currentCodingTaskId: undefined,
          statusCardPickerOpen: false,
          launcherDraftCwd: cwd,
          launcherError: validationError
        });
        await refreshStatusCard(action.threadId);
        return;
      }
      await startCodexTask(action.threadId, cwd, { preserveStatusCardMessageId: true });
      return;
    }

    if (action.kind === 'pick_current_task') {
      const task = resolveAvailableCodingTask(action.threadId, action.taskId);
      if (!task) {
        setThreadUiState(action.threadId, {
          displayMode: 'assistant',
          statusCardMode: 'status',
          currentCodingTaskId: undefined,
          statusCardPickerOpen: false
        });
        await sendPlainText(action.threadId, `任务 ${action.taskId} 不是当前线程可用的 Coding 目标。`);
        await refreshStatusCard(action.threadId);
        return;
      }
      if (!sessions.has(task.id)) {
        const ensuredSession = await ensureReplySession(task, 'status_card_open_task');
        if (!ensuredSession.ok) {
          setThreadUiState(action.threadId, {
            displayMode: 'assistant',
            statusCardMode: 'status',
            currentCodingTaskId: undefined,
            statusCardPickerOpen: false
          });
          await sendPlainText(action.threadId, `${ensuredSession.error} 已保持助手模式。`);
          await refreshStatusCard(action.threadId);
          return;
        }
      }
      setThreadUiState(action.threadId, {
        displayMode: 'coding',
        statusCardMode: 'status',
        currentCodingTaskId: task.id,
        statusCardPickerOpen: false
      });
      await refreshStatusCard(action.threadId);
      return;
    }

    if (action.kind === 'query_current_task') {
      setThreadUiState(action.threadId, {
        statusCardMode: 'status',
        statusCardPickerOpen: false
      });
      if (isAssistantReplyReceiptAction(action)) {
        const trackedAssistantReceipt = resolveTrackedAssistantReplyReceipt(action);
        if (!trackedAssistantReceipt) {
          await sendPlainText(action.threadId, '该助手回执卡已失效，请以最新助手回执为准。');
          return;
        }
        if (action.messageId && trackedAssistantReceipt.messageId !== action.messageId) {
          await sendPlainText(action.threadId, '该助手回执卡已更新，请使用最新卡片操作。');
          return;
        }
        const task = syncTaskFromSession(trackedAssistantReceipt.taskId) ?? getTaskRecord(trackedAssistantReceipt.taskId);
        if (!task || task.threadId !== action.threadId) {
          await sendPlainText(action.threadId, '该助手回执卡已失效，请以最新助手回执为准。');
          return;
        }
        await sendPlainText(action.threadId, buildAssistantReplyReceiptStatusDelivery(task, trackedAssistantReceipt));
        return;
      }
      await pruneAbandonedEmptyCodingTasksForStatusCard(action.threadId);
      const replyStatusAction = isReplyStatusCardAction(action);
      const trackedReplyStatusCard = replyStatusAction ? replyStatusCards.get(action.threadId) : undefined;
      if (replyStatusAction) {
        if (!trackedReplyStatusCard) {
          await sendPlainText(action.threadId, '该回复状态卡已失效，请使用最新卡片操作。');
          await refreshStatusCard(action.threadId);
          return;
        }
        if (action.messageId && trackedReplyStatusCard.messageId !== action.messageId) {
          await sendPlainText(action.threadId, '该回复状态卡已更新，请使用最新卡片操作。');
          await refreshStatusCard(action.threadId);
          return;
        }
      }
      const task = replyStatusAction ? resolveTrackedReplyStatusTask(action.threadId) : resolveCurrentCodingTask(action.threadId);
      if (!task) {
        await sendPlainText(action.threadId, '当前没有可用的 Coding 任务，已保持助手模式。');
        await refreshStatusCard(action.threadId);
        return;
      }
      const delivery = supportsTaskProgressDelivery(task) ? buildTaskProgressDelivery(task) : buildTaskStatusDelivery(task);
      if (!supportsTaskProgressDelivery(task)) {
        await sendPlainText(action.threadId, delivery);
      } else {
        await sendTaskText(action.threadId, task.id, delivery);
      }
      await refreshStatusCard(action.threadId);
      return;
    }

    setThreadUiState(action.threadId, {
      statusCardMode: 'status',
      statusCardPickerOpen: false
    });
    const task = resolveCurrentCodingTask(action.threadId);
    if (!task) {
      await sendPlainText(action.threadId, '当前没有可用的 Coding 任务，已保持助手模式。');
      await refreshStatusCard(action.threadId);
      return;
    }
    const { forced } = await closeTaskRecord(task);
    await sendPlainText(action.threadId, forced ? `任务 ${task.id} 已强制关闭。` : `任务 ${task.id} 已关闭。`);
    await refreshStatusCard(action.threadId);
  }

  async function startCodexTask(
    threadId: string,
    cwd: string,
    options: { preserveStatusCardMessageId?: boolean } = {}
  ): Promise<void> {
    const priorUi = getThreadUiState(threadId);
    await pruneAbandonedEmptyCodingTasks(threadId);
    const reservedTaskId = sessionRegistry.reserveNextTaskId();
    const created = store.createTask({
      id: reservedTaskId,
      taskType: 'codex_session',
      threadId,
      lifecycle: 'STARTING',
      cwd,
      model: defaultModel,
      approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
      sandbox: DEFAULT_CODEX_SANDBOX,
      sessionKind: 'coding',
      startupMode: 'new',
      interruptedByRestart: false
    });
    if (created.id !== reservedTaskId) {
      throw new Error(`Task ID registry desync: expected ${reservedTaskId}, received ${created.id}.`);
    }
    const session = codingSessionFactory({
      taskId: created.id,
      cwd,
      threadId,
      mode: 'new',
      ...(defaultModel !== undefined ? { model: defaultModel } : {}),
      approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
      sandbox: DEFAULT_CODEX_SANDBOX,
      interruptedByRestart: false
    });
    sessions.set(created.id, session);
    await session.start();
    const snapshot = session.getSnapshot?.();
    const updated = store.updateTask(created.id, {
      lifecycle: resolveStartupCompletionLifecycle(snapshot?.lifecycle),
      checkpointOutput: resolveStartupCompletionCheckpointOutput(created.checkpointOutput, snapshot),
      runtimeWarnings: resolveRetainedRuntimeWarnings(created.runtimeWarnings, snapshot?.runtimeWarnings),
      codexThreadId: snapshot?.codexThreadId,
      model: pickTaskModel(snapshot?.model, created.model),
      approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
      sandbox: DEFAULT_CODEX_SANDBOX,
      interruptedByRestart: snapshot?.interruptedByRestart ?? created.interruptedByRestart,
      startupMode: created.startupMode,
      logFilePath: session.getLogPath?.() ?? snapshot?.logPath,
      cwd,
      sessionKind: 'coding'
    });
    syncRegistryRecord(updated, session);
    rememberLastActiveThread(threadId);
    rememberRecentProjectDir(cwd);
    setThreadUiState(threadId, {
      statusCardMode: 'status',
      currentCodingTaskId: updated.id,
      statusCardMessageId: options.preserveStatusCardMessageId ? priorUi.statusCardMessageId : undefined,
      statusCardPickerOpen: false,
      launcherSelectedCwd: cwd,
      launcherDraftCwd: undefined,
      launcherError: undefined
    });
    const startupDelivery = buildCodingTaskStartupDelivery(updated);
    if (startupDelivery) {
      await sendPlainText(threadId, startupDelivery);
    }
    await refreshStatusCard(threadId);
  }

  async function handleWorkerEvent(event: FeishuServiceWorkerEvent): Promise<void> {
    const task = getTaskRecord(event.taskId);
    if (!task) return;
    const assistantTurnResolution = isAssistantTask(task) ? resolveAssistantWorkerEventTurnId(task, event) : undefined;
    const normalizedTurnId = assistantTurnResolution?.turnId;
    if (isAssistantTask(task)) {
      if (assistantTurnResolution?.scope === 'ignore') {
        logFeishuDebug('assistant worker event skipped after turn resolution', {
          taskId: event.taskId,
          type: event.type,
          threadId: task.threadId
        });
        return;
      }
      if (assistantTurnResolution?.scope === 'historical') {
        const historicalTask = buildAssistantEventTaskRecord(task, event);
        await syncAssistantReplyReceiptForTask(historicalTask, normalizedTurnId, {
          allowPendingSend: false,
          useLiveSnapshot: false
        });
        logFeishuDebug('assistant worker event applied to historical receipt only', {
          taskId: event.taskId,
          type: event.type,
          threadId: task.threadId,
          turnId: normalizedTurnId
        });
        return;
      }
      if (normalizedTurnId) {
        rememberAssistantReplyCurrentTurnId(task.id, normalizedTurnId);
      }
    }
    const wasCurrentCodingTarget = getThreadUiState(task.threadId).currentCodingTaskId === event.taskId;
    replyStatusInterruptingTasks.delete(event.taskId);
    logFeishuDebug('worker event', {
      taskId: event.taskId,
      type: event.type,
      threadId: task.threadId,
      sessionKind: task.sessionKind,
      outputLength: event.output.length
    });
    if (event.type === 'task_waiting_user') {
      const updated = updateKnownTask(event.taskId, {
        lifecycle: 'WAITING_USER',
        waitKind: event.waitKind,
        waitOptions: event.waitOptions,
        checkpointOutput: event.output,
        latestWaitPrompt: event.waitHint,
        logFilePath: sessions.get(event.taskId)?.getLogPath?.() ?? sessions.get(event.taskId)?.getSnapshot?.().logPath ?? task.logFilePath,
        codexThreadId: sessions.get(event.taskId)?.getSnapshot?.().codexThreadId ?? task.codexThreadId,
        model: pickTaskModel(sessions.get(event.taskId)?.getSnapshot?.().model, task.model),
        interruptedByRestart: sessions.get(event.taskId)?.getSnapshot?.().interruptedByRestart ?? task.interruptedByRestart
      });
      if (!updated) return;
      syncRegistryRecord(updated, sessions.get(event.taskId));
      if (isAssistantTask(updated)) {
        await syncAssistantReplyReceiptForTask(updated, normalizedTurnId);
      }
      const deliveredApprovalCard = await maybeDeliverApprovalCard(updated);
      if (!deliveredApprovalCard) {
        if (isAssistantTask(updated)) {
          await sendPlainText(updated.threadId, formatAssistantWaitingDelivery(updated), { kind: 'assistant' });
        } else {
          await sendTaskText(
            updated.threadId,
            updated.id,
            formatCheckpointDelivery({
              taskId: updated.id,
              lifecycle: updated.lifecycle,
              output: updated.checkpointOutput ?? '',
              waitHint: updated.latestWaitPrompt,
              runtimeWarnings: updated.runtimeWarnings
            })
          );
        }
      }
      await syncReplyStatusCardForTask(updated);
      if (updated.sessionKind === 'coding' && wasCurrentCodingTarget) {
        await refreshStatusCard(updated.threadId);
      }
      return;
    }

    const lifecycle = event.type === 'task_finished' ? 'IDLE' : 'FAILED';
    const updated = updateKnownTask(event.taskId, {
      lifecycle,
      checkpointOutput: event.output,
      waitKind: undefined,
      waitOptions: undefined,
      latestWaitPrompt: undefined,
      logFilePath: sessions.get(event.taskId)?.getLogPath?.() ?? sessions.get(event.taskId)?.getSnapshot?.().logPath ?? task.logFilePath,
      codexThreadId: sessions.get(event.taskId)?.getSnapshot?.().codexThreadId ?? task.codexThreadId,
      model: pickTaskModel(sessions.get(event.taskId)?.getSnapshot?.().model, task.model),
      interruptedByRestart: sessions.get(event.taskId)?.getSnapshot?.().interruptedByRestart ?? task.interruptedByRestart
    });
    if (!updated) return;
    syncRegistryRecord(updated, sessions.get(event.taskId));
    if (isAssistantTask(updated)) {
      await syncAssistantReplyReceiptForTask(updated, normalizedTurnId);
    }
    await syncApprovalCardForTask(updated);
    if (updated.sessionKind === 'coding' && event.type === 'task_failed') {
      sessions.delete(updated.id);
      const preserveFailedCodingTarget =
        updated.taskType === 'codex_session' &&
        updated.sessionKind === 'coding' &&
        updated.lifecycle === 'FAILED' &&
        Boolean(updated.codexThreadId);
      const threadUi = getThreadUiState(updated.threadId);
      if (threadUi.currentCodingTaskId === updated.id && !preserveFailedCodingTarget) {
        clearCurrentCodingTarget(updated.threadId);
      }
    }
    await syncReplyStatusCardForTask(updated);
    if (isAssistantTask(updated)) {
      if (event.type === 'task_failed' && isAssistantSessionExpired(event.output)) {
        sessions.delete(updated.id);
        clearAssistantBinding(updated.threadId);
        await createAssistantTask(updated.threadId);
        await sendPlainText(
          updated.threadId,
          '助手会话已过期，已为你新建会话，请重新发送刚才的问题（若包含图片，请重发图片）。',
          { kind: 'assistant' },
          { taskId: updated.id, sessionKind: 'assistant' }
        );
        return;
      }
      if (event.type === 'task_failed') {
        sessions.delete(updated.id);
        clearAssistantBinding(updated.threadId);
      }
      await sendPlainText(
        updated.threadId,
        formatAssistantTerminalDelivery(updated, event.type),
        { kind: 'assistant' },
        event.type === 'task_failed' ? { taskId: updated.id, sessionKind: 'assistant' } : undefined
      );
    } else {
      const codingFailureDelivery =
        event.type === 'task_failed'
          ? formatCodingTaskInterruptedDelivery(updated.id, normalizeTaskInterruptionKind(event.interruptionKind))
          : null;
      await sendTaskText(
        updated.threadId,
        updated.id,
        codingFailureDelivery ??
          formatCheckpointDelivery({
            taskId: updated.id,
            lifecycle: updated.lifecycle,
            output: updated.checkpointOutput ?? '',
            runtimeWarnings: updated.runtimeWarnings
          })
      );
    }
    if (updated.sessionKind === 'coding' && wasCurrentCodingTarget) {
      await refreshStatusCard(updated.threadId);
    }
  }

  async function sendTaskText(threadId: string, taskId: `T${number}`, text: string): Promise<void> {
    if (text.length <= MAX_SEGMENT_CHARS) {
      await sendPrefixedText(threadId, text, { kind: 'coding', taskId }, { taskId, sessionKind: 'coding' });
      return;
    }
    for (const chunk of segmentText({ taskId, text, maxChars: MAX_SEGMENT_CHARS })) {
      await sendPrefixedText(threadId, chunk, { kind: 'coding', taskId }, { taskId, sessionKind: 'coding' });
    }
  }

  async function sendPlainText(
    threadId: string,
    text: string,
    mode: DeliveryPrefixMode = { kind: 'thread' },
    failureContext?: DeliveryFailureContext
  ): Promise<void> {
    if (text.length <= MAX_SEGMENT_CHARS) {
      await sendPrefixedText(threadId, text, mode, failureContext);
      return;
    }
    for (let index = 0; index < text.length; index += MAX_SEGMENT_CHARS) {
      await sendPrefixedText(threadId, text.slice(index, index + MAX_SEGMENT_CHARS), mode, failureContext);
    }
  }

  function buildAssistantReplyReceiptStatusDelivery(
    task: CommunicateTaskRecord,
    receipt: AssistantReplyReceiptRecord
  ): string {
    const liveSnapshot = sessions.get(task.id)?.getSnapshot?.();
    const recentSummary = resolveRecentSummary({
      lifecycle: receipt.lifecycle,
      liveBuffer: undefined,
      checkpointOutput: receipt.checkpointOutput ?? task.checkpointOutput,
      logFilePath: task.logFilePath
    });
    const runtimeConfig = buildTaskRuntimeConfigView(task, liveSnapshot);
    return formatStatusQueryDelivery({
      taskId: task.id,
      lifecycle: receipt.lifecycle,
      model: runtimeConfig.model,
      sandbox: runtimeConfig.sandbox,
      approvalPolicy: runtimeConfig.approvalPolicy,
      sessionKind: runtimeConfig.sessionKind,
      startupMode: runtimeConfig.startupMode,
      interruptedByRestart: runtimeConfig.interruptedByRestart,
      defaultSandbox: runtimeConfig.defaultSandbox,
      defaultApprovalPolicy: runtimeConfig.defaultApprovalPolicy,
      quietMinutes: 0,
      recentSummary,
      waitHint: receipt.latestWaitPrompt,
      logFilePath: task.logFilePath,
      screenshotPath: task.latestScreenshotPath,
      codexThreadId: task.codexThreadId,
      recoveryNote: task.interruptedByRestart ? '上一轮因服务重启已中断，请重新发送当前这轮输入。' : undefined,
      runtimeWarnings: resolveRetainedRuntimeWarnings(task.runtimeWarnings, liveSnapshot?.runtimeWarnings)
    });
  }

  function supportsTaskProgressDelivery(task: CommunicateTaskRecord): boolean {
    return task.taskType === 'codex_session' && !isAssistantTask(task);
  }

  function buildTaskProgressDelivery(task: CommunicateTaskRecord): string {
    const liveSnapshot = sessions.get(task.id)?.getSnapshot?.();
    const previousOutput = resolveTaskProgressPreviousOutput({
      liveCheckpointOutput: liveSnapshot?.checkpointOutput,
      taskCheckpointOutput: task.checkpointOutput,
      taskCheckpointAt: task.lastCheckpointAt,
      logFilePath: liveSnapshot?.logPath ?? task.logFilePath
    });
    return formatTaskProgressDelivery({
      taskId: task.id,
      lifecycle: String(liveSnapshot?.lifecycle ?? task.lifecycle),
      previousOutput
    });
  }

  function buildTaskStatusDelivery(task: CommunicateTaskRecord): string {
    const liveSnapshot = sessions.get(task.id)?.getSnapshot?.();
    const lifecycle =
      task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED' || task.lifecycle === 'CLOSED'
        ? task.lifecycle
        : String(liveSnapshot?.lifecycle ?? task.lifecycle);
    const recentSummary = resolveRecentSummary({
      lifecycle,
      liveBuffer: liveSnapshot?.liveBuffer,
      checkpointOutput: liveSnapshot?.checkpointOutput ?? task.checkpointOutput,
      logFilePath: liveSnapshot?.logPath ?? task.logFilePath
    });
    const runtimeConfig = buildTaskRuntimeConfigView(task, liveSnapshot);
    return formatStatusQueryDelivery({
      taskId: task.id,
      lifecycle,
      model: runtimeConfig.model,
      sandbox: runtimeConfig.sandbox,
      approvalPolicy: runtimeConfig.approvalPolicy,
      sessionKind: runtimeConfig.sessionKind,
      startupMode: runtimeConfig.startupMode,
      interruptedByRestart: runtimeConfig.interruptedByRestart,
      defaultSandbox: runtimeConfig.defaultSandbox,
      defaultApprovalPolicy: runtimeConfig.defaultApprovalPolicy,
      quietMinutes: resolveSnapshotQuietMinutes(liveSnapshot),
      recentSummary,
      waitHint: task.latestWaitPrompt,
      logFilePath: liveSnapshot?.logPath ?? task.logFilePath,
      screenshotPath: task.latestScreenshotPath,
      codexThreadId: task.codexThreadId,
      recoveryNote: task.interruptedByRestart ? '上一轮因服务重启已中断，请重新发送当前这轮输入。' : undefined,
      runtimeWarnings: resolveRetainedRuntimeWarnings(task.runtimeWarnings, liveSnapshot?.runtimeWarnings)
    });
  }

  async function closeTaskRecord(task: CommunicateTaskRecord): Promise<{ forced: boolean; updated?: CommunicateTaskRecord }> {
    const session = sessions.get(task.id);
    let forced = false;
    if (session?.close) {
      const result = await session.close();
      forced = result.forced;
    }
    sessions.delete(task.id);
    const updated = updateKnownTask(task.id, {
      lifecycle: 'CLOSED',
      waitKind: undefined,
      waitOptions: undefined,
      checkpointOutput: forced ? 'Codex 会话已强制关闭。' : 'Codex 会话已关闭。',
      logFilePath: session?.getLogPath?.() ?? session?.getSnapshot?.().logPath ?? task.logFilePath,
      model: pickTaskModel(session?.getSnapshot?.().model, task.model)
    });
    if (updated) {
      sessionRegistry.markClosed(task.id, {
        closedAt: new Date().toISOString(),
        logPath: updated.logFilePath,
        codexThreadId: updated.codexThreadId ?? session?.getSnapshot?.().codexThreadId,
        lastCheckpointOutput: updated.checkpointOutput,
        interruptedByRestart: updated.interruptedByRestart ?? session?.getSnapshot?.().interruptedByRestart,
        windowPid: session?.getSnapshot?.().windowPid,
        runtimeWarnings: resolveRetainedRuntimeWarnings(updated.runtimeWarnings, session?.getSnapshot?.().runtimeWarnings)
      });
      await syncApprovalCardForTask(updated);
      await syncReplyStatusCardForTask(updated);
      clearTaskScopedRecoveryState(updated.id);
      if (isAssistantTask(updated)) {
        clearAssistantReplyReceiptPendingState(updated.id);
        clearAssistantBinding(updated.threadId);
      } else if (getThreadUiState(updated.threadId).currentCodingTaskId === updated.id) {
        clearCurrentCodingTarget(updated.threadId);
      }
    }
    return { forced, updated };
  }

  function syncTaskFromSession(taskId: `T${number}`) {
    const task = getTaskRecord(taskId);
    const session = sessions.get(taskId);
    const snapshot = session?.getSnapshot?.();
    if (!task || !snapshot) return task;
    const preserveLifecycle =
      task.lifecycle === 'WAITING_USER' || task.lifecycle === 'FAILED' || task.lifecycle === 'CLOSED';
    const checkpointOutput = preserveLifecycle
      ? task.checkpointOutput ?? normalizeMeaningfulSummaryText(snapshot.checkpointOutput)
      : normalizeMeaningfulSummaryText(snapshot.checkpointOutput) ?? task.checkpointOutput;
    const updated = updateKnownTask(taskId, {
      lifecycle: preserveLifecycle ? task.lifecycle : (snapshot.lifecycle as any),
      waitKind: preserveLifecycle ? task.waitKind : ((snapshot.waitKind as any) ?? task.waitKind),
      waitOptions: preserveLifecycle ? task.waitOptions : (snapshot.waitOptions ?? task.waitOptions),
      checkpointOutput,
      logFilePath: session?.getLogPath?.() ?? snapshot.logPath ?? task.logFilePath,
      codexThreadId: snapshot.codexThreadId ?? task.codexThreadId,
      model: pickTaskModel(snapshot.model, task.model),
      interruptedByRestart: snapshot.interruptedByRestart ?? task.interruptedByRestart
    });
    if (updated) {
      syncRegistryRecord(updated, session);
    }
    return updated;
  }

  function getTaskRecord(taskId: `T${number}`): CommunicateTaskRecord | undefined {
    const task = store.getTask(taskId) ?? cloneTaskRecord(recoveredTasks.get(taskId));
    if (!task) return undefined;
    return cloneTaskRecord({
      ...task,
      runtimeWarnings: resolveRetainedRuntimeWarnings(task.runtimeWarnings, sessions.get(taskId)?.getSnapshot?.().runtimeWarnings)
    });
  }

  function updateKnownTask(taskId: `T${number}`, patch: Partial<CommunicateTaskRecord>): CommunicateTaskRecord | undefined {
    const liveTask = store.getTask(taskId);
    if (liveTask) {
      return store.updateTask(taskId, applyDerivedTaskPatch(liveTask, patch));
    }
    const recoveredTask = recoveredTasks.get(taskId);
    if (!recoveredTask) return undefined;
    const updated = {
      ...recoveredTask,
      ...applyDerivedTaskPatch(recoveredTask, patch)
    };
    recoveredTasks.set(taskId, updated);
    return cloneTaskRecord(updated);
  }

  function applyDerivedTaskPatch(
    current: CommunicateTaskRecord,
    patch: Partial<CommunicateTaskRecord>
  ): Partial<CommunicateTaskRecord> {
    if (!Object.prototype.hasOwnProperty.call(patch, 'checkpointOutput')) {
      return patch;
    }
    const nextPatch = { ...patch };
    const previousCheckpoint = normalizeMeaningfulSummaryText(current.checkpointOutput);
    const nextCheckpoint = normalizeMeaningfulSummaryText(patch.checkpointOutput);
    if (!nextCheckpoint) {
      nextPatch.lastCheckpointAt = patch.lastCheckpointAt ?? current.lastCheckpointAt;
      return nextPatch;
    }
    nextPatch.lastCheckpointAt =
      patch.lastCheckpointAt ??
      (nextCheckpoint === previousCheckpoint ? current.lastCheckpointAt : new Date().toISOString());
    return nextPatch;
  }

  function buildResumeContext(task: CommunicateTaskRecord): CodexSessionResumeContext | undefined {
    const record = sessionRegistry.getSessionRecord(task.id);
    if (!record) return undefined;
    const nowMs = Date.now();
    const context: CodexSessionResumeContext = {};
    if (typeof record.sessionLifecycle === 'string' && record.sessionLifecycle) {
      context.sourceSessionLifecycle = record.sessionLifecycle;
    }
    if (typeof record.lastEventAt === 'string' && record.lastEventAt) {
      context.sourceLastEventAt = record.lastEventAt;
      const idleMs = parseIsoAgeMs(record.lastEventAt, nowMs);
      if (idleMs !== undefined) {
        context.sourceIdleMs = idleMs;
      }
    }
    if (typeof record.createdAt === 'string' && record.createdAt) {
      context.sourceCreatedAt = record.createdAt;
      const ageMs = parseIsoAgeMs(record.createdAt, nowMs);
      if (ageMs !== undefined) {
        context.sourceAgeMs = ageMs;
      }
    }
    return Object.keys(context).length > 0 ? context : undefined;
  }

  async function ensureReplySession(
    task: CommunicateTaskRecord,
    caller = 'unknown'
  ): Promise<
    | {
        ok: true;
        session: CodexSessionLike;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    const existing = sessions.get(task.id);
    if (existing) {
      return { ok: true, session: existing };
    }
    if (task.taskType !== 'codex_session') {
      return {
        ok: false,
        error: `任务 ${task.id} 不是 Codex 会话，无法恢复。`
      };
    }
    if (!task.codexThreadId) {
      return {
        ok: false,
        error: `任务 ${task.id} 缺少可恢复的 Codex 线程标识，请重新创建会话。`
      };
    }
    const hotConflict = resolveHotManagedCodexThreadConflict(task);
    if (hotConflict) {
      logFeishuDebug('session ensure hot conflict', {
        caller,
        taskId: task.id,
        threadId: task.threadId,
        codexThreadId: task.codexThreadId,
        conflictTaskId: hotConflict.taskId,
        conflictThreadId: hotConflict.threadId ?? null
      });
      return {
        ok: false,
        error: describeHotManagedCodexThreadConflict(task, hotConflict) ?? `任务 ${task.id} 恢复失败，请稍后重试。`
      };
    }
    const session = await ensureHotSessionForReply(task, caller);
    if (!session) {
      return {
        ok: false,
        error: `任务 ${task.id} 恢复失败，请稍后重试。`
      };
    }
    return { ok: true, session };
  }

  async function ensureHotSessionForReply(
    task: CommunicateTaskRecord,
    caller = 'unknown'
  ): Promise<CodexSessionLike | undefined> {
    const existing = sessions.get(task.id);
    logFeishuDebug('session ensure begin', {
      caller,
      taskId: task.id,
      threadId: task.threadId,
      codexThreadId: task.codexThreadId,
      hadExistingSession: Boolean(existing),
      existingSession: debugSessionSnapshot(existing)
    });
    if (existing) {
      logFeishuDebug('session ensure hit', {
        caller,
        taskId: task.id,
        threadId: task.threadId,
        codexThreadId: task.codexThreadId,
        session: debugSessionSnapshot(existing)
      });
      return existing;
    }
    if (task.taskType !== 'codex_session') return undefined;
    if (!task.codexThreadId) {
      logFeishuDebug('session ensure missing thread id', {
        caller,
        taskId: task.id,
        threadId: task.threadId
      });
      return undefined;
    }

    const ownershipConflicts = debugRegistryCodexThreadOwners(task.codexThreadId, task.id);
    if (ownershipConflicts.length > 0) {
      logFeishuDebug('session ensure codex thread conflict', {
        caller,
        taskId: task.id,
        threadId: task.threadId,
        codexThreadId: task.codexThreadId,
        owners: ownershipConflicts
      });
    }

    const resumeContext = buildResumeContext(task);
    const sessionFactory = isAssistantTask(task) ? assistantSessionFactory : codingSessionFactory;
    const session = sessionFactory({
      taskId: task.id,
      cwd: task.cwd ?? process.cwd(),
      threadId: task.threadId,
      mode: 'resume',
      resumeThreadId: task.codexThreadId,
      resumeContext,
      approvalPolicy: task.approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY,
      sandbox: task.sandbox ?? DEFAULT_CODEX_SANDBOX,
      ...(task.model !== undefined ? { model: task.model } : {}),
      interruptedByRestart: true,
      ...(task.developerInstructions ? { developerInstructions: task.developerInstructions } : {}),
      ...(task.baseInstructions ? { baseInstructions: task.baseInstructions } : {}),
      ...(task.personality ? { personality: task.personality } : {})
    });
    const replacedSession = sessions.get(task.id);
    if (replacedSession && replacedSession !== session) {
      logFeishuDebug('session ensure replaced existing session', {
        caller,
        taskId: task.id,
        threadId: task.threadId,
        codexThreadId: task.codexThreadId,
        replacedSession: debugSessionSnapshot(replacedSession),
        nextSession: debugSessionSnapshot(session)
      });
    }
    sessions.set(task.id, session);
    await session.start();
    logFeishuDebug('session ensure resume', {
      caller,
      taskId: task.id,
      threadId: task.threadId,
      codexThreadId: task.codexThreadId,
      sessionKind: task.sessionKind,
      assistant: isAssistantTask(task),
      interruptedByRestart: true,
      session: debugSessionSnapshot(session),
      ...resumeContext
    });
    const snapshot = session.getSnapshot?.();
    const updated = updateKnownTask(task.id, {
      lifecycle: resolveStartupCompletionLifecycle(snapshot?.lifecycle),
      waitKind: undefined,
      waitOptions: undefined,
      latestWaitPrompt: undefined,
      checkpointOutput: resolveStartupCompletionCheckpointOutput(task.checkpointOutput, snapshot),
      runtimeWarnings: resolveRetainedRuntimeWarnings(task.runtimeWarnings, snapshot?.runtimeWarnings),
      interruptedByRestart: true,
      startupMode: 'resume',
      codexThreadId: snapshot?.codexThreadId ?? task.codexThreadId,
      model: pickTaskModel(snapshot?.model, task.model),
      logFilePath: session.getLogPath?.() ?? snapshot?.logPath ?? task.logFilePath,
      sessionKind: task.sessionKind,
      assistantProfileId: task.assistantProfileId,
      developerInstructions: task.developerInstructions,
      baseInstructions: task.baseInstructions,
      personality: task.personality
    });
    if (updated) {
      syncRegistryRecord(updated, session);
    }
    return session;
  }

  function syncRegistryRecord(task: CommunicateTaskRecord, session?: CodexSessionLike): void {
    const snapshot = session?.getSnapshot?.();
    const existing = sessionRegistry.getSessionRecord(task.id);
    const codexThreadId = task.codexThreadId ?? snapshot?.codexThreadId ?? existing?.codexThreadId;
    const model = pickTaskModel(snapshot?.model, task.model, existing?.model);
    const meaningfulCheckpointOutput = normalizeMeaningfulSummaryText(task.checkpointOutput);
    const checkpointOutputChanged = meaningfulCheckpointOutput !== undefined && meaningfulCheckpointOutput !== existing?.lastCheckpointOutput;
    const nextCheckpointAt =
      meaningfulCheckpointOutput === undefined
        ? existing?.lastCheckpointAt
        : checkpointOutputChanged
          ? task.lastCheckpointAt ?? new Date().toISOString()
          : task.lastCheckpointAt ?? existing?.lastCheckpointAt;
    if (codexThreadId) {
      const conflictingOwners = debugRegistryCodexThreadOwners(codexThreadId, task.id);
      if (conflictingOwners.length > 0) {
        logFeishuDebug('registry codex thread conflict', {
          taskId: task.id,
          threadId: task.threadId,
          codexThreadId,
          session: debugSessionSnapshot(session),
          owners: conflictingOwners
        });
      }
    }
    sessionRegistry.upsertSessionRecord({
      taskId: task.id,
      feishuThreadId: task.threadId,
      codexThreadId,
      cwd: task.cwd ?? existing?.cwd,
      logPath: task.logFilePath ?? session?.getLogPath?.() ?? snapshot?.logPath ?? existing?.logPath,
      approvalPolicy: task.approvalPolicy ?? existing?.approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY,
      sandbox: task.sandbox ?? existing?.sandbox ?? DEFAULT_CODEX_SANDBOX,
      model,
      sessionLifecycle: normalizeRegistryLifecycle(String(task.lifecycle)),
      lastCheckpointOutput: meaningfulCheckpointOutput ?? existing?.lastCheckpointOutput,
      lastCheckpointAt: nextCheckpointAt,
      lastEventAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      closedAt: task.lifecycle === 'CLOSED' ? existing?.closedAt ?? new Date().toISOString() : existing?.closedAt,
      windowPid: snapshot?.windowPid ?? existing?.windowPid,
      interruptedByRestart: task.interruptedByRestart ?? snapshot?.interruptedByRestart ?? existing?.interruptedByRestart,
      sessionKind: task.sessionKind ?? existing?.sessionKind ?? 'coding',
      startupMode: task.startupMode ?? existing?.startupMode,
      assistantProfileId: task.assistantProfileId ?? existing?.assistantProfileId,
      developerInstructions: task.developerInstructions ?? existing?.developerInstructions,
      baseInstructions: task.baseInstructions ?? existing?.baseInstructions,
      personality: task.personality ?? existing?.personality,
      runtimeWarnings: mergeCommunicateRuntimeWarnings(
        task.runtimeWarnings,
        snapshot?.runtimeWarnings,
        existing?.runtimeWarnings
      ),
      goalSummary: task.goalSummary ?? existing?.goalSummary,
      goalSummaryStatus: task.goalSummaryStatus ?? existing?.goalSummaryStatus,
      goalSummarySourceText: task.goalSummarySourceText ?? existing?.goalSummarySourceText,
      firstUserCodingText: task.firstUserCodingText ?? existing?.firstUserCodingText
    });
  }

  return {
    handleInboundImage,
    handleInboundMessage,
    handleCardAction,
    handleWorkerEvent,
    syncStartupCardForLastActiveThread,
    rememberInboundDeliveryTarget(input: { threadId: string; senderOpenId?: string }) {
      rememberInboundDeliveryTarget(input.threadId, input.senderOpenId);
    },
    getTask(taskId: `T${number}`) {
      return getTaskRecord(taskId);
    }
  };
}

function extractWindowsPath(text: string): string | undefined {
  const matched = text.match(/([A-Za-z]:\\[A-Za-z0-9_ .()\\/-]+)/);
  const normalized = matched?.[1]?.trim().replace(/[。！!，,；;：:]+$/u, '');
  return normalized && /^[A-Za-z]:\\/.test(normalized) ? normalized : undefined;
}

function toCodexReplyPayload(params: Record<string, unknown>): CodexReplyPayload {
  const action = String(params.action ?? '');
  if (action === 'input_text') {
    return { action: 'input_text', text: String(params.text ?? '') };
  }
  if (action === 'choose_index') {
    return { action: 'choose_index', index: Number(params.index ?? 1) };
  }
  if (action === 'confirm') {
    return { action: 'confirm', value: params.value === 'deny' ? 'deny' : 'allow' };
  }
  return { action: 'free_text', text: String(params.text ?? '') };
}

function tailText(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function taskRecordFromSessionRegistry(record: SessionRegistryRecord): CommunicateTaskRecord {
  const normalized = normalizeRecoveredLifecycle(record.sessionLifecycle);
  const interruptedByRestart =
    record.interruptedByRestart ??
    (record.sessionLifecycle === 'RUNNING_TURN' ||
    record.sessionLifecycle === 'WAITING_USER' ||
    record.sessionLifecycle === 'STARTING');
    return {
      id: record.taskId,
      taskType: 'codex_session',
    threadId: record.feishuThreadId ?? '',
    lifecycle: normalized,
    cwd: record.cwd,
    logFilePath: record.logPath,
    codexThreadId: record.codexThreadId,
    model: record.model,
    approvalPolicy: record.approvalPolicy,
    sandbox: record.sandbox,
    sessionKind: record.sessionKind ?? 'coding',
    startupMode: record.startupMode,
    assistantProfileId: record.assistantProfileId,
      developerInstructions: record.developerInstructions,
      baseInstructions: record.baseInstructions,
      personality: record.personality,
      runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings),
      goalSummary: record.goalSummary,
      goalSummaryStatus: record.goalSummaryStatus,
      goalSummarySourceText: record.goalSummarySourceText,
    firstUserCodingText: record.firstUserCodingText,
    lastCheckpointAt: record.lastCheckpointAt,
    lastEventAt: record.lastEventAt,
    interruptedByRestart,
    checkpointOutput: record.lastCheckpointOutput
  };
}

function cloneTaskRecord(record?: CommunicateTaskRecord): CommunicateTaskRecord | undefined {
  return record
    ? {
        ...record,
        runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings),
        waitOptions: record.waitOptions ? [...record.waitOptions] : undefined
      }
    : undefined;
}

function normalizeRegistryLifecycle(lifecycle: string): SessionRegistryRecord['sessionLifecycle'] {
  switch (lifecycle) {
    case 'STARTING':
    case 'IDLE':
    case 'RUNNING_TURN':
    case 'WAITING_USER':
    case 'CLOSING':
    case 'CLOSED':
    case 'FAILED':
      return lifecycle;
    default:
      return 'STARTING';
  }
}

function normalizeRecoveredLifecycle(lifecycle?: SessionRegistryRecord['sessionLifecycle']): CommunicateTaskRecord['lifecycle'] {
  switch (lifecycle) {
    case 'RUNNING_TURN':
    case 'WAITING_USER':
    case 'STARTING':
      return 'IDLE';
    case 'CLOSING':
      return 'CLOSED';
    case 'IDLE':
    case 'CLOSED':
    case 'FAILED':
      return lifecycle;
    default:
      return 'STARTING';
  }
}

function resolveRecentSummary(input: {
  lifecycle: string;
  liveBuffer?: string;
  checkpointOutput?: string;
  logFilePath?: string;
}): string {
  const preferred = resolvePreferredSummaryText(input.lifecycle, input.liveBuffer, input.checkpointOutput);
  if (preferred && preferred.trim() !== '') {
    return extractSummaryLine(preferred) ?? tailText(preferred);
  }
  if (input.logFilePath) {
    const logTail = readMeaningfulLogTail(input.logFilePath);
    if (logTail) return extractSummaryLine(logTail) ?? logTail;
  }
  return '暂无输出';
}

function resolvePreferredSummaryText(
  lifecycle: string,
  liveBuffer?: string,
  checkpointOutput?: string
): string | undefined {
  return lifecycle === 'WAITING_USER'
    ? firstNonBlankText(checkpointOutput, liveBuffer)
    : firstNonBlankText(liveBuffer, checkpointOutput);
}

function resolveTaskProgressPreviousOutput(input: {
    liveCheckpointOutput?: string;
    taskCheckpointOutput?: string;
    taskCheckpointAt?: string;
    logFilePath?: string;
  }): string | undefined {
    const liveCheckpoint = normalizeMeaningfulSummaryText(input.liveCheckpointOutput);
    const taskCheckpoint = normalizeMeaningfulSummaryText(input.taskCheckpointOutput);
    const latestUserFacingReplyEntry = input.logFilePath ? readLatestUserFacingReplyLogEntry(input.logFilePath) : undefined;
    const latestUserFacingReply = latestUserFacingReplyEntry?.text;
    if (liveCheckpoint && shouldPreferTaskProgressCheckpoint(liveCheckpoint, latestUserFacingReply)) {
      return liveCheckpoint;
    }
    if (
      !liveCheckpoint &&
      taskCheckpoint &&
      shouldPreferRecoveredTaskProgressCheckpoint(taskCheckpoint, input.taskCheckpointAt, latestUserFacingReplyEntry)
    ) {
      return taskCheckpoint;
    }
    if (latestUserFacingReply) {
      return latestUserFacingReply;
    }
    if (liveCheckpoint) {
      return liveCheckpoint;
    }
    if (taskCheckpoint) {
      return taskCheckpoint;
    }
    const liveCheckpointPlaceholder = input.liveCheckpointOutput?.trim();
    const taskCheckpointPlaceholder = input.taskCheckpointOutput?.trim();
    const hasIgnorablePlaceholder =
      Boolean(liveCheckpointPlaceholder && isIgnorableSummaryText(liveCheckpointPlaceholder)) ||
      Boolean(taskCheckpointPlaceholder && isIgnorableSummaryText(taskCheckpointPlaceholder));
    if (!hasIgnorablePlaceholder || !input.logFilePath) {
      return undefined;
    }
    return readMeaningfulRawLogBlock(input.logFilePath, { skipCurrentTurnBlock: true });
  }

function firstNonBlankText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (normalizeMeaningfulSummaryText(value)) return value;
  }
  return undefined;
}

function normalizeMeaningfulSummaryText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isIgnorableSummaryText(trimmed)) return undefined;
  return value;
}

function resolveRetainedCheckpointOutput(current: string | undefined, next: string | undefined): string | undefined {
  return normalizeMeaningfulSummaryText(next) ?? current;
}

function buildCodingTaskStartupDelivery(task: Pick<CommunicateTaskRecord, 'id' | 'lifecycle' | 'model'>): string | undefined {
  const modelLabel = formatTaskModelLabel(task.model);
  if (task.lifecycle === 'FAILED' || task.lifecycle === 'CLOSED') {
    return undefined;
  }
  if (task.lifecycle === 'IDLE') {
    return `已创建任务 ${task.id}（模型 ${modelLabel}），Codex 会话已就绪。`;
  }
  return `已创建任务 ${task.id}（模型 ${modelLabel}），正在启动 Codex 会话。`;
}

function resolveRetainedRuntimeWarnings(
  current: CommunicateRuntimeWarning[] | null | undefined,
  next: CommunicateRuntimeWarning[] | null | undefined
): CommunicateRuntimeWarning[] | undefined {
  return mergeCommunicateRuntimeWarnings(next, current);
}

function resolveStartupCompletionLifecycle(lifecycle: string | undefined): CommunicateTaskRecord['lifecycle'] {
  switch (lifecycle) {
    case 'IDLE':
    case 'FAILED':
    case 'CLOSED':
      return lifecycle;
    default:
      return 'STARTING';
  }
}

function resolveStartupCompletionCheckpointOutput(
  current: string | undefined,
  snapshot: ReturnType<NonNullable<CodexSessionLike['getSnapshot']>> | undefined
): string | undefined {
  return resolveStartupCompletionLifecycle(snapshot?.lifecycle) === 'STARTING'
    ? current
    : resolveRetainedCheckpointOutput(current, snapshot?.checkpointOutput);
}

function extractSummaryLine(text: string, maxChars = 160): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line === '```') continue;
    if (line.length <= maxChars) return line;
    return `${line.slice(0, Math.max(0, maxChars - 3))}...`;
  }
  return undefined;
}

function formatTakeoverPickerSummary(text: string | undefined): string | undefined {
  const meaningful = normalizeMeaningfulSummaryText(text);
  const normalized = meaningful
    ?.replace(/\r\n/g, '\n')
    .replace(/\n{2}\[图片\]\n(?:- .*(?:\n|$))*$/u, '')
    .trim();
  if (!normalized) {
    return undefined;
  }
  const firstLine = normalized
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .find((line: string) => line !== '' && line !== '```');
  if (!firstLine) {
    return undefined;
  }
  const compact = firstLine.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return undefined;
  }
  const glyphs = Array.from(compact);
  if (glyphs.length <= TAKEOVER_PICKER_SUMMARY_MAX_CHARS) {
    return compact;
  }
  return `${glyphs.slice(0, Math.max(0, TAKEOVER_PICKER_SUMMARY_MAX_CHARS - 3)).join('')}...`;
}

function readLatestUserFacingReplyLogBlock(logFilePath: string): string | undefined {
  return readLatestUserFacingReplyLogEntry(logFilePath)?.text;
}

function readLatestUserFacingReplyLogEntry(logFilePath: string): { text: string; timestampMs?: number } | undefined {
  try {
    const content = readFileSync(logFilePath, 'utf8');
    const lines = content.split(/\r?\n/);
    return readLatestUserFacingReplyLogEntryFromLines(lines);
  } catch {
    return undefined;
  }
}

function readMeaningfulLogTail(logFilePath: string, maxChars = 4000): string | undefined {
  try {
    const content = readFileSync(logFilePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = normalizeMeaningfulLogLine(lines[index]);
      if (candidate) return tailText(candidate, maxChars);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readLatestUserFacingReplyLogBlockFromLines(lines: string[]): string | undefined {
  return readLatestUserFacingReplyLogEntryFromLines(lines)?.text;
}

function readLatestUserFacingReplyLogEntryFromLines(lines: string[]): { text: string; timestampMs?: number } | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const marker = parseUserFacingReplyLogMarker(lines[index]);
    if (!marker) {
      continue;
    }
    const block: string[] = [];
    if (marker.inlineText?.trim()) {
      block.unshift(marker.inlineText);
    }
    let foundMeaningful = block.length > 0;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const embeddedEvent = parseEmbeddedStructuredSessionLogEvent(lines[cursor]);
      if (embeddedEvent?.leading && isUserFacingReplyHardBoundaryEvent(embeddedEvent.event)) {
        if (foundMeaningful) {
          break;
        }
        continue;
      }
      const replyLine = extractPotentialUserFacingReplyLine(lines[cursor]);
      if (!foundMeaningful) {
        if (!isMeaningfulUserFacingReplyLine(lines[cursor])) {
          continue;
        }
        foundMeaningful = true;
      }
      block.unshift(replyLine ?? lines[cursor]);
    }
    const trimmed = trimMeaningfulRawLogBlock(block);
    if (trimmed) {
      return {
        text: trimmed,
        timestampMs: parseStructuredSessionLogTimestampMs(lines[index])
      };
    }
  }
  return undefined;
}

function readMeaningfulRawLogBlock(
  logFilePath: string,
  options?: { skipCurrentTurnBlock?: boolean; maxChars?: number }
): string | undefined {
  try {
    const content = readFileSync(logFilePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const recoveryMarkerIndex = options?.skipCurrentTurnBlock ? findLatestTaskProgressRecoveryMarkerIndex(lines) : -1;
    const currentTurnBoundaryIndex = options?.skipCurrentTurnBlock
      ? findLatestTaskProgressTurnBoundaryIndex(lines, recoveryMarkerIndex)
      : -1;
    const endIndexExclusive =
      recoveryMarkerIndex >= 0 ? recoveryMarkerIndex : currentTurnBoundaryIndex >= 0 ? currentTurnBoundaryIndex : lines.length;
    return readLatestMeaningfulRawLogBlock(lines, endIndexExclusive, options?.maxChars ?? 4000);
  } catch {
    return undefined;
  }
}

function isMeaningfulRawLogLine(rawLine: string | undefined): boolean {
  const line = extractRawLogTextSegment(rawLine)?.trim();
  return Boolean(line && !isIgnorableSummaryText(line));
}

function readLatestMeaningfulRawLogBlock(
  lines: string[],
  endIndexExclusive: number,
  maxChars: number
): string | undefined {
  const block: string[] = [];
  let foundMeaningful = false;
  for (let index = Math.min(endIndexExclusive, lines.length) - 1; index >= 0; index -= 1) {
    const event = parseStructuredSessionLogEvent(lines[index]);
    if (event) {
      if (foundMeaningful && isTaskProgressTurnBoundaryEvent(event)) {
        break;
      }
      continue;
    }
    if (!foundMeaningful) {
      if (!isMeaningfulRawLogLine(lines[index])) {
        continue;
      }
      foundMeaningful = true;
    }
    block.unshift(lines[index]);
  }
  if (!foundMeaningful) {
    return undefined;
  }
  const trimmed = trimMeaningfulRawLogBlock(block);
  return trimmed ? tailText(trimmed, maxChars) : undefined;
}

function trimMeaningfulRawLogBlock(lines: string[]): string | undefined {
  let startIndex = 0;
  let endIndex = lines.length - 1;
  while (startIndex <= endIndex && !isMeaningfulRawLogLine(lines[startIndex])) {
    startIndex += 1;
  }
  while (endIndex >= startIndex && !isMeaningfulRawLogLine(lines[endIndex])) {
    endIndex -= 1;
  }
  if (startIndex > endIndex) {
    return undefined;
  }
  const block = lines.slice(startIndex, endIndex + 1).join('\n').trim();
  return block || undefined;
}

function findLatestTaskProgressTurnBoundaryIndex(lines: string[], afterIndex = -1): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (index <= afterIndex) {
      return -1;
    }
    const event = parseStructuredSessionLogEvent(lines[index]);
    if (event && isTaskProgressTurnBoundaryEvent(event)) {
      return index;
    }
  }
  return -1;
}

function findLatestTaskProgressRecoveryMarkerIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseStructuredSessionLogEvent(lines[index]);
    if (event === 'SESSION RESUMED' || event === 'SESSION READY') {
      return index;
    }
  }
  return -1;
}

function isTaskProgressTurnBoundaryEvent(event: string): boolean {
  return (
    event.startsWith('FEISHU IN ') ||
    event === 'TURN START' ||
    event.startsWith('TURN_START_') ||
    event.startsWith('TURN CONCURRENT_INPUT')
  );
}

function parseStructuredSessionLogEvent(rawLine: string | undefined): string | undefined {
  const line = rawLine?.trimStart() ?? '';
  const match = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const content = match[1];
  return isStructuredSessionLogContent(content) ? content : undefined;
}

function parseStructuredSessionLogTimestampMs(rawLine: string | undefined): number | undefined {
  const line = rawLine?.trimStart() ?? '';
  const match = /^\[([^\]]+)\]\s+/.exec(line);
  if (!match) {
    return undefined;
  }
  return parseIsoTimestampMs(match[1]);
}

function parseEmbeddedStructuredSessionLogEvent(rawLine: string | undefined):
  | { event: string; prefix: string; leading: boolean }
  | undefined {
  const line = rawLine ?? '';
  const directEvent = parseStructuredSessionLogEvent(line);
  if (directEvent) {
    return {
      event: directEvent,
      prefix: '',
      leading: true
    };
  }
  const timestampPattern = /\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+/g;
  let match: RegExpExecArray | null;
  while ((match = timestampPattern.exec(line)) !== null) {
    const suffix = line.slice(match.index);
    const event = parseStructuredSessionLogEvent(suffix);
    if (event) {
      return {
        event,
        prefix: line.slice(0, match.index),
        leading: match.index === 0
      };
    }
  }
  return undefined;
}

function parseUserFacingReplyLogMarker(rawLine: string | undefined): { inlineText?: string } | undefined {
  const embeddedEvent = parseEmbeddedStructuredSessionLogEvent(rawLine);
  if (!embeddedEvent) {
    return undefined;
  }
  const event = embeddedEvent.event;
  const isUserFacingAgentMessage =
    (event.startsWith('ITEM_COMPLETED') || event.startsWith('AGENT_MESSAGE')) &&
    /"phase":"(?:final_answer|commentary)"/.test(event);
  if (
    isUserFacingAgentMessage ||
    event.startsWith('THREAD_READ_FINAL_ANSWER') ||
    event.startsWith('TASK_COMPLETE_EVENT') ||
    event.startsWith('WAITING_USER')
  ) {
    return embeddedEvent.prefix.trim() === '' ? {} : { inlineText: embeddedEvent.prefix };
  }
  return undefined;
}

function shouldPreferTaskProgressCheckpoint(checkpoint: string, latestUserFacingReply?: string): boolean {
  const trimmedCheckpoint = checkpoint.trim();
  const trimmedReply = latestUserFacingReply?.trim();
  if (!trimmedReply) {
    return true;
  }
  if (trimmedCheckpoint === trimmedReply) {
    return true;
  }
  if (checkpointContainsReplyWithDiagnosticNoise(trimmedCheckpoint, trimmedReply)) {
    return false;
  }
  return !hasTaskProgressDiagnosticNoise(trimmedCheckpoint);
}

function shouldPreferRecoveredTaskProgressCheckpoint(
  checkpoint: string,
  taskCheckpointAt: string | undefined,
  latestUserFacingReplyEntry?: { text: string; timestampMs?: number }
): boolean {
  if (!shouldPreferTaskProgressCheckpoint(checkpoint, latestUserFacingReplyEntry?.text)) {
    return false;
  }
  if (!latestUserFacingReplyEntry?.text) {
    return true;
  }
  const taskCheckpointEventMs = parseIsoTimestampMs(taskCheckpointAt);
  const latestReplyMs = latestUserFacingReplyEntry.timestampMs;
  if (taskCheckpointEventMs === undefined || latestReplyMs === undefined) {
    return false;
  }
  return taskCheckpointEventMs > latestReplyMs;
}

function checkpointContainsReplyWithDiagnosticNoise(checkpoint: string, reply: string): boolean {
  if (!checkpoint.includes(reply) || checkpoint === reply) {
    return false;
  }
  const extraLines = checkpoint
    .replace(reply, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return extraLines.some((line) => isTaskProgressDiagnosticLine(line));
}

function hasTaskProgressDiagnosticNoise(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => isTaskProgressDiagnosticLine(line));
}

function isTaskProgressDiagnosticLine(line: string): boolean {
  if (!line) {
    return false;
  }
  if (parseStructuredSessionLogEvent(line)) {
    return true;
  }
  return /^codex app-server\b/i.test(line);
}

function isStructuredSessionLogContent(content: string): boolean {
  return [
    'FEISHU IN ',
    'FEISHU OUT ',
    'SESSION ',
    'BUILD_FINGERPRINT',
    'STARTUP_',
    'SYSTEM_ERROR_',
    'STALL_DIAGNOSTIC',
    'WAITING_USER',
    'TURN ',
    'TURN_',
    'THREAD_',
    'WS_RAW_',
    'RPC_',
    'SOCKET_',
    'WINDOW_',
    'ITEM_COMPLETED',
    'COMMAND ',
    'AGENT_MESSAGE',
    'TASK_COMPLETE_EVENT',
    'APPROVAL_REQUESTED',
    'UNHANDLED_EVENT',
    'TRANSPORT_CLEANUP_REQUESTED',
    'CHILD_',
    'TCP_PROXY_ENABLED',
    'SPAWN_FAILED'
  ].some((prefix) => content.startsWith(prefix));
}

function normalizeMeaningfulLogLine(rawLine: string | undefined): string | undefined {
  const structuredEvent = parseStructuredSessionLogEvent(rawLine);
  if (structuredEvent) {
    if (structuredEvent.startsWith('FEISHU IN ')) {
      const payload = structuredEvent.slice('FEISHU IN '.length).trim();
      return payload && !isIgnorableSummaryText(payload) ? payload : undefined;
    }
    if (structuredEvent.startsWith('FEISHU OUT ')) {
      const payload = structuredEvent.slice('FEISHU OUT '.length).trim();
      return payload && !isIgnorableSummaryText(payload) ? payload : undefined;
    }
    if (isIgnorableSessionLogLine(structuredEvent)) {
      return undefined;
    }
    return undefined;
  }

  const line = extractRawLogTextSegment(rawLine)?.trim();
  if (!line || line === '```' || isIgnorableSummaryText(line)) return undefined;
  return line;
}

function extractRawLogTextSegment(rawLine: string | undefined): string | undefined {
  const embeddedEvent = parseEmbeddedStructuredSessionLogEvent(rawLine);
  if (!embeddedEvent) {
    return rawLine;
  }
  if (embeddedEvent.leading) {
    return undefined;
  }
  return embeddedEvent.prefix;
}

function extractPotentialUserFacingReplyLine(rawLine: string | undefined): string | undefined {
  const embeddedEvent = parseEmbeddedStructuredSessionLogEvent(rawLine);
  if (!embeddedEvent) {
    return rawLine;
  }
  if (!embeddedEvent.leading) {
    return embeddedEvent.prefix;
  }
  return isUserFacingReplyHardBoundaryEvent(embeddedEvent.event) ? undefined : rawLine;
}

function isMeaningfulUserFacingReplyLine(rawLine: string | undefined): boolean {
  const line = extractPotentialUserFacingReplyLine(rawLine)?.trim();
  return Boolean(line && !isIgnorableSummaryText(line));
}

function isUserFacingReplyHardBoundaryEvent(event: string): boolean {
  return [
    'FEISHU IN ',
    'FEISHU OUT ',
    'BUILD_FINGERPRINT',
    'STARTUP_',
    'SYSTEM_ERROR_',
    'STALL_DIAGNOSTIC',
    'TURN ',
    'TURN_',
    'THREAD_',
    'WS_RAW_',
    'RPC_',
    'SOCKET_',
    'WINDOW_',
    'ITEM_COMPLETED',
    'COMMAND ',
    'AGENT_MESSAGE',
    'TASK_COMPLETE_EVENT',
    'APPROVAL_REQUESTED',
    'UNHANDLED_EVENT',
    'TRANSPORT_CLEANUP_REQUESTED',
    'CHILD_',
    'TCP_PROXY_ENABLED',
    'SPAWN_FAILED',
    'SESSION OPEN',
    'SESSION CLOSE'
  ].some((prefix) => event.startsWith(prefix));
}

function isIgnorableSessionLogLine(line: string): boolean {
  return [
    'SESSION OPEN',
    'SESSION READY',
    'SESSION CLOSE',
    'TURN START',
    'THREAD_READ_POLL',
    'UNHANDLED_EVENT',
    'ITEM_COMPLETED',
    'AGENT_MESSAGE_RESYNC',
    'WINDOW_START_FAILED'
  ].some((prefix) => line.startsWith(prefix));
}

function isIgnorableSummaryText(text: string): boolean {
  return [
    'Codex 会话已启动，等待你的任务描述。',
    'Codex 会话已恢复，等待你的任务描述。',
    'Codex会话已启动，等待你的任务描述。',
    'Codex会话已恢复，等待你的任务描述。'
  ].includes(text);
}

function isLauncherStyleGoalSummarySourceText(text: string): boolean {
  const normalized = text.trim();
  const hasWindowsPath = /[A-Za-z]:\\/.test(normalized);
  if (hasWindowsPath && /(?:开|启动).{0,20}codex/i.test(normalized)) {
    return true;
  }
  if (/(?:开|启动|打开).{0,20}codex.{0,12}(?:窗口|会话)/i.test(normalized)) {
    return true;
  }
  return /^(?:帮我|请|麻烦你)?(?:开|启动)\s*(?:一个|一下)?\s*codex[。！!，,；;：:]*$/i.test(normalized);
}

function isInvalidGoalSummarySourceText(text: string): boolean {
  return isIgnorableSummaryText(text) || isLauncherStyleGoalSummarySourceText(text);
}

function resolveAssistantProfile(input?: Partial<AssistantProfileConfig>): AssistantProfileConfig {
  return {
    cwd: input?.cwd ?? DEFAULT_ASSISTANT_CWD,
    approvalPolicy: input?.approvalPolicy ?? DEFAULT_CODEX_APPROVAL_POLICY,
    sandbox: input?.sandbox ?? DEFAULT_CODEX_SANDBOX,
    assistantProfileId: input?.assistantProfileId ?? DEFAULT_ASSISTANT_PROFILE_ID,
    developerInstructions: input?.developerInstructions ?? DEFAULT_ASSISTANT_DEVELOPER_INSTRUCTIONS,
    baseInstructions: input?.baseInstructions ?? DEFAULT_ASSISTANT_BASE_INSTRUCTIONS,
    personality: input?.personality ?? DEFAULT_ASSISTANT_PERSONALITY
  };
}

function isAssistantTask(task?: Pick<CommunicateTaskRecord, 'taskType' | 'sessionKind'>): boolean {
  return task?.taskType === 'codex_session' && task.sessionKind === 'assistant';
}

function toAssistantReplyPayload(task: CommunicateTaskRecord, text: string): CodexReplyPayload {
  const trimmed = text.trim();
  if (task.lifecycle !== 'WAITING_USER') {
    return { action: 'input_text', text: trimmed };
  }

  if (task.waitKind === 'choice') {
    const index = parseAssistantChoiceIndex(trimmed);
    return index == null ? { action: 'free_text', text: trimmed } : { action: 'choose_index', index };
  }
  if (task.waitKind === 'confirm') {
    if (/^(拒绝|不允许|deny|no|取消)$/i.test(trimmed)) {
      return { action: 'confirm', value: 'deny' };
    }
    if (/^(允许|同意|确认|好的|好|继续|allow|yes)$/i.test(trimmed)) {
      return { action: 'confirm', value: 'allow' };
    }
    return { action: 'free_text', text: trimmed };
  }
  return { action: 'input_text', text: trimmed };
}

function parseApprovalCardPrompt(text: string | undefined): ApprovalCardPrompt | undefined {
  const block = extractApprovalPromptBlock(text);
  if (!block) return undefined;
  return block.kind === 'command' ? parseCommandApprovalPromptBlock(block.lines) : parseFileChangeApprovalPromptBlock(block.lines);
}

function extractApprovalPromptBlock(
  text: string | undefined
): { kind: ApprovalCardPrompt['kind']; lines: string[] } | undefined {
  const normalized = text?.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized?.trim()) return undefined;
  const lines = normalized.split('\n');
  let matched: { kind: ApprovalCardPrompt['kind']; lines: string[] } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    const kind =
      line === 'Codex 请求执行命令审批。'
        ? 'command'
        : line === 'Codex 请求文件改动审批。'
          ? 'file_change'
          : undefined;
    if (!kind) continue;
    const blockLines = [kind === 'command' ? 'Codex 请求执行命令审批。' : 'Codex 请求文件改动审批。'];
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockLine = lines[blockIndex] ?? '';
      blockLines.push(blockLine);
      if (blockLine.trim().startsWith('如需继续，请回复')) {
        break;
      }
    }
    matched = { kind, lines: blockLines };
  }
  return matched;
}

function parseCommandApprovalPromptBlock(lines: string[]): ApprovalCardPrompt | undefined {
  const commandLines: string[] = [];
  let cwd: string | undefined;
  let reason: string | undefined;
  let collectingCommand = false;
  for (const rawLine of lines.slice(1)) {
    const line = rawLine.replace(/\r/g, '');
    if (line.startsWith('命令:')) {
      commandLines.push(line.slice(3).trimStart());
      collectingCommand = true;
      continue;
    }
    if (line.startsWith('目录:')) {
      cwd = line.slice(3).trim();
      collectingCommand = false;
      continue;
    }
    if (line.startsWith('原因:')) {
      reason = line.slice(3).trim();
      collectingCommand = false;
      continue;
    }
    if (line.startsWith('如需继续，请回复')) {
      collectingCommand = false;
      continue;
    }
    if (collectingCommand) {
      commandLines.push(line);
    }
  }
  const command = commandLines.join('\n').trim();
  if (!command) return undefined;
  return {
    kind: 'command',
    content: command,
    previewLines: buildCommandPreviewLines(command),
    reason,
    detailLabel: cwd ? '目录' : undefined,
    detailValue: cwd
  };
}

function parseFileChangeApprovalPromptBlock(lines: string[]): ApprovalCardPrompt | undefined {
  let reason: string | undefined;
  let scope: string | undefined;
  const contentLines: string[] = [];
  for (const rawLine of lines.slice(1)) {
    const line = rawLine.replace(/\r/g, '');
    if (line.startsWith('原因:')) {
      reason = line.slice(3).trim();
      if (reason) {
        contentLines.push(`原因: ${reason}`);
      }
      continue;
    }
    if (line.startsWith('范围:')) {
      scope = line.slice(3).trim();
      if (scope) {
        contentLines.push(`范围: ${scope}`);
      }
      continue;
    }
    if (line.startsWith('如需继续，请回复')) {
      continue;
    }
    if (line.trim()) {
      contentLines.push(line.trimEnd());
    }
  }
  const content = contentLines.join('\n').trim();
  if (!content) return undefined;
  return {
    kind: 'file_change',
    content,
    previewLines: buildCommandPreviewLines(content),
    reason,
    detailLabel: scope ? '范围' : undefined,
    detailValue: scope
  };
}

function buildCommandPreviewLines(command: string, maxLines = 2, maxCharsPerLine = 120): string[] {
  return command
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(0, maxLines)
    .map((line) => (line.length <= maxCharsPerLine ? line : `${line.slice(0, Math.max(0, maxCharsPerLine - 3))}...`));
}

function parseAssistantChoiceIndex(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const choiceMatch = trimmed.match(/^选择第\s*([一二三四五六七八九十\d]+)\s*个$/);
  if (!choiceMatch) return null;
  const normalized = choiceMatch[1] ?? '';
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return (
    {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10
    }[normalized] ?? null
  );
}

function formatAssistantWaitingDelivery(task: CommunicateTaskRecord): string {
  const output = sanitizeAssistantText(task.checkpointOutput ?? '');
  const hint = assistantReplyHint(task.waitKind);
  return [output, hint ? `\n${hint}` : ''].join('').trim();
}

function formatAssistantTerminalDelivery(task: CommunicateTaskRecord, eventType: 'task_finished' | 'task_failed'): string {
  const output = sanitizeAssistantText(task.checkpointOutput ?? '');
  if (output) return output;
  return eventType === 'task_failed' ? '助手执行失败。' : '助手已完成。';
}

function formatCodingTaskInterruptedDelivery(
  taskId: `T${number}`,
  interruptionKind: CommunicateTaskInterruptionKind
): string {
  switch (interruptionKind) {
    case 'local_comm':
      return `任务 ${taskId} 已中断：本地通讯链路中断。`;
    case 'approval_denied':
      return `任务 ${taskId} 已中断：审批未通过。`;
    case 'upstream_execution':
      return `任务 ${taskId} 已中断：上游执行异常中断。`;
    case 'version_incompatible':
      return `任务 ${taskId} 已中断：Codex app-server 版本不兼容。`;
    case 'capability_missing':
      return `任务 ${taskId} 已中断：Codex app-server 缺少所需能力。`;
    case 'unknown':
    default:
      return `任务 ${taskId} 已中断：原因暂未归类。`;
  }
}

function sanitizeAssistantText(text: string): string {
  return text
    .replace(/对\s*T\d+\s*允许/g, '允许')
    .replace(/对\s*T\d+\s*拒绝/g, '拒绝')
    .replace(/对\s*T\d+\s*选择第一个/g, '选择第一个')
    .replace(/对\s*T\d+\s*输入[:：]\s*xxx/g, '直接回复你的内容')
    .replace(/对任务号\s*允许/g, '允许')
    .replace(/对任务号\s*拒绝/g, '拒绝')
    .replace(/如需继续，请回复[“"]允许[”"]或[“"]拒绝[”"]。/g, '如需继续，请直接回复“允许”或“拒绝”。')
    .trim();
}

function assistantReplyHint(waitKind?: CommunicateTaskRecord['waitKind']): string {
  if (waitKind === 'choice') return '可直接回复“选择第一个”或具体序号。';
  if (waitKind === 'confirm') return '可直接回复“允许”或“拒绝”。';
  if (waitKind === 'text_input') return '直接回复你的内容即可。';
  if (waitKind === 'polish_confirm') return '可直接回复“确认发送”。';
  return '';
}



function isAssistantSessionExpired(output: string): boolean {
  return /no rollout found for thread id/i.test(output);
}


















