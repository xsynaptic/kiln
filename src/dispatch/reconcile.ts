import { existsSync, readdirSync, readFileSync } from "node:fs";
import process from "node:process";

import type { BeadComment } from "../queue/bd-client.ts";
import type { RunReceipt } from "../run/receipts.ts";
import type { CrankState } from "./crank-state.ts";

import { unclosedPrUrlsForBead, unclosedPrUrlsForHead } from "../gatekeeper/pr-views.ts";
import {
  bd,
  bdComments,
  bdShow,
  beadsAwaitingReconcile,
  releaseSlotClaim,
  unclaimFromSlot,
} from "../queue/bd-client.ts";
import { prNumberFromUrl } from "../queue/gate-reads.ts";
import { latestPrGateOn, openPrGate, parkBead, parkStalledRun, parkWithOpenPr } from "../queue/gates.ts";
import { agentRunsPath } from "../shared/run-artifacts.ts";
import { releaseStalledReviews } from "./review-runs.ts";
import { latestDispatchBranch, latestDispatchTime, spentAttempts } from "./run-attempts.ts";
import { deliveredPrUrl, latestReceiptForBead, parseReceipts, strandedPrUrl } from "./run-ledger.ts";
import { isPastRunCeiling, launchGraceMinutes } from "./run-liveness.ts";

const defaultRunCeilingHours = 6;
const maxRunAttempts = 2;

type PendingOutcome =
  { ageMinutes: number; kind: "starting" } | { kind: "dead" } | { kind: "receipt"; receipt: RunReceipt };

interface ReceiptSnapshot {
  receipts: Array<RunReceipt>;
  repoRoot: string;
}

interface CrankWrites {
  isDryRun: boolean;
  parkedIds: Set<string>;
}

interface ReconcileContext extends CrankWrites {
  busyByName: Map<string, boolean>;
  ceilingHours: number;
  isQuiet: boolean;
  receipts: Array<RunReceipt>;
  repoRoot: string;
}

type PendingSettlement = "settled" | "stalled";

interface PendingRun {
  id: string;
  slot: string;
}

interface IdleSlotBead {
  comments: Array<BeadComment>;
  launchedAt: string;
  status: string;
}

// A run that finished after the crank's snapshot looks unstarted, so past the grace window the receipts file is read again
/** @internal */
export function pendingRunOutcome(
  snapshot: ReceiptSnapshot,
  beadId: string,
  launchedAt: string,
  nowMs: number,
): PendingOutcome {
  const receipt = latestReceiptForBead(snapshot.receipts, beadId, launchedAt);
  if (receipt !== undefined) {
    return { kind: "receipt", receipt };
  }
  const ageMinutes = launchedAt === "" ? Infinity : (nowMs - new Date(launchedAt).getTime()) / 60_000;
  if (ageMinutes < launchGraceMinutes) {
    return { ageMinutes, kind: "starting" };
  }
  const late = latestReceiptForBead(readReceipts(snapshot.repoRoot), beadId, launchedAt);
  return late === undefined ? { kind: "dead" } : { kind: "receipt", receipt: late };
}

export function readReceipts(repoRoot: string): Array<RunReceipt> {
  const file = agentRunsPath(repoRoot, "runs.jsonl");
  return parseReceipts(existsSync(file) ? readFileSync(file, "utf8") : "");
}

export function reconcile(crankState: CrankState): number {
  const { flags, isQuiet, parkedIds, receipts, repoRoot, slots } = crankState;
  const context: ReconcileContext = {
    busyByName: new Map(slots.map((slot) => [slot.name, slot.busy])),
    ceilingHours: runCeilingHours(),
    isDryRun: flags.isDryRun,
    isQuiet,
    parkedIds,
    receipts,
    repoRoot,
  };
  const launchesDir = agentRunsPath(repoRoot, "launches");
  const launchLogs = existsSync(launchesDir) ? readdirSync(launchesDir) : [];
  let stalled = releaseStalledReviews(context, launchLogs);
  for (const pending of beadsAwaitingReconcile()) {
    if (settlePendingRun(pending, context) === "stalled") {
      stalled += 1;
    }
  }
  return stalled;
}

// bd keeps started_at through a release that is not an unclaim, so a claim is dated by the newest mark it cannot predate
// A dispatch comment opens a claim and a PR gate closes one; an attended claim writes neither, but an unclaim clears started_at
function claimTime(marks: Array<string | undefined>, startedAt: string): string {
  let latest = startedAt;
  for (const mark of marks) {
    if (mark === undefined) {
      continue;
    }
    if (latest === "" || Date.parse(mark) > Date.parse(latest)) {
      latest = mark;
    }
  }
  return latest;
}

function didReportRunPastCeiling(
  pending: PendingRun,
  launchedAt: string,
  ceilingHours: number,
  writes: CrankWrites,
): boolean {
  const { isDryRun, parkedIds } = writes;
  if (parkedIds.has(pending.id) || !isPastRunCeiling(launchedAt, ceilingHours, Date.now())) {
    return false;
  }
  console.warn(
    `reconcile: ${pending.slot} has been busy with ${pending.id} for over ${String(ceilingHours)}h; parking the bead and leaving the guest alone`,
  );
  if (!isDryRun) {
    parkStalledRun(pending.id, pending.slot, ceilingHours, parkedIds);
  }
  return true;
}

function deadRunPrUrls(pending: PendingRun, bead: IdleSlotBead): Array<string> | undefined {
  const branch = latestDispatchBranch(bead.comments);
  const byHead = branch === undefined ? [] : unclosedPrUrlsForHead(branch, bead.launchedAt);
  const byBead = unclosedPrUrlsForBead(pending.id, bead.launchedAt);
  // Both lookups, since a bead dispatched once and then claimed by an attended session still carries the old dispatch branch
  return byHead === undefined || byBead === undefined ? undefined : [...new Set([...byHead, ...byBead])];
}

// A requeue or a stale-claim release on a guess would relaunch over a PR GitHub could not be asked about
function didHoldForItsPrs(pending: PendingRun, bead: IdleSlotBead, writes: CrankWrites): boolean {
  const prUrls = deadRunPrUrls(pending, bead);
  if (prUrls === undefined) {
    console.warn(
      `reconcile: ${pending.id} left no receipt and GitHub could not be asked for its PR; left for the next crank`,
    );
    return true;
  }
  if (prUrls.length === 0) {
    return false;
  }
  const listed = prUrls.join(", ");
  console.log(`reconcile: ${pending.id} left no receipt but opened ${listed}; parked on the PR`);
  if (writes.isDryRun) {
    return true;
  }
  parkBead(
    pending.id,
    pending.slot,
    `run on ${pending.slot} left no receipt after opening ${listed}; read the PR before assuming the work was lost`,
    writes.parkedIds,
  );
  for (const prUrl of prUrls) {
    const prNumber = prNumberFromUrl(prUrl);
    if (prNumber !== undefined) {
      openPrGate(pending.id, prNumber, prUrl);
    }
  }
  return true;
}

function gateOnDeliveredPr(pending: PendingRun, prUrl: string, isDryRun: boolean): void {
  console.log(`reconcile: ${pending.id} delivered ${prUrl}; gated on the PR merge`);
  if (isDryRun) {
    return;
  }
  const prNumber = prNumberFromUrl(prUrl);
  bd([
    "comment",
    pending.id,
    `PR open: ${prUrl}; awaiting human review. The gh:pr gate closes this bead when the PR merges.`,
  ]);
  if (prNumber !== undefined) {
    openPrGate(pending.id, prNumber, prUrl);
  }
  // Left in_progress so bd ready still skips it if the gate closes outside the crank; the claim goes because reconcile finds runs by assignee
  releaseSlotClaim(pending.id, pending.slot, "in_progress");
}

// While it stays claimed, bd ready lists it but `bd ready --claim` silently skips it, so no crank could take it
function releaseStaleClaim(pending: PendingRun, isDryRun: boolean): void {
  console.log(`reconcile: ${pending.id} is open but still claimed by ${pending.slot}; released the stale claim`);
  if (!isDryRun) {
    releaseSlotClaim(pending.id, pending.slot);
  }
}

function runCeilingHours(): number {
  const raw = process.env.KILN_RUN_CEILING_HOURS;
  const value = raw === undefined ? defaultRunCeilingHours : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : defaultRunCeilingHours;
}

function settleDeadRun(pending: PendingRun, reason: string, canRetry: boolean, writes: CrankWrites): void {
  console.log(`reconcile: ${pending.id} ${reason}; ${canRetry ? "requeued" : "parked"}`);
  if (writes.isDryRun) {
    return;
  }
  if (!canRetry) {
    parkBead(pending.id, pending.slot, reason, writes.parkedIds);
    return;
  }
  unclaimFromSlot(pending.id, pending.slot, `${reason}; requeued for one retry`);
}

function settlePendingRun(pending: PendingRun, context: ReconcileContext): PendingSettlement {
  const shown = bdShow(pending.id);
  if (shown === undefined || shown.status === "closed") {
    return "settled";
  }
  const comments = bdComments(pending.id);
  const launchedAt = claimTime([latestDispatchTime(comments), latestPrGateOn(pending.id)], shown.startedAt);
  if (context.busyByName.get(pending.slot) === true) {
    return didReportRunPastCeiling(pending, launchedAt, context.ceilingHours, context) ? "stalled" : "settled";
  }
  settleIdleSlotRun(pending, { comments, launchedAt, status: shown.status }, context);
  return "settled";
}

function settleIdleSlotRun(pending: PendingRun, bead: IdleSlotBead, context: ReconcileContext): void {
  const outcome = pendingRunOutcome(context, pending.id, bead.launchedAt, Date.now());
  if (outcome.kind === "dead" && didHoldForItsPrs(pending, bead, context)) {
    return;
  }
  // Settled before the stale-claim release, which would drop a reopened bead's delivered PR ungated
  if (bead.status === "open" && outcome.kind !== "receipt") {
    releaseStaleClaim(pending, context.isDryRun);
    return;
  }
  const canRetry =
    !context.parkedIds.has(pending.id) && spentAttempts(bead.comments, context.receipts, pending.id) < maxRunAttempts;
  settleRunOutcome(pending, outcome, canRetry, context);
}

function settleRunOutcome(
  pending: PendingRun,
  outcome: PendingOutcome,
  canRetry: boolean,
  context: ReconcileContext,
): void {
  if (outcome.kind === "starting") {
    if (!context.isQuiet) {
      console.log(
        `reconcile: ${pending.id} launched ${String(Math.round(outcome.ageMinutes))}m ago, no receipt yet; assuming the run is still starting`,
      );
    }
    return;
  }
  if (outcome.kind === "dead") {
    settleDeadRun(pending, `run on ${pending.slot} left no receipt (host-side failure)`, canRetry, context);
    return;
  }
  const prUrl = deliveredPrUrl(outcome.receipt);
  if (prUrl === undefined) {
    settleUndeliveredRun(pending, outcome.receipt, canRetry, context);
    return;
  }
  gateOnDeliveredPr(pending, prUrl, context.isDryRun);
}

function settleUndeliveredRun(pending: PendingRun, receipt: RunReceipt, canRetry: boolean, writes: CrankWrites): void {
  const { isDryRun, parkedIds } = writes;
  const stranded = strandedPrUrl(receipt);
  if (stranded !== undefined) {
    console.log(`reconcile: ${pending.id} died holding an open PR ${stranded}; parked on the PR`);
    if (!isDryRun) {
      parkWithOpenPr(
        { beadId: pending.id, prUrl: stranded, slot: pending.slot },
        `run ended ${receipt.stopReason} with its PR already open (${stranded}); read the PR before assuming the work was lost (${receipt.transcriptDir})`,
        parkedIds,
      );
    }
    return;
  }
  // Its commits never left the guest, so requeueing onto a fresh baseline would throw them away
  if ((receipt.commits ?? 0) > 0) {
    console.log(`reconcile: ${pending.id} committed but opened no PR; parked holding unpushed work`);
    if (!isDryRun) {
      parkBead(
        pending.id,
        pending.slot,
        `run committed but opened no PR (${receipt.stopReason}); the work is unpushed and survives only in the teardown mirror under refs/kiln/${pending.slot}/* (${receipt.transcriptDir})`,
        parkedIds,
      );
    }
    return;
  }
  settleDeadRun(
    pending,
    `run delivered nothing (${receipt.stopReason}, no commits, ${receipt.transcriptDir})`,
    canRetry,
    writes,
  );
}
