import { describe, expect, it } from "vitest";

import { isPastRunCeiling } from "#src/dispatch/run-liveness.ts";

describe("isPastRunCeiling", () => {
  const launchedAt = "2026-08-06T00:00:00.000Z";
  const sixHoursLater = Date.parse("2026-08-06T06:00:00.000Z");

  it("trips only once the ceiling is actually past", () => {
    expect(isPastRunCeiling(launchedAt, 360, sixHoursLater + 1)).toBe(true);
    expect(isPastRunCeiling(launchedAt, 360, sixHoursLater)).toBe(false);
    expect(isPastRunCeiling(launchedAt, 361, sixHoursLater + 1)).toBe(false);
  });

  it("never trips on an unreadable launch time", () => {
    expect(isPastRunCeiling("", 360, sixHoursLater)).toBe(false);
    expect(isPastRunCeiling("not a date", 360, sixHoursLater)).toBe(false);
  });
});
