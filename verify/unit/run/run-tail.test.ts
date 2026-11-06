import { describe, expect, it } from "vitest";

import type { ReceiptExtras } from "#src/run/run-tail.ts";

import { withExtras } from "#src/run/run-tail.ts";

const base = {
  branch: "chore/review-pr-9",
  endedAt: "2026-09-13T08:10:00.000Z",
  slot: "kiln-1",
  startedAt: "2026-09-13T08:00:00.000Z",
  stopReason: "completed",
  transcriptDir: "transcripts/kiln-1-x",
};

const none: ReceiptExtras = {
  baseline: undefined,
  bead: undefined,
  claudeCode: undefined,
  commits: undefined,
  decision: undefined,
  exitCode: undefined,
  kit: undefined,
  model: undefined,
  nudge: undefined,
  prUrl: undefined,
  review: undefined,
  signals: undefined,
};

describe("withExtras", () => {
  it("lands the extras that are present, leaves absent ones unset, and drops an empty signals array", () => {
    const receipt = withExtras(base, { ...none, commits: 0, decision: "escalated", review: 9, signals: [] });
    expect(receipt).toEqual({ ...base, commits: 0, decision: "escalated", review: 9 });
    expect(Object.keys(receipt)).not.toContain("bead");
  });
});
