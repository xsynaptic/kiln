import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";

import type { CrankState } from "#src/dispatch/crank-state.ts";
import type { RunReceipt } from "#src/run/receipts.ts";

import { claimUnlandedBead } from "#src/dispatch/bead-launch.ts";
import { checkGates, settleStrandedBeads } from "#src/dispatch/gate-pass.ts";
import { readReceipts, reconcile } from "#src/dispatch/reconcile.ts";
import { dispatchComment } from "#src/dispatch/run-attempts.ts";
import {
  fetchPrState,
  fetchReviewCandidate,
  unclosedPrUrlsForBead,
  unclosedPrUrlsForHead,
} from "#src/gatekeeper/pr-views.ts";
import { bd, unclaimFromSlot } from "#src/queue/bd-client.ts";
import { parkedBeads } from "#src/queue/gates.ts";
import { agentRunsPath } from "#src/shared/run-artifacts.ts";

import type { FakeBd } from "./fake-bd.ts";
import type { FakeGithub } from "./fake-github.ts";

import { createFakeBd, spawnSyncAgainst } from "./fake-bd.ts";
import { createFakeGithub, prUrl } from "./fake-github.ts";
import { testReceipt } from "./receipt-fixture.ts";

export const slotNames = ["kiln-1", "kiln-2"];

export const outcomes = {
  apiError: { commits: 0, hasPr: false, stopReason: "failed:api_error" },
  committed: { commits: 1, hasPr: false, stopReason: "failed:exit:1" },
  delivered: { commits: 1, hasPr: true, stopReason: "completed" },
  diedWithPr: { commits: 1, hasPr: true, stopReason: "failed:exit:1" },
  noChange: {
    commits: 0,
    hasPr: false,
    outcome: { kind: "no-change", reason: "nothing to change" },
    stopReason: "completed",
  },
  noReceipt: undefined,
  nothing: { commits: 0, hasPr: false, stopReason: "completed" },
} as const satisfies Record<
  string,
  (Pick<RunReceipt, "commits" | "outcome" | "stopReason"> & { hasPr: boolean }) | undefined
>;

export type Outcome = keyof typeof outcomes;

// maxRunAttempts plus maxUnchargedProviderDeaths
const launchesWithoutAHuman = 2 + 5;

interface LiveRun {
  beadId: string;
  branch: string;
  mode: "detached" | "session";
  sessionPr?: number;
  startedAt: string;
}

export interface World {
  bd: FakeBd;
  beads: Array<string>;
  diedHoldingPr: Set<number>;
  github: FakeGithub;
  launches: Map<string, number>;
  reopened: Set<string>;
  repoRoot: string;
  runs: Map<string, LiveRun>;
  sessionPrs: Set<number>;
  sinceHuman: Map<string, number>;
}

export const reached = {
  deadRunPrGated: 0,
  landedBeadClosed: 0,
  openPrGated: 0,
  parkedBeadWaiting: 0,
  relaunch: 0,
  relaunchAtTheBound: 0,
  relaunchPastTheChargedAttempts: 0,
  reopenedBeadGated: 0,
  sessionPrGated: 0,
};

// The mocks of node:child_process and pr-views.ts live in the test file, which hoists them over this module too
export function freshWorld(beadCount: number): World {
  const github = createFakeGithub();
  const fakeBd = createFakeBd((prNumber) => github.fetchPrState(prNumber));
  vi.mocked(spawnSync).mockImplementation(spawnSyncAgainst(fakeBd));
  vi.mocked(fetchPrState).mockImplementation((prNumber) => github.fetchPrState(prNumber));
  vi.mocked(fetchReviewCandidate).mockImplementation((prNumber) => github.fetchReviewCandidate(prNumber));
  vi.mocked(unclosedPrUrlsForBead).mockImplementation((beadId, since) => github.unclosedPrUrlsForBead(beadId, since));
  vi.mocked(unclosedPrUrlsForHead).mockImplementation((head, since) => github.unclosedPrUrlsForHead(head, since));
  const runsDir = mkdtempSync(path.join(tmpdir(), "kiln-lifecycle-"));
  vi.stubEnv("KILN_RUNS_DIR", runsDir);
  return {
    bd: fakeBd,
    beads: Array.from({ length: beadCount }, (_unused, index) => fakeBd.createBead(`bead ${String(index)}`)),
    diedHoldingPr: new Set(),
    github,
    launches: new Map(),
    reopened: new Set(),
    repoRoot: runsDir,
    runs: new Map(),
    sessionPrs: new Set(),
    sinceHuman: new Map(),
  };
}

// The phases of crank() in its order, with claimUnlandedBead and the dispatch comment standing in for fillSlots
export function crank(world: World, isLaunchFailing: boolean): void {
  const { repoRoot } = world;
  const slots = slotNames.map((name) => ({ busy: world.runs.has(name), name, ready: true, state: "running" as const }));
  const beadsByGate = new Map<string, Array<string>>();
  const parkedIds = new Set(parkedBeads(beadsByGate));
  const crankState: CrankState = {
    beadsByGate,
    flags: { dial: slotNames.length, isDryRun: false, keepWarm: 0 },
    isQuiet: true,
    parkedIds,
    receipts: readReceipts(repoRoot),
    repoRoot,
    slots,
  };
  checkGates(false, parkedIds, beadsByGate);
  reconcile(crankState);
  settleStrandedBeads(false, beadsByGate);
  for (const slot of slots) {
    if (slot.busy) {
      continue;
    }
    const bead = claimUnlandedBead(slot.name);
    if (bead === undefined) {
      return;
    }
    // dispatchToSlot rethrows after the unclaim, which ends the crank
    if (isLaunchFailing) {
      unclaimFromSlot(bead.id, slot.name, `launch on ${slot.name} failed before the run started; requeued`);
      return;
    }
    const branch = `feat/${bead.id}`;
    bd(["comment", bead.id, dispatchComment(slot.name, branch)]);
    world.runs.set(slot.name, { beadId: bead.id, branch, mode: "detached", startedAt: new Date().toISOString() });
    world.launches.set(bead.id, (world.launches.get(bead.id) ?? 0) + 1);
    world.sinceHuman.set(bead.id, (world.sinceHuman.get(bead.id) ?? 0) + 1);
  }
}

function appendReceipt(world: World, receipt: RunReceipt): void {
  const file = agentRunsPath(world.repoRoot, "runs.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(receipt)}\n`);
}

function runReceipt(run: LiveRun, slot: string, fields: Partial<RunReceipt>): RunReceipt {
  return testReceipt({
    bead: run.beadId,
    branch: run.branch,
    endedAt: new Date().toISOString(),
    slot,
    startedAt: run.startedAt,
    ...fields,
  });
}

export function endRun(world: World, slot: string, outcome: Outcome): void {
  const run = world.runs.get(slot);
  world.runs.delete(slot);
  const shape = outcomes[outcome];
  if (run === undefined || shape === undefined) {
    return;
  }
  const { hasPr, ...fields } = shape;
  const pr = hasPr ? world.github.open(run.beadId, run.branch) : undefined;
  appendReceipt(world, runReceipt(run, slot, { ...fields, ...(pr === undefined ? {} : { prUrl: prUrl(pr.number) }) }));
}

export function aHumanActsOn(world: World, beadId: string): void {
  world.sinceHuman.set(beadId, 0);
}

export function aHumanAbortsTheRun(world: World, slot: string): void {
  const run = world.runs.get(slot);
  world.runs.delete(slot);
  if (run === undefined) {
    return;
  }
  aHumanActsOn(world, run.beadId);
  appendReceipt(world, runReceipt(run, slot, { commits: 0, stopReason: "signalled:SIGINT" }));
}

export function wrapperDiesAfterThePrOpens(world: World, slot: string): void {
  const run = world.runs.get(slot);
  world.runs.delete(slot);
  if (run !== undefined) {
    world.diedHoldingPr.add(world.github.open(run.beadId, run.branch).number);
  }
}

export function sessionClaims(world: World, slot: string, beadId: string): void {
  world.bd.run(["update", beadId, "--claim", "--actor", slot]);
  const branch = `attended/${beadId}`;
  aHumanActsOn(world, beadId);
  world.runs.set(slot, { beadId, branch, mode: "session", startedAt: new Date().toISOString() });
}

export function sessionOpensItsPr(world: World, slot: string): void {
  const run = world.runs.get(slot);
  if (run === undefined) {
    return;
  }

  run.sessionPr = world.github.open(run.beadId, run.branch).number;
  world.sessionPrs.add(run.sessionPr);
}

// An anchored wrapper reads the PR for its branch in any state, so a session that opened one reads as delivered
export function sessionEnds(world: World, slot: string, isAnchored: boolean): void {
  const run = world.runs.get(slot);
  world.runs.delete(slot);
  if (run === undefined) {
    return;
  }
  if (!isAnchored) {
    if (run.sessionPr !== undefined) world.diedHoldingPr.add(run.sessionPr);
    return;
  }
  appendReceipt(
    world,
    runReceipt(run, slot, {
      commits: run.sessionPr === undefined ? 0 : 1,
      mode: "attended",
      stopReason: "completed",
      ...(run.sessionPr === undefined ? {} : { prUrl: prUrl(run.sessionPr) }),
    }),
  );
}

function liveRunOn(world: World, id: string): LiveRun | undefined {
  for (const run of world.runs.values()) {
    if (run.beadId === id) {
      return run;
    }
  }
  return undefined;
}

export function beadView(world: World, id: string) {
  const issue = world.bd.issues.get(id);
  if (issue === undefined) {
    throw new Error(`the fake bd lost ${id}`);
  }
  const gates = world.bd.gatesBlocking(id);
  const prs = world.github.prs.filter((pr) => pr.bead === id);
  const openPrGates = gates.filter((gate) => gate.status === "open" && gate.awaitType === "gh:pr");
  const isMergedPr = (awaitId: string | undefined) =>
    prs.find((pr) => String(pr.number) === awaitId)?.state === "MERGED";
  return {
    isClosed: issue.status === "closed",
    isHeld: issue.assignee !== "",
    isLanded:
      issue.status === "in_progress" &&
      gates.some((gate) => gate.status === "closed" && gate.awaitType === "gh:pr" && isMergedPr(gate.awaitId)),
    isParked: gates.some((gate) => gate.status === "open" && gate.awaitType === "human"),
    isPrGated: openPrGates.length > 0,
    issue,
    live: liveRunOn(world, id),
    openPrGates: openPrGates.map((gate) => gate.awaitId),
    prs,
  };
}

type BeadView = ReturnType<typeof beadView>;

export function isReady(view: BeadView): boolean {
  return view.issue.status === "open" && !view.isHeld && !view.isPrGated && !view.isParked;
}

function expectAccounted(view: BeadView): void {
  const isAccounted = view.isClosed || isReady(view) || view.isHeld || view.isPrGated || view.isParked || view.isLanded;
  expect(isAccounted, `${view.issue.id} is ${view.issue.status} with nothing to move it`).toBe(true);
}

function expectResolvedParkFrees(view: BeadView): void {
  if (!view.isParked || view.isHeld || view.isClosed) {
    return;
  }
  reached.parkedBeadWaiting += 1;
  const isFreed = view.issue.status === "open" || view.isPrGated || view.isLanded;
  expect(isFreed, `${view.issue.id} stays ${view.issue.status} once its park resolves`).toBe(true);
}

// An attended session is the operator's choice of bead, so the rule is dispatch's alone
function expectNoRelaunchAfterLanding(world: World, view: BeadView): void {
  if (view.live?.mode !== "detached") {
    return;
  }
  if ((world.launches.get(view.issue.id) ?? 0) > 1) {
    reached.relaunch += 1;
  }
  const merged = view.prs.filter((pr) => pr.state === "MERGED").map((pr) => pr.number);
  expect(merged, `a run works on ${view.issue.id} after its PR landed`).toEqual([]);
}

function countGatedPr(world: World, view: BeadView, prNumber: number): void {
  reached.openPrGated += 1;
  if (world.reopened.has(view.issue.id)) reached.reopenedBeadGated += 1;
  if (world.diedHoldingPr.has(prNumber)) reached.deadRunPrGated += 1;
  if (world.sessionPrs.has(prNumber)) reached.sessionPrGated += 1;
}

function expectDeliveredPrGates(world: World, view: BeadView): void {
  for (const pr of view.prs) {
    if (pr.state !== "OPEN") {
      continue;
    }
    const isUnread = view.isHeld && view.live === undefined;
    const isGated = view.openPrGates.includes(String(pr.number));
    if (isGated && !view.isHeld) {
      countGatedPr(world, view, pr.number);
    }
    const isSessionLive = view.live?.mode === "session";
    expect(
      isGated || view.isClosed || isUnread || isSessionLive,
      `PR #${String(pr.number)} of ${view.issue.id} is open ungated`,
    ).toBe(true);
  }
}

function expectRelaunchesBounded(world: World, id: string): void {
  const launches = world.sinceHuman.get(id) ?? 0;
  if (launches > 2) {
    reached.relaunchPastTheChargedAttempts += 1;
  }
  if (launches === launchesWithoutAHuman) {
    reached.relaunchAtTheBound += 1;
  }
  expect(launches, `${id} launched ${String(launches)} times without a human`).toBeLessThanOrEqual(
    launchesWithoutAHuman,
  );
}

export function expectInvariants(world: World): void {
  for (const id of world.beads) {
    const view = beadView(world, id);
    expectRelaunchesBounded(world, id);
    expectAccounted(view);
    expectResolvedParkFrees(view);
    expectNoRelaunchAfterLanding(world, view);
    expectDeliveredPrGates(world, view);
    if (view.isClosed && view.prs.some((pr) => pr.state === "MERGED")) {
      reached.landedBeadClosed += 1;
    }
  }
}
