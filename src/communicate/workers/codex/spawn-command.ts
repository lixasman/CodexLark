import fs from 'node:fs';

export type PreparedCodexSpawnCommand = {
  command: string;
  args: string[];
  shell: boolean;
};

export function prepareCodexSpawnCommand(command: string, args: string[]): PreparedCodexSpawnCommand {
  const normalizedCommand = normalizeCodexCommand(command);
  return {
    command: normalizedCommand,
    args: [...args],
    shell: shouldUseCodexShell(normalizedCommand)
  };
}

function normalizeCodexCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  if (!/\.ps1$/i.test(command)) return command;

  const candidates = [
    command.replace(/\.ps1$/i, '.cmd'),
    command.replace(/\.ps1$/i, '.bat'),
    command.replace(/\.ps1$/i, '.exe')
  ];
  const matched = candidates.find((candidate) => fs.existsSync(candidate));
  return matched ?? command;
}

function shouldUseCodexShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}
