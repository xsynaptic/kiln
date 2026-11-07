import type { VmState } from "../vm/vm.ts";
import type { Flags } from "./dispatch-flags.ts";

import { readLiveLease } from "../vm/lease.ts";
import { rescueAndStopSlot } from "../vm/rescue.ts";
import { slotToolchain, toolchainStamp } from "../vm/toolchain.ts";
import { hasAgentTmuxSession, hasHeadlessClaude, isSlotProvisioned } from "../vm/vm.ts";
import { labeled, slotList } from "./format.ts";

export interface SlotState {
  busy: boolean;
  name: string;
  ready: boolean;
  state: "absent" | VmState;
}

export function launchCapacity(dial: number, busyCount: number, freeCount: number, maxLaunch: number): number {
  return Math.min(dial - busyCount, freeCount, maxLaunch);
}

export function logSlotState(slots: Array<SlotState>): void {
  console.log(labeled("slots", slotList(slots)));
}

export function probeSlot(name: string, repoRoot: string, vmStates: Map<string, VmState>): SlotState {
  const state = vmStates.get(name);
  const isLeased = readLiveLease(repoRoot, name) !== undefined;
  if (state === undefined) {
    return { busy: isLeased, name, ready: false, state: "absent" };
  }
  if (state === "stopped") {
    if (isLeased) {
      console.log(`${name} is stopped but still leased; leaving it alone (an interrupted run: check its receipt)`);
    }
    return { busy: isLeased, name, ready: false, state };
  }
  const isBusy = isLeased || hasHeadlessClaude(name) || hasAgentTmuxSession(name);
  return { busy: isBusy, name, ready: isSlotProvisioned(name, toolchainStamp(slotToolchain(repoRoot))), state };
}

export function reclaimIdleSlots(flags: Flags, slots: Array<SlotState>, filled: Set<string>, isQuiet: boolean): void {
  const idle = slots.filter((slot) => slot.state === "running" && !slot.busy && !filled.has(slot.name));
  const toStop = idle.slice(flags.keepWarm);
  const kept = idle.length - toStop.length;
  if (!isQuiet && kept > 0) {
    console.log(
      `keeping ${String(kept)} idle slot(s) warm: ${idle
        .slice(0, flags.keepWarm)
        .map((slot) => slot.name)
        .join(", ")}`,
    );
  }
  for (const slot of toStop) {
    console.log(`reclaiming ${slot.name}: idle, stopping it`);
    if (flags.isDryRun) {
      continue;
    }
    try {
      rescueAndStopSlot(slot.name, { isDelete: false });
    } catch (error) {
      console.warn(`  could not stop ${slot.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
