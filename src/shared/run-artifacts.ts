import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { scrubGitEnv } from "./git.ts";
import { capture } from "./proc.ts";

export function agentRunsPath(repoRoot: string, ...segments: Array<string>): string {
  return path.join(agentRunsRoot(repoRoot), ...segments);
}

// Outside the checkout, so the guests' read-only mount never shows them other runs' receipts or transcripts
export function agentRunsRoot(repoRoot: string): string {
  const configured = process.env.KILN_RUNS_DIR;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured)) {
      // A relative path would resolve against each process's working folder and split the store and its leases
      throw new Error(`KILN_RUNS_DIR must be an absolute path, got: ${configured}`);
    }
    return configured;
  }
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-agent-runs`);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function mainCheckoutPath(): string {
  scrubGitEnv();
  const commonDir = capture("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.dirname(commonDir);
}

export function safeCapture(command: string, args: Array<string>): string | undefined {
  try {
    return capture(command, args);
  } catch {
    return undefined;
  }
}

export function timestampSlug(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

const defaultRetentionDays = 30;

export function pruneOldRuns(repoRoot: string): number {
  const raw = process.env.KILN_RUNS_RETENTION_DAYS;
  const days = raw === undefined ? defaultRetentionDays : Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    return 0;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const sub of ["transcripts", "launches", "briefs"]) {
    pruned += pruneDirOlderThan(agentRunsPath(repoRoot, sub), cutoff);
  }
  return pruned;
}

function pruneDirOlderThan(dir: string, cutoff: number): number {
  let entries: Array<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoff) continue;
    rmSync(full, { force: true, recursive: true });
    pruned += 1;
  }
  return pruned;
}
