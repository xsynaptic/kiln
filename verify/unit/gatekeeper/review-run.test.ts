import { describe, expect, it } from "vitest";

import type { ReviewBrief } from "#src/gatekeeper/review-run.ts";

import { parseReviewArgs } from "#src/commands/review.ts";
import { composeReviewBrief } from "#src/gatekeeper/review-run.ts";

function brief(overrides: Partial<ReviewBrief> = {}): ReviewBrief {
  return {
    beadId: "bd-42",
    headRefName: "feat/thing",
    headSha: "4c0857af79b6eff47e4c9412ff8d3ca58c094a91",
    knownSlugs: [],
    prNumber: 106,
    title: "feat(thing): do the thing",
    url: "https://github.com/owner/repo/pull/106",
    ...overrides,
  };
}

describe("composeReviewBrief", () => {
  it("names the spec bead and sends the gatekeeper to it before the diff", () => {
    const composed = composeReviewBrief(brief());
    expect(composed).toContain("- Spec bead: bd-42.");
    expect(composed).toContain("bd show bd-42");
    expect(composed).toContain("before the diff");
  });

  it("says so explicitly when a label-opted PR has no bead", () => {
    const composed = composeReviewBrief(brief({ beadId: undefined }));
    expect(composed).toContain("- Spec bead: none.");
    expect(composed).not.toContain("bd show");
  });

  it("carries the head the brief was written against, so a review can tell the branch moved", () => {
    expect(composeReviewBrief(brief())).toContain("4c0857af79b6eff47e4c9412ff8d3ca58c094a91");
  });

  it("lists the slugs already on file, so a review reuses a key instead of coining one", () => {
    const composed = composeReviewBrief(
      brief({
        knownSlugs: [{ gist: "the contributor doc names a script that is gone", slug: "stale-doc-testing" }],
      }),
    );
    expect(composed).toContain("- `stale-doc-testing`: the contributor doc names a script that is gone");
  });

  it("leaves the section out entirely when the queue is empty", () => {
    expect(composeReviewBrief(brief())).not.toContain("Signal slugs");
  });

  it("leaves naming the contract to the run prompt", () => {
    expect(composeReviewBrief(brief())).not.toContain("contract");
  });
});

describe("parseReviewArgs", () => {
  it("reads the slot, the PR and the optional bead off the flags", () => {
    expect(parseReviewArgs(["kiln-2", "--pr", "106", "--bead", "bd-42"])).toStrictEqual({
      beadId: "bd-42",
      isStamped: false,
      name: "kiln-2",
      prNumber: 106,
    });
  });

  it("leaves the bead undefined where no --bead was passed, since a label-opted PR has none", () => {
    expect(parseReviewArgs(["kiln-2", "--pr", "106"]).beadId).toBeUndefined();
  });

  it("carries the crank's --stamped through", () => {
    expect(parseReviewArgs(["kiln-2", "--pr", "106", "--stamped"]).isStamped).toBe(true);
  });

  it.each([
    ["no slot", ["--pr", "106"]],
    ["a flag where the slot belongs", ["--pr", "106", "kiln-2"]],
    ["no PR", ["kiln-2"]],
    ["a PR that is not a number", ["kiln-2", "--pr", "one-oh-six"]],
    ["--bead with nothing after it", ["kiln-2", "--pr", "106", "--bead"]],
    ["a bead id that could reach the shell", ["kiln-2", "--pr", "106", "--bead", "bd 42; rm"]],
  ])("refuses %s", (_case, argv) => {
    expect(() => parseReviewArgs(argv)).toThrow("usage:");
  });
});
