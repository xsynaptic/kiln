import { describe, expect, it } from "vitest";

import { parseSince } from "#src/commands/report.ts";
import { decisionsBy, deliveryByDuration, isFlagged, landingLags, summarizeDays } from "#src/dispatch/report.ts";
import { testReceipt } from "#support/receipt-fixture.ts";

const prUrl = "https://github.com/acme/sample/pull/9";

describe("isFlagged", () => {
  it("flags a task run that completed without a PR, bead or not, and every run that did not complete", () => {
    expect(isFlagged(testReceipt({ bead: "bd-1" }))).toBe(true);
    expect(isFlagged(testReceipt({}))).toBe(true);
    expect(isFlagged(testReceipt({ bead: "bd-1", prUrl }))).toBe(false);
    expect(isFlagged(testReceipt({ decision: "merged", review: 9, stopReason: "failed:api_error" }))).toBe(true);
  });

  it("flags a completed review only when it stated no decision, since a review opens no PR of its own", () => {
    expect(isFlagged(testReceipt({ decision: "escalated", review: 9 }))).toBe(false);
    expect(isFlagged(testReceipt({ review: 9 }))).toBe(true);
  });
});

describe("summarizeDays", () => {
  it("counts the PRs task runs opened, once each, and none a review only touched", () => {
    const [day] = summarizeDays([
      testReceipt({ bead: "bd-1", costUsd: 1.5, prUrl }),
      testReceipt({ bead: "bd-1", costUsd: 1, prUrl }),
      testReceipt({
        costUsd: 0.25,
        decision: "merged",
        prUrl: "https://github.com/acme/sample/pull/10",
        review: 10,
      }),
    ]);
    expect(day).toMatchObject({ costUsd: 2.75, day: "2026-09-12", prs: 1, runs: 3 });
  });
});

describe("decisionsBy", () => {
  it("tallies review decisions per key and leaves undecided runs and non-reviews out", () => {
    const table = decisionsBy(
      [
        testReceipt({ baseline: "abc", decision: "merged", review: 9 }),
        testReceipt({ baseline: "abc", decision: "merged", review: 9 }),
        testReceipt({ baseline: "def", decision: "escalated", review: 9 }),
        testReceipt({ baseline: "def", review: 9 }),
        testReceipt({ baseline: "def", bead: "bd-1", decision: "merged" }),
        testReceipt({ decision: "nothing-to-land", review: 9 }),
      ],
      "baseline",
    );
    expect(table.get("abc")?.get("merged")).toBe(2);
    expect([...(table.get("def") ?? [])]).toEqual([["escalated", 1]]);
    expect(table.get("unrecorded")?.get("nothing-to-land")).toBe(1);
  });
});

describe("deliveryByDuration", () => {
  it("buckets task runs by wall time, a run on a boundary landing in the later bucket", () => {
    const buckets = deliveryByDuration([
      testReceipt({ bead: "bd-1", commits: 1, endedAt: "2026-09-12T08:15:00.000Z", prUrl }),
      testReceipt({ endedAt: "2026-09-12T08:05:00.000Z" }),
      testReceipt({ endedAt: "2026-09-12T08:05:00.000Z", review: 9 }),
    ]);
    expect(buckets[0]).toMatchObject({ delivered: 0, runs: 1 });
    expect(buckets[1]).toMatchObject({ delivered: 1, runs: 1 });
  });
});

describe("parseSince", () => {
  it("defaults to a week back and refuses a malformed date", () => {
    expect(parseSince([], Date.parse("2026-09-13T12:00:00.000Z"))).toBe("2026-09-06");
    expect(parseSince(["--since", "2026-08-18"], 0)).toBe("2026-08-18");
    expect(() => parseSince(["--since", "yesterday"], 0)).toThrow("usage");
  });
});

describe("landingLags", () => {
  it("measures the wait from the delivering run's end to the merging review's", () => {
    expect(
      landingLags([
        testReceipt({ endedAt: "2026-09-12T08:10:00.000Z", prUrl }),
        testReceipt({ decision: "merged", endedAt: "2026-09-12T10:40:00.000Z", review: 9 }),
      ]),
    ).toEqual([{ minutes: 150, pullRequest: "9" }]);
  });

  it("counts a repaired landing, since fixing forward is still the gatekeeper landing it", () => {
    expect(
      landingLags([
        testReceipt({ endedAt: "2026-09-12T08:10:00.000Z", prUrl }),
        testReceipt({ decision: "fixed-and-merged", endedAt: "2026-09-12T09:10:00.000Z", review: 9 }),
      ]).map((lag) => lag.minutes),
    ).toEqual([60]);
  });

  it("takes the first delivery, so a retry's receipt cannot read as a shorter wait than the PR had", () => {
    expect(
      landingLags([
        testReceipt({ endedAt: "2026-09-12T08:10:00.000Z", prUrl }),
        testReceipt({ endedAt: "2026-09-12T09:10:00.000Z", prUrl }),
        testReceipt({ decision: "merged", endedAt: "2026-09-12T10:10:00.000Z", review: 9 }),
      ]).map((lag) => lag.minutes),
    ).toEqual([120]);
  });

  it("leaves out a review that did not land it, and a landing whose delivery is outside the window", () => {
    expect(
      landingLags([
        testReceipt({ endedAt: "2026-09-12T08:10:00.000Z", prUrl }),
        testReceipt({ decision: "escalated", endedAt: "2026-09-12T09:10:00.000Z", review: 9 }),
        testReceipt({ decision: "merged", endedAt: "2026-09-12T09:10:00.000Z", review: 10 }),
      ]),
    ).toEqual([]);
  });

  it("sorts ascending, which is what the median and p90 read off", () => {
    expect(
      landingLags([
        testReceipt({ endedAt: "2026-09-12T08:00:00.000Z", prUrl }),
        testReceipt({ decision: "merged", endedAt: "2026-09-12T11:00:00.000Z", review: 9 }),
        testReceipt({ endedAt: "2026-09-12T08:00:00.000Z", prUrl: "https://github.com/acme/sample/pull/10" }),
        testReceipt({ decision: "merged", endedAt: "2026-09-12T09:00:00.000Z", review: 10 }),
      ]).map((lag) => lag.pullRequest),
    ).toEqual(["10", "9"]);
  });
});
