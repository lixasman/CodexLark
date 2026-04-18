import { type CommunicateTaskIntent, type CommunicateTaskRecord, type CommunicateTaskType } from '../protocol/task-types';

export type StructuredTaskCommand = {
  intent: CommunicateTaskIntent;
  taskType?: CommunicateTaskType;
  taskId?: string;
  params: Record<string, unknown>;
  targetThreadId: string;
  confidence: number;
  needsClarification: boolean;
  clarificationPrompt?: string;
  reason: string;
};

export type RouteUserMessageInput = {
  text: string;
  threadId: string;
  waitingTasks: Pick<CommunicateTaskRecord, 'id' | 'taskType' | 'threadId' | 'lifecycle' | 'waitKind'>[];
};

