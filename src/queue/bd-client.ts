import { spawnSync } from "node:child_process";

import type { BdGate, BdIssue } from "./bd-records.ts";

import { parseEach, parseJson } from "../shared/lenient-json.ts";
import { sleepMs } from "../shared/proc.ts";
import { agentSlotNames } from "../vm/ports.ts";
import { bdCommentSchema, bdGateSchema, bdIssueSchema } from "./bd-records.ts";

const bdBackoffMs = 100;
const bdMaxAttempts = 5;

export const dispatchActor = "dispatch";

export interface BeadComment {
  author: string;
  createdAt: string;
  text: string;
}

export interface DispatchBead {
  assignee?: string;
  id: string;
  labels?: Array<string>;
  title: string;
}

export interface ShownBead {
  assignee: string;
  startedAt: string;
  status: string;
}

export function bd(args: Array<string>): string {
  const result = runBd(args);
  if (result.status !== 0) {
    throw new Error(result.stderr || `bd ${args[0] ?? ""} failed`);
  }
  return result.stdout;
}

// bd won't clear a claim held by another actor, even an expired one, unless the write names that holder
export function releaseSlotClaim(beadId: string, slot: string, status?: "in_progress"): void {
  const statusArgs = status === undefined ? [] : [`--status=${status}`];
  bdGuarded(beadId, ["update", beadId, ...statusArgs, "--assignee", "", "--if-assignee", slot]);
}

// Use `unclaim`, not `update`: it also sets the status back to open, and `bd ready` skips a bead left in_progress
export function unclaimFromSlot(beadId: string, slot: string, reason: string): void {
  bdGuarded(beadId, ["unclaim", beadId, "--if-assignee", slot, "--reason", reason]);
}

// A failed guard exits 1 from `unclaim` and 13 from `update`, but both print this text
function isGuardMismatch(stderr: string): boolean {
  return stderr.includes("assignee mismatch");
}

function bdGuarded(beadId: string, args: Array<string>): void {
  const result = runBd(args);
  if (result.status === 0) {
    return;
  }
  if (isGuardMismatch(result.stderr)) {
    const [reason] = result.stderr.split("\n", 1);
    console.warn(`${beadId} moved under the crank (${reason ?? ""}); left to its holder`);
    return;
  }
  throw new Error(result.stderr || `bd ${args[0] ?? ""} failed`);
}

// Every call passes --actor, because bd ignores BEADS_ACTOR whenever its config names an actor
function runBd(args: Array<string>): { status: null | number; stderr: string; stdout: string } {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync("bd", [...args, "--actor", dispatchActor], {
      encoding: "utf8",
    });
    const stderr = result.stderr.trim();
    if (result.status !== 0 && isSerializationConflict(stderr) && attempt < bdMaxAttempts) {
      sleepMs(bdBackoffMs * attempt);
      continue;
    }
    return { status: result.status, stderr, stdout: result.stdout.trim() };
  }
}

export function bdComments(id: string): Array<BeadComment> {
  return parseEach(bdCommentSchema, bdJson(["comments", id, "--json"])).map((comment) => ({
    author: comment.author,
    createdAt: comment.created_at,
    text: comment.text,
  }));
}

export function bdJson(args: Array<string>): unknown {
  try {
    return JSON.parse(bd(args));
  } catch {
    return undefined;
  }
}

export function bdReady(): Array<DispatchBead> {
  return parseEach(bdIssueSchema, bdJson(["ready", "--json", ...readyFilterFlags()]))
    .map((issue) => toDispatchBead(issue))
    .filter((bead) => bead !== undefined);
}

// Read `assignee`, not `owner`: owner is whoever created the bead
export function bdShow(id: string): ShownBead | undefined {
  const [issue] = parseEach(bdIssueSchema, bdJson(["show", id, "--json"]));
  if (issue?.status === undefined) {
    return undefined;
  }
  return {
    assignee: issue.assignee ?? "",
    // Not updated_at, which changes whenever the run writes to its own bead
    startedAt: issue.started_at ?? "",
    status: issue.status,
  };
}

export function beadsAwaitingReconcile(): Array<{ id: string; slot: string }> {
  const pending: Array<{ id: string; slot: string }> = [];
  for (const name of agentSlotNames) {
    const assigned = parseEach(bdIssueSchema, bdJson(["list", "--assignee", name, "--json"]));
    for (const issue of assigned) {
      if (issue.id !== undefined) {
        pending.push({ id: issue.id, slot: name });
      }
    }
  }
  return pending;
}

/** @internal */
export function parseClaimedBead(stdout: string): DispatchBead | undefined {
  const [issue] = parseEach(bdIssueSchema, parseJson(stdout));
  if (issue === undefined) return undefined;
  return toDispatchBead(issue);
}

export function claimNextReady(slotName: string): DispatchBead | undefined {
  const args = ["ready", "--claim", "--json", ...readyFilterFlags(), "--actor", slotName];
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync("bd", args, { encoding: "utf8" });
    if (result.status === 0) {
      return parseClaimedBead(result.stdout);
    }
    const stderr = result.stderr.trim();
    if (!isSerializationConflict(stderr) || attempt >= bdMaxAttempts) {
      throw new Error(stderr || "bd ready --claim failed");
    }
    sleepMs(bdBackoffMs * attempt);
  }
}

// When two writes race, Dolt aborts the loser with a raw `Error 1213 (40001)`, which is safe to retry
/** @internal */
export function isSerializationConflict(stderr: string): boolean {
  return stderr.includes("1213") || stderr.includes("40001") || stderr.includes("serialization failure");
}

export function listGates(): Array<BdGate> {
  return parseEach(bdGateSchema, bdJson(["gate", "list", "--json"]));
}

// bd ready lists epics too, because parent-child links never block
function readyFilterFlags(): Array<string> {
  return ["--exclude-type=epic"];
}

function toDispatchBead(issue: BdIssue): DispatchBead | undefined {
  const { assignee, id, labels, title } = issue;
  if (id === undefined || title === undefined) {
    return undefined;
  }
  const bead: DispatchBead = { id, title };
  if (labels !== undefined) {
    bead.labels = labels;
  }
  if (assignee !== undefined && assignee !== "") {
    bead.assignee = assignee;
  }
  return bead;
}
