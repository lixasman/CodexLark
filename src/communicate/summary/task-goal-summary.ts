import { createCodexAppSession } from '../workers/codex/app-session';
import { type CodexReplyPayload, type CodexWorkerEvent } from '../workers/codex/types';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type LlmClient = {
  complete: (req: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
  }) => Promise<{
    id: string;
    choices: Array<{
      index: number;
      message: { role: 'assistant'; content: string };
    }>;
  }>;
};

export type TaskGoalSummaryGenerator = {
  summarize: (input: { sourceText: string; cwd?: string }) => Promise<string | undefined>;
};

export type TaskGoalSummarySession = {
  start: () => void;
  sendReply: (reply: CodexReplyPayload) => void;
  close?: () => Promise<{ forced: boolean }> | { forced: boolean };
  getSnapshot?: () => {
    lifecycle: string;
    liveBuffer: string;
    checkpointOutput?: string;
  };
};

export type TaskGoalSummarySessionFactoryInput = {
  taskId: string;
  cwd: string;
  command: string[];
  approvalPolicy: string;
  sandbox: string;
  ephemeral?: boolean;
  allowKnownBadCodexVersion?: boolean;
  developerInstructions: string;
  baseInstructions: string;
  enableLogWindow: boolean;
  onEvent: (event: TaskGoalSummarySessionEvent) => void;
};

export type TaskGoalSummaryRuntimeConfig = {
  codexCommand: string[];
  timeoutMs: number;
  allowKnownBadCodexVersion?: boolean;
  sessionFactory?: (input: TaskGoalSummarySessionFactoryInput) => TaskGoalSummarySession;
};

type CreateTaskGoalSummaryGeneratorInput = {
  client: LlmClient;
  model: string;
  timeoutMs: number;
};

type TaskGoalSummarySessionEvent = Extract<
  CodexWorkerEvent,
  { type: 'task_finished' | 'task_failed' | 'task_waiting_user' }
>;

type PendingSummaryRequest = {
  generation: number;
  resolve: (value: string | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const SYSTEM_PROMPT = [
  '你负责把用户最初的任务意图压缩成一句简体中文短摘要。',
  '摘要语义必须是“这个任务最初要做什么”，不是最近进展。',
  '不要输出路径、状态、失败原因、等待提示、数字选项。',
  '不要发明原文没有的新需求。',
  '只输出一句简体中文短摘要，不要输出解释，不要加项目符号。'
].join('\n');

const SUMMARY_SESSION_TASK_ID = 'goal-summary';
const SUMMARY_SESSION_APPROVAL_POLICY = 'never';
const SUMMARY_SESSION_SANDBOX = 'read-only';
const SUMMARY_SESSION_BASE_INSTRUCTIONS = '默认使用简体中文回答，只输出一句简体中文短摘要。';
const SUMMARY_SESSION_DEVELOPER_INSTRUCTIONS = [
  '你是任务目标摘要助手。',
  '你负责把用户最初的任务意图压缩成一句简体中文短摘要。',
  '每次只根据当前这轮提供的原始任务描述作答，忽略此前会话内容。',
  '不要调用工具，不要读取文件，不要依赖工作区内容。',
  '摘要语义必须是“这个任务最初要做什么”，不是最近进展。',
  '不要输出路径、状态、失败原因、等待提示、数字选项。',
  '不要发明原文没有的新需求。',
  '只输出一句简体中文短摘要，不要输出解释，不要加项目符号。'
].join('\n');

export function createTaskGoalSummaryGenerator(
  input: CreateTaskGoalSummaryGeneratorInput
): TaskGoalSummaryGenerator {
  return {
    async summarize({ sourceText }) {
      const trimmed = sourceText.trim();
      if (!trimmed) return undefined;

      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: trimmed }
      ];

      try {
        const response = await withTimeout(
          input.client.complete({
            model: input.model,
            messages,
            temperature: 0,
            max_tokens: 80
          }),
          input.timeoutMs
        );
        const content = response.choices[0]?.message?.content ?? '';
        return normalizeGoalSummary(content);
      } catch {
        return undefined;
      }
    }
  };
}

export function createTaskGoalSummaryGeneratorFromCodexCommand(
  input: TaskGoalSummaryRuntimeConfig
): TaskGoalSummaryGenerator {
  const sessionFactory =
    input.sessionFactory ??
    ((options: TaskGoalSummarySessionFactoryInput) =>
      createCodexAppSession({
        taskId: options.taskId,
        cwd: options.cwd,
        command: options.command,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        ephemeral: options.ephemeral,
        allowKnownBadCodexVersion: options.allowKnownBadCodexVersion,
        developerInstructions: options.developerInstructions,
        baseInstructions: options.baseInstructions,
        enableLogWindow: options.enableLogWindow,
        onEvent: options.onEvent
      }));

  let queuedSummary: Promise<void> = Promise.resolve();
  let sessionState:
    | {
        generation: number;
        session: TaskGoalSummarySession;
      }
    | null = null;
  let pendingRequest: PendingSummaryRequest | null = null;
  let nextGeneration = 1;

  async function resetSession(generation?: number): Promise<void> {
    const current = sessionState;
    if (!current) return;
    if (generation != null && current.generation !== generation) return;
    sessionState = null;
    try {
      await current.session.close?.();
    } catch {
      // Best effort cleanup only.
    }
  }

  function settlePendingRequest(generation: number, value: string | undefined): void {
    const current = pendingRequest;
    if (!current || current.generation !== generation) return;
    pendingRequest = null;
    if (current.timer) clearTimeout(current.timer);
    void resetSession(generation).finally(() => {
      current.resolve(value);
    });
  }

  function handleSessionEvent(generation: number, event: TaskGoalSummarySessionEvent): void {
    if (event.type === 'task_finished') {
      settlePendingRequest(generation, normalizeGoalSummary(event.output));
      return;
    }

    settlePendingRequest(generation, undefined);
  }

  function createSession(cwd: string): {
    generation: number;
    session: TaskGoalSummarySession;
  } {
    const generation = nextGeneration++;
    const session = sessionFactory({
      taskId: SUMMARY_SESSION_TASK_ID,
      cwd,
      command: [...input.codexCommand],
      approvalPolicy: SUMMARY_SESSION_APPROVAL_POLICY,
      sandbox: SUMMARY_SESSION_SANDBOX,
      ephemeral: true,
      allowKnownBadCodexVersion: input.allowKnownBadCodexVersion,
      developerInstructions: SUMMARY_SESSION_DEVELOPER_INSTRUCTIONS,
      baseInstructions: SUMMARY_SESSION_BASE_INSTRUCTIONS,
      enableLogWindow: false,
      onEvent: (event) => handleSessionEvent(generation, event)
    });
    sessionState = { generation, session };
    session.start();
    return sessionState;
  }

  async function summarizeViaSession(sourceText: string, cwd: string): Promise<string | undefined> {
    try {
      await resetSession();
      const { generation, session } = createSession(cwd);
      return await new Promise<string | undefined>((resolve) => {
        const timer =
          Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
            ? setTimeout(() => {
                settlePendingRequest(generation, undefined);
              }, input.timeoutMs)
            : undefined;

        pendingRequest = { generation, resolve, timer };
        try {
          session.sendReply({
            action: 'free_text',
            text: buildCodexGoalSummaryPrompt(sourceText)
          });
        } catch {
          settlePendingRequest(generation, undefined);
        }
      });
    } catch {
      await resetSession();
      return undefined;
    }
  }

  return {
    async summarize({ sourceText, cwd }) {
      const trimmed = sourceText.trim();
      if (!trimmed) return undefined;

      const executionCwd = cwd?.trim() || process.cwd();
      const run = async () => summarizeViaSession(trimmed, executionCwd);
      const next = queuedSummary.then(run, run);
      queuedSummary = next.then(
        () => undefined,
        () => undefined
      );
      return await next;
    }
  };
}
function buildCodexGoalSummaryPrompt(sourceText: string): string {
  return [
    '只根据本轮给出的原始任务描述生成摘要，忽略之前所有任务内容。',
    '摘要语义必须是“这个任务最初要做什么”，不是最近进展。',
    '不要输出路径、状态、失败原因、等待提示、数字选项。',
    '不要发明原文没有的新需求。',
    '只输出一句简体中文短摘要，不要输出解释，不要加项目符号。',
    '',
    '原始任务描述：',
    sourceText
  ].join('\n');
}

function normalizeGoalSummary(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^(?:[-*]\s+|\d+[.)、]\s+)/, '');
    if (!line) continue;
    return line;
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`task goal summary timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

