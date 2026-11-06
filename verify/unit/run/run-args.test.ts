import { describe, expect, it } from "vitest";

import type { Args } from "#src/run/run-args.ts";

import { parseWatchFlags, reAnchorCommand, runMode } from "#src/run/run-args.ts";

const task: Args = {
  attach: false,
  bead: "bd-1",
  brief: "brief.md",
  name: "kiln-2",
  noReset: false,
  readonlyTaskState: false,
  slug: "fix-the-thing",
  type: "fix",
};

const review: Args = {
  attach: false,
  brief: "brief.md",
  name: "kiln-2",
  noReset: false,
  readonlyTaskState: false,
  review: 812,
  slug: "review-pr-812",
  type: "chore",
};

describe("reAnchorCommand", () => {
  it("hands kiln watch the reviewed PR and the bead it was printed with", () => {
    expect(parseWatchFlags(reAnchorCommand(review).split(" ").slice(4))).toEqual({ bead: undefined, review: 812 });
    expect(parseWatchFlags(reAnchorCommand(task).split(" ").slice(4))).toEqual({ bead: "bd-1", review: undefined });
  });

  it("refuses a review that is not a PR number", () => {
    expect(() => parseWatchFlags(["kiln-2", "--review", "latest"])).toThrow("--review");
  });
});

describe("runMode", () => {
  it("reads a review as the gatekeeper whatever else is set", () => {
    expect(runMode({ attach: false, review: 12 })).toBe("gatekeeper");
    expect(runMode({ attach: true })).toBe("attended");
    expect(runMode({ attach: false })).toBe("detached");
  });
});
