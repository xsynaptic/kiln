import process from "node:process";

import { agentSlotFromName } from "../vm/ports.ts";
import { attachAgentTmux, hasAgentTmuxSession, isVmRunning } from "../vm/vm.ts";

export async function run(argv: Array<string>): Promise<void> {
  const isReadOnly = argv.includes("--read-only");
  const name = argv.find((arg) => !arg.startsWith("-"));
  const extras = argv.filter((arg) => arg !== name && arg !== "--read-only");
  if (name === undefined || extras.length > 0 || agentSlotFromName(name) === undefined) {
    throw new Error("usage: pnpm kiln attach <kiln-n> [--read-only]");
  }
  if (!isVmRunning(name)) {
    throw new Error(`${name} is not running`);
  }
  if (!hasAgentTmuxSession(name)) {
    throw new Error(
      `no live session in ${name}; start one with pnpm kiln shell ${name}, ` +
        `or pnpm kiln run ${name} --attach --brief <file> --slug <slug>`,
    );
  }
  process.exitCode = await attachAgentTmux(name, isReadOnly);
}
