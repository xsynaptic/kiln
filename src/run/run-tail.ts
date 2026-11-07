import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDefined, pickBy } from "remeda";
import { z } from "zod";

import type { RunReceipt } from "./receipts.ts";

import { kilnConfig } from "../config/config.ts";
import { parseEach, parseJson } from "../shared/lenient-json.ts";
import { agentRunsPath, ensureDir, pruneOldRuns, safeCapture } from "../shared/run-artifacts.ts";
import { scrubSecrets } from "../shared/scrub.ts";
import { didScpFromGuest, sshCaptureSafe } from "../vm/vm.ts";
import { receiptLine } from "./receipts.ts";
import { appendSignalsFile } from "./signals.ts";

export type ReceiptExtras = {
  [
    Field in
      | "baseline"
      | "bead"
      | "claudeCode"
      | "commits"
      | "decision"
      | "exitCode"
      | "kit"
      | "model"
      | "nudge"
      | "outcome"
      | "prUrl"
      | "review"
      | "signals"
  ]: RunReceipt[Field] | undefined;
};

export function finishReceipt(repoRoot: string, base: RunReceipt, extras: ReceiptExtras): void {
  const receipt = withExtras(base, extras);
  appendReceipt(repoRoot, receipt);
  console.log(`\nrun ${receipt.stopReason}; receipt appended to ${agentRunsPath(repoRoot, "runs.jsonl")}`);
  if (extras.prUrl !== undefined) {
    console.log(`  PR: ${extras.prUrl}`);
  }
  if (receipt.signals === undefined) {
    return;
  }
  const file = appendSignalsFile(repoRoot, receipt.signals, path.basename(base.transcriptDir));
  console.log(`  ${String(receipt.signals.length)} signal(s) filed to ${file}`);
}

export function probeCommits(profile: string, clonePath: string, launchHead: string | undefined): number | undefined {
  if (launchHead === undefined) {
    return undefined;
  }
  const raw = sshCaptureSafe(profile, `git -C ${JSON.stringify(clonePath)} rev-list --count ${launchHead}..HEAD`);
  const commits = raw === undefined ? NaN : Number(raw);
  return Number.isNaN(commits) ? undefined : commits;
}

const branchPrSchema = z.object({ createdAt: z.string(), url: z.string() });

// `--state all`, because a review run's receipt is written after the PR it approved has merged
// A bead reuses its branch on every attempt, so a PR opened before `openedSince` is an earlier attempt's
export function prUrlForBranch(head: string, openedSince: string | undefined): string | undefined {
  const listed = safeCapture("gh", [
    "pr",
    "list",
    "--repo",
    kilnConfig.identity.githubRepo,
    "--head",
    head,
    "--state",
    "all",
    "--json",
    "createdAt,url",
  ]);
  const sinceMs = openedSince === undefined ? -Infinity : Date.parse(openedSince);
  return parseEach(branchPrSchema, parseJson(listed)).find((pr) => Date.parse(pr.createdAt) >= sinceMs)?.url;
}

export function rescuePaneLog(
  profile: string,
  paneLogPath: string,
  transcriptDir: string,
  secrets: Array<string>,
): void {
  const paneOnHost = path.join(transcriptDir, "pane.log");
  if (didScpFromGuest(profile, paneLogPath, paneOnHost)) {
    scrubFile(paneOnHost, secrets);
  }
}

// Only a transcript changed after launch counts, so a run that wrote none never picks up the previous run's
export function rescueSessionTranscript(
  profile: string,
  transcriptDir: string,
  startedAt: string,
  secrets: Array<string>,
): string | undefined {
  const startEpoch = Math.floor(new Date(startedAt).getTime() / 1000);
  const newest = sshCaptureSafe(
    profile,
    `find ~/.claude/projects -name '*.jsonl' -newermt @${String(startEpoch)} 2>/dev/null | xargs -r ls -t | head -1`,
  );
  if (newest === undefined || newest.length === 0) {
    return undefined;
  }
  const sessionOnHost = path.join(transcriptDir, "session.jsonl");
  if (!didScpFromGuest(profile, newest, sessionOnHost)) {
    return undefined;
  }
  scrubFile(sessionOnHost, secrets);
  return readFileSync(sessionOnHost, "utf8");
}

export function scrubFile(filePath: string, secrets: Array<string>): void {
  try {
    writeFileSync(filePath, scrubSecrets(readFileSync(filePath, "utf8"), secrets));
  } catch {}
}

function appendReceipt(repoRoot: string, receipt: RunReceipt): void {
  ensureDir(agentRunsPath(repoRoot));
  appendFileSync(agentRunsPath(repoRoot, "runs.jsonl"), `${receiptLine(receipt)}\n`);
  const pruned = pruneOldRuns(repoRoot);
  if (pruned > 0) {
    console.log(`  pruned ${String(pruned)} run artifact(s) past the retention window`);
  }
}

/** @internal */
export function withExtras(base: RunReceipt, extras: ReceiptExtras): RunReceipt {
  const { signals, ...fields } = extras;
  const present = pickBy(fields, isDefined);
  return { ...base, ...present, ...(signals !== undefined && signals.length > 0 ? { signals } : {}) };
}
