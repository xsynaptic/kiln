import type { DispatchBead } from "../queue/bd-client.ts";
import type { CrankState } from "./crank-state.ts";
import type { Flags } from "./dispatch-flags.ts";
import type { ReviewPlan } from "./review-runs.ts";

import { kilnConfig } from "../config/config.ts";
import { bdReady } from "../queue/bd-client.ts";
import { liveGatesOf, openGhPrGates, parkedBeads } from "../queue/gates.ts";
import { agentSlotNames } from "../vm/ports.ts";
import { listVmStates } from "../vm/vm.ts";
import { fillSlots } from "./bead-launch.ts";
import { labeled } from "./format.ts";
import { checkGates, settleStrandedBeads } from "./gate-pass.ts";
import { syncMain } from "./main-checkout.ts";
import { readReceipts, reconcile } from "./reconcile.ts";
import { launchReviews, planReviews, settleExhaustedReviews } from "./review-runs.ts";
import { shouldHoldForOutage } from "./run-attempts.ts";
import { launchCapacity, logSlotState, probeSlot, reclaimIdleSlots } from "./slots.ts";

export interface CrankOptions {
  maxLaunch?: number;
  quiet?: boolean;
}

export interface CrankSummary {
  inFlight: number;
  isBlocked: boolean;
  launched: number;
  openGates: number;
  parked: Array<string>;
  ready: number;
  stalled: number;
}

export async function crank(flags: Flags, repoRoot: string, options: CrankOptions = {}): Promise<CrankSummary> {
  const isQuiet = options.quiet === true;
  const maxLaunch = options.maxLaunch ?? Infinity;
  syncMain(repoRoot, flags.isDryRun);

  const receipts = readReceipts(repoRoot);

  const vmStates = listVmStates();
  const slots = agentSlotNames.slice(0, kilnConfig.slots.max).map((name) => probeSlot(name, repoRoot, vmStates));

  const beadsByGate = new Map<string, Array<string>>();
  const parkedIds = new Set(parkedBeads(beadsByGate));
  const crankState: CrankState = { beadsByGate, flags, isQuiet, parkedIds, receipts, repoRoot, slots };
  const gateCandidates = checkGates(flags.isDryRun, parkedIds, beadsByGate);
  const stalled = reconcile(crankState);
  settleStrandedBeads(flags.isDryRun, beadsByGate);

  // Runs after reconcile, so freshly delivered runs already have gates and resolved gates are gone
  const gates = openGhPrGates();
  const ready = bdReady();
  const liveGates = liveGatesOf(gates, beadsByGate, parkedIds);

  const busyAtCrank = slots.filter((slot) => slot.busy).length;
  const freeAtCrank = slots.filter((slot) => !slot.busy);
  const capacity = launchCapacity(flags.dial, busyAtCrank, freeAtCrank.length, maxLaunch);
  const reviews =
    capacity > 0 ? planReviews(crankState, liveGates, gateCandidates) : { exhausted: [], inFlight: 0, planned: [] };
  settleExhaustedReviews(crankState, reviews.exhausted);
  // Recounted rather than subtracted, because one park can empty several gates while a gate it skipped stays live
  const openGates = liveGatesOf(liveGates, beadsByGate, parkedIds).length;
  const hasOpportunity = capacity > 0 && (ready.length > 0 || reviews.planned.length > 0);
  const heldReason = reportedHoldReason(crankState, hasOpportunity);
  const isBlocked = heldReason !== undefined;
  const filled = isBlocked ? new Set<string>() : await launchAll(crankState, reviews, ready, maxLaunch);

  reclaimIdleSlots(flags, slots, filled, isQuiet);

  const busyCount = slots.filter((slot) => slot.busy).length;
  return {
    inFlight: busyCount + filled.size,
    isBlocked,
    launched: filled.size,
    openGates,
    parked: [...parkedIds],
    ready: ready.length,
    stalled,
  };
}

async function launchAll(
  crankState: CrankState,
  reviews: ReviewPlan,
  ready: Array<DispatchBead>,
  maxLaunch: number,
): Promise<Set<string>> {
  const filled = await launchReviews(crankState, reviews, maxLaunch);
  const beadSlots = await fillSlots(crankState, ready, maxLaunch - filled.size, filled);
  for (const name of beadSlots) {
    filled.add(name);
  }
  return filled;
}

function reportedHoldReason(crankState: CrankState, hasOpportunity: boolean): string | undefined {
  if (!hasOpportunity) {
    return undefined;
  }
  if (crankState.isQuiet) {
    logSlotState(crankState.slots);
  }
  if (!shouldHoldForOutage(crankState.receipts, Date.now())) {
    return undefined;
  }
  const heldReason =
    "recent runs died to provider errors; holding launches until one gets through or the burst ages out";
  console.log(labeled("dispatch", heldReason));
  return heldReason;
}
