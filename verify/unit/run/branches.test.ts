import { describe, expect, it } from "vitest";

import { isBranchType, typeFromTitle } from "#src/run/branches.ts";

describe("isBranchType", () => {
  it("accepts conventional-commit types and nothing else", () => {
    expect(isBranchType("feat")).toBe(true);
    expect(isBranchType("fix")).toBe(true);
    expect(isBranchType("chore")).toBe(true);
    expect(isBranchType("wip")).toBe(false);
    expect(isBranchType("faet")).toBe(false);
    expect(isBranchType("")).toBe(false);
  });
});

describe("typeFromTitle", () => {
  it("reads a conventional prefix, scoped or bare", () => {
    expect(typeFromTitle("fix(api): reject empty slugs")).toBe("fix");
    expect(typeFromTitle("chore: bump deps")).toBe("chore");
    expect(typeFromTitle("refactor!: drop the legacy path")).toBe("refactor");
  });

  it("defaults to feat when no recognizable prefix leads the title", () => {
    expect(typeFromTitle("Add batch exports")).toBe("feat");
    expect(typeFromTitle("wip: try things")).toBe("feat");
    expect(typeFromTitle("fix the thing")).toBe("feat");
  });
});
