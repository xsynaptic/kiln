import { describe, expect, it } from "vitest";

import { bdDependencySchema, bdGateSchema } from "#src/queue/bd-records.ts";
import {
  escalatedGateIds,
  humanGatesBlocking,
  openGatesOfType,
  prNumberFromUrl,
  resolvedPrGateNumbers,
  strandedBeadIds,
} from "#src/queue/gate-reads.ts";
import { parseEach } from "#src/shared/lenient-json.ts";

describe("escalatedGateIds", () => {
  it("extracts gate ids from bd gate check's per-gate ESCALATE lines", () => {
    const checked = [
      "⚠ bd-abc: ESCALATE - PR 'feat: the thing' was closed without merging",
      "",
      "Checked 1 gates: 0 resolved, 1 escalated, 0 errors",
    ].join("\n");
    expect(escalatedGateIds(checked)).toEqual(["bd-abc"]);
  });

  it("returns nothing for resolved-only or empty output", () => {
    expect(escalatedGateIds("Checked 3 gates: 1 resolved, 0 escalated, 0 errors")).toEqual([]);
    expect(escalatedGateIds("")).toEqual([]);
  });
});

describe("openGatesOfType", () => {
  const gates = parseEach(bdGateSchema, [
    { await_type: "human", id: "gt-old", status: "open", updated_at: "2026-08-01T00:00:00Z" },
    { await_id: "42", await_type: "gh:pr", id: "gt-pr", status: "open", updated_at: "2026-08-03T00:00:00Z" },
    { await_type: "human", id: "gt-new", status: "open", updated_at: "2026-08-05T00:00:00Z" },
    { await_type: "human", id: "gt-done", status: "closed", updated_at: "2026-08-06T00:00:00Z" },
  ]);

  it("keeps only open gates of the asked-for type", () => {
    expect(openGatesOfType(gates, "human").map((gate) => gate.id)).toEqual(["gt-new", "gt-old"]);
    expect(openGatesOfType(gates, "gh:pr").map((gate) => gate.id)).toEqual(["gt-pr"]);
  });

  it("drops a resolved gate even though it is the most recent", () => {
    expect(openGatesOfType(gates, "human").map((gate) => gate.id)).not.toContain("gt-done");
  });

  it("returns nothing when no gate matches", () => {
    expect(openGatesOfType(gates, "timer")).toEqual([]);
    expect(openGatesOfType([], "human")).toEqual([]);
  });
});

describe("humanGatesBlocking", () => {
  const parks = [
    { blocked: ["bd-1", "bd-2"], id: "gt-stalled" },
    { blocked: ["bd-3"], id: "gt-escalated" },
    { blocked: ["bd-1"], id: "gt-unreviewable" },
  ];

  it("finds every gate parking the bead", () => {
    expect(humanGatesBlocking("bd-1", parks)).toEqual(["gt-stalled", "gt-unreviewable"]);
    expect(humanGatesBlocking("bd-3", parks)).toEqual(["gt-escalated"]);
  });

  it("finds nothing for a bead no gate parks", () => {
    expect(humanGatesBlocking("bd-9", parks)).toEqual([]);
    expect(humanGatesBlocking("bd-1", [])).toEqual([]);
  });
});

describe("resolvedPrGateNumbers", () => {
  it("reads every resolved gh:pr gate the bead waits on, oldest attempt first", () => {
    const dependencies = [
      { await_id: "1280", await_type: "gh:pr", dependency_type: "blocks", id: "bd-g1", status: "closed" },
      { await_id: null, await_type: null, dependency_type: "parent-child", id: "bd-epic", status: "open" },
      { await_id: "1292", await_type: "gh:pr", dependency_type: "blocks", id: "bd-g2", status: "closed" },
    ];
    expect(resolvedPrGateNumbers(parseEach(bdDependencySchema, dependencies))).toEqual([1280, 1292]);
  });

  it("skips open gates, human gates, and a gate with no usable PR number", () => {
    const dependencies = [
      { await_id: "1294", await_type: "gh:pr", dependency_type: "blocks", id: "bd-live", status: "open" },
      { await_type: "human", dependency_type: "blocks", id: "bd-park", status: "closed" },
      { await_id: "", await_type: "gh:pr", dependency_type: "blocks", id: "bd-blank", status: "closed" },
    ];
    expect(resolvedPrGateNumbers(parseEach(bdDependencySchema, dependencies))).toEqual([]);
  });
});

describe("strandedBeadIds", () => {
  const inProgress = [
    { assignee: "kiln-1", id: "bd-running" },
    { assignee: "", id: "bd-gated" },
    { assignee: "", id: "bd-parked" },
    { assignee: "", id: "bd-stranded" },
  ];
  const gated = new Set(["bd-gated", "bd-parked"]);

  it("finds only the beads no gate and no run will ever move", () => {
    expect(strandedBeadIds(inProgress, gated)).toEqual(["bd-stranded"]);
  });

  it("leaves a live run alone even with every gate resolved", () => {
    expect(strandedBeadIds([{ assignee: "kiln-2", id: "bd-running" }], new Set())).toEqual([]);
  });
});

describe("prNumberFromUrl", () => {
  it("extracts the PR number for the gh:pr gate", () => {
    expect(prNumberFromUrl("https://github.com/acme/sample/pull/15")).toBe("15");
    expect(prNumberFromUrl("https://github.com/acme/sample")).toBeUndefined();
  });
});
