import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import { agentRunsRoot } from "#src/shared/run-artifacts.ts";

describe("agentRunsRoot", () => {
  const saved = process.env.KILN_RUNS_DIR;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KILN_RUNS_DIR;
    } else {
      process.env.KILN_RUNS_DIR = saved;
    }
  });

  it("defaults to a sibling <checkout>-agent-runs directory", () => {
    delete process.env.KILN_RUNS_DIR;
    expect(agentRunsRoot("/Users/dev/proj/sample")).toBe(path.join("/Users/dev/proj", "sample-agent-runs"));
  });

  it("honors an absolute KILN_RUNS_DIR override", () => {
    process.env.KILN_RUNS_DIR = "/var/agent-store";
    expect(agentRunsRoot("/Users/dev/proj/sample")).toBe("/var/agent-store");
  });

  it("rejects a relative KILN_RUNS_DIR", () => {
    process.env.KILN_RUNS_DIR = "relative/store";
    expect(() => agentRunsRoot("/Users/dev/proj/sample")).toThrow(/absolute/);
  });

  it("ignores an empty KILN_RUNS_DIR", () => {
    process.env.KILN_RUNS_DIR = "";
    expect(agentRunsRoot("/Users/dev/proj/sample")).toBe(path.join("/Users/dev/proj", "sample-agent-runs"));
  });
});
