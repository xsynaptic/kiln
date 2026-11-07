import path from "node:path";
import process from "node:process";

import type { RunContext } from "./run-context.ts";

import { kilnConfig } from "../config/config.ts";
import { agentRunsRoot } from "../shared/run-artifacts.ts";
import { beadsClient } from "../vm/beads.ts";
import {
  agentRunExportLine,
  agentTmuxSession,
  agentTmuxSocket,
  bashTimeoutExportLine,
  gateEnvExportLines,
  singleQuote,
  sshCaptureSafe,
  startAgentTmux,
  writeGuestFile,
} from "../vm/vm.ts";
import { watchSession } from "./guest-wait.ts";
import { attendedStopReason, runModel } from "./receipts.ts";
import { modelFlag, reAnchorCommand, taskBranch } from "./run-args.ts";
import { finishReceipt, probeCommits, prUrlForBranch, rescuePaneLog, rescueSessionTranscript } from "./run-tail.ts";

export async function runAttended(context: RunContext): Promise<void> {
  const { args, baseline, claudeCode, clonePath, kit, launchHead, prompt, repoRoot, secrets, tokens, transcriptDir } =
    context;
  const workDir = path.posix.dirname(clonePath);
  const promptPath = path.posix.join(workDir, "attended-prompt.txt");
  const exitMarkerPath = path.posix.join(workDir, "attended-exit");
  const paneLogPath = path.posix.join(workDir, "attended-pane.log");
  writeGuestFile(args.name, promptPath, prompt);

  const windowCommand = `"$HOME/.local/bin/claude"${modelFlag(args.model)} --dangerously-skip-permissions "$(cat ${promptPath})"; echo $? > ${exitMarkerPath}`;
  const beads = beadsClient(args.name, args.readonlyTaskState);
  const runSecrets = [...secrets, beads.passwordLine.trim()];
  const startedAt = new Date().toISOString();
  startAgentTmux({
    afterStart: [
      `tmux -L ${agentTmuxSocket} pipe-pane -t ${agentTmuxSession} -o ${singleQuote(`cat >> ${paneLogPath}`)}`,
    ],
    beforeStart: [
      ...beads.envLines,
      agentRunExportLine(path.basename(transcriptDir), "attended"),
      bashTimeoutExportLine,
      ...gateEnvExportLines(kilnConfig.gates.env),
      `rm -f ${exitMarkerPath} ${paneLogPath}`,
    ],
    clonePath,
    profile: args.name,
    tokens: `${tokens}${beads.passwordLine}`,
    windowCommand,
  });

  console.log(`attended run active in ${args.name} (guest tmux session '${agentTmuxSession}')`);
  console.log(`  attach with: pnpm kiln attach ${args.name}   (Ctrl-b d detaches; the run keeps going)`);
  console.log(`  this wrapper waits for the session to end, then writes the receipt; Ctrl-C here ABORTS the run\n`);

  const watchOutcome = await watchSession(args.name);
  if (watchOutcome.detached) {
    console.log(`\nSIGTERM: detached from the attended run in ${args.name}; the session continues.`);
    console.log(`  re-anchor with: ${reAnchorCommand(args)}`);
    return;
  }
  const abortSignal = watchOutcome.abortSignal;
  const endedAt = new Date().toISOString();

  const exitRaw = sshCaptureSafe(args.name, `cat ${exitMarkerPath}`);
  const exitCode =
    exitRaw === undefined || exitRaw === "" || Number.isNaN(Number(exitRaw)) ? undefined : Number(exitRaw);
  const commits = probeCommits(args.name, clonePath, launchHead);
  rescuePaneLog(args.name, paneLogPath, transcriptDir, runSecrets);
  const session = rescueSessionTranscript(args.name, transcriptDir, startedAt, runSecrets);
  const prUrl = prUrlForBranch(taskBranch(args), args.review === undefined ? startedAt : undefined);

  finishReceipt(
    repoRoot,
    {
      branch: taskBranch(args),
      endedAt,
      mode: "attended",
      slot: args.name,
      startedAt,
      stopReason: attendedStopReason(exitCode, abortSignal),
      transcriptDir: path.relative(agentRunsRoot(repoRoot), transcriptDir),
    },
    {
      baseline,
      bead: args.bead,
      claudeCode,
      commits,
      decision: undefined,
      exitCode,
      kit,
      model: session === undefined ? undefined : runModel(session),
      nudge: undefined,
      prUrl,
      review: args.review,
      signals: undefined,
    },
  );
  process.exitCode = abortSignal === undefined ? (exitCode ?? 1) : 1;
}
