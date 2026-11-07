import { fc, test } from "@fast-check/vitest";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Outcome, World } from "#support/lifecycle-world.ts";

import { needsHumanLabel } from "#src/gatekeeper/review-launch.ts";
import {
  aHumanAbortsTheRun,
  aHumanActsOn,
  beadView,
  crank,
  endRun,
  expectInvariants,
  freshWorld,
  isReady,
  outcomes,
  reached,
  sessionClaims,
  sessionEnds,
  sessionOpensItsPr,
  slotNames,
  wrapperDiesAfterThePrOpens,
} from "#support/lifecycle-world.ts";

vi.mock(import("node:child_process"), async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: vi.fn(),
}));

vi.mock(import("#src/gatekeeper/pr-views.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPrState: vi.fn(),
  fetchReviewCandidate: vi.fn(),
  unclosedPrUrlsForBead: vi.fn(),
  unclosedPrUrlsForHead: vi.fn(),
}));

// Past the launch grace window, so a run with no receipt reads as dead on the next crank
const stepMs = 11 * 60_000;

function quietly(step: () => void): void {
  const log = vi.spyOn(console, "log").mockReturnValue();
  const warn = vi.spyOn(console, "warn").mockReturnValue();
  try {
    step();
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

function action(label: string, isEnabled: (world: Readonly<World>) => boolean, act: (world: World) => void) {
  return {
    check: (world: Readonly<World>) => isEnabled(world),
    run: (_model: World, world: World) => {
      vi.setSystemTime(Date.now() + stepMs);
      quietly(() => {
        act(world);
      });
      expectInvariants(world);
    },
    toString: () => label,
  } satisfies fc.Command<World, World>;
}

function beadAt(world: Readonly<World>, index: number): string {
  return world.beads[index % world.beads.length] ?? "";
}

function prAt(world: Readonly<World>, index: number) {
  return world.github.prs[index % Math.max(1, world.github.prs.length)];
}

function runOf(world: Readonly<World>, slot: string, mode: "detached" | "session") {
  const run = world.runs.get(slot);
  return run?.mode === mode ? run : undefined;
}

function isHoldingItsBead(world: Readonly<World>, slot: string, mode: "detached" | "session"): boolean {
  const run = runOf(world, slot, mode);
  return run !== undefined && world.bd.issues.get(run.beadId)?.assignee === slot;
}

function isGatekeeperReviewing(world: Readonly<World>, index: number): boolean {
  const pr = prAt(world, index);
  if (pr?.state !== "OPEN" || pr.labels.includes(needsHumanLabel)) {
    return false;
  }
  const view = beadView(world, pr.bead);
  return view.openPrGates.includes(String(pr.number)) && !view.isParked;
}

function sessionBead(world: Readonly<World>, slot: string): string {
  return world.runs.get(slot)?.beadId ?? "";
}

function resolveTheParkOn(world: World, bead: string): void {
  const park = world.bd.gatesBlocking(bead).find((gate) => gate.status === "open" && gate.awaitType === "human");
  world.bd.run(["gate", "resolve", park?.id ?? "", "--reason", "unparked", "--actor", "someone"]);
}

function closeUnmerged(world: World, prNumber: number): void {
  const pr = world.github.prs.find((candidate) => candidate.number === prNumber);
  if (pr !== undefined) pr.state = "CLOSED";
}

function replayInOrder(world: World, steps: Array<() => void>): void {
  for (const step of steps) {
    vi.setSystemTime(Date.now() + stepMs);
    quietly(step);
    expectInvariants(world);
  }
}

const slot = fc.constantFrom(...slotNames);
const beadIndex = fc.nat({ max: 2 });
const prIndex = fc.nat({ max: 5 });

const crankRuns = fc.boolean().map((isLaunchFailing) =>
  action(
    isLaunchFailing ? "TheCrankRunsAndALaunchFails" : "TheCrankRuns",
    () => true,
    (world) => {
      crank(world, isLaunchFailing);
    },
  ),
);

const runEnds = fc.tuple(slot, fc.constantFrom(...(Object.keys(outcomes) as Array<Outcome>))).map(([name, outcome]) =>
  action(
    `TheRunEnds(${name}, ${outcome})`,
    (world) => runOf(world, name, "detached") !== undefined,
    (world) => {
      endRun(world, name, outcome);
    },
  ),
);

// Its own action as well as an outcome, so runs of free retries come up often enough to pass the charged attempts
const providerDrops = slot.map((name) =>
  action(
    `TheProviderDropsTheRun(${name})`,
    (world) => runOf(world, name, "detached") !== undefined,
    (world) => {
      endRun(world, name, "apiError");
    },
  ),
);

const humanAborts = slot.map((name) =>
  action(
    `AHumanAbortsTheRun(${name})`,
    (world) => runOf(world, name, "detached") !== undefined,
    (world) => {
      aHumanAbortsTheRun(world, name);
    },
  ),
);

const detachedRunActions = [
  runEnds,
  providerDrops,
  humanAborts,
  slot.map((name) =>
    action(
      `TheHostWrapperDiesAfterThePrOpens(${name})`,
      (world) => runOf(world, name, "detached") !== undefined,
      (world) => {
        wrapperDiesAfterThePrOpens(world, name);
      },
    ),
  ),
];

const sessionActions = [
  fc.tuple(slot, beadIndex).map(([name, index]) =>
    action(
      `AnAttendedSessionClaims(${name}, ${String(index)})`,
      (world) => !world.runs.has(name) && isReady(beadView(world, beadAt(world, index))),
      (world) => {
        sessionClaims(world, name, beadAt(world, index));
      },
    ),
  ),
  slot.map((name) =>
    action(
      `TheSessionOpensItsPr(${name})`,
      (world) => isHoldingItsBead(world, name, "session") && runOf(world, name, "session")?.sessionPr === undefined,
      (world) => {
        sessionOpensItsPr(world, name);
      },
    ),
  ),
  slot.map((name) =>
    action(
      `TheSessionGatesItsPr(${name})`,
      (world) =>
        isHoldingItsBead(world, name, "session") &&
        runOf(world, name, "session")?.sessionPr !== undefined &&
        !beadView(world, sessionBead(world, name)).isPrGated,
      (world) => {
        const prNumber = String(runOf(world, name, "session")?.sessionPr ?? "");
        const id = sessionBead(world, name);
        world.bd.run(["gate", "create", "--type=gh:pr", "--blocks", id, `--await-id=${prNumber}`, "--actor", name]);
      },
    ),
  ),
  slot.map((name) =>
    action(
      `TheSessionReleasesItsClaim(${name})`,
      (world) => isHoldingItsBead(world, name, "session") && beadView(world, sessionBead(world, name)).isPrGated,
      (world) => {
        world.bd.run(["update", sessionBead(world, name), "--assignee", "", "--actor", name]);
      },
    ),
  ),
  slot.map((name) =>
    action(
      `TheSessionParksItsBead(${name})`,
      (world) =>
        isHoldingItsBead(world, name, "session") &&
        runOf(world, name, "session")?.sessionPr === undefined &&
        !beadView(world, sessionBead(world, name)).isParked,
      (world) => {
        const id = sessionBead(world, name);
        world.bd.run(["gate", "create", "--type=human", "--blocks", id, "--reason", "needs a human", "--actor", name]);
      },
    ),
  ),
  slot.map((name) =>
    action(
      `TheSessionUnclaimsItsParkedBead(${name})`,
      (world) =>
        isHoldingItsBead(world, name, "session") &&
        runOf(world, name, "session")?.sessionPr === undefined &&
        beadView(world, sessionBead(world, name)).isParked,
      (world) => {
        world.bd.run(["unclaim", sessionBead(world, name), "--actor", name]);
      },
    ),
  ),
  fc.tuple(slot, fc.boolean()).map(([name, isAnchored]) =>
    action(
      `TheSessionEnds(${name}, ${isAnchored ? "anchored" : "detached"})`,
      (world) => runOf(world, name, "session") !== undefined,
      (world) => {
        sessionEnds(world, name, isAnchored);
      },
    ),
  ),
];

const resolvesAPark = beadIndex.map((index) =>
  action(
    `AHumanResolvesAPark(${String(index)})`,
    (world) => beadView(world, beadAt(world, index)).isParked,
    (world) => {
      const park = world.bd
        .gatesBlocking(beadAt(world, index))
        .find((gate) => gate.status === "open" && gate.awaitType === "human");
      aHumanActsOn(world, beadAt(world, index));
      world.bd.run(["gate", "resolve", park?.id ?? "", "--reason", "unparked", "--actor", "someone"]);
    },
  ),
);

const outsideActions = [
  beadIndex.map((index) =>
    action(
      `SomeoneReopensAClaimedBead(${String(index)})`,
      (world) => {
        const issue = world.bd.issues.get(beadAt(world, index));
        return issue?.assignee !== "" && issue?.status === "in_progress";
      },
      (world) => {
        const id = beadAt(world, index);
        world.reopened.add(id);
        aHumanActsOn(world, id);
        world.bd.run(["update", id, "--status", "open", "--actor", "someone"]);
      },
    ),
  ),
  fc.tuple(prIndex, fc.boolean()).map(([index, isMerge]) =>
    action(
      isMerge ? `TheGatekeeperMerges(${String(index)})` : `TheGatekeeperEscalates(${String(index)})`,
      (world) => isGatekeeperReviewing(world, index),
      (world) => {
        const pr = prAt(world, index);
        if (pr === undefined) return;
        if (isMerge) pr.state = "MERGED";
        else pr.labels.push(needsHumanLabel);
      },
    ),
  ),
  fc.tuple(prIndex, fc.constantFrom("MERGED", "CLOSED")).map(([index, state]) =>
    action(
      state === "MERGED" ? `AHumanMergesThePr(${String(index)})` : `AHumanClosesThePrUnmerged(${String(index)})`,
      (world) => prAt(world, index)?.state === "OPEN",
      (world) => {
        const pr = prAt(world, index);
        if (pr !== undefined) pr.state = state;
      },
    ),
  ),
  resolvesAPark,
  fc.boolean().map((isReachable) =>
    action(
      isReachable ? "GitHubComesBack" : "GitHubGoesDown",
      (world) => world.github.reach.isReachable !== isReachable,
      (world) => {
        world.github.reach.isReachable = isReachable;
      },
    ),
  ),
  fc.constant(
    action(
      "AHumanRunsGateCheck",
      () => true,
      (world) => {
        world.bd.run(["gate", "check", "--type=gh:pr", "--actor", "someone"]);
      },
    ),
  ),
];

// The crank is listed twice, since every other actor needs a state only a crank produces
const lifecycleActions = [crankRuns, crankRuns, ...detachedRunActions, ...sessionActions, ...outsideActions];

// One bead and the actors that decide a retry, so a run of free deaths long enough to reach the cap comes up
const retryActions = [
  crankRuns,
  crankRuns,
  runEnds,
  providerDrops,
  providerDrops,
  providerDrops,
  providerDrops,
  humanAborts,
  resolvesAPark,
];

const worlds: Array<World> = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T08:00:00.000Z"));
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const world of worlds) rmSync(world.repoRoot, { force: true, recursive: true });
});

describe("the real dispatch code across lifecycle sequences", () => {
  test.prop([fc.integer({ max: 3, min: 2 }), fc.commands(lifecycleActions, { maxCommands: 150, size: "max" })], {
    numRuns: 300,
  })(
    "keeps every bead accounted, freed by its park, gated by its PR, and never relaunched once landed",
    (beadCount, commands) => {
      const world = freshWorld(beadCount);
      worlds.push(world);
      fc.modelRun(() => ({ model: world, real: world }), commands);
    },
  );

  test.prop([fc.commands(retryActions, { maxCommands: 80, size: "max" })], { numRuns: 200 })(
    "launches a bead at most its charged attempts plus its free provider deaths without a human",
    (commands) => {
      const world = freshWorld(1);
      worlds.push(world);
      fc.modelRun(() => ({ model: world, real: world }), commands);
    },
  );

  it("keeps an attended session's PR gated when an earlier parked run of its bead left a receipt", () => {
    const world = freshWorld(2);
    worlds.push(world);
    const bead = world.beads[1] ?? "";
    replayInOrder(world, [
      () => {
        crank(world, false);
      },
      () => {
        endRun(world, "kiln-2", "committed");
      },
      () => {
        crank(world, false);
      },
      () => {
        resolveTheParkOn(world, bead);
      },
      () => {
        sessionClaims(world, "kiln-2", bead);
        sessionOpensItsPr(world, "kiln-2");
        sessionEnds(world, "kiln-2", false);
      },
      () => {
        crank(world, false);
      },
    ]);
    expect(beadView(world, bead).openPrGates).toEqual(["1"]);
  });

  it("keeps an attended session's PR gated when its bead's last claim delivered a PR that closed unmerged", () => {
    const world = freshWorld(2);
    worlds.push(world);
    const bead = world.beads[1] ?? "";
    replayInOrder(world, [
      () => {
        crank(world, false);
      },
      () => {
        endRun(world, "kiln-2", "delivered");
      },
      () => {
        crank(world, false);
      },
      () => {
        closeUnmerged(world, 1);
      },
      () => {
        crank(world, false);
      },
      () => {
        resolveTheParkOn(world, bead);
      },
      () => {
        sessionClaims(world, "kiln-2", bead);
        sessionOpensItsPr(world, "kiln-2");
        sessionEnds(world, "kiln-2", false);
      },
      () => {
        crank(world, false);
      },
    ]);
    expect(beadView(world, bead).openPrGates).toEqual(["2"]);
  });

  it("keeps a second attended session's PR gated when the first one's anchored PR closed unmerged", () => {
    const world = freshWorld(1);
    worlds.push(world);
    const bead = world.beads[0] ?? "";
    replayInOrder(world, [
      () => {
        sessionClaims(world, "kiln-1", bead);
        sessionOpensItsPr(world, "kiln-1");
        sessionEnds(world, "kiln-1", true);
      },
      () => {
        crank(world, false);
      },
      () => {
        closeUnmerged(world, 1);
      },
      () => {
        crank(world, false);
      },
      () => {
        resolveTheParkOn(world, bead);
      },
      () => {
        sessionClaims(world, "kiln-1", bead);
        sessionOpensItsPr(world, "kiln-1");
        sessionEnds(world, "kiln-1", false);
      },
      () => {
        crank(world, false);
      },
    ]);
    expect(beadView(world, bead).openPrGates).toEqual(["2"]);
  });

  it("reaches every case the invariants guard", () => {
    expect(Object.entries(reached).filter(([, count]) => count === 0)).toEqual([]);
  });
});
