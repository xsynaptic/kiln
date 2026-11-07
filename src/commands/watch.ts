import { parseWatchFlags } from "../run/run-args.ts";
import { watchSlot } from "../run/watch-run.ts";
import { agentSlotFromName } from "../vm/ports.ts";

export async function run(argv: Array<string>): Promise<void> {
  const name = argv[0];
  if (name === undefined || agentSlotFromName(name) === undefined) {
    throw new Error("usage: pnpm kiln watch <kiln-n> [--bead <id>] [--review <pr-number>]");
  }
  await watchSlot(name, parseWatchFlags(argv));
}
