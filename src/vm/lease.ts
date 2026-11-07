import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import { parseJson, textOr } from "../shared/lenient-json.ts";
import { agentRunsPath } from "../shared/run-artifacts.ts";

export interface KeepAwakeHandle {
  kill: () => void;
}

export interface Lease {
  mode: string;
  pid: number;
  startedAt: string;
}

const leaseSchema = z.object({
  mode: textOr("unknown"),
  pid: z.number(),
  startedAt: textOr(""),
}) satisfies z.ZodType<Lease>;

export function acquireLease(
  repoRoot: string,
  name: string,
  mode: string,
  spawnKeepAwake: () => KeepAwakeHandle | undefined = spawnCaffeinate,
): () => void {
  const file = leasePath(repoRoot, name);
  mkdirSync(path.dirname(file), { recursive: true });
  const lease: Lease = {
    mode,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  if (!didCreateLeaseFile(file, lease)) {
    takeOverStaleLease(file, name);
    if (!didCreateLeaseFile(file, lease)) {
      throw leasedError(name, readLease(file));
    }
  }
  const keepAwake = spawnKeepAwake();
  return () => {
    keepAwake?.kill();
    rmSync(file, { force: true });
  };
}

// Created exclusively, so two processes racing for the same lease can't both get it
function didCreateLeaseFile(file: string, lease: Lease): boolean {
  try {
    writeFileSync(file, JSON.stringify(lease), { flag: "wx" });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

// Renamed aside rather than deleted, so when two processes clear the same stale lease only one succeeds
function takeOverStaleLease(file: string, name: string): void {
  const current = readLease(file);
  if (current !== undefined && isPidAlive(current.pid)) {
    throw leasedError(name, current);
  }
  try {
    renameSync(file, `${file}.stale-${String(process.pid)}`);
  } catch {
    return;
  }
  rmSync(`${file}.stale-${String(process.pid)}`, { force: true });
}

function leasedError(name: string, holder: Lease | undefined): Error {
  if (holder === undefined) {
    return new Error(`${name} is leased by another process; wait for it to finish or abort it first`);
  }
  return new Error(
    `${name} is leased by a live ${holder.mode} (pid ${String(holder.pid)}, since ${holder.startedAt}); ` +
      `wait for it to finish or abort it first`,
  );
}

export function readLiveLease(repoRoot: string, name: string): Lease | undefined {
  const lease = readLease(leasePath(repoRoot, name));
  return lease !== undefined && isPidAlive(lease.pid) ? lease : undefined;
}

function readLease(file: string): Lease | undefined {
  return leaseSchema.safeParse(parseJson(readFileIfPresent(file))).data;
}

function readFileIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function spawnCaffeinate(): KeepAwakeHandle | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    const child = spawn("caffeinate", ["-im", "-w", String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      console.warn(`keep-awake unavailable (${error.message}); continuing`);
    });
    child.unref();
    return child;
  } catch (error) {
    console.warn(`keep-awake unavailable (${error instanceof Error ? error.message : String(error)}); continuing`);
    return undefined;
  }
}

// EPERM means the process is alive but belongs to another user
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function leasePath(repoRoot: string, name: string): string {
  return agentRunsPath(repoRoot, "locks", `${name}.lock`);
}
