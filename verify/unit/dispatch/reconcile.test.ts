import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import type { RunReceipt } from "#src/run/receipts.ts";

import { pendingRunOutcome } from "#src/dispatch/reconcile.ts";

const LAUNCHED_AT = "2026-08-17T19:20:00.000Z";
const NOW_MS = Date.parse("2026-08-17T19:46:20.716Z");
const REPO_ROOT = "/repo";

function delivered(startedAt = "2026-08-17T19:20:30.000Z"): RunReceipt {
  return {
    bead: "bd-7",
    branch: "feat/x",
    commits: 3,
    endedAt: "2026-08-17T19:46:07.905Z",
    prUrl: "https://github.com/o/r/pull/1",
    slot: "kiln-1",
    startedAt,
    stopReason: "completed",
    transcriptDir: "/runs/t",
  };
}

function store(receipts: Array<RunReceipt>): void {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-test-"));
  process.env.KILN_RUNS_DIR = dir;
  if (receipts.length > 0) {
    writeFileSync(path.join(dir, "runs.jsonl"), receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""));
  }
}

describe("pendingRunOutcome (dead-run boundary)", () => {
  const saved = process.env.KILN_RUNS_DIR;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KILN_RUNS_DIR;
    } else {
      process.env.KILN_RUNS_DIR = saved;
    }
  });

  it("takes the receipt the snapshot already carries", () => {
    store([]);
    const receipt = delivered();
    expect(pendingRunOutcome({ receipts: [receipt], repoRoot: REPO_ROOT }, "bd-7", LAUNCHED_AT, NOW_MS)).toEqual({
      kind: "receipt",
      receipt,
    });
  });

  it("leaves a run inside the grace window alone, without reading the file", () => {
    store([delivered()]);
    const justLaunched = new Date(NOW_MS - 2 * 60_000).toISOString();
    expect(pendingRunOutcome({ receipts: [], repoRoot: REPO_ROOT }, "bd-7", justLaunched, NOW_MS)).toEqual({
      ageMinutes: 2,
      kind: "starting",
    });
  });

  it("finds a receipt written after the crank took its snapshot", () => {
    store([delivered()]);
    expect(pendingRunOutcome({ receipts: [], repoRoot: REPO_ROOT }, "bd-7", LAUNCHED_AT, NOW_MS)).toEqual({
      kind: "receipt",
      receipt: delivered(),
    });
  });

  it("still calls a run dead when the file has nothing either", () => {
    store([]);
    expect(pendingRunOutcome({ receipts: [], repoRoot: REPO_ROOT }, "bd-7", LAUNCHED_AT, NOW_MS)).toEqual({
      kind: "dead",
    });
  });

  it("does not count a receipt from an earlier attempt", () => {
    store([delivered("2026-08-17T18:00:00.000Z")]);
    expect(pendingRunOutcome({ receipts: [], repoRoot: REPO_ROOT }, "bd-7", LAUNCHED_AT, NOW_MS)).toEqual({
      kind: "dead",
    });
  });
});
