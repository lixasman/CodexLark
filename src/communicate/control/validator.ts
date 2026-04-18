import { type StructuredTaskCommand } from './router-types';
import {
  normalizeCodexSessionLifecycle,
  type CommunicateTaskId,
  type CommunicateTaskRecord
} from '../protocol/task-types';

type TaskStoreReader = {
  getTask(id: CommunicateTaskId): CommunicateTaskRecord | undefined;
  listWaitingTasksByThread(threadId: string): CommunicateTaskRecord[];
};

export type ReplyValidationResult =
  | {
      ok: true;
      task: CommunicateTaskRecord;
    }
  | {
      ok: false;
      error: string;
      needsClarification?: boolean;
    };

export function validateReplyCommand(input: {
  currentThreadId: string;
  store: TaskStoreReader;
  command: StructuredTaskCommand;
}): ReplyValidationResult {
  const { command, currentThreadId, store } = input;
  if (command.intent !== 'reply_task') {
    return { ok: false, error: 'Only reply_task commands can be validated here.' };
  }

  const action = String(command.params.action ?? '');
  const resolvedTask = resolveTask(command, currentThreadId, store);
  if ('ok' in resolvedTask) return resolvedTask;
  const task = resolvedTask;
  const normalizedLifecycle = normalizeCodexSessionLifecycle(task);

  if (task.threadId !== currentThreadId) {
    return { ok: false, error: `Task ${task.id} does not belong to the current thread.` };
  }

  if (task.taskType === 'codex_session') {
    if (normalizedLifecycle == null) {
      return { ok: false, error: `任务 ${task.id} 处于旧版运行态，请重新创建会话。` };
    }

    const isTextReply = action === 'input_text' || action === 'free_text';
    if (isTextReply && (normalizedLifecycle === 'STARTING' || normalizedLifecycle === 'IDLE' || normalizedLifecycle === 'RUNNING_TURN')) {
      return { ok: true, task };
    }
    if (normalizedLifecycle === 'RUNNING_TURN') {
      return { ok: false, error: `任务 ${task.id} 正在执行中。` };
    }
    if (normalizedLifecycle === 'CLOSING') {
      return { ok: false, error: `任务 ${task.id} 正在关闭中，暂时无法接收输入。` };
    }
    if (normalizedLifecycle === 'CLOSED') {
      return { ok: false, error: `任务 ${task.id} 已关闭。` };
    }
    if (normalizedLifecycle === 'FAILED') {
      return { ok: false, error: `任务 ${task.id} 已失败，无法继续接收输入。` };
    }
  }

  if (task.lifecycle !== 'WAITING_USER') {
    return { ok: false, error: `Task ${task.id} is already finished or not waiting for user input.` };
  }

  if (action === 'choose_index' && task.waitKind !== 'choice') {
    return { ok: false, error: `Task ${task.id} is not waiting for a choice.` };
  }
  if (action === 'input_text' && task.waitKind !== 'text_input') {
    return { ok: false, error: `Task ${task.id} is not waiting for text_input.` };
  }
  if (action === 'confirm' && task.waitKind !== 'confirm') {
    return { ok: false, error: `Task ${task.id} is not waiting for a confirm action.` };
  }
  if (action === 'confirm_polish_send' && task.waitKind !== 'polish_confirm') {
    return { ok: false, error: `Task ${task.id} is not waiting for polish confirmation.` };
  }

  if (action === 'confirm' && command.params.value === 'allow' && (task.waitOptions?.length ?? 0) > 1) {
    return {
      ok: false,
      error: `Task ${task.id} has multiple allow-like options; please be more explicit.`,
      needsClarification: true
    };
  }

  return { ok: true, task };
}


function resolveTask(
  command: StructuredTaskCommand,
  currentThreadId: string,
  store: TaskStoreReader
): CommunicateTaskRecord | Extract<ReplyValidationResult, { ok: false }> {
  if (command.taskId) {
    const task = store.getTask(command.taskId as CommunicateTaskId);
    return task ?? { ok: false, error: `Unknown task: ${command.taskId}` };
  }

  const waiting = store.listWaitingTasksByThread(currentThreadId);
  if (waiting.length !== 1) {
    return {
      ok: false,
      error: 'Multiple waiting tasks exist in this thread; please provide a task ID.',
      needsClarification: true
    };
  }
  return waiting[0];
}

