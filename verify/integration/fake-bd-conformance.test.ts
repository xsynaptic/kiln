import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { BdAnswer } from "#support/fake-bd.ts";

import { sleepMs } from "#src/shared/proc.ts";
import { initBdStore } from "#support/bd-store.ts";
import { createFakeBd } from "#support/fake-bd.ts";

// One bd call; `{name}` stands for the id an earlier step captured under that name
interface Step {
  args: Array<string>;
  capture?: string;
}

interface Observed {
  isMismatch: boolean;
  output: unknown;
  status: number;
}

const roots: Array<string> = [];

const observedFields = [
  "assignee",
  "author",
  "await_id",
  "await_type",
  "dependency_type",
  "status",
  "text",
  "title",
] as const;

const secondPrecision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const microsecondPrecision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface Names {
  byId: Map<string, string>;
  startedAt: Map<string, Array<string>>;
}

function answerOfInstalled(root: string) {
  return (args: Array<string>): BdAnswer => {
    const result = spawnSync("bd", args, {
      encoding: "utf8",
      env: { ...process.env, BEADS_DIR: path.join(root, ".beads") },
    });
    return { status: result.status ?? 1, stderr: result.stderr.trim(), stdout: result.stdout.trim() };
  };
}

function parsed(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

// Clock times differ between the two runs, so a timestamp is compared by its format and a started_at by whether it moved
function timestampShape(value: string): string {
  if (secondPrecision.test(value)) return "to the second";
  return microsecondPrecision.test(value) ? "to the microsecond" : `unexpected ${value}`;
}

function startedAtShape(name: string, value: string, names: Names): string {
  const seen = names.startedAt.get(name) ?? [];
  if (!seen.includes(value)) seen.push(value);
  names.startedAt.set(name, seen);
  return `${timestampShape(value)}, value ${String(seen.indexOf(value))}`;
}

function observedFieldsOf(record: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const field of observedFields) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && fieldValue !== "" && !(field === "title" && record.issue_type === "gate")) {
      observed[field] = fieldValue;
    }
  }
  return observed;
}

// Ids differ between the two stores, so every id is replaced by the name the sequence gave it
function normalize(value: unknown, names: Names): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, names));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const name = names.byId.get(String(record.id)) ?? "unnamed";
  const normal: Record<string, unknown> = { id: name, ...observedFieldsOf(record) };
  if (typeof record.created_at === "string") {
    normal.created_at = timestampShape(record.created_at);
  }
  if (typeof record.started_at === "string") {
    normal.started_at = startedAtShape(name, record.started_at, names);
  }
  return normal;
}

// A claim lands a second after the step before it, so whether bd stamps it afresh shows in a started_at to the second
function replay(
  steps: Array<Step>,
  answer: (args: Array<string>) => BdAnswer,
  waitASecond: () => void,
): Array<Observed> {
  const ids = new Map<string, string>();
  const names: Names = { byId: new Map(), startedAt: new Map() };
  return steps.map(({ args, capture }) => {
    const resolved = args.map((arg) => arg.replaceAll(/\{(\w+)\}/g, (_match, name: string) => ids.get(name) ?? name));
    const withActor = resolved.includes("--actor") ? resolved : [...resolved, "--actor", "dispatch"];
    if (withActor.includes("--claim")) {
      waitASecond();
    }
    const { status, stderr, stdout } = answer(withActor);
    const output = parsed(stdout);
    if (capture !== undefined && typeof output === "object" && output !== null && "id" in output) {
      ids.set(capture, String(output.id));
      names.byId.set(String(output.id), capture);
    }
    return { isMismatch: stderr.includes("assignee mismatch"), output: normalize(output, names), status };
  });
}

function expectConformance(steps: Array<Step>): void {
  const root = initBdStore();
  roots.push(root);
  const installed = replay(steps, answerOfInstalled(root), () => {
    sleepMs(1000);
  });
  const fake = createFakeBd(() => undefined);
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    const answered = replay(
      steps,
      (args) => fake.run(args),
      () => {
        vi.setSystemTime(Date.now() + 1000);
      },
    );
    expect(answered).toEqual(installed);
  } finally {
    vi.useRealTimers();
  }
}

function create(name: string, priority: string): Step {
  return { args: ["create", name, "--priority", priority, "--json"], capture: name };
}

const readyList: Step = { args: ["ready", "--json", "--exclude-type=epic"] };

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

describe("the fake bd against the installed bd", { timeout: 120_000 }, () => {
  it("claims in priority order, skips a claimed bead that was reopened, and guards releases by holder", () => {
    expectConformance([
      create("alpha", "1"),
      create("beta", "2"),
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-1"] },
      { args: ["update", "{alpha}", "--status", "open", "--actor", "someone"] },
      readyList,
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-2"] },
      { args: ["update", "{beta}", "--claim", "--actor", "kiln-3"] },
      { args: ["update", "{alpha}", "--assignee", "", "--if-assignee", "kiln-7"] },
      { args: ["unclaim", "{beta}", "--if-assignee", "kiln-7", "--reason", "never applied"] },
      { args: ["update", "{alpha}", "--status=in_progress", "--assignee", "", "--if-assignee", "kiln-1"] },
      { args: ["unclaim", "{beta}", "--if-assignee", "kiln-2", "--reason", "requeued"] },
      { args: ["show", "{alpha}", "--json"] },
      { args: ["list", "--status", "in_progress", "--json"] },
      readyList,
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-1"] },
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-2"] },
      { args: ["list", "--assignee", "kiln-1", "--json"] },
    ]);
  });

  it("holds a bead behind a PR gate until it resolves, and refuses to close it while gated or held", () => {
    expectConformance([
      create("gamma", "2"),
      { args: ["update", "{gamma}", "--claim", "--actor", "kiln-1"] },
      { args: ["close", "{gamma}", "--reason", "landed"] },
      { args: ["gate", "create", "--type=gh:pr", "--blocks", "{gamma}", "--await-id=5", "--json"], capture: "prGate" },
      { args: ["update", "{gamma}", "--status=in_progress", "--assignee", "", "--if-assignee", "kiln-1"] },
      { args: ["gate", "list", "--json"] },
      { args: ["dep", "list", "{prGate}", "--direction", "up", "--json"] },
      { args: ["update", "{gamma}", "--status", "open"] },
      readyList,
      { args: ["close", "{gamma}", "--reason", "landed"] },
      { args: ["gate", "resolve", "{prGate}", "--reason", "merged"] },
      { args: ["gate", "list", "--json"] },
      { args: ["dep", "list", "{gamma}", "--json"] },
      readyList,
      { args: ["close", "{gamma}", "--reason", "landed"] },
      { args: ["show", "{gamma}", "--json"] },
    ]);
  });

  it("writes comments by their actor to the second, and restamps started_at only on a claim after an unclaim", () => {
    expectConformance([
      create("zeta", "2"),
      { args: ["update", "{zeta}", "--claim", "--actor", "kiln-1"] },
      { args: ["comment", "{zeta}", "dispatched to kiln-1 as feat/zeta"] },
      { args: ["show", "{zeta}", "--json"] },
      { args: ["unclaim", "{zeta}", "--if-assignee", "kiln-1", "--reason", "run left no receipt; requeued"] },
      { args: ["show", "{zeta}", "--json"] },
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-2"] },
      { args: ["comment", "{zeta}", "a session note", "--actor", "kiln-2"] },
      { args: ["comments", "{zeta}", "--json"] },
      { args: ["update", "{zeta}", "--status=in_progress", "--assignee", "", "--if-assignee", "kiln-2"] },
      { args: ["show", "{zeta}", "--json"] },
      { args: ["update", "{zeta}", "--status", "open"] },
      { args: ["update", "{zeta}", "--claim", "--actor", "kiln-3"] },
      { args: ["show", "{zeta}", "--json"] },
    ]);
  });

  it("keeps a parked bead off bd ready until its human gate resolves", () => {
    expectConformance([
      create("delta", "2"),
      create("epsilon", "3"),
      { args: ["update", "{delta}", "--claim", "--actor", "kiln-1"] },
      {
        args: ["gate", "create", "--type=human", "--blocks", "{delta}", "--reason", "nothing to do", "--json"],
        capture: "park",
      },
      { args: ["unclaim", "{delta}", "--if-assignee", "kiln-1", "--reason", "parked"] },
      readyList,
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-2"] },
      { args: ["ready", "--claim", "--json", "--exclude-type=epic", "--actor", "kiln-3"] },
      { args: ["gate", "resolve", "{park}", "--reason", "unparked"] },
      readyList,
      { args: ["dep", "list", "{delta}", "--json"] },
      { args: ["unclaim", "{delta}", "--if-assignee", "kiln-1", "--reason", "already released"] },
    ]);
  });
});
