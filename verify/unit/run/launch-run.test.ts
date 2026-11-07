import { describe, expect, it } from "vitest";

import { launchPrompt } from "#src/run/launch-run.ts";

const prompt = {
  branch: "feat/sample",
  briefPath: "/home/agent/brief.md",
  contractsDir: "/home/agent/kiln/contracts",
  mode: "detached",
} as const;

describe("launchPrompt", () => {
  it("names the mode's contract before the playbook", () => {
    const text = launchPrompt({ ...prompt, playbook: "docs/kiln/worker.md" });
    const contractAt = text.indexOf("/home/agent/kiln/contracts/detached.md");
    expect(contractAt).toBeGreaterThan(-1);
    expect(text.indexOf("docs/kiln/worker.md")).toBeGreaterThan(contractAt);
  });

  it("names no playbook when the project configures none", () => {
    const text = launchPrompt({ ...prompt, playbook: undefined });
    expect(text).toContain("/home/agent/kiln/contracts/detached.md");
    expect(text).not.toContain("playbook");
  });
});
