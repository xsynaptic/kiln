import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarkerPollConfig } from "#src/run/guest-wait.ts";

import { run } from "#src/commands/watch.ts";
import { readReceipts } from "#src/dispatch/reconcile.ts";
import { awaitGuestMarker } from "#src/run/guest-wait.ts";
import { watchSlot } from "#src/run/watch-run.ts";
import { mainCheckoutPath, safeCapture } from "#src/shared/run-artifacts.ts";
import { acquireLease } from "#src/vm/lease.ts";
import {
  didScpFromGuest,
  guestClonePath,
  hasHeadlessClaude,
  isVmRunning,
  probeAgentTmuxSession,
  sshCaptureSafe,
} from "#src/vm/vm.ts";

vi.mock(import("#src/vm/vm.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  didScpFromGuest: vi.fn(),
  guestClonePath: vi.fn(),
  hasHeadlessClaude: vi.fn(),
  isVmRunning: vi.fn(),
  probeAgentTmuxSession: vi.fn(),
  sshCaptureSafe: vi.fn(),
}));

vi.mock(import("#src/run/guest-wait.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  awaitGuestMarker: vi.fn(),
}));

vi.mock(import("#src/shared/run-artifacts.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  mainCheckoutPath: vi.fn(),
  safeCapture: vi.fn(),
}));

const slot = "kiln-3";
const workDir = "/mnt/lima-data/work";
const blindExit = `${workDir}/blind-exit`;
const attendedExit = `${workDir}/attended-exit`;
const blindStream = `${workDir}/blind-stream.jsonl`;
const prUrl = "https://github.com/acme/sample/pull/31";
const earlierPrUrl = "https://github.com/acme/sample/pull/30";
// The run launched at 08:00, before the watch began
const launchedAtSeconds = Date.parse("2026-09-12T08:00:00Z") / 1000;
const ourPr = { createdAt: "2026-09-12T08:30:00Z", url: prUrl };
const earlierAttemptPr = { createdAt: "2026-09-11T17:00:00Z", url: earlierPrUrl };

const noFlags = { bead: undefined, review: undefined };

const succeeded = `${JSON.stringify({ subtype: "success", type: "result" })}\n`;
const partial = `${JSON.stringify({ type: "assistant" })}\n`;

type LiveMode = "attended" | "blind" | undefined;

// The guest's work dir: what each file holds, and what the live run writes when it ends
interface Guest {
  files: Map<string, string>;
  onEnd: Map<string, string>;
}

let guest: Guest = { files: new Map(), onEnd: new Map() };
let repoRoot = "";

function hostRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "kiln-watch-"));
}

function liveRun(mode: LiveMode, files: Record<string, string>, onEnd: Record<string, string>): void {
  guest = { files: new Map(Object.entries(files)), onEnd: new Map(Object.entries(onEnd)) };
  vi.mocked(hasHeadlessClaude).mockReturnValue(mode === "blind");
  vi.mocked(probeAgentTmuxSession).mockReturnValue(mode === "attended" ? "live" : "ended");
}

// Answers on the first marker present, as the guest probe does; when none is, the live run ends and writes its own
function markerWait(_profile: string, config: MarkerPollConfig) {
  const present = () => config.exitMarkers.find((marker) => guest.files.has(marker));
  if (present() === undefined) {
    for (const [file, content] of guest.onEnd) guest.files.set(file, content);
  }
  const marker = present();
  return Promise.resolve({
    interrupted: false,
    markerExit: marker === undefined ? undefined : Number(guest.files.get(marker)),
  });
}

function guestShell(_profile: string, command: string): string | undefined {
  if (command.includes("branch --show-current")) return "feat/sample";
  if (command.includes("rev-list --count")) return "2";
  if (command.startsWith("stat -c %Y")) return String(launchedAtSeconds);
  return undefined;
}

function didCopyFromGuest(_profile: string, guestPath: string, hostDest: string): boolean {
  const content = guest.files.get(guestPath);
  if (content === undefined) {
    return false;
  }
  writeFileSync(hostDest, content);
  return true;
}

function quietly(): void {
  vi.spyOn(console, "log").mockReturnValue();
}

beforeEach(() => {
  vi.restoreAllMocks();
  repoRoot = hostRoot();
  const credentials = hostRoot();
  writeFileSync(path.join(credentials, "oauth"), "oauth-secret");
  writeFileSync(path.join(credentials, "pat"), "pat-secret");
  vi.stubEnv("KILN_RUNS_DIR", path.join(repoRoot, "runs"));
  vi.stubEnv("KILN_OAUTH_TOKEN_FILE", path.join(credentials, "oauth"));
  vi.stubEnv("KILN_GITHUB_PAT_FILE", path.join(credentials, "pat"));
  vi.mocked(mainCheckoutPath).mockReturnValue(repoRoot);
  vi.mocked(safeCapture).mockReturnValue(JSON.stringify([ourPr]));
  vi.mocked(isVmRunning).mockReturnValue(true);
  vi.mocked(guestClonePath).mockReturnValue(`${workDir}/sample`);
  vi.mocked(sshCaptureSafe).mockImplementation(guestShell);
  vi.mocked(didScpFromGuest).mockImplementation(didCopyFromGuest);
  vi.mocked(awaitGuestMarker).mockImplementation(markerWait);
  quietly();
});

describe("kiln watch refuses what it cannot receipt", () => {
  it("refuses without a slot name, or with a name that is not a slot", async () => {
    await expect(run([])).rejects.toThrow("usage: pnpm kiln watch");
    await expect(run(["dispatch"])).rejects.toThrow("usage: pnpm kiln watch");
  });

  it("refuses a slot whose VM is not running", async () => {
    vi.mocked(isVmRunning).mockReturnValue(false);
    await expect(watchSlot(slot, noFlags)).rejects.toThrow("not running");
    expect(readReceipts(repoRoot)).toEqual([]);
  });

  it("refuses a running slot with no live run, whatever markers a past run left", async () => {
    liveRun(undefined, { [attendedExit]: "0", [blindExit]: "0" }, {});
    await expect(watchSlot(slot, noFlags)).rejects.toThrow("no live run");
    expect(readReceipts(repoRoot)).toEqual([]);
  });

  it("refuses while another process holds the slot lease", async () => {
    liveRun("blind", {}, { [blindExit]: "0", [blindStream]: succeeded });
    const release = acquireLease(repoRoot, slot, "blind run", () => undefined);
    try {
      await expect(watchSlot(slot, noFlags)).rejects.toThrow("leased by a live blind run");
    } finally {
      release();
    }
    expect(awaitGuestMarker).not.toHaveBeenCalled();
    expect(readReceipts(repoRoot)).toEqual([]);
  });
});

describe("kiln watch receipts the live run", () => {
  it("writes a watch receipt carrying the bead, the review and the guest stream's stop reason", async () => {
    liveRun("blind", {}, { [blindExit]: "0", [blindStream]: succeeded });
    await watchSlot(slot, { bead: "acme-7", review: 31 });
    expect(readReceipts(repoRoot)).toMatchObject([
      { bead: "acme-7", commits: 2, exitCode: 0, mode: "watch", prUrl, review: 31, slot, stopReason: "completed" },
    ]);
  });

  it("takes the stop reason from the marker when the guest left no stream", async () => {
    liveRun("attended", {}, { [attendedExit]: "3" });
    await watchSlot(slot, noFlags);
    expect(readReceipts(repoRoot)).toMatchObject([{ exitCode: 3, mode: "watch", stopReason: "failed:exit:3" }]);
  });

  it("reads a blind run that left no stream as crashed, as its own wrapper would, whatever its exit", async () => {
    liveRun("blind", {}, { [blindExit]: "0" });
    await watchSlot(slot, noFlags);
    expect(readReceipts(repoRoot)).toMatchObject([{ exitCode: 0, stopReason: "crashed:no-result-event" }]);
  });

  it("takes no PR an earlier attempt opened on the branch, but the one the run reports in its result", async () => {
    vi.mocked(safeCapture).mockReturnValue(JSON.stringify([earlierAttemptPr]));
    liveRun("attended", {}, { [attendedExit]: "0" });
    await watchSlot(slot, noFlags);
    const claimed = JSON.stringify({ structured_output: { prUrl }, subtype: "success", type: "result" });
    liveRun("blind", {}, { [blindExit]: "0", [blindStream]: `${claimed}\n` });
    await watchSlot(slot, noFlags);
    const [attended, blind] = readReceipts(repoRoot);
    expect(attended?.prUrl).toBeUndefined();
    expect(blind?.prUrl).toBe(prUrl);
  });

  it("writes no receipt when Ctrl-C stops the watch", async () => {
    liveRun("blind", {}, { [blindExit]: "0", [blindStream]: succeeded });
    vi.mocked(awaitGuestMarker).mockResolvedValue({ interrupted: true, markerExit: undefined });
    await watchSlot(slot, { ...noFlags, bead: "acme-7" });
    expect(readReceipts(repoRoot)).toEqual([]);
  });

  it("waits out a live blind run past the exit marker an earlier attended run left", async () => {
    liveRun("blind", { [attendedExit]: "1", [blindStream]: partial }, { [blindExit]: "0", [blindStream]: succeeded });
    await watchSlot(slot, { ...noFlags, bead: "acme-7" });
    expect(readReceipts(repoRoot)).toMatchObject([{ exitCode: 0, stopReason: "completed" }]);
  });

  it("reads a live attended run's own marker, not the exit and stream an earlier blind run left", async () => {
    liveRun("attended", { [blindExit]: "0", [blindStream]: succeeded }, { [attendedExit]: "2" });
    await watchSlot(slot, { ...noFlags, bead: "acme-7" });
    expect(readReceipts(repoRoot)).toMatchObject([{ exitCode: 2, stopReason: "failed:exit:2" }]);
  });
});
