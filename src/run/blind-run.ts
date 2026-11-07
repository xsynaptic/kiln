import { createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { RunContext, RunCredentials } from "./run-context.ts";

import { kilnConfig } from "../config/config.ts";
import { agentRunsRoot } from "../shared/run-artifacts.ts";
import { lineScrubber } from "../shared/scrub.ts";
import { beadsClient } from "../vm/beads.ts";
import { guestKilnGateDir } from "../vm/guest-kit.ts";
import {
  agentRunExportLine,
  bashTimeoutExportLine,
  didScpFromGuest,
  gateEnvExportLines,
  singleQuote,
  spawnDetachedSshScript,
  sshCaptureSafe,
  writeGuestFile,
} from "../vm/vm.ts";
import { awaitGuestMarker } from "./guest-wait.ts";
import { runOutput, runOutputSchema, stopReasonFor } from "./receipts.ts";
import { modelFlag, reAnchorCommand, taskBranch } from "./run-args.ts";
import { lastResultSubtype, lastResultTerminalReason, resultMetrics, runModel } from "./run-stream.ts";
import { finishReceipt, probeCommits, prUrlForBranch, rescueSessionTranscript, scrubFile } from "./run-tail.ts";
import { nudgeMarkerFile, nudgeRecord, wrapupHookFile, wrapupHookSource, wrapupSettings } from "./wrapup-nudge.ts";

// Single-quoted, because the guest parses this again in `bash -c`, and double quotes would run any backticks in the prompt
/** @internal */
export function guestClaudeCommand(prompt: string, model: string | undefined, settingsFlag: string): string {
  return `"$HOME/.local/bin/claude" -p ${singleQuote(prompt)}${modelFlag(model)}${settingsFlag} --dangerously-skip-permissions --output-format stream-json --verbose --json-schema ${singleQuote(runOutputSchema)}`;
}

interface LaunchResult {
  aborted: boolean;
  detached: boolean;
  exitCode: number | undefined;
  signal: string | undefined;
}

// Scrubbed like the stream, because a gate log can hold raw output from a process that had the run's credentials
function fetchGateFiles(
  name: string,
  paths: { clonePath: string; runSecrets: Array<string>; transcriptDir: string },
): void {
  const hostDir = path.join(paths.transcriptDir, "kiln-gate");
  mkdirSync(hostDir, { recursive: true });
  for (const pattern of ["*.json", "*.log"]) {
    didScpFromGuest(name, path.posix.join(paths.clonePath, guestKilnGateDir, pattern), hostDir);
  }
  const files = readdirSync(hostDir);
  if (files.length === 0) {
    rmSync(hostDir, { recursive: true });
    return;
  }
  for (const file of files) {
    scrubFile(path.join(hostDir, file), paths.runSecrets);
  }
}

export async function runBlind(context: RunContext): Promise<void> {
  const { args, baseline, claudeCode, clonePath, kit, launchHead, prompt, repoRoot, secrets, tokens, transcriptDir } =
    context;
  const branch = taskBranch(args);
  const streamLog = path.join(transcriptDir, "stream.jsonl");
  const workDir = path.posix.dirname(clonePath);
  const guestStreamPath = path.posix.join(workDir, "blind-stream.jsonl");
  const exitMarkerPath = path.posix.join(workDir, "blind-exit");
  const pgidPath = path.posix.join(workDir, "blind-pgid");
  const hookPath = path.posix.join(workDir, wrapupHookFile);
  const nudgeMarkerPath = path.posix.join(workDir, nudgeMarkerFile);
  // Kept outside the clone, so a baseline reset can't wipe it and the run can't edit its own nudge
  writeGuestFile(args.name, hookPath, readFileSync(wrapupHookSource(), "utf8"));
  const settingsFlag = ` --settings ${singleQuote(wrapupSettings(hookPath, nudgeMarkerPath))}`;
  const claudeCommand = guestClaudeCommand(prompt, args.model, settingsFlag);
  const beads = beadsClient(args.name, args.readonlyTaskState);
  const runSecrets = [...secrets, beads.passwordLine.trim()];
  const script = [
    "set -euo pipefail",
    "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN",
    "IFS= read -r GH_TOKEN",
    "export CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN",
    ...beads.envLines,
    agentRunExportLine(path.basename(transcriptDir), "detached"),
    bashTimeoutExportLine,
    ...gateEnvExportLines(kilnConfig.gates.env),
    `cd ${JSON.stringify(clonePath)}`,
    `rm -f ${guestStreamPath} ${exitMarkerPath} ${pgidPath} ${nudgeMarkerPath}`,
    // `setsid` and a file in the guest, so a dropped connection neither kills the run nor breaks its output
    `setsid bash -c ${singleQuote(`${claudeCommand} >> ${guestStreamPath} 2>&1; echo $? > ${exitMarkerPath}`)} &`,
    `echo $! > ${pgidPath}`,
    `tail --retry --pid=$! -f -n +1 ${guestStreamPath}`,
    `RC=$(cat ${exitMarkerPath} 2>/dev/null || echo 1)`,
    `exit "$RC"`,
  ].join("\n");

  const startedAt = new Date().toISOString();
  console.log(`launching blind run in ${args.name}; stream tees to ${path.relative(repoRoot, streamLog)}\n`);
  const outcome = await launch(args.name, script, streamLog, {
    secrets: runSecrets,
    tokens: `${tokens}${beads.passwordLine}`,
  });

  if (outcome.detached) {
    console.log(`\nSIGTERM: detached from the live run in ${args.name}; it continues in the guest.`);
    console.log(`  re-anchor with: ${reAnchorCommand(args)}`);
    return;
  }

  let exitCode = outcome.exitCode;
  let signal = outcome.signal;
  if (outcome.aborted) {
    // The forwarded kill only reaches the local ssh, not the run detached inside the guest
    sshCaptureSafe(args.name, `PG=$(cat ${pgidPath} 2>/dev/null); [ -n "$PG" ] && kill -TERM -"$PG" 2>/dev/null; true`);
    // `outcome.signal` is the SIGTERM from forward()'s teardown, not something the operator sent
    signal = "SIGINT";
  } else {
    const guestEnd = await awaitGuestMarker(args.name, {
      exitMarkers: [exitMarkerPath],
      onInterrupt: () => {
        sshCaptureSafe(
          args.name,
          `PG=$(cat ${pgidPath} 2>/dev/null); [ -n "$PG" ] && kill -TERM -"$PG" 2>/dev/null; true`,
        );
      },
      pgrepPattern: "[c]laude -p",
      stillVerb: "anchored",
    });
    if (guestEnd.interrupted) {
      signal = "SIGINT";
    } else if (guestEnd.markerExit !== undefined) {
      exitCode = guestEnd.markerExit;
      signal = undefined;
    }
    // The host copy stops when the connection drops, so the guest's file is the complete stream
    didScpFromGuest(args.name, guestStreamPath, streamLog);
    scrubFile(streamLog, runSecrets);
    fetchGateFiles(args.name, { clonePath, runSecrets, transcriptDir });
  }
  const endedAt = new Date().toISOString();

  const stream = readFileSync(streamLog, "utf8");
  const resultSubtype = lastResultSubtype(stream);
  const terminalReason = lastResultTerminalReason(stream);
  const output = runOutput(stream);
  const prUrl = prUrlForBranch(branch, args.review === undefined ? startedAt : undefined) ?? output.prUrl;
  const commits = probeCommits(args.name, clonePath, launchHead);
  rescueSessionTranscript(args.name, transcriptDir, startedAt, runSecrets);

  finishReceipt(
    repoRoot,
    {
      branch,
      endedAt,
      slot: args.name,
      startedAt,
      stopReason: stopReasonFor(exitCode, signal, resultSubtype, terminalReason),
      transcriptDir: path.relative(agentRunsRoot(repoRoot), transcriptDir),
      ...resultMetrics(stream),
    },
    {
      baseline,
      bead: args.bead,
      claudeCode,
      commits,
      decision: output.decision,
      exitCode,
      kit,
      model: runModel(stream),
      nudge: nudgeRecord(args.name, workDir),
      outcome: output.outcome,
      prUrl,
      review: args.review,
      signals: output.signals,
    },
  );
  process.exitCode = exitCode ?? 1;
}

// SIGINT is the only deliberate abort; SIGTERM detaches and leaves the guest run alive, and SIGHUP only silences the console
function launch(
  profile: string,
  script: string,
  streamLog: string,
  credentials: RunCredentials,
): Promise<LaunchResult> {
  const log = createWriteStream(streamLog);
  const child = spawnDetachedSshScript(profile, script);
  child.stdin.write(credentials.tokens);
  child.stdin.end();
  let isQuiet = false;
  // One scrubber per stream, because each holds back its own unfinished line
  const outScrubber = lineScrubber(credentials.secrets);
  const errScrubber = lineScrubber(credentials.secrets);
  child.stdout.on("data", (chunk: Buffer) => {
    const scrubbed = outScrubber.feed(chunk.toString());
    if (scrubbed.length === 0) {
      return;
    }
    if (!isQuiet) {
      process.stdout.write(scrubbed);
    }
    log.write(scrubbed);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const scrubbed = errScrubber.feed(chunk.toString());
    if (scrubbed.length === 0) {
      return;
    }
    if (!isQuiet) {
      process.stderr.write(scrubbed);
    }
    log.write(scrubbed);
  });
  let isAborted = false;
  const forward = (): void => {
    isAborted = true;
    if (child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  return new Promise((resolve) => {
    let isSettled = false;
    const finish = (result: LaunchResult): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      // Pipes stuck on the shared ssh connection would keep the wrapper alive forever
      child.stdout.destroy();
      child.stderr.destroy();
      log.write(outScrubber.flush());
      log.write(errScrubber.flush());
      log.end();
      resolve(result);
    };
    const detach = (): void => {
      child.unref();
      finish({ aborted: false, detached: true, exitCode: undefined, signal: undefined });
    };
    // Never removed, because a late SIGTERM must not kill the wrapper while it writes the receipt
    process.on("SIGINT", forward);
    process.on("SIGTERM", detach);
    process.on("SIGHUP", () => {
      isQuiet = true;
    });
    // 'exit', not 'close', which the shared ssh connection can hold off forever; the grace period collects trailing output
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        finish({
          aborted: isAborted,
          detached: false,
          exitCode: code === null ? undefined : code,
          signal: signal === null ? undefined : signal,
        });
      }, 500);
    });
  });
}
