import { describe, expect, it, vi } from "vitest";

import { claimUnlandedBead } from "#src/dispatch/bead-launch.ts";
import { didCloseLandedBead } from "#src/dispatch/gate-pass.ts";
import { fetchPrState } from "#src/gatekeeper/pr-views.ts";
import {
  bd,
  bdComments,
  bdReady,
  bdShow,
  claimNextReady,
  dispatchActor,
  releaseSlotClaim,
  unclaimFromSlot,
} from "#src/queue/bd-client.ts";
import { parkBead, parkBehindGate, parkGates, parkStalledRun, parkWithOpenPr } from "#src/queue/gates.ts";
import { useBdStore } from "#support/bd-store.ts";

vi.mock(import("#src/gatekeeper/pr-views.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPrState: vi.fn(),
}));

const testSlot = "kiln-9";

const { createBead, prGateOn, ...store } = useBdStore();

function claimedBead(title: string): string {
  return store.claimedBead(title, testSlot);
}

function quietly<Result>(step: () => Result): Result {
  const log = vi.spyOn(console, "log").mockReturnValue();
  try {
    return step();
  } finally {
    log.mockRestore();
  }
}

function escalatedBead(title: string): { id: string; prGate: { awaitId: string; id: string } } {
  const id = claimedBead(title);
  const prGate = prGateOn(id, "7");
  releaseSlotClaim(id, testSlot, "in_progress");
  quietly(() => {
    parkBehindGate(prGate, "PR #7 escalated to a human", { beadsByGate: new Map(), parkedIds: new Set() });
  });
  return { id, prGate };
}

function isReady(id: string): boolean {
  return bdReady().some((bead) => bead.id === id);
}

function parkOf(id: string): string {
  const park = parkGates(new Map()).find((gate) => gate.blocked.includes(id));
  if (park === undefined) {
    throw new Error(`no human gate parks ${id}`);
  }
  return park.id;
}

describe("the slot claim lifecycle against the installed bd", () => {
  it("claims a ready bead for the slot", () => {
    createBead("ready for a slot");
    const claimed = claimNextReady(testSlot);
    expect(claimed?.assignee).toBe(testSlot);
    expect(bdShow(claimed?.id ?? "")?.status).toBe("in_progress");
  });

  it("releases a delivered bead's claim and keeps it in progress", () => {
    const id = claimedBead("delivered");
    releaseSlotClaim(id, testSlot, "in_progress");
    expect(bdShow(id)).toMatchObject({ assignee: "", status: "in_progress" });
  });

  it("requeues a bead the slot holds and leaves the reason on it", () => {
    const id = claimedBead("requeued");
    unclaimFromSlot(id, testSlot, "run delivered nothing; requeued for one retry");
    expect(bdShow(id)).toMatchObject({ assignee: "", status: "open" });
    expect(bdComments(id)).toContainEqual(
      expect.objectContaining({ author: dispatchActor, text: "run delivered nothing; requeued for one retry" }),
    );
  });

  it("leaves a bead another slot holds to its holder", () => {
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    const id = claimedBead("held elsewhere");
    releaseSlotClaim(id, "kiln-8", "in_progress");
    unclaimFromSlot(id, "kiln-8", "never applied");
    expect(bdShow(id)).toMatchObject({ assignee: testSlot, status: "in_progress" });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("parks against the installed bd", { timeout: 30_000 }, () => {
  it("returns a parked bead to bd ready once a human resolves its gate", () => {
    const id = claimedBead("parked");
    parkBead(id, testSlot, "run delivered nothing", new Set());
    expect(isReady(id)).toBe(false);
    bd(["gate", "resolve", parkOf(id), "--reason", "unparked"]);
    expect(isReady(id)).toBe(true);
  });

  it("holds an escalated bead behind its open PR gate, then closes it from open on the merge", () => {
    const { id, prGate } = escalatedBead("escalated");
    expect(bdShow(id)).toMatchObject({ assignee: "", status: "open" });
    bd(["gate", "resolve", parkOf(id), "--reason", "reviewed"]);
    expect(isReady(id)).toBe(false);
    bd(["gate", "resolve", prGate.id, "--reason", "merged"]);
    expect(didCloseLandedBead(id, "landed: PR #7 merged", [])).toBe(true);
    expect(bdShow(id)?.status).toBe("closed");
  });
});

describe("landing and parking paths the lifecycle model found", { timeout: 30_000 }, () => {
  it("reopens a stalled run's delivered bead when its PR closes unmerged, so resolving the park requeues it", () => {
    const id = claimedBead("stalled, delivered, closed unmerged");
    parkStalledRun(id, testSlot, 6, new Set());
    const prGate = prGateOn(id, "9");
    releaseSlotClaim(id, testSlot, "in_progress");
    quietly(() => {
      parkBehindGate(prGate, "PR #9 closed without merge", { beadsByGate: new Map(), parkedIds: new Set([id]) });
    });
    bd(["gate", "resolve", prGate.id, "--reason", "PR #9 closed without merge"]);
    bd(["gate", "resolve", parkOf(id), "--reason", "unparked"]);
    expect(isReady(id)).toBe(true);
  });

  it("holds a run that died with its PR open behind that PR once its park resolves", () => {
    const id = claimedBead("died with its PR open");
    parkWithOpenPr({ beadId: id, prUrl: "https://github.com/acme/sample/pull/11", slot: testSlot }, "died", new Set());
    bd(["gate", "resolve", parkOf(id), "--reason", "unparked"]);
    expect(bdShow(id)).toMatchObject({ assignee: "", status: "open" });
    expect(isReady(id)).toBe(false);
  });

  it("closes a bead whose PR landed outside the crank instead of launching it", () => {
    vi.mocked(fetchPrState).mockReturnValue("MERGED");
    const id = createBead("landed outside the crank", "0");
    const prGate = prGateOn(id, "12");
    bd(["gate", "resolve", prGate.id, "--reason", "a bare bd gate check"]);
    expect(isReady(id)).toBe(true);
    const launched = quietly(() => claimUnlandedBead(testSlot));
    expect(launched?.id).not.toBe(id);
    expect(bdShow(id)?.status).toBe("closed");
  });
});
