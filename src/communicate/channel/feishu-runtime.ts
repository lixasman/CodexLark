import { createCodexSession } from '../workers/codex/session';
import { createCodexAppSession } from '../workers/codex/app-session';
import { createSessionRegistry } from '../storage/session-registry';
import { createFeishuApiClient } from './feishu-api';
import {
  acquireFeishuLongConnectionLease,
  createFeishuLongConnectionClient,
  type FeishuLongConnectionLeaseHandle,
  type FeishuLongConnectionRuntimeConfig
} from './feishu-longconn';
import { saveImage } from './feishu-image-store';
import { createFeishuChannel } from './feishu-message';
import { createFeishuService } from './feishu-service';
import { createTaskGoalSummaryGeneratorFromCodexCommand } from '../summary/task-goal-summary';
import { extractCodexModelFromCommand } from '../control/codex-model';

const MESSAGE_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_STALE_TEXT_GRACE_MS = 30 * 60 * 1000;
const FEISHU_DEBUG = process.env.COMMUNICATE_FEISHU_DEBUG === '1';

function logFeishuDebug(message: string, extra?: Record<string, unknown>): void {
  if (!FEISHU_DEBUG) return;
  if (extra) {
    try {
      console.log(`[feishu-runtime] ${message} ${JSON.stringify(extra)}`);
      return;
    } catch {
      console.log(`[feishu-runtime] ${message}`);
      return;
    }
  }
  console.log(`[feishu-runtime] ${message}`);
}

function normalizeFeishuTimestampMs(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function isStartupStaleText(input: {
  incomingCreateTimeMs?: number;
  lastAcceptedTextCreateTimeMs?: number;
  runtimeStartedAtMs?: number;
}): boolean {
  if (
    input.incomingCreateTimeMs === undefined
    || input.lastAcceptedTextCreateTimeMs === undefined
    || input.runtimeStartedAtMs === undefined
  ) {
    return false;
  }
  return (
    input.incomingCreateTimeMs < input.lastAcceptedTextCreateTimeMs &&
    input.incomingCreateTimeMs < input.runtimeStartedAtMs - STARTUP_STALE_TEXT_GRACE_MS
  );
}

type PersistentFeishuInboundDeduper = {
  isDuplicate: (messageId: string) => boolean;
  getSeenAt: (messageId: string) => number | undefined;
  markDone: (messageId: string) => void;
  claim: (messageId: string) => PersistentFeishuInboundClaimResult;
};

type PersistentFeishuInboundClaimResult =
  | {
      kind: 'claimed';
      claimedAt: number;
      complete: () => void;
      release: () => void;
    }
  | {
      kind: 'duplicate';
      source: 'recent' | 'in-flight';
      seenAt?: number;
      claimedAt?: number;
    };

function trimFeishuDedupeId(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveFeishuInboundDedupeId(input: {
  messageId?: string;
  eventId?: string;
  frameMessageId?: string;
}): string | undefined {
  return trimFeishuDedupeId(input.messageId)
    ?? trimFeishuDedupeId(input.eventId)
    ?? trimFeishuDedupeId(input.frameMessageId);
}

function resolveFeishuCardActionDedupeId(input: {
  eventId?: string;
  frameMessageId?: string;
}): string | undefined {
  return trimFeishuDedupeId(input.eventId)
    ?? trimFeishuDedupeId(input.frameMessageId);
}

export function createPersistentFeishuInboundDeduper(
  sessionRegistry: ReturnType<typeof createSessionRegistry>
): PersistentFeishuInboundDeduper {
  const recent = new Map<string, number>();
  const inFlight = new Map<string, { claimedAt: number; token: number }>();
  let nextClaimToken = 1;
  for (const [messageId, seenAt] of Object.entries(sessionRegistry.getInboundMessages())) {
    if (!messageId.trim() || typeof seenAt !== 'number' || !Number.isFinite(seenAt) || seenAt < 0) {
      continue;
    }
    recent.set(messageId, Math.floor(seenAt));
  }

  function trimExpired(now: number, persistToRegistry = true): void {
    const cutoff = now - MESSAGE_DEDUP_TTL_MS;
    for (const [messageId, seenAt] of recent.entries()) {
      if (seenAt < cutoff) {
        recent.delete(messageId);
      }
    }
    if (persistToRegistry) {
      sessionRegistry.pruneInboundMessages(cutoff);
    }
  }

  return {
    isDuplicate(messageId: string): boolean {
      const now = Date.now();
      trimExpired(now, false);
      return recent.has(messageId) || inFlight.has(messageId);
    },
    getSeenAt(messageId: string): number | undefined {
      const now = Date.now();
      trimExpired(now, false);
      return recent.get(messageId);
    },
    markDone(messageId: string): void {
      const now = Date.now();
      trimExpired(now);
      recent.set(messageId, now);
      inFlight.delete(messageId);
      sessionRegistry.markInboundMessage(messageId, now);
    },
    claim(messageId: string): PersistentFeishuInboundClaimResult {
      const now = Date.now();
      trimExpired(now, false);
      const seenAt = recent.get(messageId);
      if (seenAt !== undefined) {
        return {
          kind: 'duplicate',
          source: 'recent',
          seenAt
        };
      }
      const inFlightClaim = inFlight.get(messageId);
      if (inFlightClaim) {
        return {
          kind: 'duplicate',
          source: 'in-flight',
          claimedAt: inFlightClaim.claimedAt
        };
      }

      const token = nextClaimToken++;
      inFlight.set(messageId, {
        claimedAt: now,
        token
      });
      let finished = false;

      return {
        kind: 'claimed',
        claimedAt: now,
        complete(): void {
          if (finished) return;
          finished = true;
          const activeClaim = inFlight.get(messageId);
          if (!activeClaim || activeClaim.token !== token) {
            return;
          }
          inFlight.delete(messageId);
          const seenNow = Date.now();
          trimExpired(seenNow);
          recent.set(messageId, seenNow);
          sessionRegistry.markInboundMessage(messageId, seenNow);
        },
        release(): void {
          if (finished) return;
          finished = true;
          const activeClaim = inFlight.get(messageId);
          if (activeClaim?.token === token) {
            inFlight.delete(messageId);
          }
        }
      };
    }
  };
}

export function createFeishuLongConnectionRuntime(config: FeishuLongConnectionRuntimeConfig) {
  const apiClient = createFeishuApiClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl
  });
  const channel = createFeishuChannel(apiClient);
  const sessionRegistry = createSessionRegistry();
  const inboundDeduper = createPersistentFeishuInboundDeduper(sessionRegistry);
  const defaultModel = extractCodexModelFromCommand(config.codexCommand);
  const goalSummaryGenerator = config.goalSummary
    ? createTaskGoalSummaryGeneratorFromCodexCommand({
        ...config.goalSummary,
        allowKnownBadCodexVersion: config.allowKnownBadCodexVersion
      })
    : undefined;

  function getLastAcceptedTextCreateTimeMs(threadId: string): number | undefined {
    return sessionRegistry.getThreadUiState(threadId)?.lastAcceptedTextCreateTimeMs;
  }

  const startupTextWatermarkByThreadId = new Map<string, number | undefined>();
  function getStartupTextWatermarkMs(threadId: string, currentWatermarkMs: number | undefined): number | undefined {
    if (!startupTextWatermarkByThreadId.has(threadId)) {
      // Freeze the restart baseline so out-of-order startup replays do not chase newer messages.
      startupTextWatermarkByThreadId.set(threadId, currentWatermarkMs);
    }
    return startupTextWatermarkByThreadId.get(threadId);
  }

  function markAcceptedTextCreateTimeMs(threadId: string, createTimeMs: number): void {
    const current = sessionRegistry.getThreadUiState(threadId);
    const nextCreateTimeMs = Math.max(current?.lastAcceptedTextCreateTimeMs ?? 0, createTimeMs);
    if (current?.lastAcceptedTextCreateTimeMs === nextCreateTimeMs) return;
    sessionRegistry.upsertThreadUiState({
      feishuThreadId: threadId,
      displayMode: current?.displayMode ?? 'assistant',
      lastAcceptedTextCreateTimeMs: nextCreateTimeMs
    });
  }

  let serviceRef: ReturnType<typeof createFeishuService> | null = null;
  const service = createFeishuService({
    channel,
    sessionRegistry,
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
    onTextMessage: async (message) => {
      const dedupeId = resolveFeishuInboundDedupeId(message);
      const dedupeClaim = dedupeId ? inboundDeduper.claim(dedupeId) : undefined;
      const claimed = dedupeClaim?.kind === 'claimed' ? dedupeClaim : undefined;
      const incomingCreateTimeMs = normalizeFeishuTimestampMs(message.createTime);
      if (dedupeClaim?.kind === 'duplicate') {
        service.rememberInboundDeliveryTarget({
          threadId: message.threadId,
          senderOpenId: message.senderOpenId
        });
        logFeishuDebug('inbound dedupe duplicate', {
          kind: 'text',
          threadId: message.threadId,
          eventId: message.eventId,
          messageId: message.messageId,
          frameMessageId: message.frameMessageId,
          traceId: message.traceId,
          createTime: message.createTime,
          dedupeId,
          duplicateHit: true,
          seenAt: dedupeClaim.seenAt,
          claimSource: dedupeClaim.source,
          claimedAt: dedupeClaim.claimedAt
        });
        return;
      }
      try {
        const lastAcceptedTextCreateTimeMs = getLastAcceptedTextCreateTimeMs(message.threadId);
        const startupTextWatermarkMs = getStartupTextWatermarkMs(message.threadId, lastAcceptedTextCreateTimeMs);
        const startupStaleCutoffMs =
          runtimeStartedAtMs !== undefined
            ? runtimeStartedAtMs - STARTUP_STALE_TEXT_GRACE_MS
            : undefined;
        if (isStartupStaleText({
          incomingCreateTimeMs,
          lastAcceptedTextCreateTimeMs: startupTextWatermarkMs,
          runtimeStartedAtMs
        })) {
          logFeishuDebug('inbound startup stale ignored', {
            kind: 'text',
            threadId: message.threadId,
            eventId: message.eventId,
            messageId: message.messageId,
            frameMessageId: message.frameMessageId,
            traceId: message.traceId,
            createTime: message.createTime,
            incomingCreateTimeMs,
            lastAcceptedTextCreateTimeMs: startupTextWatermarkMs,
            currentLastAcceptedTextCreateTimeMs: lastAcceptedTextCreateTimeMs,
            runtimeStartedAtMs,
            startupStaleCutoffMs,
            dedupeId
          });
          claimed?.complete();
          return;
        }
        // Compare against the restart baseline only; moving watermarks can drop delayed messages.
        const staleWatermarkMs = startupTextWatermarkMs;
        if (
          incomingCreateTimeMs !== undefined &&
          staleWatermarkMs !== undefined &&
          incomingCreateTimeMs < staleWatermarkMs
        ) {
          logFeishuDebug('inbound stale ignored', {
            kind: 'text',
            threadId: message.threadId,
            eventId: message.eventId,
            messageId: message.messageId,
            frameMessageId: message.frameMessageId,
            traceId: message.traceId,
            createTime: message.createTime,
            incomingCreateTimeMs,
            lastAcceptedTextCreateTimeMs: staleWatermarkMs,
            currentLastAcceptedTextCreateTimeMs: lastAcceptedTextCreateTimeMs,
            dedupeId
          });
          claimed?.release();
          return;
        }
        logFeishuDebug('inbound dedupe accept', {
          kind: 'text',
          threadId: message.threadId,
          eventId: message.eventId,
          messageId: message.messageId,
          frameMessageId: message.frameMessageId,
          traceId: message.traceId,
          createTime: message.createTime,
          dedupeId,
          duplicateHit: false,
          claimSource: claimed ? 'claimed' : undefined,
          claimedAt: claimed?.claimedAt
        });
        await service.handleInboundMessage(message);
        if (incomingCreateTimeMs !== undefined) {
          markAcceptedTextCreateTimeMs(message.threadId, incomingCreateTimeMs);
        }
        claimed?.complete();
      } catch (error) {
        claimed?.release();
        throw error;
      }
    },
    onImageMessage: async (message) => {
      const dedupeId = resolveFeishuInboundDedupeId({ messageId: message.messageId });
      const dedupeClaim = dedupeId ? inboundDeduper.claim(dedupeId) : undefined;
      const claimed = dedupeClaim?.kind === 'claimed' ? dedupeClaim : undefined;
      if (dedupeClaim?.kind === 'duplicate') {
        service.rememberInboundDeliveryTarget({ threadId: message.threadId });
        logFeishuDebug('inbound dedupe duplicate', {
          kind: 'image',
          threadId: message.threadId,
          messageId: message.messageId,
          createTime: message.createTime,
          dedupeId,
          duplicateHit: true,
          seenAt: dedupeClaim.seenAt,
          claimSource: dedupeClaim.source,
          claimedAt: dedupeClaim.claimedAt
        });
        return;
      }
      try {
        logFeishuDebug('inbound dedupe accept', {
          kind: 'image',
          threadId: message.threadId,
          messageId: message.messageId,
          createTime: message.createTime,
          dedupeId,
          duplicateHit: false,
          claimSource: claimed ? 'claimed' : undefined,
          claimedAt: claimed?.claimedAt
        });
        const download = await apiClient.downloadImage({ imageKey: message.imageKey, messageId: message.messageId });
        const imagePath = saveImage({ imageKey: message.imageKey, data: download.data, contentType: download.contentType });
        const receivedAt = normalizeFeishuTimestampMs(message.createTime);
        await service.handleInboundImage({ threadId: message.threadId, imagePath, receivedAt });
        claimed?.complete();
      } catch (error) {
        claimed?.release();
        throw error;
      }
    },
    onCardAction: async (action) => {
      const dedupeId = resolveFeishuCardActionDedupeId(action);
      const dedupeClaim = dedupeId ? inboundDeduper.claim(dedupeId) : undefined;
      const claimed = dedupeClaim?.kind === 'claimed' ? dedupeClaim : undefined;
      if (dedupeClaim?.kind === 'duplicate') {
        logFeishuDebug('inbound dedupe duplicate', {
          kind: 'card_action',
          threadId: action.threadId,
          messageId: action.messageId,
          eventId: action.eventId,
          frameMessageId: action.frameMessageId,
          traceId: action.traceId,
          cardActionKind: action.kind,
          dedupeId,
          duplicateHit: true,
          seenAt: dedupeClaim.seenAt,
          claimSource: dedupeClaim.source,
          claimedAt: dedupeClaim.claimedAt
        });
        return;
      }
      try {
        logFeishuDebug('inbound dedupe accept', {
          kind: 'card_action',
          threadId: action.threadId,
          messageId: action.messageId,
          eventId: action.eventId,
          frameMessageId: action.frameMessageId,
          traceId: action.traceId,
          cardActionKind: action.kind,
          dedupeId,
          duplicateHit: false,
          claimSource: claimed ? 'claimed' : undefined,
          claimedAt: claimed?.claimedAt
        });
        await service.handleCardAction(action);
        claimed?.complete();
      } catch (error) {
        claimed?.release();
        throw error;
      }
    }
  });

  let lease: FeishuLongConnectionLeaseHandle | null = null;
  let runtimeStartedAtMs: number | undefined;

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
          runtimeStartedAtMs = undefined;
          startupTextWatermarkByThreadId.clear();
          logFeishuDebug('runtime lease stop', { error: error.message });
          void client.stop();
          void config.onLeaseLost?.(error);
        }
      });
      lease = acquiredLease;
      startupTextWatermarkByThreadId.clear();
      runtimeStartedAtMs = Date.now();
      try {
        await client.start();
      } catch (error) {
        lease = null;
        runtimeStartedAtMs = undefined;
        startupTextWatermarkByThreadId.clear();
        acquiredLease.release();
        throw error;
      }
      try {
        await service.syncStartupCardForLastActiveThread();
      } catch (error) {
        logFeishuDebug('startup launcher sync failed', {
          error: String(error)
        });
      }
    },
    async stop(): Promise<void> {
      const activeLease = lease;
      lease = null;
      runtimeStartedAtMs = undefined;
      startupTextWatermarkByThreadId.clear();
      try {
        await client.stop();
      } finally {
        activeLease?.release();
      }
    }
  };
}

export type { FeishuLongConnectionRuntimeConfig };

