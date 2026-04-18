import {
  cloneCommunicateRuntimeWarnings,
  type CommunicateTaskId,
  type CommunicateTaskRecord,
  type CreateCommunicateTaskInput,
  type UpdateCommunicateTaskPatch
} from '../protocol/task-types';

export function createTaskIdGenerator(startAt = 1): () => CommunicateTaskId {
  let nextValue = startAt;
  return () => `T${nextValue++}` as CommunicateTaskId;
}

export function createTaskStore(seedGenerator?: () => CommunicateTaskId) {
  const nextId = seedGenerator ?? createTaskIdGenerator();
  const tasks = new Map<CommunicateTaskId, CommunicateTaskRecord>();

  return {
    createTask(input: CreateCommunicateTaskInput): CommunicateTaskRecord {
      const id = input.id ?? nextId();
      const record: CommunicateTaskRecord = {
        id,
        taskType: input.taskType,
        threadId: input.threadId,
        lifecycle: input.lifecycle,
        waitKind: input.waitKind,
        waitOptions: input.waitOptions,
        codexThreadId: input.codexThreadId,
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
        interruptedByRestart: input.interruptedByRestart,
        sessionKind: input.sessionKind,
        startupMode: input.startupMode,
        assistantProfileId: input.assistantProfileId,
        developerInstructions: input.developerInstructions,
        baseInstructions: input.baseInstructions,
        personality: input.personality,
        runtimeWarnings: cloneCommunicateRuntimeWarnings(input.runtimeWarnings),
        polishCandidateText: input.polishCandidateText,
        checkpointOutput: input.checkpointOutput,
        lastCheckpointAt: input.lastCheckpointAt,
        lastEventAt: input.lastEventAt,
        latestWaitPrompt: input.latestWaitPrompt,
        latestScreenshotPath: input.latestScreenshotPath,
        goalSummary: input.goalSummary,
        goalSummaryStatus: input.goalSummaryStatus,
        goalSummarySourceText: input.goalSummarySourceText,
        firstUserCodingText: input.firstUserCodingText,
        cwd: input.cwd,
        logFilePath: input.logFilePath
      };
      tasks.set(id, record);
      return { ...record, runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings) };
    },

    getTask(id: CommunicateTaskId): CommunicateTaskRecord | undefined {
      const record = tasks.get(id);
      return record ? { ...record, runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings) } : undefined;
    },

    updateTask(id: CommunicateTaskId, patch: UpdateCommunicateTaskPatch): CommunicateTaskRecord {
      const record = tasks.get(id);
      if (!record) throw new Error(`Unknown task: ${id}`);
      const updated: CommunicateTaskRecord = {
        ...record,
        ...patch,
        runtimeWarnings: Object.prototype.hasOwnProperty.call(patch, 'runtimeWarnings')
          ? cloneCommunicateRuntimeWarnings(patch.runtimeWarnings)
          : cloneCommunicateRuntimeWarnings(record.runtimeWarnings)
      };
      tasks.set(id, updated);
      return { ...updated, runtimeWarnings: cloneCommunicateRuntimeWarnings(updated.runtimeWarnings) };
    },

    deleteTask(id: CommunicateTaskId): CommunicateTaskRecord | undefined {
      const record = tasks.get(id);
      if (!record) return undefined;
      tasks.delete(id);
      return { ...record, runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings) };
    },

    listTasksByThread(threadId: string): CommunicateTaskRecord[] {
      return Array.from(tasks.values())
        .filter((record) => record.threadId === threadId)
        .map((record) => ({ ...record, runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings) }));
    },

    listWaitingTasksByThread(threadId: string): CommunicateTaskRecord[] {
      return Array.from(tasks.values())
        .filter((record) => record.threadId === threadId && record.lifecycle === 'WAITING_USER')
        .map((record) => ({ ...record, runtimeWarnings: cloneCommunicateRuntimeWarnings(record.runtimeWarnings) }));
    }
  };
}
