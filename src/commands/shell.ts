import process from "node:process";

import { startShellSession } from "../run/shell-session.ts";
import { agentSlotFromName } from "../vm/ports.ts";
import { attachAgentTmux, hasAgentTmuxSession, isVmRunning } from "../vm/vm.ts";

export async function run(argv: Array<string>): Promise<void> {
  const name = argv[0];
  if (name === undefined || argv.length > 1 || agentSlotFromName(name) === undefined) {
    throw new Error("usage: pnpm kiln shell <kiln-n>");
  }
  if (!isVmRunning(name)) {
    throw new Error(`${name} is not running; provision it first: pnpm kiln new ${name}`);
  }
  if (hasAgentTmuxSession(name)) {
    console.log(`joining the live session in ${name} (Ctrl-b d detaches without ending it)`);
  } else {
    startShellSession(name);
    console.log(`interactive claude started in ${name}; /exit ends the session, Ctrl-b d detaches`);
  }
  process.exitCode = await attachAgentTmux(name);
}
