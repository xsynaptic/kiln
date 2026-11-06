import { describe, expect, it } from "vitest";

import { isSerializationConflict, parseClaimedBead } from "#src/queue/bd-client.ts";

describe("isSerializationConflict", () => {
  it("matches the raw Dolt serialization-failure signatures", () => {
    expect(
      isSerializationConflict(
        "Error 1213 (40001): serialization failure: this transaction conflicts with a committed transaction from another client",
      ),
    ).toBe(true);
    expect(isSerializationConflict("serialization failure")).toBe(true);
    expect(isSerializationConflict("Error 40001")).toBe(true);
  });

  it("does not match unrelated bd errors", () => {
    expect(isSerializationConflict("issue bd-1 not found")).toBe(false);
    expect(isSerializationConflict("already claimed by operator")).toBe(false);
    expect(isSerializationConflict("")).toBe(false);
  });
});

describe("parseClaimedBead", () => {
  it("reads the claimed bead out of the one-record array", () => {
    expect(
      parseClaimedBead('[{"id":"bd-7","title":"fix(api): the thing","labels":["agent"],"assignee":"kiln-1"}]'),
    ).toEqual({
      assignee: "kiln-1",
      id: "bd-7",
      labels: ["agent"],
      title: "fix(api): the thing",
    });
  });

  it("answers with nothing when the claim took nothing", () => {
    expect(parseClaimedBead("[]")).toBeUndefined();
  });

  it("answers with nothing when stdout does not parse", () => {
    expect(parseClaimedBead("bd: no ready issues\n")).toBeUndefined();
  });
});
