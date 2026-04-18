export const COMMUNICATE_WAIT_KINDS = ['choice', 'confirm', 'text_input', 'polish_confirm'] as const;

export type CommunicateWaitKind = (typeof COMMUNICATE_WAIT_KINDS)[number];

export function normalizeWaitKind(value: string | null | undefined): CommunicateWaitKind | null {
  if (!value) return null;
  return (COMMUNICATE_WAIT_KINDS as readonly string[]).includes(value) ? (value as CommunicateWaitKind) : null;
}

