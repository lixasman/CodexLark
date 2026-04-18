export const COMMUNICATE_TASK_EVENTS = [
  'task_started',
  'task_output',
  'task_waiting_user',
  'task_finished',
  'task_failed',
  'task_status_snapshot'
] as const;

export type CommunicateTaskEventType = (typeof COMMUNICATE_TASK_EVENTS)[number];

export const COMMUNICATE_TASK_INTERRUPTION_KINDS = [
  'local_comm',
  'approval_denied',
  'upstream_execution',
  'version_incompatible',
  'capability_missing',
  'unknown'
] as const;

export type CommunicateTaskInterruptionKind = (typeof COMMUNICATE_TASK_INTERRUPTION_KINDS)[number];

export function normalizeTaskEventType(value: string | null | undefined): CommunicateTaskEventType | null {
  if (!value) return null;
  return (COMMUNICATE_TASK_EVENTS as readonly string[]).includes(value) ? (value as CommunicateTaskEventType) : null;
}

export function normalizeTaskInterruptionKind(value: string | null | undefined): CommunicateTaskInterruptionKind {
  if (!value) return 'unknown';
  return (COMMUNICATE_TASK_INTERRUPTION_KINDS as readonly string[]).includes(value)
    ? (value as CommunicateTaskInterruptionKind)
    : 'unknown';
}
