import { beforeEach, describe, expect, it, vi } from "vitest";

import { unclosedPrUrlsForBead, unclosedPrUrlsForHead } from "#src/gatekeeper/pr-views.ts";
import { safeCapture } from "#src/shared/run-artifacts.ts";

vi.mock(import("#src/shared/run-artifacts.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  safeCapture: vi.fn(),
}));

const launchedAt = "2026-09-12T08:00:00Z";

function listing(number: number, state: string, createdAt: string, body = `Bead: acme-7`) {
  return { body, createdAt, state, url: `https://github.com/acme/sample/pull/${String(number)}` };
}

function ghAnswers(prs: Array<ReturnType<typeof listing>>): void {
  vi.mocked(safeCapture).mockReturnValue(JSON.stringify(prs));
}

beforeEach(() => {
  vi.mocked(safeCapture).mockReset();
});

describe("the PRs a dead run may have left", () => {
  it("keeps open and merged PRs opened since the launch, and drops closed ones and an earlier attempt's", () => {
    ghAnswers([
      listing(4, "OPEN", "2026-09-12T08:20:00Z"),
      listing(3, "MERGED", "2026-09-12T08:10:00Z"),
      listing(2, "CLOSED", "2026-09-12T08:05:00Z"),
      listing(1, "MERGED", "2026-09-11T17:00:00Z"),
    ]);
    expect(unclosedPrUrlsForHead("feat/sample", launchedAt)).toEqual([
      "https://github.com/acme/sample/pull/4",
      "https://github.com/acme/sample/pull/3",
    ]);
  });

  it("takes only a PR whose body names the bead on its own line, not one the search matched loosely", () => {
    ghAnswers([
      listing(6, "OPEN", "2026-09-12T08:20:00Z", "Fixes the thing\n\nRun: x\nBead: acme-7\n"),
      listing(5, "OPEN", "2026-09-12T08:20:00Z", "Run: y\nBead: acme-7.1"),
      listing(4, "OPEN", "2026-09-12T08:20:00Z", "Follow-up to Bead: acme-7 work"),
    ]);
    expect(unclosedPrUrlsForBead("acme-7", launchedAt)).toEqual(["https://github.com/acme/sample/pull/6"]);
  });

  it("tells a GitHub that could not answer apart from one that found no PR", () => {
    vi.mocked(safeCapture).mockReturnValue(undefined);
    expect(unclosedPrUrlsForHead("feat/sample", launchedAt)).toBeUndefined();
    ghAnswers([]);
    expect(unclosedPrUrlsForHead("feat/sample", launchedAt)).toEqual([]);
  });
});
