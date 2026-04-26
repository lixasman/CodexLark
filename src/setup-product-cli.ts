import readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errorOutput } from "node:process";

import { runLaunchWorkflow, runRepairWorkflow, type ProductFlowIo } from "./setup/product-flow";

type ProductCommand = "launch" | "repair";

type ProductCliIo = ProductFlowIo & {
  close?: () => void;
};

function usage(): string {
  return [
    "用法：",
    "  node dist/setup-product-cli.js launch",
    "  node dist/setup-product-cli.js repair"
  ].join("\n");
}

function createDefaultIo(): ProductCliIo {
  const rl = readline.createInterface({
    input,
    output
  });

  return {
    stdout: (text) => {
      output.write(text);
    },
    stderr: (text) => {
      errorOutput.write(text);
    },
    prompt: async (question) => await rl.question(question),
    interactive: Boolean(input.isTTY && output.isTTY),
    close: () => {
      rl.close();
    }
  };
}

function parseCommand(argv: string[]): ProductCommand {
  const [command, ...rest] = argv;
  if (!command || rest.length > 0 || (command !== "launch" && command !== "repair")) {
    throw new Error("invalid-command");
  }
  return command;
}

export async function runCli(argv = process.argv.slice(2), io: ProductCliIo = createDefaultIo()): Promise<number> {
  try {
    const command = parseCommand(argv);
    const result =
      command === "launch"
        ? await runLaunchWorkflow({
            env: process.env,
            io
          })
        : await runRepairWorkflow({
            env: process.env,
            io
          });
    return result.ok ? 0 : 1;
  } catch (error) {
    if ((error as Error)?.message === "invalid-command") {
      io.stdout(`${usage()}\n`);
      return 1;
    }
    io.stderr(`${String(error)}\n`);
    return 1;
  } finally {
    io.close?.();
  }
}

if (require.main === module) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
