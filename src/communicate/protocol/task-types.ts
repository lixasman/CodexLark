import { normalizeWaitKind, type CommunicateWaitKind } from './wait-kinds';

export const COMMUNICATE_TASK_INTENTS = ['start_task', 'reply_task', 'query_task', 'cancel_task', 'resume_task', 'takeover_local_codex'] as const;
export type CommunicateTaskIntent = (typeof COMMUNICATE_TASK_INTENTS)[number];

export const COMMUNICATE_TASK_TYPES = ['codex_session', 'chat_reply'] as const;
export type CommunicateTaskType = (typeof COMMUNICATE_TASK_TYPES)[number];

export const COMMUNICATE_TASK_LIFECYCLES = [
  'CREATED',
  'ROUTING',
  'RUNNING',
  'WAITING_USER',
  'RESUMING',
  'FINISHED',
  'FAILED',
  'CANCELLED',
  'STARTING',
  'IDLE',
  'RUNNING_TURN',
  'CLOSING',
  'CLOSED'
] as const;
export type CommunicateTaskLifecycle = (typeof COMMUNICATE_TASK_LIFECYCLES)[number];

export const NORMALIZED_CODEX_SESSION_LIFECYCLES = [
  'STARTING',
  'IDLE',
  'RUNNING_TURN',
  'WAITING_USER',
  'CLOSING',
  'CLOSED',
  'FAILED'
] as const;
export type NormalizedCodexSessionLifecycle = (typeof NORMALIZED_CODEX_SESSION_LIFECYCLES)[number];

export const COMMUNICATE_SESSION_KINDS = ['coding', 'assistant'] as const;
export type CommunicateSessionKind = (typeof COMMUNICATE_SESSION_KINDS)[number];

export const COMMUNICATE_SESSION_STARTUP_MODES = ['new', 'resume'] as const;
export type CommunicateSessionStartupMode = (typeof COMMUNICATE_SESSION_STARTUP_MODES)[number];

export const COMMUNICATE_ASSISTANT_PERSONALITIES = ['none', 'friendly', 'pragmatic'] as const;
export type CommunicateAssistantPersonality = (typeof COMMUNICATE_ASSISTANT_PERSONALITIES)[number];

export type CommunicateTaskState =
  | {
      lifecycle: Exclude<CommunicateTaskLifecycle, 'WAITING_USER'>;
      waitKind?: undefined;
    }
  | {
      lifecycle: 'WAITING_USER';
      waitKind: CommunicateWaitKind;
    };

export type CommunicateTaskId = `T${number}`;
export type CommunicateTaskModel = string | null | undefined;
export type CommunicateRuntimeWarning = {
  code: string;
  message: string;
  version?: string;
  overrideActive?: boolean;
};

export type CommunicateTaskRecord = {
  id: CommunicateTaskId;
  taskType: CommunicateTaskType;
  threadId: string;
  lifecycle: CommunicateTaskLifecycle;
  cwd?: string;
  logFilePath?: string;
  codexThreadId?: string;
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  interruptedByRestart?: boolean;
  sessionKind?: CommunicateSessionKind;
  startupMode?: CommunicateSessionStartupMode;
  assistantProfileId?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  personality?: CommunicateAssistantPersonality;
  runtimeWarnings?: CommunicateRuntimeWarning[];
  waitKind?: CommunicateWaitKind;
  waitOptions?: string[];
  polishCandidateText?: string;
  checkpointOutput?: string;
  lastCheckpointAt?: string;
  lastEventAt?: string;
  latestWaitPrompt?: string;
  latestScreenshotPath?: string;
  goalSummary?: string;
  goalSummaryStatus?: 'pending' | 'ready' | 'failed';
  goalSummarySourceText?: string;
  firstUserCodingText?: string;
};

export type CreateCommunicateTaskInput = {
  id?: CommunicateTaskId;
  taskType: CommunicateTaskType;
  threadId: string;
  lifecycle: CommunicateTaskLifecycle;
  cwd?: string;
  logFilePath?: string;
  codexThreadId?: string;
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  interruptedByRestart?: boolean;
  sessionKind?: CommunicateSessionKind;
  startupMode?: CommunicateSessionStartupMode;
  assistantProfileId?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  personality?: CommunicateAssistantPersonality;
  runtimeWarnings?: CommunicateRuntimeWarning[];
  waitKind?: CommunicateWaitKind;
  waitOptions?: string[];
  polishCandidateText?: string;
  checkpointOutput?: string;
  lastCheckpointAt?: string;
  lastEventAt?: string;
  latestWaitPrompt?: string;
  latestScreenshotPath?: string;
  goalSummary?: string;
  goalSummaryStatus?: 'pending' | 'ready' | 'failed';
  goalSummarySourceText?: string;
  firstUserCodingText?: string;
};

export type UpdateCommunicateTaskPatch = Partial<Omit<CommunicateTaskRecord, 'id' | 'taskType' | 'threadId'>>;

export type CommunicateTaskRuntimeConfigInput = {
  model?: CommunicateTaskModel;
  sandbox?: string | null;
  approvalPolicy?: string | null;
  sessionKind?: CommunicateSessionKind | null;
  startupMode?: CommunicateSessionStartupMode | null;
  interruptedByRestart?: boolean | null;
  defaultSandbox?: string;
  defaultApprovalPolicy?: string;
};

export function cloneCommunicateRuntimeWarnings(
  warnings: CommunicateRuntimeWarning[] | null | undefined
): CommunicateRuntimeWarning[] | undefined {
  if (!Array.isArray(warnings) || warnings.length === 0) return undefined;
  const normalized = warnings
    .filter((warning): warning is CommunicateRuntimeWarning => Boolean(warning && typeof warning.message === 'string'))
    .map((warning) => ({
      code: String(warning.code ?? '').trim(),
      message: warning.message.trim(),
      version: typeof warning.version === 'string' && warning.version.trim() ? warning.version.trim() : undefined,
      overrideActive: warning.overrideActive === true ? true : undefined
    }))
    .filter((warning) => warning.message.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

export function mergeCommunicateRuntimeWarnings(
  ...warningSets: Array<CommunicateRuntimeWarning[] | null | undefined>
): CommunicateRuntimeWarning[] | undefined {
  const merged: CommunicateRuntimeWarning[] = [];
  const seen = new Set<string>();
  for (const warningSet of warningSets) {
    const normalized = cloneCommunicateRuntimeWarnings(warningSet);
    if (!normalized) continue;
    for (const warning of normalized) {
      const key = [
        warning.code,
        warning.version ?? '',
        warning.message,
        warning.overrideActive === true ? 'override' : 'normal'
      ].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(warning);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

export function listCommunicateRuntimeWarningMessages(
  warnings: CommunicateRuntimeWarning[] | null | undefined
): string[] {
  const normalized = cloneCommunicateRuntimeWarnings(warnings);
  if (!normalized) return [];
  const messages: string[] = [];
  const seen = new Set<string>();
  for (const warning of normalized) {
    if (seen.has(warning.message)) continue;
    seen.add(warning.message);
    messages.push(warning.message);
  }
  return messages;
}

export function isCommunicateTaskId(value: string): value is CommunicateTaskId {
  return /^T\d+$/.test(value);
}

export function normalizeCommunicateTaskModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCommunicateTaskSetting(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function describeCommunicateTaskModel(model: CommunicateTaskModel): string {
  const normalized = normalizeCommunicateTaskModel(model);
  if (normalized) return normalized;
  return model === null ? '未知' : '未设置';
}

export function describeCommunicateTaskSetting(value: string | null | undefined, options?: { defaultValue?: string }): string {
  const normalized = normalizeCommunicateTaskSetting(value);
  if (normalized) return normalized;
  if (value === null) return '未知';
  const fallback = normalizeCommunicateTaskSetting(options?.defaultValue);
  if (fallback) return `默认(${fallback})`;
  return '未设置';
}

export function describeCommunicateTaskSessionKind(value: CommunicateSessionKind | null | undefined): string {
  if (value === 'coding' || value === 'assistant') return value;
  return value === null ? '未知' : '未设置';
}

export function describeCommunicateTaskBoolean(value: boolean | null | undefined): string {
  if (value === true) return '是';
  if (value === false) return '否';
  return value === null ? '未知' : '未设置';
}

export function describeCommunicateTaskResumeState(value: CommunicateSessionStartupMode | null | undefined): string {
  if (value === 'resume') return '是';
  if (value === 'new') return '否';
  return value === null ? '未知' : '未设置';
}

export function shouldDisplayCommunicateTaskRuntimeSessionLine(input: CommunicateTaskRuntimeConfigInput): boolean {
  return !(input.sessionKind === 'assistant' && input.startupMode === 'new' && input.interruptedByRestart === false);
}

export function formatCommunicateTaskRuntimeConfig(input: CommunicateTaskRuntimeConfigInput): {
  primary: string;
  secondary: string;
  showSecondary: boolean;
} {
  return {
    primary: [
      `model ${describeCommunicateTaskModel(input.model)}`,
      `sandbox ${describeCommunicateTaskSetting(input.sandbox, { defaultValue: input.defaultSandbox })}`,
      `approvalPolicy ${describeCommunicateTaskSetting(input.approvalPolicy, { defaultValue: input.defaultApprovalPolicy })}`
    ].join(' · '),
    secondary: [
      `sessionKind ${describeCommunicateTaskSessionKind(input.sessionKind)}`,
      `恢复态 ${describeCommunicateTaskResumeState(input.startupMode)}`,
      `中断恢复 ${describeCommunicateTaskBoolean(input.interruptedByRestart)}`
    ].join(' · '),
    showSecondary: shouldDisplayCommunicateTaskRuntimeSessionLine(input)
  };
}

export function normalizeCodexSessionLifecycle(input: Pick<CommunicateTaskRecord, 'taskType' | 'lifecycle'>):
  | NormalizedCodexSessionLifecycle
  | null {
  if (input.taskType !== 'codex_session') {
    if (input.lifecycle === 'WAITING_USER') return 'WAITING_USER';
    if (input.lifecycle === 'FAILED') return 'FAILED';
    if (input.lifecycle === 'FINISHED' || input.lifecycle === 'CANCELLED' || input.lifecycle === 'CLOSED') return 'CLOSED';
    return null;
  }

  switch (input.lifecycle) {
    case 'STARTING':
    case 'IDLE':
    case 'RUNNING_TURN':
    case 'WAITING_USER':
    case 'CLOSING':
    case 'CLOSED':
    case 'FAILED':
      return input.lifecycle;
    case 'CREATED':
    case 'ROUTING':
    case 'RESUMING':
      return 'STARTING';
    case 'FINISHED':
    case 'CANCELLED':
      return 'CLOSED';
    case 'RUNNING':
    default:
      return null;
  }
}

export { normalizeWaitKind };
