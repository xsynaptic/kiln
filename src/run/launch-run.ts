import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { Args } from "./run-args.ts";
import type { RunContext, RunCredentials } from "./run-context.ts";

import { credentialsDir, kilnConfig } from "../config/config.ts";
import { agentRunsPath, ensureDir, mainCheckoutPath, timestampSlug } from "../shared/run-artifacts.ts";
import { stageGuestKit } from "../vm/guest-kit.ts";
import { acquireLease } from "../vm/lease.ts";
import { agentSlotFromName } from "../vm/ports.ts";
import { parseClaudeVersion } from "../vm/toolchain.ts";
import { didSshAnswer, guestClonePath, isVmRunning, sshCaptureSafe, writeGuestFile } from "../vm/vm.ts";
import { runAttended } from "./attended-run.ts";
import { runBlind } from "./blind-run.ts";
import { currentBranch, prepareClone } from "./clone-baseline.ts";
import { runMode, taskBranch } from "./run-args.ts";
import { wrapupHookSource } from "./wrapup-nudge.ts";

export async function startRun(args: Args): Promise<void> {
  if (agentSlotFromName(args.name) === undefined) {
    throw new Error("slot must be kiln-<n> (n in 1..8)");
  }
  if (!isVmRunning(args.name)) {
    throw new Error(`${args.name} is not running; provision it first: pnpm kiln new ${args.name}`);
  }
  const briefContent = readFileSync(args.brief, "utf8");
  const { oauthToken, pat } = readTokens();
  const credentials: RunCredentials = { secrets: [oauthToken, pat], tokens: `${oauthToken}\n${pat}\n` };

  const repoRoot = mainCheckoutPath();
  const releaseLease = acquireLease(repoRoot, args.name, args.attach ? "attended run" : "blind run");
  try {
    await leasedRun(args, repoRoot, briefContent, credentials);
  } finally {
    releaseLease();
  }
}

export function readTokens(): { oauthToken: string; pat: string } {
  const oauthFile = process.env.KILN_OAUTH_TOKEN_FILE ?? path.join(credentialsDir(), "oauth-token");
  if (!existsSync(oauthFile)) {
    throw new Error(
      `no OAuth token at ${oauthFile}; create it once with \`claude setup-token\` (chmod 600), ` +
        `or point KILN_OAUTH_TOKEN_FILE at it`,
    );
  }
  const patFile = process.env.KILN_GITHUB_PAT_FILE ?? path.join(credentialsDir(), "github-pat");
  if (!existsSync(patFile)) {
    throw new Error(
      `no machine-user PAT at ${patFile}; without it the run cannot fetch github/main, push, or ` +
        `open a PR, so it would spend a slot to deliver nothing. Create the file (chmod 600) or ` +
        `point KILN_GITHUB_PAT_FILE at it`,
    );
  }
  return {
    oauthToken: readFileSync(oauthFile, "utf8").trim(),
    pat: readFileSync(patFile, "utf8").trim(),
  };
}

async function leasedRun(
  args: Args,
  repoRoot: string,
  briefContent: string,
  credentials: RunCredentials,
): Promise<void> {
  const clonePath = guestClonePath(args.name);
  const briefPath = path.posix.join(path.posix.dirname(clonePath), "brief.md");
  const branch = taskBranch(args);

  if (!didSshAnswer(args.name)) {
    throw new Error(`${args.name} is not answering ssh; the slot is up but not reachable`);
  }

  const cloneBaseline = { base: args.base ?? "main", branch };
  if (args.noReset) {
    const current = currentBranch(args.name, clonePath);
    if (current !== branch) {
      throw new Error(`--no-reset needs the clone on ${branch}, but it is on ${current ?? "an unknown branch"}`);
    }
    console.log(`continuing on ${args.name}'s existing clone state (--no-reset), branch ${branch}`);
  } else {
    console.log(`baselining ${args.name} clone on github/${cloneBaseline.base}, branching ${branch}`);
    prepareClone(args.name, clonePath, cloneBaseline, credentials.tokens);
  }
  writeGuestFile(args.name, briefPath, briefContent);
  const { kit, modesDir } = stageGuestKit(args.name, clonePath, [wrapupHookSource()]);
  const claudeCode = parseClaudeVersion(sshCaptureSafe(args.name, `"$HOME/.local/bin/claude" --version`));
  const launchHead = sshCaptureSafe(args.name, `git -C ${JSON.stringify(clonePath)} rev-parse HEAD`);
  const baseline = sshCaptureSafe(args.name, `git -C ${JSON.stringify(clonePath)} rev-parse github/main`);

  const runName = `${args.name}-${timestampSlug()}`;
  const transcriptDir = agentRunsPath(repoRoot, "transcripts", runName);
  ensureDir(transcriptDir);

  // Nothing here is read from the branch, because a branch under review could rewrite its own instructions
  const prompt =
    `Read ${briefPath} and complete that task. Your operating manual is ` +
    `${modesDir}/${runMode(args)}.md, staged by the host beside the mode docs it links; follow it ` +
    `exactly, including the delivery steps. The project's additions are ${kilnConfig.projectDoc} on ` +
    `\`github/main\`, which you read with \`git show github/main:<path>\`, as you do every repo ` +
    `file it links. The task branch ${branch} is already checked out.`;

  const context: RunContext = {
    ...credentials,
    args,
    baseline,
    claudeCode,
    clonePath,
    kit,
    launchHead,
    prompt,
    repoRoot,
    transcriptDir,
  };
  await (args.attach ? runAttended(context) : runBlind(context));
}
