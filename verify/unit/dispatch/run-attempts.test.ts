import { describe, expect, it } from "vitest";

import type { BeadComment } from "#src/queue/bd-client.ts";
import type { RunReceipt } from "#src/run/receipts.ts";

import {
  dispatchComment,
  latestDispatchTime,
  priorLaunch,
  shouldHoldForOutage,
  spentAttempts,
} from "#src/dispatch/run-attempts.ts";
import { latestReceiptForBead } from "#src/dispatch/run-ledger.ts";
import { DISPATCH_ACTOR } from "#src/queue/bd-client.ts";
import { testReceipt } from "#support/receipt-fixture.ts";

function dispatched(createdAt = "2026-07-10T08:00:00Z"): BeadComment {
  return {
    author: DISPATCH_ACTOR,
    createdAt,
    text: dispatchComment("kiln-1", "feat/x"),
  };
}

function providerDeath(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return testReceipt({ bead: "bd-1", commits: 0, stopReason: "failed:api_error", ...overrides });
}

describe("spentAttempts", () => {
  it("counts the dispatch comments, including a launch that left no receipt", () => {
    expect(spentAttempts([dispatched(), dispatched()], [], "bd-1")).toBe(2);
    expect(spentAttempts([], [], "bd-1")).toBe(0);
  });

  it("counts only the launch comments, only from the dispatch actor", () => {
    const noise: Array<BeadComment> = [
      {
        author: DISPATCH_ACTOR,
        createdAt: "2026-07-10T09:00:00Z",
        text: "PR open: https://example.com/pull/1; awaiting human review.",
      },
      { author: "kiln-1", createdAt: "2026-07-10T09:00:00Z", text: "dispatched to kiln-1 as feat/x" },
    ];
    expect(spentAttempts(noise, [], "bd-1")).toBe(0);
    expect(spentAttempts([...noise, dispatched()], [], "bd-1")).toBe(1);
  });

  it("gives back the attempt an operator aborted, but charges every other death", () => {
    const aborted = testReceipt({ bead: "bd-1", stopReason: "signalled:SIGINT" });
    const crashed = testReceipt({ bead: "bd-1", stopReason: "crashed:no-result-event" });
    expect(spentAttempts([dispatched(), dispatched()], [aborted], "bd-1")).toBe(1);
    expect(spentAttempts([dispatched(), dispatched()], [aborted, aborted], "bd-1")).toBe(0);
    expect(spentAttempts([dispatched(), dispatched()], [crashed], "bd-1")).toBe(2);
  });

  it("gives back a provider death that left nothing behind", () => {
    expect(spentAttempts([dispatched(), dispatched()], [providerDeath()], "bd-1")).toBe(1);
  });

  it("charges a provider death that left commits in the guest", () => {
    const withWork = testReceipt({ bead: "bd-1", commits: 2, stopReason: "failed:api_error" });
    expect(spentAttempts([dispatched(), dispatched()], [withWork], "bd-1")).toBe(2);
  });

  it("charges provider deaths past the fifth, so an outage that never lifts parks the bead", () => {
    const launches = Array.from({ length: 7 }, () => dispatched());
    const deaths = Array.from({ length: 7 }, () => providerDeath());
    expect(spentAttempts(launches.slice(0, 5), deaths.slice(0, 5), "bd-1")).toBe(0);
    expect(spentAttempts(launches, deaths, "bd-1")).toBe(2);
  });

  it("ignores another bead's abort", () => {
    const aborted = testReceipt({ bead: "bd-2", stopReason: "signalled:SIGINT" });
    expect(spentAttempts([dispatched(), dispatched()], [aborted], "bd-1")).toBe(2);
  });
});

describe("shouldHoldForOutage", () => {
  const now = Date.parse("2026-08-06T23:00:00.000Z");

  function endedMinutesAgo(minutes: number): string {
    return new Date(now - minutes * 60_000).toISOString();
  }

  it("holds once nothing but provider deaths sits behind the crank", () => {
    const receipts = [providerDeath({ endedAt: endedMinutesAgo(9) }), providerDeath({ endedAt: endedMinutesAgo(3) })];
    expect(shouldHoldForOutage(receipts, now)).toBe(true);
  });

  it("never holds on a single death or an empty window", () => {
    const lone = providerDeath({ endedAt: endedMinutesAgo(3) });
    expect(shouldHoldForOutage([lone], now)).toBe(false);
    expect(shouldHoldForOutage([], now)).toBe(false);
  });

  it("lets a completed run in the window clear the hold", () => {
    const receipts = [
      providerDeath({ endedAt: endedMinutesAgo(9) }),
      testReceipt({ endedAt: endedMinutesAgo(5) }),
      providerDeath({ endedAt: endedMinutesAgo(3) }),
    ];
    expect(shouldHoldForOutage(receipts, now)).toBe(false);
  });

  it("stops holding once the burst ages out of the window", () => {
    const receipts = [providerDeath({ endedAt: endedMinutesAgo(40) }), providerDeath({ endedAt: endedMinutesAgo(20) })];
    expect(shouldHoldForOutage(receipts, now)).toBe(false);
  });
});

describe("latestDispatchTime", () => {
  it("takes the latest launch comment's timestamp, ignoring dispatch's other comments", () => {
    const comments = [
      dispatched("2026-07-29T20:24:11Z"),
      dispatched("2026-07-30T10:32:44Z"),
      { author: DISPATCH_ACTOR, createdAt: "2026-07-30T11:00:00Z", text: "PR open: later noise" },
    ];
    expect(latestDispatchTime(comments)).toBe("2026-07-30T10:32:44Z");
    expect(latestDispatchTime([])).toBeUndefined();
  });

  it("keeps yesterday's receipt away from a bead relaunched today, whatever bd's started_at says", () => {
    const receipts = [
      testReceipt({ bead: "bd-1", startedAt: "2026-07-29T20:28:12.375Z", stopReason: "failed:api_error" }),
    ];
    const since = latestDispatchTime([dispatched("2026-07-30T10:32:44Z")]);
    expect(latestReceiptForBead(receipts, "bd-1", since)).toBeUndefined();
  });
});

describe("priorLaunch", () => {
  it("is undefined for a bead dispatch has never launched", () => {
    expect(priorLaunch([], [], "bd-1")).toBeUndefined();
  });

  it("numbers the relaunch and reports the latest launch's receipt, never an older one", () => {
    const comments = [dispatched("2026-07-29T20:24:11Z"), dispatched("2026-07-30T10:32:44Z")];
    const older = testReceipt({ bead: "bd-1", startedAt: "2026-07-29T20:28:00.000Z", stopReason: "failed:api_error" });
    const latest = testReceipt({ bead: "bd-1", startedAt: "2026-07-30T10:33:00.000Z", stopReason: "failed:max_turns" });
    expect(priorLaunch(comments, [older, latest], "bd-1")).toEqual({ launch: 3, stopReason: "failed:max_turns" });
    expect(priorLaunch(comments, [older], "bd-1")).toEqual({ launch: 3, stopReason: undefined });
  });
});
