import { describe, expect, it } from "vitest";

import { dialDefault, parseDispatchArgs } from "#src/dispatch/dispatch-flags.ts";

describe("parseDispatchArgs (the launch/settle boundary)", () => {
  it("launches nothing under reconcile", () => {
    expect(parseDispatchArgs(["reconcile"]).dial).toBe(0);
  });

  it("fills the fleet under launch", () => {
    expect(parseDispatchArgs(["launch"]).dial).toBe(dialDefault);
  });

  it("caps the fleet under launch", () => {
    expect(parseDispatchArgs(["launch", "--dial", "1"]).dial).toBe(1);
  });

  it("carries the shared flags through either subcommand", () => {
    expect(parseDispatchArgs(["reconcile", "--dry-run"]).isDryRun).toBe(true);
    expect(parseDispatchArgs(["launch", "--dry-run"]).isDryRun).toBe(true);
  });

  it("refuses a dial under reconcile", () => {
    expect(() => parseDispatchArgs(["reconcile", "--dial", "2"])).toThrow("--dial");
  });

  it("reports the usage rather than acting when no subcommand is named", () => {
    expect(() => parseDispatchArgs([])).toThrow("usage: pnpm kiln dispatch");
  });

  it("reports the usage for an unknown subcommand", () => {
    expect(() => parseDispatchArgs(["--dial", "2"])).toThrow("usage: pnpm kiln dispatch");
  });
});
