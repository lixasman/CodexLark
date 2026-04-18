import { normalizeCommunicateTaskModel } from '../protocol/task-types';

export function extractCodexModelFromCommand(command: string[]): string | undefined {
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index];
    if (part === '--model') {
      return normalizeCommunicateTaskModel(command[index + 1]);
    }
    if (typeof part === 'string' && part.startsWith('--model=')) {
      return normalizeCommunicateTaskModel(part.slice('--model='.length));
    }
  }
  return undefined;
}
