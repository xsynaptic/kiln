import process from "node:process";

import { agentTmuxKill, probeAgentTmuxSession, sshCaptureSafe } from "../vm/vm.ts";
import { classifyProbe, deadMissLimit, nextMisses } from "./receipts.ts";

export interface MarkerPollConfig {
  exitMarkers: Array<string>;
  onInterrupt?: () => void;
  pgrepPattern: string;
  stillVerb: string;
}

interface GuestEnd {
  interrupted: boolean;
  markerExit: number | undefined;
}

export async function awaitGuestMarker(profile: string, config: MarkerPollConfig): Promise<GuestEnd> {
  const markerBranches = config.exitMarkers
    .map((marker, index) => `${index === 0 ? "if" : "elif"} [ -f ${marker} ]; then echo "ended $(cat ${marker})"; `)
    .join("");
  const probeCommand = `${markerBranches}elif pgrep -f '${config.pgrepPattern}' >/dev/null; then echo running; else echo dead; fi`;
  let interruptSignal: string | undefined;
  const onSigint = (): void => {
    interruptSignal = "SIGINT";
  };
  process.on("SIGINT", onSigint);
  // oxlint-disable-next-line typescript/no-empty-function -- a handler stops SIGHUP killing the wait
  process.on("SIGHUP", () => {});
  let misses = 0;
  let isAnnounced = false;
  try {
    while (interruptSignal === undefined) {
      const state = classifyProbe(sshCaptureSafe(profile, probeCommand));
      if (state.kind === "ended") {
        return { interrupted: false, markerExit: state.markerExit };
      }
      misses = nextMisses(misses, state.kind);
      if (state.kind === "dead" && misses >= deadMissLimit) {
        return { interrupted: false, markerExit: undefined };
      }
      if (!isAnnounced && state.kind === "unreachable") {
        console.log(
          `\n${profile} unreachable; still ${config.stillVerb} (a host sleep or forwarder blip is not a crash)`,
        );
        isAnnounced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    config.onInterrupt?.();
    return { interrupted: true, markerExit: undefined };
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export async function watchSession(profile: string): Promise<{ abortSignal?: string; detached: boolean }> {
  let abortSignal: string | undefined;
  let detachSignal: string | undefined;
  const onAbort = (): void => {
    abortSignal = "SIGINT";
  };
  const onDetach = (): void => {
    detachSignal = "SIGTERM";
  };
  process.on("SIGINT", onAbort);
  process.on("SIGTERM", onDetach);
  // oxlint-disable-next-line typescript/no-empty-function -- a handler stops SIGHUP killing the anchor
  process.on("SIGHUP", () => {});
  let isAnnounced = false;
  while (abortSignal === undefined && detachSignal === undefined) {
    const probe = probeAgentTmuxSession(profile);
    if (probe === "ended") {
      break;
    }
    if (probe === "unreachable" && !isAnnounced) {
      console.log(
        `\n${profile} unreachable; still anchored (a host sleep or forwarder blip is not the session ending)`,
      );
      isAnnounced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (detachSignal !== undefined) {
    return { detached: true };
  }
  if (abortSignal !== undefined) {
    console.log(`\n${abortSignal} received; aborting the run (killing the guest tmux server)`);
    agentTmuxKill(profile);
    return { abortSignal, detached: false };
  }
  return { detached: false };
}
