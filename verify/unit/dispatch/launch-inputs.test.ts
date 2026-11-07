import { describe, expect, it } from "vitest";

import { composeBrief, modelFromLabels, slugForBead } from "#src/dispatch/launch-inputs.ts";

describe("composeBrief", () => {
  const bead = { id: "bd-42", title: "Fix the thing" };

  it("carries each slug with its gist, in the order it was given them", () => {
    const brief = composeBrief(bead, "feat/fix-the-thing", [
      {
        gist: "the slow suite timed out on a cold start",
        slug: "flaky-e2e",
      },
      { gist: "the contributor doc names a script that is gone", slug: "stale-doc-testing" },
    ]);
    expect(brief).toContain("- `flaky-e2e`: the slow suite timed out on a cold start");
    expect(brief).toContain("- `stale-doc-testing`: the contributor doc names a script that is gone");
    expect(brief.indexOf("flaky-e2e")).toBeLessThan(brief.indexOf("stale-doc-testing"));
  });

  it("leaves the section out entirely when the queue is empty", () => {
    const brief = composeBrief(bead, "feat/fix-the-thing", []);
    expect(brief).not.toContain("Signal slugs");
    expect(brief.endsWith("as far as you need.")).toBe(true);
  });

  it("tells a relaunch which launch it is and how the last run ended, receipt or not", () => {
    const brief = composeBrief(bead, "feat/fix-the-thing", [], { launch: 2, stopReason: "failed:max_turns" });
    expect(brief).toContain("This is launch 2 of this bead. The previous run ended failed:max_turns;");
    expect(composeBrief(bead, "feat/fix-the-thing", [], { launch: 3, stopReason: undefined })).toContain(
      "ended without leaving a receipt",
    );
  });

  it("leaves naming the contract to the run prompt", () => {
    expect(composeBrief(bead, "feat/fix-the-thing", [])).not.toContain("contract");
  });
});

describe("modelFromLabels", () => {
  const allowed = ["opus", "sonnet"] as const;

  it("reads an allowed model:<name> label chosen at filing time", () => {
    expect(modelFromLabels(["slice", "model:sonnet"], allowed)).toBe("sonnet");
  });

  it("takes the first allowed model when no label asks for one", () => {
    expect(modelFromLabels(undefined, allowed)).toBe("opus");
    expect(modelFromLabels(["slice"], allowed)).toBe("opus");
  });

  it("takes the default over a label naming a model the project does not allow", () => {
    expect(modelFromLabels(["model:haiku"], allowed)).toBe("opus");
    expect(modelFromLabels(["model:opus; rm -rf /"], allowed)).toBe("opus");
    expect(modelFromLabels(["model:"], allowed)).toBe("opus");
  });

  it("matches a name whole rather than by family", () => {
    expect(modelFromLabels(["model:claude-sonnet-5"], allowed)).toBe("opus");
  });
});

describe("slugForBead", () => {
  it("kebabs the title and cuts at a word boundary", () => {
    expect(slugForBead({ id: "bd-1", title: "fix: handle widgets whose names overflow the limit" })).toBe(
      "fix-handle-widgets-whose-names",
    );
  });

  it("falls back to the bead id when the title yields nothing", () => {
    expect(slugForBead({ id: "bd-9x", title: "???" })).toBe("bd-9x");
  });
});
