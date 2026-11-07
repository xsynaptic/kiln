import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";

import type { ReviewCandidate, ReviewProgress } from "../gatekeeper/review-launch.ts";
import type { RunReceipt } from "../run/receipts.ts";
import type { CrankState } from "./crank-state.ts";
import type { SlotState } from "./slots.ts";

import { gatekeeperPatFile, kilnConfig } from "../config/config.ts";
import { fetchReviewCandidate, labeledReviewPrs } from "../gatekeeper/pr-views.ts";
import { decideReview, maxInFlightReviews, maxReviewAttempts, reviewLaunchArgs } from "../gatekeeper/review-launch.ts";
import {
  deleteReviewMarker,
  readReviewMarker,
  reviewMarkerPrNumber,
  stampReviewLaunch,
} from "../gatekeeper/review-ledger.ts";
import { gateBlockedBeads, parkBehindGate } from "../queue/gates.ts";
import { spawnKiln } from "../shared/kiln-cli.ts";
import { agentRunsPath, ensureDir, timestampSlug } from "../shared/run-artifacts.ts";
import { provisionSlotLogged } from "../vm/provision-logged.ts";
import { hasReceiptSince } from "./run-ledger.ts";
import { isPastRunCeiling, launchGraceMinutes } from "./run-liveness.ts";
import { launchCapacity } from "./slots.ts";

interface ExhaustedReview {
  gate: { awaitId: string; id: string };
  prNumber: number;
}

interface PlannedReview {
  attempts: number;
  beadId?: string;
  headSha: string;
  prNumber: number;
}

interface ReviewOrigin {
  beadId?: string;
  gate?: { awaitId: string; id: string };
}

interface ReviewProgressSource {
  busyByName: Map<string, boolean>;
  gatekeeperLogin: string;
  isQuiet: boolean;
  receipts: Array<RunReceipt>;
  repoRoot: string;
}

export interface ReviewPlan {
  exhausted: Array<ExhaustedReview>;
  inFlight: number;
  planned: Array<PlannedReview>;
}

interface StalledReviewScan {
  busyByName: Map<string, boolean>;
  ceilingMinutes: number;
  isDryRun: boolean;
  receipts: Array<RunReceipt>;
  repoRoot: string;
}

export async function launchReviews(crankState: CrankState, plan: ReviewPlan, maxLaunch: number): Promise<Set<string>> {
  const { flags, isQuiet, repoRoot, slots } = crankState;
  const filled = new Set<string>();
  if (plan.planned.length === 0) {
    return filled;
  }
  const capacity = reviewCapacity(flags.dial, plan.inFlight, slots, maxLaunch);
  if (capacity <= 0) {
    reportNoCapacity(plan, isQuiet);
    return filled;
  }
  const freeSlots = slots.filter((slot) => !slot.busy);
  for (const [index, review] of plan.planned.slice(0, capacity).entries()) {
    const slot = freeSlots[index];
    if (slot === undefined) {
      break;
    }
    if (await didFillSlot(repoRoot, slot, review, flags.isDryRun)) {
      filled.add(slot.name);
    }
  }
  return filled;
}

/** @internal */
export function reviewCapacity(dial: number, inFlight: number, slots: Array<SlotState>, maxLaunch: number): number {
  const busyCount = slots.filter((slot) => slot.busy).length;
  const freeCount = slots.length - busyCount;
  const slotCapacity = launchCapacity(dial, busyCount, freeCount, maxLaunch);
  return Math.min(slotCapacity, maxInFlightReviews - inFlight);
}

function reportNoCapacity(plan: ReviewPlan, isQuiet: boolean): void {
  if (isQuiet) {
    return;
  }
  const reason = plan.inFlight > 0 ? "a review is already in flight" : "no capacity this crank";
  console.log(`review: ${String(plan.planned.length)} PR(s) awaiting review, ${reason}`);
}

async function didFillSlot(
  repoRoot: string,
  slot: SlotState,
  review: PlannedReview,
  isDryRun: boolean,
): Promise<boolean> {
  if (isDryRun) {
    console.log(`would launch gatekeeper review of PR #${String(review.prNumber)} in ${slot.name}`);
    return true;
  }
  return didLaunchReview(repoRoot, slot, review);
}

export function planReviews(
  crankState: CrankState,
  gates: Array<{ awaitId: string; id: string }>,
  gateCandidates: Map<number, ReviewCandidate>,
): ReviewPlan {
  const { beadsByGate, isQuiet, receipts, repoRoot, slots } = crankState;
  const plan: ReviewPlan = { exhausted: [], inFlight: 0, planned: [] };
  if (kilnConfig.identity.gatekeeperLogin === undefined) {
    return plan;
  }
  const { numbers, originByPr } = indexReviewPrs(gates, beadsByGate);
  if (numbers.size === 0) {
    return plan;
  }
  if (!existsSync(gatekeeperPatFile())) {
    console.warn(`review launches skipped: no gatekeeper PAT at ${gatekeeperPatFile()}`);
    return plan;
  }
  const source: ReviewProgressSource = {
    busyByName: new Map(slots.map((slot) => [slot.name, slot.busy])),
    gatekeeperLogin: kilnConfig.identity.gatekeeperLogin,
    isQuiet,
    receipts,
    repoRoot,
  };
  const ordered = [...numbers].toSorted((first, second) => first - second);
  for (const prNumber of ordered) {
    const candidate = gateCandidates.get(prNumber) ?? fetchReviewCandidate(prNumber);
    if (candidate === undefined) {
      console.warn(`review: could not read PR #${String(prNumber)}; skipping this crank`);
      continue;
    }
    addReviewDecision(plan, candidate, originByPr.get(prNumber) ?? {}, source);
  }
  return plan;
}

export function releaseStalledReviews(scan: StalledReviewScan, launchLogs: Array<string>): number {
  const { busyByName, ceilingMinutes, isDryRun, receipts, repoRoot } = scan;
  let stalled = 0;
  for (const fileName of launchLogs) {
    const prNumber = reviewMarkerPrNumber(fileName);
    if (prNumber === undefined) {
      continue;
    }
    const marker = readReviewMarker(repoRoot, prNumber);
    if (
      marker === undefined ||
      busyByName.get(marker.slot) !== true ||
      hasReceiptSince(receipts, marker.slot, marker.launchedAt) ||
      !isPastRunCeiling(marker.launchedAt, ceilingMinutes, Date.now())
    ) {
      continue;
    }
    stalled += 1;
    console.warn(
      `reconcile: ${marker.slot} has been busy reviewing PR #${String(prNumber)} for over ${String(ceilingMinutes)} minutes; released its marker so the review can run elsewhere, and left the guest alone`,
    );
    if (!isDryRun) {
      deleteReviewMarker(repoRoot, prNumber);
    }
  }
  return stalled;
}

export function settleExhaustedReviews(crankState: CrankState, exhausted: Array<ExhaustedReview>): void {
  const { flags, repoRoot } = crankState;
  for (const review of exhausted) {
    const reason = `gatekeeper review failed ${String(maxReviewAttempts)} runs at this head; ${reviewByHand(review.prNumber)}`;
    if (flags.isDryRun) {
      console.log(`would park the beads behind PR #${String(review.prNumber)}: ${reason}`);
      continue;
    }
    parkBehindGate(review.gate, reason, crankState);
    deleteReviewMarker(repoRoot, review.prNumber);
  }
}

function addReviewDecision(
  plan: ReviewPlan,
  candidate: ReviewCandidate,
  origin: ReviewOrigin,
  source: ReviewProgressSource,
): void {
  const { beadId, gate } = origin;
  const prNumber = candidate.number;
  const progress = readReviewProgress(source, prNumber);
  const decision = decideReview(candidate, source.gatekeeperLogin, progress);
  if (decision.action === "launch") {
    plan.planned.push({
      attempts: decision.attempts,
      headSha: candidate.headSha,
      prNumber,
      ...(beadId === undefined ? {} : { beadId }),
    });
    return;
  }
  if (decision.reason === "in-flight") {
    plan.inFlight += 1;
    if (!source.isQuiet) {
      console.log(`review: PR #${String(prNumber)} run in flight on ${progress.marker?.slot ?? ""}`);
    }
    return;
  }
  if (decision.reason === "reviewed") {
    deleteReviewMarker(source.repoRoot, prNumber);
    return;
  }
  if (decision.reason === "attempts-exhausted") {
    recordExhaustedReview(prNumber, gate, plan.exhausted);
  }
}

function indexReviewPrs(gates: Array<{ awaitId: string; id: string }>, beadsByGate: Map<string, Array<string>>) {
  const originByPr = new Map<number, ReviewOrigin>();
  const numbers = new Set<number>();
  for (const gate of gates) {
    const value = Number(gate.awaitId);
    if (!Number.isSafeInteger(value)) {
      continue;
    }
    numbers.add(value);
    const [beadId] = gateBlockedBeads(gate.id, beadsByGate);
    originByPr.set(value, { gate, ...(beadId === undefined ? {} : { beadId }) });
  }
  for (const value of labeledReviewPrs()) {
    numbers.add(value);
  }
  return { numbers, originByPr };
}

async function didLaunchReview(repoRoot: string, slot: SlotState, review: PlannedReview): Promise<boolean> {
  const startNote = slot.ready ? "" : " (provisioning it first)";
  console.log(
    `launching gatekeeper review of PR #${String(review.prNumber)} in ${slot.name}${startNote} (attempt ${String(review.attempts)})`,
  );
  try {
    if (!slot.ready) {
      await provisionSlotLogged(repoRoot, slot.name);
    }
    // Stamped before the spawn, so a wrapper that dies at once has still spent its attempt
    stampReviewLaunch(repoRoot, review.prNumber, review.headSha, slot.name);
    launchReviewDetached(repoRoot, slot.name, review.prNumber, review.beadId);
    return true;
  } catch (error) {
    console.warn(
      `  review launch for PR #${String(review.prNumber)} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function launchReviewDetached(repoRoot: string, slot: string, prNumber: number, beadId: string | undefined): void {
  ensureDir(agentRunsPath(repoRoot, "launches"));
  const logPath = agentRunsPath(repoRoot, "launches", `review-pr-${String(prNumber)}-${timestampSlug()}.log`);
  const fd = openSync(logPath, "a");
  const child = spawnKiln(reviewLaunchArgs(slot, prNumber, beadId), {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.on("error", (error) => {
    console.error(`detached review launch for PR #${String(prNumber)} failed: ${error.message}`);
  });
  child.unref();
  closeSync(fd);
  console.log(`  launched detached (wrapper log: ${path.relative(repoRoot, logPath)})`);
}

function readReviewProgress(source: ReviewProgressSource, prNumber: number): ReviewProgress {
  const marker = readReviewMarker(source.repoRoot, prNumber);
  if (marker === undefined) {
    return { hasReceipt: false, isHolding: false, marker };
  }
  const launchAgeMinutes = (Date.now() - new Date(marker.launchedAt).getTime()) / 60_000;
  return {
    hasReceipt: hasReceiptSince(source.receipts, marker.slot, marker.launchedAt),
    isHolding: source.busyByName.get(marker.slot) === true || launchAgeMinutes < launchGraceMinutes,
    marker,
  };
}

function recordExhaustedReview(
  prNumber: number,
  gate: ExhaustedReview["gate"] | undefined,
  exhausted: Array<ExhaustedReview>,
): void {
  if (gate === undefined) {
    console.warn(
      `review: PR #${String(prNumber)} failed ${String(maxReviewAttempts)} review runs at this head; ${reviewByHand(prNumber)}`,
    );
    return;
  }
  exhausted.push({ gate, prNumber });
}

function reviewByHand(prNumber: number): string {
  return `review by hand: pnpm kiln review <kiln-n> --pr ${String(prNumber)}`;
}
