import type { RunReceipt } from "../run/receipts.ts";
import type { Flags } from "./dispatch-flags.ts";
import type { SlotState } from "./slots.ts";

export interface CrankState {
  beadsByGate: Map<string, Array<string>>;
  flags: Flags;
  isQuiet: boolean;
  parkedIds: Set<string>;
  receipts: Array<RunReceipt>;
  repoRoot: string;
  slots: Array<SlotState>;
}
