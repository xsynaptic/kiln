import { describe, expect, it } from "vitest";

import { isGateLive, liveGatesOf } from "#src/queue/gates.ts";

describe("liveGatesOf (the crank's open-gate count)", () => {
  it("drops every gate a park emptied and keeps one whose bead it skipped", () => {
    const beadsByGate = new Map([
      ["gt-1", ["bd-1"]],
      ["gt-2", ["bd-1"]],
      ["gt-3", ["bd-closed"]],
    ]);
    const gates = ["gt-1", "gt-2", "gt-3"].map((id) => ({ awaitId: "7", id }));
    expect(liveGatesOf(gates, beadsByGate, new Set(["bd-1"])).map((gate) => gate.id)).toEqual(["gt-3"]);
  });
});

describe("isGateLive (park/drain boundary)", () => {
  it("is live while its bead still waits on the machinery", () => {
    expect(isGateLive(["bd-1"], new Set())).toBe(true);
  });

  it("is not live once its only bead is parked", () => {
    expect(isGateLive(["bd-1"], new Set(["bd-1"]))).toBe(false);
  });

  it("is live while any one of several beads is unparked", () => {
    expect(isGateLive(["bd-1", "bd-2"], new Set(["bd-1"]))).toBe(true);
  });

  it("is not live with nothing behind it", () => {
    expect(isGateLive([], new Set())).toBe(false);
  });
});
