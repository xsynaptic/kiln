import { describe, expect, it } from "vitest";

import { launchCapacity } from "#src/dispatch/slots.ts";

describe("launchCapacity (governor consult boundary)", () => {
  it("is zero when the dial is zero (pause-for-the-day)", () => {
    expect(launchCapacity(0, 0, 2, 10)).toBe(0);
  });

  it("is zero when maxLaunch is zero", () => {
    expect(launchCapacity(2, 0, 2, 0)).toBe(0);
  });

  it("subtracts busy slots from the dial", () => {
    expect(launchCapacity(3, 1, 5, 10)).toBe(2);
  });

  it("never exceeds the free slots", () => {
    expect(launchCapacity(4, 0, 1, 10)).toBe(1);
  });
});
