import type { ReviewCandidate } from "../gatekeeper/review-launch.ts";
import type { GateParks, ParkGate } from "../queue/gates.ts";

import { kilnConfig } from "../config/config.ts";
import { fetchPrState, fetchReviewCandidate } from "../gatekeeper/pr-views.ts";
import { escalationDoubt } from "../gatekeeper/review-launch.ts";
import { bd, bdJson, bdShow, listGates } from "../queue/bd-client.ts";
import { bdDependencySchema, bdIssueSchema } from "../queue/bd-records.ts";
import { escalatedGateIds, humanGatesBlocking, resolvedPrGateNumbers, strandedBeadIds } from "../queue/gate-reads.ts";
import { gateBlockedBeads, isGateLive, openGhPrGates, parkBehindGate, parkGates } from "../queue/gates.ts";
import { parseEach } from "../shared/lenient-json.ts";

interface GateCheckPass extends GateParks {
  escalated: Set<string>;
  standingParks: () => Array<ParkGate>;
}

export function checkGates(
  isDryRun: boolean,
  parkedIds: Set<string>,
  beadsByGate: Map<string, Array<string>>,
): Map<number, ReviewCandidate> {
  const candidates = new Map<number, ReviewCandidate>();
  const gates = openGhPrGates();
  if (gates.length === 0) {
    return candidates;
  }
  if (isDryRun) {
    console.log(`${String(gates.length)} open PR gate(s); gate check skipped (dry run)`);
    return candidates;
  }
  const checked = bd(["gate", "check", "--type=gh:pr"]);
  if (checked.length > 0) {
    console.log(checked);
  }
  // bd gate check changes nothing for a PR closed without merging, so the bead would stay gated forever unless this acts
  const escalated = new Set(escalatedGateIds(checked));
  let parks: Array<ParkGate> | undefined;
  const standingParks = () => (parks = parks ?? parkGates(beadsByGate));
  const pass: GateCheckPass = { beadsByGate, escalated, parkedIds, standingParks };
  for (const gate of gates) {
    const candidate = settleCheckedGate(gate, pass);
    if (candidate !== undefined) {
      candidates.set(candidate.number, candidate);
    }
  }
  return candidates;
}

function settleCheckedGate(gate: { awaitId: string; id: string }, pass: GateCheckPass): ReviewCandidate | undefined {
  const { beadsByGate, parkedIds } = pass;
  if (bdShow(gate.id)?.status === "closed") {
    closeBeadsBehindGate(gate, beadsByGate, pass.standingParks(), parkedIds);
    return undefined;
  }
  if (pass.escalated.has(gate.id)) {
    const reason = `PR #${gate.awaitId} closed without merge`;
    parkBehindGate(gate, reason, pass);
    bd(["gate", "resolve", gate.id, "--reason", reason]);
    return undefined;
  }
  if (!isGateLive(gateBlockedBeads(gate.id, beadsByGate), parkedIds)) {
    return undefined;
  }
  return settleEscalatedGate(gate, pass);
}

export function settleStrandedBeads(isDryRun: boolean, beadsByGate: Map<string, Array<string>>): void {
  const gatedIds = new Set(
    listGates()
      .filter((gate) => gate.status === "open")
      .flatMap((gate) => (gate.id === undefined ? [] : gateBlockedBeads(gate.id, beadsByGate))),
  );
  const inProgress = parseEach(bdIssueSchema, bdJson(["list", "--status", "in_progress", "--json"])).flatMap(
    ({ assignee, id }) => (id === undefined ? [] : [{ assignee: assignee ?? "", id }]),
  );
  const stranded = strandedBeadIds(inProgress, gatedIds).filter((beadId) => !didSettleLandedBead(beadId, isDryRun));
  if (stranded.length > 0) {
    console.warn(
      `reconcile: ${stranded.join(", ")} sit in_progress with no assignee and no open gate; nothing will move them (bd close <id> if its work landed, else bd update <id> --status open to requeue it)`,
    );
  }
}

type Landing = { kind: "landed"; prNumber: number } | { kind: "unknown" } | { kind: "unlanded" };

// A `bd gate check` run by hand resolves a merged PR's gate without closing its bead, so the gate pass never sees it
export function landingOf(beadId: string): Landing {
  const dependencies = parseEach(bdDependencySchema, bdJson(["dep", "list", beadId, "--json"]));
  let isUnknown = false;
  for (const prNumber of resolvedPrGateNumbers(dependencies)) {
    const state = fetchPrState(prNumber);
    if (state === "MERGED") {
      return { kind: "landed", prNumber };
    }
    if (state === undefined) {
      isUnknown = true;
    }
  }
  return { kind: isUnknown ? "unknown" : "unlanded" };
}

export function didCloseLandedPr(beadId: string, prNumber: number): boolean {
  if (!didCloseLandedBead(beadId, `landed: PR #${String(prNumber)} merged`, [])) {
    return false;
  }
  console.log(`closed ${beadId}: PR #${String(prNumber)} merged, its gate already resolved outside the crank`);
  maybeCloseParentEpic(beadId);
  return true;
}

function didSettleLandedBead(beadId: string, isDryRun: boolean): boolean {
  const landing = landingOf(beadId);
  if (landing.kind !== "landed") {
    return false;
  }
  if (isDryRun) {
    console.log(`would close ${beadId}: PR #${String(landing.prNumber)} merged (dry run)`);
    return true;
  }
  return didCloseLandedPr(beadId, landing.prNumber);
}

// bd won't close a bead an open human gate blocks, and with the PR gate already resolved no later crank would retry
function closeBeadsBehindGate(
  gate: { awaitId: string; id: string },
  beadsByGate: Map<string, Array<string>>,
  parks: Array<ParkGate>,
  parkedIds: Set<string>,
): void {
  for (const beadId of gateBlockedBeads(gate.id, beadsByGate)) {
    const bead = bdShow(beadId);
    if (bead === undefined || bead.status === "closed") {
      continue;
    }
    if (!didCloseLandedBead(beadId, `landed: PR #${gate.awaitId} merged`, parks)) {
      continue;
    }
    parkedIds.delete(beadId);
    console.log(`closed ${beadId}: PR #${gate.awaitId} merged`);
    maybeCloseParentEpic(beadId);
  }
}

/** @internal */
export function didCloseLandedBead(beadId: string, reason: string, parks: Array<ParkGate>): boolean {
  try {
    for (const parkId of humanGatesBlocking(beadId, parks)) {
      bd(["gate", "resolve", parkId, "--reason", reason]);
    }
    bd(["close", beadId, "--reason", reason]);
    return true;
  } catch (error) {
    console.warn(`  could not close ${beadId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function maybeCloseParentEpic(beadId: string): void {
  const [issue] = parseEach(bdIssueSchema, bdJson(["show", beadId, "--json"]));
  const parentId = issue?.parent;
  if (parentId === undefined) {
    return;
  }
  const [parentIssue] = parseEach(bdIssueSchema, bdJson(["show", parentId, "--json"]));
  if (parentIssue?.issue_type !== "epic" || parentIssue.status === "closed") {
    return;
  }
  const unfinished = parseEach(
    bdIssueSchema,
    bdJson(["list", "--parent", parentId, "--status", "open,in_progress,deferred", "--json"]),
  );
  if (unfinished.length > 0) {
    return;
  }
  bd(["close", parentId, "--reason", `all child slices closed (last: ${beadId})`]);
  console.log(`closed ${parentId}: last child ${beadId} landed`);
}

function settleEscalatedGate(gate: { awaitId: string; id: string }, parks: GateParks): ReviewCandidate | undefined {
  const prNumber = Number(gate.awaitId);
  if (kilnConfig.identity.gatekeeperLogin === undefined || !Number.isSafeInteger(prNumber)) {
    return undefined;
  }
  const candidate = fetchReviewCandidate(prNumber);
  if (candidate === undefined) {
    return undefined;
  }
  const doubt = escalationDoubt(candidate, kilnConfig.identity.gatekeeperLogin);
  if (doubt !== undefined) {
    parkBehindGate(gate, `PR #${String(prNumber)} escalated to a human`, parks, doubt);
  }
  return candidate;
}
