import { describe, expect, it } from "vitest";

import { reviewMarkerPrNumber } from "#src/gatekeeper/review-ledger.ts";

describe("reviewMarkerPrNumber", () => {
  it("reads the PR number a review marker carries only in its filename", () => {
    expect(reviewMarkerPrNumber("review-pr-361.json")).toBe(361);
  });

  it("ignores a task run's launch log sharing the directory", () => {
    expect(reviewMarkerPrNumber("bd-1-2026-07-10T08-00-00-000Z.log")).toBeUndefined();
    expect(reviewMarkerPrNumber("review-pr-361-2026-07-10T09-00-00-000Z.log")).toBeUndefined();
  });
});
