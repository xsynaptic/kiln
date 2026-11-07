import { agentSlotFromName } from "../vm/ports.ts";
import { provisionSlot } from "../vm/provision.ts";

export async function run(argv: Array<string>): Promise<void> {
  const name = argv[0];
  const slotNumber = name === undefined ? undefined : agentSlotFromName(name);
  if (name === undefined || slotNumber === undefined) {
    throw new Error("usage: pnpm kiln new kiln-<n>   (n in 1..8)");
  }
  await provisionSlot(name, slotNumber);
}
