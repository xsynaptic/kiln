import { spawnSync } from "node:child_process";
import process from "node:process";
import { z } from "zod";

import { kilnConfig } from "../config/config.ts";
import { parseJson } from "../shared/lenient-json.ts";

// Herdr finds agents by the pane's foreground process, which is ssh for a slot, so the claim registers the agent itself
// Reported state overrides herdr's own detection, so the poller passes on what detection would have said
const metadataSource = `${kilnConfig.identity.projectName}:slot`;
const pollMs = 3000;
const reportableStates = new Set(["blocked", "idle", "unknown", "working"]);

interface SlotPaneClaim {
  release: () => void;
}

// Herdr drops any event whose sequence number isn't higher than the last one, even across a release
const seq = { last: 0n };
function nextSeq(): string {
  const now = BigInt(Date.now()) * 1_000_000n;
  seq.last = now > seq.last ? now : seq.last + 1n;
  return String(seq.last);
}

function didRunHerdr(args: Array<string>): boolean {
  return spawnSync("herdr", args, { stdio: "ignore" }).status === 0;
}

function didReportState(paneId: string, slot: string, state: string): boolean {
  return didRunHerdr([
    "pane",
    "report-agent",
    paneId,
    "--source",
    metadataSource,
    "--agent",
    "claude",
    "--state",
    state,
    "--seq",
    nextSeq(),
    "--message",
    `sandbox session in ${slot}`,
  ]);
}

const herdrExplainSchema = z.object({ state: z.string() });

function detectorState(paneId: string): string | undefined {
  const result = spawnSync("herdr", ["agent", "explain", paneId, "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  const state = herdrExplainSchema.safeParse(parseJson(result.stdout)).data?.state;
  return state === "done" ? "idle" : state;
}

// Skipped inside Claude Code, where HERDR_PANE_ID names the calling session's own pane
export function claimSlotPane(slot: string): SlotPaneClaim | undefined {
  const paneId = process.env.HERDR_PANE_ID;
  if (paneId === undefined || paneId.length === 0 || process.env.CLAUDECODE !== undefined) {
    return undefined;
  }
  if (!didReportState(paneId, slot, "working")) {
    return undefined;
  }
  didRunHerdr(["agent", "rename", paneId, slot]);
  didRunHerdr(["pane", "report-metadata", paneId, "--source", metadataSource, "--display-agent", "claude (slot)"]);

  let lastState = "working";
  const poller = setInterval(() => {
    const state = detectorState(paneId);
    if (state === undefined || state === lastState || !reportableStates.has(state)) return;
    lastState = state;
    didReportState(paneId, slot, state);
  }, pollMs);
  poller.unref();

  return {
    release: () => {
      clearInterval(poller);
      didRunHerdr(["pane", "report-metadata", paneId, "--source", metadataSource, "--clear-display-agent"]);
      didRunHerdr([
        "pane",
        "release-agent",
        paneId,
        "--source",
        metadataSource,
        "--agent",
        "claude",
        "--seq",
        nextSeq(),
      ]);
    },
  };
}
