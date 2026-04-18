import { EventEmitter } from 'node:events';
import { type CommunicateTaskInterruptionKind } from '../../protocol/task-events';
import { type CommunicateAssistantPersonality, type CommunicateRuntimeWarning } from '../../protocol/task-types';
import { type CommunicateWaitKind } from '../../protocol/wait-kinds';

export type CodexSessionLifecycle =
  | 'CREATED'
  | 'RUNNING'
  | 'WAITING_USER'
  | 'FINISHED'
  | 'FAILED'
  | 'STARTING'
  | 'IDLE'
  | 'RUNNING_TURN'
  | 'CLOSING'
  | 'CLOSED';

export type CodexSessionSnapshot = {
  taskId: string;
  lifecycle: CodexSessionLifecycle;
  liveBuffer: string;
  activeTurnId?: string;
  sessionInstanceId?: string;
  checkpointOutput?: string;
  runtimeWarnings?: CommunicateRuntimeWarning[];
  waitKind?: CommunicateWaitKind;
  waitOptions?: string[];
  cwd?: string;
  logPath?: string;
  codexThreadId?: string;
  model?: string;
  windowPid?: number;
  interruptedByRestart?: boolean;
  exitCode?: number | null;
  lastProgressAt?: string;
  activeCommand?: boolean;
  activeCommandCommand?: string;
  activeCommandStartedAt?: string;
  lastCommandProgressAt?: string;
};

export type CodexWorkerEvent =
  | {
      type: 'task_waiting_user';
      taskId: `T${number}`;
      turnId?: string;
      waitKind: CommunicateWaitKind;
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
      interruptionKind: CommunicateTaskInterruptionKind;
    };

export type CodexReplyPayload =
  | { action: 'input_text'; text: string }
  | { action: 'choose_index'; index: number }
  | { action: 'confirm'; value: 'allow' | 'deny' }
  | { action: 'free_text'; text: string };

export type CodexSessionPersonaConfig = {
  developerInstructions?: string;
  baseInstructions?: string;
  personality?: CommunicateAssistantPersonality;
};

export type CodexSessionResumeContext = {
  sourceSessionLifecycle?: string;
  sourceLastEventAt?: string;
  sourceCreatedAt?: string;
  sourceIdleMs?: number;
  sourceAgeMs?: number;
};

export type CodexSessionCloseResult = {
  forced: boolean;
};

export type CodexSessionInterruptResult = {
  interrupted: boolean;
  turnId?: string | null;
};

export type CodexSessionStallDiagnosticInput = {
  trigger: 'reply_status_suspected_stalled' | 'reply_status_interrupt_requested';
  threadId?: string;
  quietMs?: number;
  stallConfirmations?: number;
  replyStatusCardMessageId?: string;
};

export type SpawnedCodexChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (chunk: string) => void };
  pid?: number;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
};

export type CodexSpawnFactory = (
  command: string,
  args: string[],
  options: { cwd?: string; shell?: boolean }
) => SpawnedCodexChild;
