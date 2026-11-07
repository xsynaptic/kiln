import { keys } from "remeda";
import { describe, expect, it } from "vitest";

import { parseClaudeVersion, toolchainStamp } from "#src/vm/toolchain.ts";

const pinnedToolchain = { beads: "1.3.2", claude: "2.1.270", gitleaks: "8.30.1", node: "24.9.0", pnpm: "12.4.1" };

describe("parseClaudeVersion", () => {
  it("takes the semver off `claude --version`", () => {
    expect(parseClaudeVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
  });

  it("answers nothing for a missing binary or unexpected output", () => {
    expect(parseClaudeVersion(undefined)).toBeUndefined();
    expect(parseClaudeVersion("command not found")).toBeUndefined();
  });
});

describe("toolchainStamp", () => {
  it("stops matching a slot stamped before any one tool moved", () => {
    const stamped = toolchainStamp(pinnedToolchain);
    for (const tool of keys(pinnedToolchain)) {
      expect(toolchainStamp({ ...pinnedToolchain, [tool]: "9.9.9" })).not.toBe(stamped);
    }
  });
});
