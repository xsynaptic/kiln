import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { guestClaudeCommand } from "#src/run/blind-run.ts";
import { singleQuote } from "#src/vm/vm.ts";

function promptReachingGuestClaude(prompt: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "blind-run-"));
  const binDir = path.join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "claude");
  writeFileSync(stub, '#!/bin/sh\nprintf %s "$2"\n');
  chmodSync(stub, 0o755);
  const command = guestClaudeCommand(prompt, "opus", " --settings '{}'");
  const result = spawnSync("bash", ["-c", `bash -c ${singleQuote(command)}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return result.stdout;
}

describe("guestClaudeCommand", () => {
  it("hands the prompt to the guest verbatim, backticks and quotes included", () => {
    const prompt =
      "Your operating manual is /mnt/work/kiln/modes/gatekeeper.md; read docs/agents.md on `github/main`, " +
      'which you read with `git show github/main:<path>`, as you do the "policy" files it links.';
    expect(promptReachingGuestClaude(prompt)).toBe(prompt);
  });

  it("survives a prompt carrying the single quote it is wrapped in", () => {
    const prompt = "Read the run's brief and $HOME/notes, then report `pnpm check`.";
    expect(promptReachingGuestClaude(prompt)).toBe(prompt);
  });
});
