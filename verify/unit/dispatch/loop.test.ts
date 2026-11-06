import { describe, expect, it } from "vitest";

import type { LoopControl } from "#src/dispatch/loop.ts";

import { applyLoopSignal, shouldStop } from "#src/dispatch/loop.ts";

function control(): LoopControl {
  return { isStopRequested: false };
}

describe("applyLoopSignal", () => {
  it("stops the loop on the first signal, whatever it is", () => {
    const state = control();
    expect(applyLoopSignal(state)).toMatch(/stopping the loop/);
    expect(state.isStopRequested).toBe(true);
  });

  it("names the command that reaches a run, because stopping the loop does not", () => {
    expect(applyLoopSignal(control())).toContain("pnpm kiln rm <slot>");
  });

  it("says it once however long the wrapper relay takes to arrive", () => {
    const state = control();
    applyLoopSignal(state);
    expect(applyLoopSignal(state)).toBeUndefined();
    expect(applyLoopSignal(state)).toBeUndefined();
    expect(state.isStopRequested).toBe(true);
  });
});

describe("shouldStop", () => {
  const unbounded = Infinity;

  it("keeps going while ready work or in-flight runs remain (unbounded)", () => {
    expect(shouldStop({ budgetLeft: unbounded, inFlight: 1, openGates: 0, ready: 0 })).toBe(false);
    expect(shouldStop({ budgetLeft: unbounded, inFlight: 0, openGates: 0, ready: 2 })).toBe(false);
  });

  it("keeps polling while PRs await a merge, so a later merge unblocks dependents", () => {
    expect(shouldStop({ budgetLeft: unbounded, inFlight: 0, openGates: 1, ready: 0 })).toBe(false);
  });

  it("stops an unbounded loop only when the graph is fully drained", () => {
    expect(shouldStop({ budgetLeft: unbounded, inFlight: 0, openGates: 0, ready: 0 })).toBe(true);
  });

  it("drains before stopping on a spent budget, even with ready work left", () => {
    expect(shouldStop({ budgetLeft: 0, inFlight: 1, openGates: 0, ready: 3 })).toBe(false);
    expect(shouldStop({ budgetLeft: 0, inFlight: 0, openGates: 2, ready: 3 })).toBe(true);
  });
});
