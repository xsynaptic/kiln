import { readFileSync } from "node:fs";
import path from "node:path";

import type { ReviewDecision, RunOutcome, RunSignal } from "./receipts.ts";
import type { WatchFlags } from "./run-args.ts";
import type { ResultMetrics } from "./run-stream.ts";

import { agentRunsPath, agentRunsRoot, ensureDir, mainCheckoutPath, timestampSlug } from "../shared/run-artifacts.ts";
import { acquireLease } from "../vm/lease.ts";
import {
  didScpFromGuest,
  guestClonePath,
  hasHeadlessClaude,
  isVmRunning,
  probeAgentTmuxSession,
  sshCaptureSafe,
} from "../vm/vm.ts";
import { currentBranch } from "./clone-baseline.ts";
import { awaitGuestMarker } from "./guest-wait.ts";
import { readTokens } from "./launch-run.ts";
import { attendedStopReason, runOutput, stopReasonFor } from "./receipts.ts";
import { lastResultSubtype, lastResultTerminalReason, resultMetrics, runModel } from "./run-stream.ts";
import { finishReceipt, prUrlForBranch, rescueSessionTranscript, scrubFile } from "./run-tail.ts";
import { nudgeRecord } from "./wrapup-nudge.ts";

export async function watchSlot(name: string, flags: WatchFlags): Promise<void> {
  if (!isVmRunning(name)) {
    throw new Error(`${name} is not running; there is nothing to watch`);
  }
  const repoRoot = mainCheckoutPath();
  const releaseLease = acquireLease(repoRoot, name, "watch");
  try {
    await watchRun(name, flags, repoRoot);
  } finally {
    releaseLease();
  }
}

interface StreamReading {
  decision: ReviewDecision | undefined;
  metrics: ResultMetrics;
  model: string | undefined;
  outcome: RunOutcome | undefined;
  prUrl: string | undefined;
  signals: Array<RunSignal> | undefined;
  stopReason: string;
}

// Each mode clears only its own marker and stream, so the other mode's are a past run's
function liveRunMode(name: string): "attended" | "blind" {
  if (hasHeadlessClaude(name)) {
    return "blind";
  }
  if (probeAgentTmuxSession(name) === "live") {
    return "attended";
  }
  throw new Error(
    `no live run in ${name} (no headless claude, no attended session); ` +
      `a leftover exit marker would belong to an already-receipted run`,
  );
}

// The watch begins after the run did, so the run's start is the age of the file its launch wrote once
function liveRunStart(name: string, workDir: string, mode: "attended" | "blind"): string | undefined {
  const launchFile = path.posix.join(workDir, mode === "blind" ? "blind-pgid" : "attended-prompt.txt");
  const raw = sshCaptureSafe(name, `stat -c %Y ${launchFile}`);
  const seconds = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

function watchedPrUrl(
  name: string,
  workDir: string,
  run: { branch: string; mode: "attended" | "blind"; reported: string | undefined; review: number | undefined },
): string | undefined {
  const openedSince = run.review === undefined ? liveRunStart(name, workDir, run.mode) : undefined;
  return prUrlForBranch(run.branch, openedSince) ?? run.reported;
}

function readBlindStream(
  name: string,
  workDir: string,
  streamOnHost: string,
  secrets: Array<string>,
): string | undefined {
  if (!didScpFromGuest(name, path.posix.join(workDir, "blind-stream.jsonl"), streamOnHost)) {
    return undefined;
  }
  scrubFile(streamOnHost, secrets);
  return readFileSync(streamOnHost, "utf8");
}

function streamReading(stream: string | undefined, markerExit: number | undefined): StreamReading {
  if (stream === undefined) {
    return {
      decision: undefined,
      metrics: {},
      model: undefined,
      outcome: undefined,
      prUrl: undefined,
      signals: undefined,
      stopReason: attendedStopReason(markerExit, undefined),
    };
  }
  const { decision, outcome, prUrl, signals } = runOutput(stream);
  return {
    decision,
    metrics: resultMetrics(stream),
    model: runModel(stream),
    outcome,
    prUrl,
    signals,
    stopReason: stopReasonFor(markerExit, undefined, lastResultSubtype(stream), lastResultTerminalReason(stream)),
  };
}

async function watchRun(name: string, flags: WatchFlags, repoRoot: string): Promise<void> {
  const clonePath = guestClonePath(name);
  const workDir = path.posix.dirname(clonePath);
  const branch = currentBranch(name, clonePath) ?? "unknown";
  const mode = liveRunMode(name);

  const startedAt = new Date().toISOString();
  const transcriptDir = agentRunsPath(repoRoot, "transcripts", `${name}-watch-${timestampSlug()}`);
  ensureDir(transcriptDir);
  console.log(`watching the live run in ${name} (branch ${branch}); Ctrl-C stops watching without touching it`);

  // No onInterrupt, so Ctrl-C leaves the run running
  const end = await awaitGuestMarker(name, {
    exitMarkers: [path.posix.join(workDir, `${mode}-exit`)],
    pgrepPattern: "[c]laude",
    stillVerb: "watching",
  });
  if (end.interrupted) {
    console.log("\nstopped watching; the run continues and remains unreceipted");
    return;
  }
  const endedAt = new Date().toISOString();
  const { oauthToken, pat } = readTokens();
  const secrets = [oauthToken, pat];

  // A blind run's missing stream reads as empty, as blind-run.ts reads it, so a clean exit is not taken for a completion
  const stream =
    mode === "blind"
      ? (readBlindStream(name, workDir, path.join(transcriptDir, "stream.jsonl"), secrets) ?? "")
      : undefined;
  const { decision, metrics, outcome, signals, stopReason, ...reading } = streamReading(stream, end.markerExit);
  const session = rescueSessionTranscript(name, transcriptDir, startedAt, secrets);
  const model = reading.model ?? (session === undefined ? undefined : runModel(session));

  const commitsRaw = sshCaptureSafe(
    name,
    `git -C ${JSON.stringify(clonePath)} rev-list --count github/main..HEAD 2>/dev/null`,
  );
  const commits = commitsRaw === undefined ? NaN : Number(commitsRaw);
  const prUrl = watchedPrUrl(name, workDir, { branch, mode, reported: reading.prUrl, review: flags.review });

  finishReceipt(
    repoRoot,
    {
      branch,
      endedAt,
      mode: "watch",
      slot: name,
      startedAt,
      stopReason,
      transcriptDir: path.relative(agentRunsRoot(repoRoot), transcriptDir),
      ...metrics,
    },
    {
      baseline: undefined,
      bead: flags.bead,
      claudeCode: undefined,
      commits: Number.isNaN(commits) ? undefined : commits,
      decision,
      exitCode: end.markerExit,
      kit: undefined,
      model,
      nudge: nudgeRecord(name, workDir),
      outcome,
      prUrl,
      review: flags.review,
      signals,
    },
  );
}
