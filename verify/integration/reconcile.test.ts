import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrankState } from "#src/dispatch/crank-state.ts";
import type { RunReceipt } from "#src/run/receipts.ts";

import { reconcile } from "#src/dispatch/reconcile.ts";
import { dispatchComment } from "#src/dispatch/run-attempts.ts";
import { launchGraceMinutes } from "#src/dispatch/run-liveness.ts";
import { unclosedPrUrlsForBead, unclosedPrUrlsForHead } from "#src/gatekeeper/pr-views.ts";
import { bd, bdReady, bdShow } from "#src/queue/bd-client.ts";
import { openGhPrGates, parkGates } from "#src/queue/gates.ts";
import { useBdStore } from "#support/bd-store.ts";
import { testReceipt } from "#support/receipt-fixture.ts";

vi.mock(import("#src/gatekeeper/pr-views.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  unclosedPrUrlsForBead: vi.fn(),
  unclosedPrUrlsForHead: vi.fn(),
}));

const slot = "kiln-8";
const branch = "feat/sample";

const store = useBdStore();

beforeAll(() => {
  const runsDir = mkdtempSync(path.join(tmpdir(), "kiln-runs-"));
  vi.stubEnv("KILN_RUNS_DIR", runsDir);
});

beforeEach(() => {
  vi.mocked(unclosedPrUrlsForBead).mockReturnValue([]);
  vi.mocked(unclosedPrUrlsForHead).mockReturnValue([]);
});

function crankStateFor(receipts: Array<RunReceipt>): CrankState {
  return {
    beadsByGate: new Map(),
    flags: { dial: 0, isDryRun: false, keepWarm: 0 },
    isQuiet: true,
    parkedIds: new Set(),
    receipts,
    repoRoot: store.root(),
    slots: [{ busy: false, name: slot, ready: true, state: "running" }],
  };
}

function launchedBead(title: string): string {
  const id = store.claimedBead(title, slot);
  bd(["comment", id, dispatchComment(slot, branch)]);
  return id;
}

function reconcileQuietly(receipts: Array<RunReceipt>): void {
  const log = vi.spyOn(console, "log").mockReturnValue();
  try {
    reconcile(crankStateFor(receipts));
  } finally {
    log.mockRestore();
  }
}

// Past the launch grace window, so a run with no receipt reads as dead
function reconcileAfterTheGrace(): void {
  vi.useFakeTimers({ now: Date.now() + (launchGraceMinutes + 1) * 60_000, toFake: ["Date"] });
  try {
    reconcileQuietly([]);
  } finally {
    vi.useRealTimers();
  }
}

function isParked(id: string): boolean {
  return parkGates(new Map()).some((gate) => gate.blocked.includes(id));
}

function prGatesOn(id: string): Array<string> {
  return openGhPrGates()
    .filter((gate) => bd(["dep", "list", gate.id, "--direction", "up", "--json"]).includes(id))
    .map((gate) => gate.awaitId);
}

describe("reconcile paths the lifecycle model found", { timeout: 30_000 }, () => {
  it("gates a delivered run's PR when the bead was reopened before reconcile read its receipt", () => {
    const id = launchedBead("reopened while its run delivered");
    const delivered = testReceipt({
      bead: id,
      branch,
      commits: 1,
      prUrl: "https://github.com/acme/sample/pull/21",
      slot,
      startedAt: new Date().toISOString(),
    });
    store.shell("bd", ["update", id, "--status", "open", "--actor", "someone"]);
    reconcileQuietly([delivered]);
    expect(prGatesOn(id)).toEqual(["21"]);
    expect(bdShow(id)).toMatchObject({ assignee: "", status: "in_progress" });
    expect(bdReady().map((bead) => bead.id)).not.toContain(id);
  });

  it("parks a run whose host wrapper died after the guest opened its PR, behind that PR", () => {
    vi.mocked(unclosedPrUrlsForHead).mockImplementation((head) =>
      head === branch ? ["https://github.com/acme/sample/pull/22"] : [],
    );
    const id = launchedBead("wrapper died after the PR opened");
    reconcileAfterTheGrace();
    expect(prGatesOn(id)).toEqual(["22"]);
    expect(isParked(id)).toBe(true);
    expect(bdReady().map((bead) => bead.id)).not.toContain(id);
  });

  it("parks an attended session that ended unanchored before it gated its PR, behind that PR", () => {
    vi.mocked(unclosedPrUrlsForBead).mockImplementation((beadId) =>
      beadId === id ? ["https://github.com/acme/sample/pull/23"] : [],
    );
    const id = store.claimedBead("attended session died before its gate", slot);
    reconcileAfterTheGrace();
    expect(prGatesOn(id)).toEqual(["23"]);
    expect(isParked(id)).toBe(true);
    expect(bdReady().map((bead) => bead.id)).not.toContain(id);
  });

  it("gates every PR a dead claim's bead has, when its branch on file is an earlier run's", () => {
    vi.mocked(unclosedPrUrlsForHead).mockImplementation((head) =>
      head === branch ? ["https://github.com/acme/sample/pull/24"] : [],
    );
    vi.mocked(unclosedPrUrlsForBead).mockImplementation((beadId) =>
      beadId === id ? ["https://github.com/acme/sample/pull/25", "https://github.com/acme/sample/pull/24"] : [],
    );
    const id = launchedBead("an earlier run's branch, then a session's PR");
    reconcileAfterTheGrace();
    expect(prGatesOn(id).toSorted()).toEqual(["24", "25"]);
    expect(isParked(id)).toBe(true);
  });
});
