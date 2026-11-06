import { describe, expect, it } from "vitest";

import { idleReason } from "#src/dispatch/bead-launch.ts";

const load = { busyCount: 2, capacity: 1, dial: 3, freeCount: 1, readyCount: 4 };

describe("idleReason", () => {
  it("launches when there is both capacity and a ready bead", () => {
    expect(idleReason(load)).toBeUndefined();
  });

  it("names the load when the dial leaves no capacity", () => {
    expect(idleReason({ ...load, capacity: 0 })).toBe("no capacity: 2 run(s) in flight, dial 3, 1 free slot(s)");
  });

  it("reports an empty queue once there is capacity to fill", () => {
    expect(idleReason({ ...load, readyCount: 0 })).toBe("nothing ready to dispatch");
  });

  it("reports no capacity ahead of an empty queue", () => {
    expect(idleReason({ ...load, capacity: 0, readyCount: 0 })).toMatch(/^no capacity/);
  });
});
