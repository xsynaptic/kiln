import { describe, expect, it } from "vitest";

import { crankHeader, crankSummaryLines } from "#src/dispatch/format.ts";

describe("crankHeader", () => {
  const at = new Date(2026, 6, 20, 3, 7, 4);

  it("stamps the crank with a zero-padded local time", () => {
    expect(crankHeader(264, false, at)).toContain("03:07:04");
  });

  it("keeps the crank number and marks a draining crank", () => {
    expect(crankHeader(264, false, at)).toContain("crank 264");
    expect(crankHeader(264, true, at)).toContain("(draining)");
    expect(crankHeader(264, false, at)).not.toContain("(draining)");
  });
});

describe("crankSummaryLines", () => {
  const summary = {
    inFlight: 0,
    isBlocked: false,
    launched: 0,
    openGates: 0,
    parked: [] as Array<string>,
    ready: 0,
    stalled: 0,
  };

  it("names every parked bead, since nothing else does", () => {
    const line = crankSummaryLines({ ...summary, parked: ["bd-3", "bd-4"] }, 0);
    expect(line).toContain("2 parked");
    expect(line).toContain("bd-3, bd-4");
  });

  it("reports a quiet queue without an empty id list", () => {
    const line = crankSummaryLines(summary, 0);
    expect(line).toContain("0 parked");
    expect(line).not.toContain("()");
  });

  it("names a slot past the run ceiling, and stays silent without one", () => {
    expect(crankSummaryLines({ ...summary, inFlight: 1, stalled: 1 }, 0)).toContain("1 past the run ceiling");
    expect(crankSummaryLines(summary, 0)).not.toContain("run ceiling");
  });

  it("surfaces an outage hold streak, and stays silent without one", () => {
    expect(crankSummaryLines(summary, 0, 20)).toContain("held 20 in a row for provider errors");
    expect(crankSummaryLines(summary, 0)).not.toContain("held");
  });
});
