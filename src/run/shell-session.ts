import { kilnConfig } from "../config/config.ts";
import { mainCheckoutPath, timestampSlug } from "../shared/run-artifacts.ts";
import { beadsClient } from "../vm/beads.ts";
import { stageGuestKit } from "../vm/guest-kit.ts";
import { readLiveLease } from "../vm/lease.ts";
import { agentRunExportLine, gateEnvExportLines, guestClonePath, hasHeadlessClaude, startAgentTmux } from "../vm/vm.ts";
import { readTokens } from "./launch-run.ts";

export function startShellSession(name: string): void {
  assertNoBlindRun(name);
  startSession(name);
}

function assertNoBlindRun(name: string): void {
  const lease = readLiveLease(mainCheckoutPath(), name);
  if (lease !== undefined) {
    throw new Error(`${name} is leased by a live ${lease.mode} (pid ${String(lease.pid)}); pick another slot`);
  }
  if (hasHeadlessClaude(name)) {
    throw new Error(`${name} is running a blind agent run; pick another slot`);
  }
}

function startSession(name: string): void {
  const { oauthToken, pat } = readTokens();
  const clonePath = guestClonePath(name);
  stageGuestKit(name, clonePath);
  const beads = beadsClient(name);
  startAgentTmux({
    beforeStart: [
      ...beads.envLines,
      agentRunExportLine(`${name}-${timestampSlug()}`, "shell"),
      ...gateEnvExportLines(kilnConfig.gates.env),
      `cd ${JSON.stringify(clonePath)}`,
      `if [ -z "$(git status --porcelain)" ]; then`,
      `  git fetch --quiet github main 2>/dev/null || true`,
      `  git switch --quiet main 2>/dev/null || true`,
      `  git merge --ff-only --quiet github/main 2>/dev/null || true`,
      `fi`,
      `echo "clone on branch $(git branch --show-current)"`,
    ],
    clonePath,
    profile: name,
    tokens: `${oauthToken}\n${pat}\n${beads.passwordLine}`,
    windowCommand: `"$HOME/.local/bin/claude" --dangerously-skip-permissions`,
  });
}
