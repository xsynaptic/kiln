import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const HOOK = path.join(import.meta.dirname, "../../../src/run/wrapup-hook.mjs");

interface HookRun {
  latched: boolean;
  marker: unknown;
  status: null | number;
  stdout: string;
}

function assistant(tokens: number, startedMinutesAgo = 0): string {
  return JSON.stringify({
    message: {
      usage: {
        cache_creation_input_tokens: tokens - 2,
        cache_read_input_tokens: 1,
        input_tokens: 1,
      },
    },
    timestamp: new Date(Date.now() - startedMinutesAgo * 60_000).toISOString(),
    type: "assistant",
    uuid: "turn-1",
  });
}

function runHook(transcript: string, workDir?: string): HookRun {
  const dir = workDir ?? mkdtempSync(path.join(tmpdir(), "wrapup-"));
  const transcriptPath = path.join(dir, "session.jsonl");
  writeFileSync(transcriptPath, transcript);
  const payload = {
    agent_type: null,
    transcript_path: transcriptPath,
  };
  const markerPath = path.join(dir, "blind-nudged");
  const result = spawnSync(process.execPath, [HOOK, markerPath], {
    encoding: "utf8",
    env: { ...process.env },
    input: JSON.stringify(payload),
  });
  return {
    latched: existsSync(`${transcriptPath}.wrapup-nudged`),
    marker: existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : undefined,
    status: result.status,
    stdout: result.stdout,
  };
}

describe("the wrap-up nudge hook", () => {
  it("says nothing below both thresholds", () => {
    const run = runHook(assistant(120_000, 5));
    expect(run.stdout).toBe("");
    expect(run.latched).toBe(false);
    expect(run.marker).toBeUndefined();
  });

  it("nudges past the token threshold and latches", () => {
    const run = runHook(assistant(420_000));
    const parsed: unknown = JSON.parse(run.stdout);
    expect(parsed).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(run.stdout).toContain("~420k tokens");
    expect(run.stdout).toContain("hand it off");
    expect(run.latched).toBe(true);
    expect(run.marker).toStrictEqual({ minutes: 0, tokens: 420_000, trigger: "tokens" });
  });

  it("nudges on elapsed time with context nowhere near its threshold", () => {
    const run = runHook(assistant(90_000, 80));
    expect(run.stdout).toContain("80 minutes elapsed");
    expect(run.latched).toBe(true);
    expect(run.marker).toStrictEqual({ minutes: 80, tokens: 90_000, trigger: "time" });
  });

  it("names both when the run is out of room and out of time at once", () => {
    expect(runHook(assistant(420_000, 80)).marker).toMatchObject({ trigger: "both" });
  });

  it("fires only once per run", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "wrapup-"));
    expect(runHook(assistant(420_000), workDir).stdout).toContain("~420k tokens");
    expect(runHook(assistant(430_000), workDir).stdout).toBe("");
  });

  it("still nudges when no marker path is passed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wrapup-"));
    const transcriptPath = path.join(dir, "session.jsonl");
    writeFileSync(transcriptPath, assistant(420_000));
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: "utf8",
      env: { ...process.env },
      input: JSON.stringify({ agent_type: null, transcript_path: transcriptPath }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("~420k tokens");
  });

  it("exits clean and silent on junk it cannot read", () => {
    for (const transcript of ["", "not json\n{torn", '{"type":"assistant"}']) {
      const run = runHook(transcript);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    }
  });
});
