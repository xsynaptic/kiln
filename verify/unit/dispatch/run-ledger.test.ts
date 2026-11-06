import { describe, expect, it } from "vitest";

import {
  deliveredPrUrl,
  hasReceiptSince,
  latestReceiptForBead,
  parseReceipts,
  strandedPrUrl,
} from "#src/dispatch/run-ledger.ts";
import { testReceipt } from "#support/receipt-fixture.ts";

describe("parseReceipts", () => {
  it("parses receipt lines and skips noise", () => {
    const text = [
      "not json",
      JSON.stringify(testReceipt({ bead: "bd-1" })),
      "{broken",
      JSON.stringify({ unrelated: true }),
      JSON.stringify(testReceipt({ bead: "bd-2" })),
    ].join("\n");
    const receipts = parseReceipts(text);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]?.bead).toBe("bd-2");
  });
});

describe("latestReceiptForBead", () => {
  it("returns the last receipt in file order", () => {
    const receipts = [
      testReceipt({ bead: "bd-1", stopReason: "failed:error" }),
      testReceipt({ bead: "bd-1", stopReason: "completed" }),
    ];
    expect(latestReceiptForBead(receipts, "bd-1")?.stopReason).toBe("completed");
    expect(latestReceiptForBead(receipts, "bd-9")).toBeUndefined();
  });

  it("ignores receipts older than the launch-time bead update (a previous attempt)", () => {
    const receipts = [testReceipt({ bead: "bd-1", startedAt: "2026-07-10T08:00:00.000Z", stopReason: "failed:error" })];
    expect(latestReceiptForBead(receipts, "bd-1", "2026-07-10T09:00:00.000Z")).toBeUndefined();
    expect(latestReceiptForBead(receipts, "bd-1", "2026-07-10T08:00:00.000Z")).toBeDefined();
  });

  it("counts a same-second receipt against bd's second-precision started_at", () => {
    const receipts = [testReceipt({ bead: "bd-1", startedAt: "2026-07-19T04:46:29.123Z" })];
    expect(latestReceiptForBead(receipts, "bd-1", "2026-07-19T04:46:29Z")).toBeDefined();
  });
});

describe("hasReceiptSince", () => {
  const launchedAt = "2026-08-06T01:00:00.000Z";

  it("finds a receipt on the slot at or after the launch", () => {
    expect(hasReceiptSince([testReceipt({ slot: "kiln-2", startedAt: launchedAt })], "kiln-2", launchedAt)).toBe(true);
    expect(
      hasReceiptSince([testReceipt({ slot: "kiln-2", startedAt: "2026-08-06T02:00:00.000Z" })], "kiln-2", launchedAt),
    ).toBe(true);
  });

  it("ignores receipts from before the launch or from another slot", () => {
    expect(
      hasReceiptSince([testReceipt({ slot: "kiln-2", startedAt: "2026-08-06T00:59:00.000Z" })], "kiln-2", launchedAt),
    ).toBe(false);
    expect(hasReceiptSince([testReceipt({ slot: "kiln-1", startedAt: launchedAt })], "kiln-2", launchedAt)).toBe(false);
    expect(hasReceiptSince([], "kiln-2", launchedAt)).toBe(false);
  });
});

describe("deliveredPrUrl", () => {
  const prUrl = "https://github.com/acme/sample/pull/10";

  it("hands on the PR url for a delivered run and withholds it otherwise", () => {
    expect(deliveredPrUrl(testReceipt({ commits: 1, prUrl }))).toBe(prUrl);
    expect(deliveredPrUrl(testReceipt({ commits: 0, prUrl }))).toBeUndefined();
  });
});

describe("strandedPrUrl", () => {
  const prUrl = "https://github.com/acme/sample/pull/10";

  it("surfaces the PR a died-mid-stream run left open", () => {
    expect(strandedPrUrl(testReceipt({ commits: 2, prUrl, stopReason: "failed:api_error" }))).toBe(prUrl);
  });

  it("has nothing to surface for a delivered run, which the gh:pr gate already owns", () => {
    expect(strandedPrUrl(testReceipt({ commits: 2, prUrl }))).toBeUndefined();
  });

  it("has nothing to surface for a run that opened no PR", () => {
    expect(strandedPrUrl(testReceipt({ commits: 2, stopReason: "failed:api_error" }))).toBeUndefined();
  });
});
