import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceiptExtras } from "#src/run/run-tail.ts";

import { prUrlForBranch, withExtras } from "#src/run/run-tail.ts";
import { safeCapture } from "#src/shared/run-artifacts.ts";

vi.mock(import("#src/shared/run-artifacts.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  safeCapture: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(safeCapture).mockReset();
});

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
  outcome: undefined,
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

describe("prUrlForBranch", () => {
  const runStart = "2026-09-13T08:00:00.000Z";
  const earlier = { createdAt: "2026-09-12T15:00:00Z", url: "https://github.com/acme/sample/pull/4" };
  const ours = { createdAt: "2026-09-13T08:40:00Z", url: "https://github.com/acme/sample/pull/7" };

  it("takes the PR this run opened on its branch, newest first as gh lists them", () => {
    vi.mocked(safeCapture).mockReturnValue(JSON.stringify([ours, earlier]));
    expect(prUrlForBranch("feat/sample", runStart)).toBe(ours.url);
  });

  it("skips the PR an earlier attempt opened on the same branch, closed or not", () => {
    vi.mocked(safeCapture).mockReturnValue(JSON.stringify([earlier]));
    expect(prUrlForBranch("feat/sample", runStart)).toBeUndefined();
  });

  it("takes the reviewed PR, opened before the review run, when no start bounds it", () => {
    vi.mocked(safeCapture).mockReturnValue(JSON.stringify([earlier]));
    expect(prUrlForBranch("feat/sample", undefined)).toBe(earlier.url);
  });

  it("finds no PR when gh fails or lists none", () => {
    vi.mocked(safeCapture).mockReturnValue(undefined);
    expect(prUrlForBranch("feat/sample", runStart)).toBeUndefined();
    vi.mocked(safeCapture).mockReturnValue("[]");
    expect(prUrlForBranch("feat/sample", runStart)).toBeUndefined();
  });
});
