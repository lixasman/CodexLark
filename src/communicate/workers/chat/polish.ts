import { type CommunicateTaskRecord } from '../../protocol/task-types';

type PolishStore = {
  getTask(id: `T${number}`): CommunicateTaskRecord | undefined;
  updateTask(
    id: `T${number}`,
    patch: Partial<Omit<CommunicateTaskRecord, 'id' | 'taskType' | 'threadId'>>
  ): CommunicateTaskRecord;
};

export async function preparePolishCandidateTask(input: {
  store: PolishStore;
  taskId: `T${number}`;
  originalText: string;
  rewrite: (text: string) => Promise<string> | string;
}): Promise<CommunicateTaskRecord> {
  const task = input.store.getTask(input.taskId);
  if (!task) throw new Error(`Unknown task: ${input.taskId}`);
  const candidateText = (await input.rewrite(input.originalText)).trim();
  return input.store.updateTask(input.taskId, {
    lifecycle: 'WAITING_USER',
    waitKind: 'polish_confirm',
    polishCandidateText: candidateText,
    checkpointOutput: candidateText
  });
}

export function confirmPolishCandidate(task: CommunicateTaskRecord): { action: 'input_text'; text: string } {
  if (task.waitKind !== 'polish_confirm') {
    throw new Error(`Task ${task.id} is not waiting for polish confirmation.`);
  }
  if (!task.polishCandidateText) {
    throw new Error(`Task ${task.id} does not have a polish candidate.`);
  }
  return {
    action: 'input_text',
    text: task.polishCandidateText
  };
}

