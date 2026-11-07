import { agentSlotFromName } from "../vm/ports.ts";
import { rescueAndStopSlot } from "../vm/rescue.ts";

export function run(argv: Array<string>): void {
  const name = argv.find((arg) => !arg.startsWith("-"));
  if (name === undefined || agentSlotFromName(name) === undefined) {
    throw new Error("usage: pnpm kiln rm <kiln-n> [--delete]");
  }
  rescueAndStopSlot(name, { isDelete: argv.includes("--delete") });
}
