import { parseArgs } from "./util/args";
import { isSetupCliVerb, runSetupCommand, type SetupCliVerb, type SetupCommandResult } from "./setup";
import { redactSetupSecretsForOutput } from "./setup/redaction";

export type SetupCliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type SetupCliInvocation =
  | { kind: "help" }
  | {
      kind: "command";
      command: SetupCliVerb;
    };

class SetupCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupCliUsageError";
  }
}

function defaultIo(): SetupCliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    }
  };
}

function formatFlagNames(flagKeys: string[]): string {
  return flagKeys.map((key) => `--${key}`).join(", ");
}

function parseSetupCliInvocation(argv: string[]): SetupCliInvocation {
  const { command, flags, positionals } = parseArgs(argv);
  const flagKeys = Object.keys(flags);
  const hasHelpFlag = flagKeys.includes("help");

  if (hasHelpFlag) {
    const otherFlagKeys = flagKeys.filter((key) => key !== "help");
    if (command || positionals.length > 0 || otherFlagKeys.length > 0 || flags.help !== true) {
      throw new SetupCliUsageError("--help 不接受额外参数");
    }
    return { kind: "help" };
  }

  if (!command) {
    throw new SetupCliUsageError("缺少 command");
  }
  if (!isSetupCliVerb(command)) {
    throw new SetupCliUsageError(`未知 command: ${command}`);
  }
  if (positionals.length > 0) {
    throw new SetupCliUsageError(`不支持额外 positional 参数: ${positionals.join(", ")}`);
  }
  if (flagKeys.length > 0) {
    throw new SetupCliUsageError(`未知 flag: ${formatFlagNames(flagKeys)}`);
  }

  return {
    kind: "command",
    command
  };
}

export function usage(): string {
  return [
    "用法：",
    "  node dist/setup-cli.js <command>",
    "",
    "Commands:",
    "  --help",
    "  first-run",
    "  repair",
    "  doctor",
    "  export-diagnostics",
    "  resolve-launch-env"
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<SetupCommandResult> {
  const invocation = parseSetupCliInvocation(argv);
  if (invocation.kind !== "command") {
    throw new SetupCliUsageError("--help 仅用于显示帮助");
  }
  return runSetupCommand(invocation.command);
}

export async function runCli(argv = process.argv.slice(2), io: SetupCliIo = defaultIo()): Promise<number> {
  try {
    const invocation = parseSetupCliInvocation(argv);
    if (invocation.kind === "help") {
      io.stdout(`${usage()}\n`);
      return 0;
    }

    const result = await runSetupCommand(invocation.command);
    io.stdout(`${JSON.stringify(redactSetupSecretsForOutput(result))}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof SetupCliUsageError) {
      io.stdout(`${usage()}\n`);
      io.stderr(`${error.message}\n`);
      return 1;
    }

    io.stderr(`${String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
