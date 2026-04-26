import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { createCodexSession } from '../workers/codex/session';

import { createCodexAppSession } from '../workers/codex/app-session';
import { extractCodexModelFromCommand } from '../control/codex-model';
import { createTaskGoalSummaryGeneratorFromCodexCommand, type TaskGoalSummaryRuntimeConfig } from '../summary/task-goal-summary';
import { createFeishuApiClient } from './feishu-api';
import { type FeishuFrame, type FeishuFrameHeader, decodeFeishuFrame, encodeFeishuFrame, feishuFrameHeadersToRecord } from './feishu-frame';
import { createFeishuService } from './feishu-service';
import { saveImage } from './feishu-image-store';
import { createFeishuChannel, parseFeishuCardActionEvent, parseFeishuMessageEvent, type FeishuCardActionEvent } from './feishu-message';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const FEISHU_BASE_URL = 'https://open.feishu.cn';
const CONTROL_FRAME_TYPE = 0;
const DATA_FRAME_TYPE = 1;
const MAX_FRAME_PARTS = 256;
const MESSAGE_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const CACHED_ENDPOINT_UNUSABLE_WINDOW_MS = 5_000;
const CACHED_ENDPOINT_UNUSABLE_STREAK_LIMIT = 2;
const FEISHU_LEASE_KIND = 'feishu-longconn';
const FEISHU_LEASE_VERSION = 1;
const FEISHU_LEASE_OWNER_FILE = 'owner.json';
const FEISHU_LEASE_HEARTBEAT_FILE_PREFIX = 'heartbeat.';
const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_STALE_AFTER_MS = 15_000;

function buildCardActionToast(action: FeishuCardActionEvent): Record<string, unknown> {
  const content =
    action.kind === 'switch_mode_assistant'
      ? '正在切换到助手模式'
      : action.kind === 'switch_mode_coding'
        ? '正在切换到 Coding 模式'
        : action.kind === 'open_task_picker'
          ? '正在加载任务列表'
          : action.kind === 'open_takeover_picker'
            ? '正在加载本地 Codex 列表'
            : action.kind === 'create_new_task'
              ? '正在新建任务'
            : action.kind === 'pick_current_task'
              ? `正在切换到 ${action.taskId}`
              : action.kind === 'pick_takeover_task'
                ? `正在选择 ${action.taskId}`
                : action.kind === 'select_recent_cwd'
                  ? '正在选择最近目录'
                  : action.kind === 'submit_launch_coding'
                    ? '正在启动编程窗口'
                    : action.kind === 'query_current_task'
                      ? '正在查询当前任务'
                      : action.kind === 'interrupt_stalled_task'
                        ? '正在处理中断当前任务'
                        : action.kind === 'takeover_picker_prev_page'
                          ? '正在加载上一页'
                          : action.kind === 'takeover_picker_next_page'
                            ? '正在加载下一页'
                            : action.kind === 'refresh_takeover_picker'
                              ? '正在刷新本地 Codex 列表'
                              : action.kind === 'confirm_takeover_task'
                                ? '正在确认接管'
                                : action.kind === 'return_to_launcher'
                                  ? '正在返回启动卡'
                                  : action.kind === 'return_to_status'
                                    ? '正在返回状态卡'
                                    : action.kind === 'close_current_task'
                                      ? '正在关闭当前任务'
                                      : '正在处理卡片操作';
  return {
    toast: {
      type: 'info',
      content
    }
  };
}

function buildCallbackResponsePayload(result?: Record<string, unknown>): Record<string, unknown> {
  if (!result) {
    return { code: 200 };
  }
  return {
    code: 200,
    data: Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
  };
}

const FEISHU_DEBUG = process.env.COMMUNICATE_FEISHU_DEBUG === '1';
const FEISHU_INSTANCE_TAG = normalizeFeishuInstanceTag(process.env.COMMUNICATE_FEISHU_INSTANCE_TAG);
const FEISHU_DEBUG_LOG_PATH = resolveFeishuDebugLogPath();
const FEISHU_RAW_EVENT_DUMP_PATH = resolveFeishuRawEventDumpPath();
let feishuDebugLogDirReady = false;
let feishuRawEventDumpDirReady = false;
let feishuDebugSinkFailureReported = false;
let feishuRawEventDumpFailureReported = false;
function reportFeishuSinkFailure(kind: 'debug log' | 'raw event dump', filePath: string | undefined, error: unknown): void {
  const alreadyReported = kind === 'debug log' ? feishuDebugSinkFailureReported : feishuRawEventDumpFailureReported;
  if (alreadyReported) return;
  if (kind === 'debug log') {
    feishuDebugSinkFailureReported = true;
  } else {
    feishuRawEventDumpFailureReported = true;
  }
  const detail = {
    instanceTag: FEISHU_INSTANCE_TAG,
    path: filePath,
    error: error instanceof Error ? error.message : String(error)
  };
  try {
    console.error(`[feishu-longconn] ${kind} sink failed ${JSON.stringify(detail)}`);
  } catch {
    console.error(`[feishu-longconn] ${kind} sink failed`);
  }
}
function logFeishuDebug(message: string, extra?: Record<string, unknown>): void {
  if (!FEISHU_DEBUG) return;
  let line = `[feishu-longconn] ${message}`;
  const detail = FEISHU_INSTANCE_TAG
    ? {
        instanceTag: FEISHU_INSTANCE_TAG,
        ...(extra ?? {})
      }
    : extra;
  if (detail) {
    try {
      line = `${line} ${JSON.stringify(detail)}`;
    } catch {
      // Keep the plain prefix-only line below.
    }
  }
  console.log(line);
  if (!FEISHU_DEBUG_LOG_PATH) return;
  try {
    if (!feishuDebugLogDirReady) {
      mkdirSync(path.dirname(FEISHU_DEBUG_LOG_PATH), { recursive: true });
      feishuDebugLogDirReady = true;
    }
    appendFileSync(FEISHU_DEBUG_LOG_PATH, `${line}\n`, 'utf8');
  } catch (error) {
    reportFeishuSinkFailure('debug log', FEISHU_DEBUG_LOG_PATH, error);
  }
}

function dumpFeishuRawEvent(headers: Record<string, string>, payloadText: string): void {
  if (!FEISHU_RAW_EVENT_DUMP_PATH) return;
  let parsedPayload: unknown;
  let parseError: string | undefined;
  try {
    parsedPayload = JSON.parse(payloadText) as unknown;
  } catch (error) {
    parseError = String(error);
  }
  const entry = {
    at: new Date().toISOString(),
    instanceTag: FEISHU_INSTANCE_TAG,
    headers: {
      type: headers.type,
      message_id: headers.message_id,
      trace_id: headers.trace_id,
      seq: headers.seq,
      sum: headers.sum
    },
    payloadShape: compactFeishuPayload(parsedPayload),
    payloadText: payloadText.length > 32_000 ? `${payloadText.slice(0, 32_000)}...[truncated]` : payloadText,
    parseError
  };
  try {
    if (!feishuRawEventDumpDirReady) {
      mkdirSync(path.dirname(FEISHU_RAW_EVENT_DUMP_PATH), { recursive: true });
      feishuRawEventDumpDirReady = true;
    }
    appendFileSync(FEISHU_RAW_EVENT_DUMP_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    reportFeishuSinkFailure('raw event dump', FEISHU_RAW_EVENT_DUMP_PATH, error);
  }
}

type FeishuClientConfigPayload = {
  PingInterval?: number;
  ReconnectCount?: number;
  ReconnectInterval?: number;
  ReconnectNonce?: number;
};

export type FeishuLongConnectionLeaseOwner = {
  ownerId: string;
  pid: number;
  instanceTag: string;
  startedAt: string;
  heartbeatAt: string;
};

export type FeishuLongConnectionLeaseState = {
  version: typeof FEISHU_LEASE_VERSION;
  kind: typeof FEISHU_LEASE_KIND;
  owner: FeishuLongConnectionLeaseOwner;
};

export type FeishuLongConnectionLeaseConfig = {
  dirPath?: string;
  appId?: string;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  instanceTag?: string;
  isProcessAlive?: (pid: number) => boolean;
  logger?: (message: string, extra?: Record<string, unknown>) => void;
  onLeaseLost?: (error: FeishuLongConnectionLeaseLostError) => void | Promise<void>;
};

export class FeishuLongConnectionLeaseConflictError extends Error {
  readonly leaseDir: string;
  readonly owner?: FeishuLongConnectionLeaseOwner;
  readonly heartbeatAgeMs?: number;
  readonly ownerAlive?: boolean;

  constructor(input: {
    leaseDir: string;
    owner?: FeishuLongConnectionLeaseOwner;
    heartbeatAgeMs?: number;
    ownerAlive?: boolean;
  }) {
    const ownerSummary = input.owner
      ? `PID ${input.owner.pid} (instanceTag=${input.owner.instanceTag}, startedAt=${input.owner.startedAt}, heartbeatAt=${input.owner.heartbeatAt})`
      : 'unknown owner';
    super(`Feishu long connection lease is already held by ${ownerSummary}; leaseDir=${input.leaseDir}`);
    this.name = 'FeishuLongConnectionLeaseConflictError';
    this.leaseDir = input.leaseDir;
    this.owner = input.owner;
    this.heartbeatAgeMs = input.heartbeatAgeMs;
    this.ownerAlive = input.ownerAlive;
  }
}

export class FeishuLongConnectionLeaseLostError extends Error {
  readonly leaseDir: string;
  readonly owner: FeishuLongConnectionLeaseOwner;

  constructor(input: { leaseDir: string; owner: FeishuLongConnectionLeaseOwner; reason: string }) {
    super(`Feishu long connection lease lost: ${input.reason}; leaseDir=${input.leaseDir}`);
    this.name = 'FeishuLongConnectionLeaseLostError';
    this.leaseDir = input.leaseDir;
    this.owner = input.owner;
  }
}

export type FeishuLongConnectionLeaseHandle = {
  getState: () => FeishuLongConnectionLeaseState;
  release: () => void;
};

export type FeishuLongConnectionConfig = {
  url: string;
  serviceId: string;
  deviceId: string;
  pingIntervalMs: number;
  reconnectCount: number;
  reconnectIntervalMs: number;
  reconnectNonceMs: number;
};

export type FeishuWebSocketLike = {
  binaryType?: BinaryType;
  readyState: number;
  addEventListener: (type: string, listener: (event: any) => void) => void;
  removeEventListener?: (type: string, listener: (event: any) => void) => void;
  send: (data: BufferSource) => void;
  close: () => void;
};



type FeishuInboundTextMessage = {
  threadId: string;
  text: string;
  senderOpenId?: string;
  eventId?: string;
  createTime?: number;
  messageId?: string;
  traceId?: string;
  frameMessageId?: string;
  frameSeq?: string;
  frameSum?: string;
  messageType?: string;
  chatId?: string;
};
type FeishuInboundImageMessage = {
  threadId: string;
  imageKey: string;
  messageId?: string;
  createTime?: number;
};

export type FeishuLongConnectionClient = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type FeishuLongConnectionClientConfig = {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  createWebSocket?: (url: string) => FeishuWebSocketLike;
  onTextMessage: (message: FeishuInboundTextMessage) => Promise<void>;
  onImageMessage?: (message: FeishuInboundImageMessage) => Promise<void>;
  onCardAction?: (action: FeishuCardActionEvent) => Promise<void>;
};

export type FeishuLongConnectionRuntimeConfig = {
  appId: string;
  appSecret: string;
  codexCommand: string[];
  takeoverListLimit?: number;
  assistantAppServerEnabled?: boolean;
  codingAppServerEnabled?: boolean;
  allowKnownBadCodexVersion?: boolean;
  goalSummary?: TaskGoalSummaryRuntimeConfig;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  createWebSocket?: (url: string) => FeishuWebSocketLike;
  lease?: FeishuLongConnectionLeaseConfig;
  onLeaseLost?: (error: FeishuLongConnectionLeaseLostError) => void | Promise<void>;
};

export function createFeishuLongConnectionRuntime(config: FeishuLongConnectionRuntimeConfig) {
  const apiClient = createFeishuApiClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl
  });
  const channel = createFeishuChannel(apiClient);
  const defaultModel = extractCodexModelFromCommand(config.codexCommand);
  const goalSummaryGenerator = config.goalSummary
    ? createTaskGoalSummaryGeneratorFromCodexCommand({
        ...config.goalSummary,
        allowKnownBadCodexVersion: config.allowKnownBadCodexVersion
      })
    : undefined;

  let serviceRef: ReturnType<typeof createFeishuService> | null = null;
  const service = createFeishuService({
    channel,
    sessionFactory: (options) =>
      createCodexSession({
        taskId: options.taskId,
        cwd: options.cwd,
        command: config.codexCommand,
        mode: options.mode,
        resumeThreadId: options.resumeThreadId,
        resumeContext: options.resumeContext,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        model: typeof options.model === 'string' ? options.model : undefined,
        allowKnownBadCodexVersion: config.allowKnownBadCodexVersion,
        interruptedByRestart: options.interruptedByRestart,
        developerInstructions: options.developerInstructions,
        baseInstructions: options.baseInstructions,
        personality: options.personality,
        onEvent: (event) => void serviceRef?.handleWorkerEvent(event)
      }),
    assistantSessionFactory: (options) => {
      if (config.assistantAppServerEnabled === false) {
        return createCodexSession({
          taskId: options.taskId,
          cwd: options.cwd,
          command: config.codexCommand,
          structuredFallback: 'disabled',
          mode: options.mode,
          resumeThreadId: options.resumeThreadId,
          resumeContext: options.resumeContext,
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          model: typeof options.model === 'string' ? options.model : undefined,
          allowKnownBadCodexVersion: config.allowKnownBadCodexVersion,
          interruptedByRestart: options.interruptedByRestart,
          developerInstructions: options.developerInstructions,
          baseInstructions: options.baseInstructions,
          personality: options.personality,
          onEvent: (event) => void serviceRef?.handleWorkerEvent(event)
        });
      }
      return createCodexAppSession({
        taskId: options.taskId,
        cwd: options.cwd,
        command: config.codexCommand,
        mode: options.mode,
        resumeThreadId: options.resumeThreadId,
        resumeContext: options.resumeContext,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        model: typeof options.model === 'string' ? options.model : undefined,
        allowKnownBadCodexVersion: config.allowKnownBadCodexVersion,
        interruptedByRestart: options.interruptedByRestart,
        developerInstructions: options.developerInstructions,
        baseInstructions: options.baseInstructions,
        personality: options.personality,
        onEvent: (event) => void serviceRef?.handleWorkerEvent(event)
      });
    },
    codingSessionFactory: (options) => {
      if (config.codingAppServerEnabled === false) {
        return createCodexSession({
          taskId: options.taskId,
          cwd: options.cwd,
          command: config.codexCommand,
          structuredFallback: 'disabled',
          mode: options.mode,
          resumeThreadId: options.resumeThreadId,
          resumeContext: options.resumeContext,
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          model: typeof options.model === 'string' ? options.model : undefined,
          allowKnownBadCodexVersion: config.allowKnownBadCodexVersion,
          interruptedByRestart: options.interruptedByRestart,
          developerInstructions: options.developerInstructions,
          baseInstructions: options.baseInstructions,
          personality: options.personality,
          onEvent: (event) => void serviceRef?.handleWorkerEvent(event)
        });
      }
      return createCodexAppSession({
        taskId: options.taskId,
        cwd: options.cwd,
        command: config.codexCommand,
        mode: options.mode,
        resumeThreadId: options.resumeThreadId,
        resumeContext: options.resumeContext,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        model: typeof options.model === 'string' ? options.model : undefined,
        allowKnownBadCodexVersion: config.allowKnownBadCodexVersion,
        interruptedByRestart: options.interruptedByRestart,
        developerInstructions: options.developerInstructions,
        baseInstructions: options.baseInstructions,
        personality: options.personality,
        onEvent: (event) => void serviceRef?.handleWorkerEvent(event)
      });
    },
    takeoverListLimit: config.takeoverListLimit,
    defaultModel,
    goalSummaryGenerator
  });
  serviceRef = service;

  const client = createFeishuLongConnectionClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
    createWebSocket: config.createWebSocket,
    onTextMessage: (message) => service.handleInboundMessage(message),
    onImageMessage: async (message) => {
      const download = await apiClient.downloadImage({ imageKey: message.imageKey, messageId: message.messageId });
      const imagePath = saveImage({ imageKey: message.imageKey, data: download.data, contentType: download.contentType });
      const receivedAt = normalizeFeishuTimestampMs(message.createTime);
      await service.handleInboundImage({ threadId: message.threadId, imagePath, receivedAt });
    },
    onCardAction: async (action) => {
      await service.handleCardAction(action);
    }
  });

  let lease: FeishuLongConnectionLeaseHandle | null = null;

  return {
    service,
    client,
    async start(): Promise<void> {
      if (lease) {
        return;
      }
      const acquiredLease = acquireFeishuLongConnectionLease({
        ...config.lease,
        appId: config.appId,
        logger: logFeishuDebug,
        onLeaseLost: (error) => {
          if (lease === acquiredLease) {
            lease = null;
          }
          logFeishuDebug('runtime lease stop', { error: error.message });
          void client.stop();
          void config.onLeaseLost?.(error);
        }
      });
      lease = acquiredLease;
      try {
        await client.start();
      } catch (error) {
        lease = null;
        acquiredLease.release();
        throw error;
      }
    },
    async stop(): Promise<void> {
      const activeLease = lease;
      lease = null;
      try {
        await client.stop();
      } finally {
        activeLease?.release();
      }
    }
  };
}

export function createFeishuLongConnectionClient(config: FeishuLongConnectionClientConfig): FeishuLongConnectionClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const createWebSocket = config.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as FeishuWebSocketLike);
  const accumulator = createFrameAccumulator();
  const messageDeduper = createMessageDeduper();

  let socket: FeishuWebSocketLike | null = null;
  let connectionConfig: FeishuLongConnectionConfig | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let unusableCachedReconnectStreak = 0;
  const activeHandlers = new Set<Promise<void>>();

  function clearTimers(): void {
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function trackActiveHandler(handler: Promise<void>): void {
    activeHandlers.add(handler);
    void handler.finally(() => {
      activeHandlers.delete(handler);
    });
  }

  async function waitForActiveHandlersToDrain(): Promise<void> {
    while (activeHandlers.size > 0) {
      await Promise.allSettled(Array.from(activeHandlers));
    }
  }

  function schedulePing(): void {
    if (!connectionConfig || stopped) return;
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      pingTimer = null;
      sendPing();
      schedulePing();
    }, connectionConfig.pingIntervalMs);
  }

  function sendFrame(frame: FeishuFrame): void {
    if (!socket || socket.readyState !== 1) return;
    socket.send(encodeFeishuFrame(frame) as unknown as BufferSource);
  }

  function sendPing(): void {
    if (!connectionConfig) return;
    sendFrame({
      SeqID: 0n,
      LogID: 0n,
      service: Number(connectionConfig.serviceId),
      method: CONTROL_FRAME_TYPE,
      headers: [{ key: 'type', value: 'ping' }]
    });
  }

  function scheduleReconnect(refreshConfig = false): void {
    if (stopped || !connectionConfig) return;
    if (connectionConfig.reconnectCount >= 0 && reconnectAttempts >= connectionConfig.reconnectCount) return;
    if (reconnectTimer) return;

    const delay = connectionConfig.reconnectIntervalMs + Math.floor(connectionConfig.reconnectNonceMs * Math.random());
    logFeishuDebug('ws reconnect scheduled', { attempt: reconnectAttempts + 1, delayMs: delay, refreshConfig });
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopped) return;
      reconnectAttempts += 1;
      try {
        await connect(refreshConfig);
      } catch {
        scheduleReconnect(refreshConfig);
      }
    }, delay);
  }

  function markCachedReconnectUsable(): void {
    unusableCachedReconnectStreak = 0;
  }

  function shouldRefreshConfigAfterSocketLoss(input: {
    usingCachedConfig: boolean;
    openedAt: number;
    sawInboundFrame: boolean;
  }): boolean {
    if (!input.usingCachedConfig) {
      markCachedReconnectUsable();
      return false;
    }
    const livedMs = Math.max(0, Date.now() - input.openedAt);
    const unusable = !input.sawInboundFrame && livedMs <= CACHED_ENDPOINT_UNUSABLE_WINDOW_MS;
    if (!unusable) {
      markCachedReconnectUsable();
      return false;
    }
    unusableCachedReconnectStreak += 1;
    const refreshConfig = unusableCachedReconnectStreak >= CACHED_ENDPOINT_UNUSABLE_STREAK_LIMIT;
    logFeishuDebug('ws cached reconnect closed before usable', {
      livedMs,
      sawInboundFrame: input.sawInboundFrame,
      unusableCachedReconnectStreak,
      refreshConfig
    });
    if (refreshConfig) {
      markCachedReconnectUsable();
    }
    return refreshConfig;
  }

  async function handleControlFrame(frame: FeishuFrame): Promise<void> {
    const headers = feishuFrameHeadersToRecord(frame.headers);
    const type = headers.type;
    if (type !== 'pong' || !frame.payload) return;
    const payload = JSON.parse(textDecoder.decode(frame.payload)) as FeishuClientConfigPayload;
    if (!connectionConfig) return;
    connectionConfig = {
      ...connectionConfig,
      pingIntervalMs: toDurationMs(payload.PingInterval, connectionConfig.pingIntervalMs),
      reconnectCount: payload.ReconnectCount ?? connectionConfig.reconnectCount,
      reconnectIntervalMs: toDurationMs(payload.ReconnectInterval, connectionConfig.reconnectIntervalMs),
      reconnectNonceMs: toDurationMsAllowZero(payload.ReconnectNonce, connectionConfig.reconnectNonceMs)
    };
    schedulePing();
  }

  function buildAckHeaders(headers: Record<string, string>): FeishuFrameHeader[] {
    const ackHeaders: FeishuFrameHeader[] = [{ key: 'type', value: 'ack' }];
    if (headers.message_id) ackHeaders.push({ key: 'message_id', value: headers.message_id });
    if (headers.trace_id) ackHeaders.push({ key: 'trace_id', value: headers.trace_id });
    return ackHeaders;
  }

  async function sendAck(
    frame: FeishuFrame,
    headers: Record<string, string>,
    code: 200 | 500,
    payload?: Record<string, unknown>
  ): Promise<void> {
    logFeishuDebug('event ack', {
      code,
      messageId: headers.message_id,
      traceId: headers.trace_id,
      payload: payload ?? { code }
    });
    sendFrame({
      SeqID: frame.SeqID,
      LogID: frame.LogID,
      service: frame.service,
      method: frame.method,
      headers: buildAckHeaders(headers),
      payload: textEncoder.encode(JSON.stringify(payload ?? { code }))
    });
  }

  async function sendCallbackResponse(frame: FeishuFrame, result?: Record<string, unknown>, durationMs = 0): Promise<void> {
    logFeishuDebug('event callback response', {
      messageId: frame.headers?.find((header) => header.key === 'message_id')?.value,
      traceId: frame.headers?.find((header) => header.key === 'trace_id')?.value,
      durationMs,
      result
    });
    sendFrame({
      SeqID: frame.SeqID,
      LogID: frame.LogID,
      service: frame.service,
      method: frame.method,
      headers: [...(frame.headers ?? []), { key: 'biz_rt', value: String(Math.max(0, durationMs)) }],
      payload: textEncoder.encode(JSON.stringify(buildCallbackResponsePayload(result)))
    });
  }

  async function handleDataFrame(frame: FeishuFrame): Promise<void> {
    const headers = feishuFrameHeadersToRecord(frame.headers);
    if (headers.type !== 'event' || !frame.payload) return;
    const startedAt = Date.now();

    let merged: Uint8Array | null = null;
    try {
      merged = accumulator.push({
        messageId: headers.message_id,
        sum: Number(headers.sum ?? '1'),
        seq: Number(headers.seq ?? '0'),
        traceId: headers.trace_id,
        payload: frame.payload
      });
    } catch {
      await sendAck(frame, headers, 500);
      return;
    }

    if (!merged) return;

    const headerMessageId = headers.message_id?.trim();
    let dedupeId = headerMessageId;
    let ackSent = false;

    try {
      const payloadText = textDecoder.decode(merged);
      dumpFeishuRawEvent(headers, payloadText);
      const payload = JSON.parse(payloadText) as unknown;
      const eventType = extractEventType(payload);
      const meta = extractEventMeta(payload);
      const message = parseFeishuMessageEvent(payload);
      const cardAction = parseFeishuCardActionEvent(payload);
      logFeishuDebug('event received', {
        eventType,
        eventId: meta.eventId,
        createTime: meta.createTime,
        messageId: meta.messageId,
        traceId: headers.trace_id,
        frameMessageId: headers.message_id,
        frameSeq: headers.seq,
        frameSum: headers.sum,
        chatId: meta.chatId,
        messageType: meta.messageType,
        content: (payload as any)?.event?.message?.content,
        cardActionKind: cardAction?.kind,
        cardActionMessageId: cardAction?.messageId
      });
      if (!eventType || (!message && !cardAction)) {
        logFeishuDebug('event sparse payload', {
          eventType,
          eventId: meta.eventId,
          traceId: headers.trace_id,
          frameMessageId: headers.message_id,
          frameSeq: headers.seq,
          frameSum: headers.sum,
          payload: compactFeishuPayload(payload)
        });
      }
      if (!message && !cardAction && eventType?.includes('card.action')) {
        logFeishuDebug('card action parse miss', {
          eventType,
          eventId: meta.eventId,
          traceId: headers.trace_id,
          frameMessageId: headers.message_id,
          payload: compactFeishuPayload(payload)
        });
      }
      if (cardAction && meta.eventId) {
        dedupeId = meta.eventId;
      } else {
        const payloadMessageId = extractPayloadMessageId(payload);
        if (payloadMessageId) {
          dedupeId = payloadMessageId;
        }
      }
      if (dedupeId && messageDeduper.isDuplicate(dedupeId)) {
        logFeishuDebug('event duplicate ignored', {
          eventType,
          dedupeId,
          eventId: meta.eventId,
          traceId: headers.trace_id,
          frameMessageId: headers.message_id,
          cardActionKind: cardAction?.kind
        });
        await sendAck(frame, headers, 200);
        return;
      }
      if (dedupeId) {
        messageDeduper.markInFlight(dedupeId);
      }
      let handlerPromise: Promise<void> | null = null;
      if (message?.kind === 'text') {
        handlerPromise = config.onTextMessage({
          ...message,
          eventId: meta.eventId,
          createTime: meta.createTime,
          messageId: meta.messageId,
          traceId: headers.trace_id,
          frameMessageId: headers.message_id,
          frameSeq: headers.seq,
          frameSum: headers.sum,
          messageType: meta.messageType,
          chatId: meta.chatId
        });
      }
      if (message?.kind === 'image' && config.onImageMessage) {
        handlerPromise = config.onImageMessage({
          threadId: message.threadId,
          imageKey: message.imageKey,
          messageId: meta.messageId,
          createTime: meta.createTime
        });
      }
      if (!handlerPromise && cardAction && config.onCardAction) {
        handlerPromise = config.onCardAction({
          ...cardAction,
          eventId: meta.eventId,
          traceId: headers.trace_id,
          frameMessageId: headers.message_id
        });
      }
      if (cardAction) {
        await sendCallbackResponse(frame, buildCardActionToast(cardAction), Date.now() - startedAt);
        ackSent = true;
      } else {
        await sendAck(frame, headers, 200);
        ackSent = true;
      }
      if (handlerPromise) {
        await handlerPromise;
      }
      if (dedupeId) {
        messageDeduper.markDone(dedupeId);
      }
    } catch {
      if (dedupeId) {
        messageDeduper.markFailed(dedupeId);
      }
      if (!ackSent) {
        await sendAck(frame, headers, 500);
      }
    }
  }

  async function handleSocketMessage(data: unknown): Promise<void> {
    try {
      const bytes = await toUint8Array(data);
      const frame = decodeFeishuFrame(bytes);
      if (frame.method === CONTROL_FRAME_TYPE) {
        await handleControlFrame(frame);
        return;
      }
      if (frame.method === DATA_FRAME_TYPE) {
        await handleDataFrame(frame);
      }
    } catch {
      // ignore decode errors
    }
  }

  async function connect(refreshConfig = false): Promise<void> {
    // Reuse the current endpoint/device on the first reconnect so Feishu does not treat
    // the socket as a brand-new consumer and replay older backlog frames immediately.
    if (refreshConfig) {
      markCachedReconnectUsable();
    }
    const cachedConfig = connectionConfig;
    const usingCachedConfig = !refreshConfig && cachedConfig !== null;
    const nextConfig = usingCachedConfig
      ? cachedConfig
      : await fetchFeishuLongConnectionConfig({
          appId: config.appId,
          appSecret: config.appSecret,
          baseUrl: config.baseUrl,
          fetchImpl
        });
    connectionConfig = nextConfig;
    clearTimers();

    const ws = createWebSocket(nextConfig.url);
    ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        logFeishuDebug('ws open', { url: nextConfig.url, serviceId: nextConfig.serviceId, deviceId: nextConfig.deviceId });
        socket = ws;
        reconnectAttempts = 0;
        if (!usingCachedConfig) {
          markCachedReconnectUsable();
        }
        attachSocketListeners(ws, { usingCachedConfig, openedAt: Date.now() });
        sendPing();
        schedulePing();
        resolve();
      };
      const onError = (event: unknown) => {
        cleanup();
        safeClose(ws);
        if (!stopped) scheduleReconnect(usingCachedConfig);
        reject(event instanceof Error ? event : new Error('Feishu long connection open failed'));
      };
      const cleanup = () => {
        ws.removeEventListener?.('open', onOpen);
        ws.removeEventListener?.('error', onError);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  function attachSocketListeners(
    ws: FeishuWebSocketLike,
    lifecycle: {
      usingCachedConfig: boolean;
      openedAt: number;
    }
  ): void {
    let sawInboundFrame = false;
    let refreshDecision: boolean | null = null;
    const resolveRefreshDecision = (): boolean => {
      if (refreshDecision !== null) return refreshDecision;
      refreshDecision = shouldRefreshConfigAfterSocketLoss({
        usingCachedConfig: lifecycle.usingCachedConfig,
        openedAt: lifecycle.openedAt,
        sawInboundFrame
      });
      return refreshDecision;
    };
    ws.addEventListener('message', (event: { data: unknown }) => {
      if (stopped) {
        return;
      }
      sawInboundFrame = true;
      markCachedReconnectUsable();
      trackActiveHandler(handleSocketMessage(event.data));
    });
    ws.addEventListener('close', () => {
      const refreshConfig = resolveRefreshDecision();
      logFeishuDebug('ws close', { reason: 'close', refreshConfig });
      if (socket === ws) socket = null;
      if (!stopped) scheduleReconnect(refreshConfig);
    });
    ws.addEventListener('error', () => {
      const refreshConfig = resolveRefreshDecision();
      logFeishuDebug('ws error', { reason: 'error', refreshConfig });
      if (socket === ws) socket = null;
      safeClose(ws);
      if (!stopped) scheduleReconnect(refreshConfig);
    });
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      reconnectAttempts = 0;
      try {
        await connect(true);
      } catch (error) {
        if (connectionConfig) {
          scheduleReconnect(true);
          return;
        }
        throw error;
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimers();
      const current = socket;
      socket = null;
      if (current) {
        safeClose(current);
      }
      await waitForActiveHandlersToDrain();
    }
  };
}

export async function fetchFeishuLongConnectionConfig(input: {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<FeishuLongConnectionConfig> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? FEISHU_BASE_URL).replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/callback/ws/endpoint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      locale: 'zh'
    },
    body: JSON.stringify({
      AppID: input.appId,
      AppSecret: input.appSecret
    })
  });
  const payload = await response.json() as {
    code?: number;
    msg?: string;
    data?: {
      URL?: string;
      url?: string;
      ClientConfig?: FeishuClientConfigPayload;
      client_config?: FeishuClientConfigPayload;
    };
  };
  const url = payload.data?.URL ?? payload.data?.url;
  const clientConfig = payload.data?.ClientConfig ?? payload.data?.client_config;
  if (!response.ok || payload.code !== 0 || !url || !clientConfig) {
    throw new Error(`Failed to fetch Feishu long connection config: ${payload.msg ?? response.status}`);
  }

  const parsed = new URL(url);
  const deviceId = parsed.searchParams.get('device_id') ?? '';
  const serviceId = parsed.searchParams.get('service_id') ?? '';
  if (!serviceId) {
    throw new Error('Feishu long connection config is missing service_id');
  }

  return {
    url,
    deviceId,
    serviceId,
    pingIntervalMs: toDurationMs(clientConfig.PingInterval, 120_000),
    reconnectCount: clientConfig.ReconnectCount ?? -1,
    reconnectIntervalMs: toDurationMs(clientConfig.ReconnectInterval, 120_000),
    reconnectNonceMs: toDurationMsAllowZero(clientConfig.ReconnectNonce, 30_000)
  };
}

function safeToNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function normalizeFeishuTimestampMs(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function resolveFeishuDebugLogPath(): string | undefined {
  const explicit = (process.env.COMMUNICATE_FEISHU_DEBUG_LOG_PATH ?? '').trim();
  if (explicit) return explicit;
  const registryPath = (process.env.COMMUNICATE_SESSION_REGISTRY_PATH ?? '').trim();
  if (registryPath) return path.join(path.dirname(registryPath), 'feishu-longconn-debug.log');
  return path.join(process.cwd(), 'logs', 'communicate', 'feishu-longconn-debug.log');
}

function resolveFeishuRawEventDumpPath(): string | undefined {
  const explicit = (process.env.COMMUNICATE_FEISHU_RAW_EVENT_DUMP_PATH ?? '').trim();
  if (explicit) return explicit;
  if (!FEISHU_DEBUG) return undefined;
  const registryPath = (process.env.COMMUNICATE_SESSION_REGISTRY_PATH ?? '').trim();
  if (registryPath) return path.join(path.dirname(registryPath), 'feishu-longconn-raw-events.log');
  return path.join(process.cwd(), 'logs', 'communicate', 'feishu-longconn-raw-events.log');
}

function normalizeFeishuInstanceTag(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractEventType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, any>;
  const raw = record.header?.event_type ?? record.header?.eventType;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractEventMeta(payload: unknown): {
  eventId?: string;
  createTime?: number;
  messageId?: string;
  messageType?: string;
  chatId?: string;
} {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, any>;
  const header = record.header as Record<string, any> | undefined;
  const message = record.event?.message as Record<string, any> | undefined;
  const eventId = typeof header?.event_id === 'string' ? header.event_id : undefined;
  const messageId = typeof message?.message_id === 'string' ? message.message_id : undefined;
  const messageType = typeof message?.message_type === 'string' ? message.message_type : undefined;
  const chatId = typeof message?.chat_id === 'string' ? message.chat_id : undefined;
  const createTime = safeToNumber(message?.create_time);
  return { eventId, createTime, messageId, messageType, chatId };
}
function extractPayloadMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, any>;
  const message = record.event?.message;
  const raw = message?.message_id ?? message?.messageId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function compactFeishuPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, any>;
  const event = record.event;
  const context = event?.context ?? record.context;
  const action = event?.action ?? record.action;
  return {
    rootKeys: Object.keys(record).slice(0, 20),
    header: compactFeishuRecord(record.header),
    eventKeys: event && typeof event === 'object' ? Object.keys(event).slice(0, 20) : undefined,
    context: compactFeishuRecord(context),
    action: compactFeishuRecord(action)
  };
}

function compactFeishuRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 20)) {
    compact[key] = compactFeishuValue(item, depth + 1);
  }
  return compact;
}

function compactFeishuValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (value && typeof value === 'object') {
    if (depth >= 2) {
      return `{keys:${Object.keys(value as Record<string, unknown>).slice(0, 10).join(',')}}`;
    }
    return compactFeishuRecord(value, depth) ?? `{keys:${Object.keys(value as Record<string, unknown>).slice(0, 10).join(',')}}`;
  }
  return value as string | number | boolean | null | undefined;
}

function createMessageDeduper() {
  const inFlight = new Set<string>();
  const recent = new Map<string, number>();

  function trimExpired(now: number): void {
    for (const [key, value] of recent.entries()) {
      if (now - value > MESSAGE_DEDUP_TTL_MS) {
        recent.delete(key);
      }
    }
  }

  return {
    isDuplicate(messageId: string): boolean {
      const now = Date.now();
      trimExpired(now);
      return inFlight.has(messageId) || recent.has(messageId);
    },
    markInFlight(messageId: string): void {
      const now = Date.now();
      trimExpired(now);
      inFlight.add(messageId);
    },
    markDone(messageId: string): void {
      const now = Date.now();
      trimExpired(now);
      inFlight.delete(messageId);
      recent.set(messageId, now);
    },
    markFailed(messageId: string): void {
      inFlight.delete(messageId);
    }
  };
}

function createFrameAccumulator() {
  const cache = new Map<string, { parts: Array<Uint8Array | undefined>; createdAt: number; traceId?: string }>();

  return {
    push(input: { messageId?: string; sum: number; seq: number; traceId?: string; payload: Uint8Array }): Uint8Array | null {
      const messageId = input.messageId?.trim();
      if (!messageId) return input.payload;

      const total = Number.isFinite(input.sum) && input.sum > 0 ? Math.max(1, Math.floor(input.sum)) : 1;
      const index = Number.isFinite(input.seq) ? Math.floor(input.seq) : 0;

      if (total > MAX_FRAME_PARTS) {
        throw new Error(`Too many frame fragments: ${total}`);
      }
      if (index < 0 || index >= total) {
        throw new Error(`Frame fragment index out of range: ${index}`);
      }

      const entry = cache.get(messageId) ?? {
        parts: new Array(total).fill(undefined),
        createdAt: Date.now(),
        traceId: input.traceId
      };
      if (entry.parts.length < total) {
        entry.parts.length = total;
      }
      entry.parts[index] = input.payload;
      cache.set(messageId, entry);

      if (entry.parts.some((part) => !part)) {
        trimExpired(cache);
        return null;
      }

      cache.delete(messageId);
      return merge(entry.parts as Uint8Array[]);
    }
  };
}

function trimExpired(cache: Map<string, { parts: Array<Uint8Array | undefined>; createdAt: number }>): void {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.createdAt > 10_000) {
      cache.delete(key);
    }
  }
}

function merge(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function toDurationMs(seconds: number | undefined, fallbackMs: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.floor(seconds * 1_000);
}
function toDurationMsAllowZero(seconds: number | undefined, fallbackMs: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.floor(seconds * 1_000);
}

async function toUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return textEncoder.encode(data);
  throw new Error('Unsupported Feishu WebSocket message payload');
}

function safeClose(socket: FeishuWebSocketLike): void {
  try {
    socket.close();
  } catch {
    // ignore close errors
  }
}
type ExistingLeaseAnalysis = {
  owner?: FeishuLongConnectionLeaseOwner;
  heartbeatAgeMs?: number;
  alive?: boolean;
  stale: boolean;
  reason: 'active-owner' | 'stale-owner' | 'invalid-state';
};

type FeishuLongConnectionLeaseDirInput = {
  explicitPath?: string;
  appId?: string;
};

export function resolveFeishuLongConnectionLeaseDir(input?: string | FeishuLongConnectionLeaseDirInput): string {
  const explicitPath = typeof input === 'string' ? input : input?.explicitPath;
  if (explicitPath?.trim()) {
    return path.resolve(explicitPath);
  }
  const appId = typeof input === 'string' ? undefined : input?.appId;
  const leaseRoot = resolveFeishuLongConnectionLeaseRootDir();
  const appSegment = normalizeFeishuLeaseAppSegment(appId ?? process.env.FEISHU_APP_ID);
  return path.join(leaseRoot, appSegment);
}

export function acquireFeishuLongConnectionLease(config: FeishuLongConnectionLeaseConfig = {}): FeishuLongConnectionLeaseHandle {
  const now = config.now ?? Date.now;
  const heartbeatIntervalMs = Math.max(500, Math.floor(config.heartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS));
  const staleAfterMs = Math.max(heartbeatIntervalMs * 2, Math.floor(config.staleAfterMs ?? DEFAULT_LEASE_STALE_AFTER_MS));
  const leaseDir = resolveFeishuLongConnectionLeaseDir({
    explicitPath: config.dirPath,
    appId: config.appId
  });
  const ownerId = randomUUID();
  const instanceTag = normalizeFeishuInstanceTag(config.instanceTag ?? process.env.COMMUNICATE_FEISHU_INSTANCE_TAG) ?? `pid-${process.pid}`;
  const startedAt = new Date(now() - Math.max(0, Math.floor(process.uptime() * 1_000))).toISOString();
  const isProcessAlive = config.isProcessAlive ?? defaultIsProcessAlive;
  const ownerFilePath = path.join(leaseDir, FEISHU_LEASE_OWNER_FILE);
  const heartbeatFilePath = buildFeishuLeaseHeartbeatFilePath(leaseDir, ownerId);
  let released = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let state = buildLeaseState({
    ownerId,
    pid: process.pid,
    instanceTag,
    startedAt,
    heartbeatAt: new Date(now()).toISOString()
  });

  mkdirSync(path.dirname(leaseDir), { recursive: true });

  while (true) {
    try {
      mkdirSync(leaseDir);
      writeLeaseState(ownerFilePath, state);
      writeLeaseState(heartbeatFilePath, state);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      const analysis = analyzeExistingLease({
        leaseDir,
        staleAfterMs,
        now,
        isProcessAlive
      });
      if (!analysis.stale) {
        throw new FeishuLongConnectionLeaseConflictError({
          leaseDir,
          owner: analysis.owner,
          heartbeatAgeMs: analysis.heartbeatAgeMs,
          ownerAlive: analysis.alive
        });
      }
      config.logger?.('single-instance stale lease takeover', {
        leaseDir,
        reason: analysis.reason,
        owner: analysis.owner,
        heartbeatAgeMs: analysis.heartbeatAgeMs,
        ownerAlive: analysis.alive
      });

      const backupDir = `${leaseDir}.stale.${now()}.${process.pid}.${ownerId}`;
      try {
        renameSync(leaseDir, backupDir);
      } catch (renameError) {
        if (isMissingError(renameError) || isAlreadyExistsError(renameError)) {
          continue;
        }
        throw renameError;
      }
      rmSync(backupDir, { recursive: true, force: true });
    }
  }

  heartbeatTimer = setInterval(() => {
    if (released) {
      return;
    }
    try {
      state = touchLease({
        ownerFilePath,
        heartbeatFilePath,
        leaseDir,
        state,
        now
      });
    } catch (error) {
      const leaseError = error instanceof FeishuLongConnectionLeaseLostError
        ? error
        : new FeishuLongConnectionLeaseLostError({
            leaseDir,
            owner: state.owner,
            reason: error instanceof Error ? error.message : String(error)
          });
      released = true;
      clearLeaseTimer(heartbeatTimer);
      heartbeatTimer = null;
      config.logger?.('single-instance lease lost', {
        leaseDir,
        owner: state.owner,
        error: leaseError.message
      });
      void config.onLeaseLost?.(leaseError);
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return {
    getState(): FeishuLongConnectionLeaseState {
      return state;
    },
    release(): void {
      if (released) {
        return;
      }
      clearLeaseTimer(heartbeatTimer);
      heartbeatTimer = null;
      released = true;
      releaseLease(heartbeatFilePath);
    }
  };
}

function buildLeaseState(owner: FeishuLongConnectionLeaseOwner): FeishuLongConnectionLeaseState {
  return {
    version: FEISHU_LEASE_VERSION,
    kind: FEISHU_LEASE_KIND,
    owner
  };
}

function touchLease(input: {
  ownerFilePath: string;
  heartbeatFilePath: string;
  leaseDir: string;
  state: FeishuLongConnectionLeaseState;
  now: () => number;
}): FeishuLongConnectionLeaseState {
  const current = readLeaseState(input.ownerFilePath);
  if (!current || current.owner.ownerId !== input.state.owner.ownerId) {
    throw new FeishuLongConnectionLeaseLostError({
      leaseDir: input.leaseDir,
      owner: input.state.owner,
      reason: current ? 'owner changed' : 'lease disappeared'
    });
  }
  const nextState = buildLeaseState({
    ...input.state.owner,
    heartbeatAt: new Date(input.now()).toISOString()
  });
  writeLeaseState(input.heartbeatFilePath, nextState);
  const confirmed = readLeaseState(input.ownerFilePath);
  if (!confirmed || confirmed.owner.ownerId !== input.state.owner.ownerId) {
    rmSync(input.heartbeatFilePath, { force: true });
    throw new FeishuLongConnectionLeaseLostError({
      leaseDir: input.leaseDir,
      owner: input.state.owner,
      reason: confirmed ? 'owner changed' : 'lease disappeared'
    });
  }
  return nextState;
}

function releaseLease(heartbeatFilePath: string): void {
  rmSync(heartbeatFilePath, { force: true });
}

function analyzeExistingLease(input: {
  leaseDir: string;
  staleAfterMs: number;
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
}): ExistingLeaseAnalysis {
  const ownerSnapshot = readLeaseState(path.join(input.leaseDir, FEISHU_LEASE_OWNER_FILE));
  if (!ownerSnapshot) {
    return {
      stale: true,
      reason: 'invalid-state'
    };
  }
  const heartbeatState = readLeaseState(buildFeishuLeaseHeartbeatFilePath(input.leaseDir, ownerSnapshot.owner.ownerId));
  const owner = heartbeatState?.owner.ownerId === ownerSnapshot.owner.ownerId
    ? {
        ...ownerSnapshot.owner,
        heartbeatAt: heartbeatState.owner.heartbeatAt
      }
    : ownerSnapshot.owner;
  const heartbeatAtMs = heartbeatState ? Date.parse(owner.heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatAtMs) ? Math.max(0, input.now() - heartbeatAtMs) : undefined;
  const alive = input.isProcessAlive(ownerSnapshot.owner.pid);
  const stale = !alive || heartbeatAgeMs === undefined || heartbeatAgeMs > input.staleAfterMs;
  return {
    owner,
    heartbeatAgeMs,
    alive,
    stale,
    reason: stale ? 'stale-owner' : 'active-owner'
  };
}

function resolveFeishuLongConnectionLeaseRootDir(): string {
  const explicitRoot = (process.env.COMMUNICATE_FEISHU_LEASE_DIR ?? '').trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  const appDataRoot = (process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '').trim();
  if (appDataRoot) {
    return path.join(appDataRoot, 'CodexLark', 'communicate', 'feishu-longconn');
  }
  return path.join(os.homedir(), '.codexlark', 'communicate', 'feishu-longconn');
}

function normalizeFeishuLeaseAppSegment(appId: string | undefined): string {
  const trimmed = (appId ?? '').trim();
  if (!trimmed) {
    return 'app-default';
  }
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_\.]+/, '')
    .replace(/[_\.]+$/, '');
  return normalized ? `app-${normalized}` : 'app-default';
}

function buildFeishuLeaseHeartbeatFilePath(leaseDir: string, ownerId: string): string {
  return path.join(leaseDir, `${FEISHU_LEASE_HEARTBEAT_FILE_PREFIX}${ownerId}.json`);
}

function readLeaseState(ownerFilePath: string): FeishuLongConnectionLeaseState | undefined {
  try {
    const raw = JSON.parse(readFileSync(ownerFilePath, 'utf8')) as Partial<FeishuLongConnectionLeaseState>;
    if (raw?.kind !== FEISHU_LEASE_KIND || raw?.version !== FEISHU_LEASE_VERSION || !raw.owner) {
      return undefined;
    }
    const owner = raw.owner as Partial<FeishuLongConnectionLeaseOwner>;
    if (
      typeof owner.ownerId !== 'string' ||
      typeof owner.instanceTag !== 'string' ||
      typeof owner.startedAt !== 'string' ||
      typeof owner.heartbeatAt !== 'string' ||
      typeof owner.pid !== 'number' ||
      !Number.isFinite(owner.pid)
    ) {
      return undefined;
    }
    return buildLeaseState({
      ownerId: owner.ownerId,
      pid: Math.floor(owner.pid),
      instanceTag: owner.instanceTag,
      startedAt: owner.startedAt,
      heartbeatAt: owner.heartbeatAt
    });
  } catch {
    return undefined;
  }
}

function writeLeaseState(ownerFilePath: string, state: FeishuLongConnectionLeaseState): void {
  writeFileSync(ownerFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function clearLeaseTimer(timer: NodeJS.Timeout | null): void {
  if (timer) {
    clearInterval(timer);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

