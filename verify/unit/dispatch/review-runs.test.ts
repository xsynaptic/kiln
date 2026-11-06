import { describe, expect, it } from "vitest";

import type { SlotState } from "#src/dispatch/slots.ts";

import { reviewCapacity } from "#src/dispatch/review-runs.ts";

function slot(name: string, isBusy: boolean): SlotState {
  return { busy: isBusy, name, ready: true, state: "running" };
}

describe("reviewCapacity (review launch boundary)", () => {
  it("caps at one review however much fleet capacity there is", () => {
    const slots = [slot("kiln-1", false), slot("kiln-2", false), slot("kiln-3", false)];
    expect(reviewCapacity(4, 0, slots, 10)).toBe(1);
  });

  it("is zero while a review is already in flight", () => {
    expect(reviewCapacity(4, 1, [slot("kiln-1", false), slot("kiln-2", false)], 10)).toBe(0);
  });

  it("subtracts busy slots from the dial", () => {
    expect(reviewCapacity(1, 0, [slot("kiln-1", true), slot("kiln-2", false)], 10)).toBe(0);
  });

  it("is zero with no free slot to launch into", () => {
    expect(reviewCapacity(4, 0, [slot("kiln-1", true), slot("kiln-2", true)], 10)).toBe(0);
  });
});
