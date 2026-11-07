import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { replayDecision } from "#src/run/kiln-gate-replay.mjs";
import { scrubGitEnv } from "#src/shared/git.ts";
import { copyKilnGate } from "#src/vm/guest-kit.ts";
import { pushGateShimLines } from "#src/vm/vm.ts";

function verdict(overrides: Partial<Parameters<typeof replayDecision>[0]["verdicts"][number]> = {}) {
  return {
    dirty: false,
    exit: 0,
    finishedAt: "2026-11-07T10:01:00.000Z",
    name: "author",
    startedAt: "2026-11-07T10:00:00.000Z",
    tree: "tree-a",
    ...overrides,
  };
}

describe("replayDecision", () => {
  it("passes a push whose every tree carries a green verdict from either gate", () => {
    const verdicts = [verdict(), verdict({ name: "merge", tree: "tree-b" })];
    const decision = replayDecision({ headTree: "tree-b", isDirty: true, pushedTrees: ["tree-a", "tree-b"], verdicts });
    expect(decision).toEqual({ kind: "pass" });
  });

  it("runs the gate for an unproven tree that is the clean checkout", () => {
    expect(replayDecision({ headTree: "tree-a", isDirty: false, pushedTrees: ["tree-a"], verdicts: [] })).toEqual({
      kind: "run",
    });
  });

  it("never replays a red verdict, one graded over uncommitted changes, or one from a gate it does not run", () => {
    const verdicts = [verdict({ exit: 1 }), verdict({ dirty: true, name: "merge" }), verdict({ name: "lint" })];
    expect(replayDecision({ headTree: "tree-a", isDirty: false, pushedTrees: ["tree-a"], verdicts })).toEqual({
      kind: "run",
    });
  });

  it("refuses an unproven tree that is not checked out, since a gate here would grade another tree", () => {
    const state = { headTree: "tree-b", isDirty: false, pushedTrees: ["tree-a", "tree-a", "tree-b"], verdicts: [] };
    expect(replayDecision(state)).toEqual({ kind: "refuse", reason: "not-checked-out", trees: ["tree-a", "tree-b"] });
  });

  it("refuses over uncommitted changes rather than grade them in the pushed tree's place", () => {
    expect(replayDecision({ headTree: "tree-a", isDirty: true, pushedTrees: ["tree-a"], verdicts: [] })).toEqual({
      kind: "refuse",
      reason: "dirty",
      trees: ["tree-a"],
    });
  });

  it("passes a push that only deletes, since it carries no tree", () => {
    expect(replayDecision({ headTree: "tree-a", isDirty: true, pushedTrees: [], verdicts: [] })).toEqual({
      kind: "pass",
    });
  });
});

const gitConfig = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];

const stubGate = [
  `if [ -e "$STUB_DIR/ignore-term-$1" ]; then trap "" TERM; fi`,
  `echo "$1 gate ran"`,
  `echo "$1" >> "$STUB_DIR/runs"`,
  `echo "$$" > "$STUB_DIR/pid-$1"`,
  `while [ -e "$STUB_DIR/hold-$1" ]; do sleep 0.05; done`,
  `exit "$(cat "$STUB_DIR/exit" 2>/dev/null || echo 0)"`,
].join("\n");

const stubGitleaks = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$(dirname "$0")/gitleaks-args"\nexit "\${GITLEAKS_EXIT:-0}"\n`;

interface Box {
  bin: string;
  env: NodeJS.ProcessEnv;
  repo: string;
  root: string;
  script: string;
  stub: string;
}

interface GateRun {
  status: null | number;
  stderr: string;
  stdout: string;
}

function git(box: Box, ...args: Array<string>): string {
  const result = spawnSync("git", [...gitConfig, ...args], { cwd: box.repo, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitFile(box: Box, file: string, content: string): void {
  writeFileSync(path.join(box.repo, file), content);
  git(box, "add", file);
  git(box, "commit", "--quiet", "-m", `touch ${file}`);
}

function kilnGate(box: Box, args: Array<string>, options: { env?: NodeJS.ProcessEnv; input?: string } = {}): GateRun {
  const result = spawnSync(process.execPath, [box.script, ...args], {
    cwd: box.repo,
    encoding: "utf8",
    env: { ...box.env, ...options.env },
    input: options.input ?? "",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function startKilnGate(box: Box, args: Array<string>) {
  const child = spawn(process.execPath, [box.script, ...args], { cwd: box.repo, env: box.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<GateRun>((resolve) => {
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
  return { child, done };
}

function gateRuns(box: Box): Array<string> {
  const runs = path.join(box.stub, "runs");
  return existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n") : [];
}

function readVerdict(box: Box, name: string): unknown {
  const file = path.join(box.repo, ".git", "kiln-gate", `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

function pushLine(sha: string, remoteSha = "0".repeat(40)): string {
  return `refs/heads/feat ${sha} refs/heads/feat ${remoteSha}\n`;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function orphanGate(box: Box): Promise<number> {
  writeFileSync(path.join(box.stub, "hold-author"), "");
  const author = startKilnGate(box, ["author"]);
  await untilGateRuns(box);
  author.child.kill("SIGKILL");
  await author.done;
  const orphan = Number(readFileSync(path.join(box.stub, "pid-author"), "utf8"));
  expect(isRunning(orphan)).toBe(true);
  return orphan;
}

async function untilGateRuns(box: Box): Promise<void> {
  await vi.waitFor(
    () => {
      expect(gateRuns(box).length).toBeGreaterThan(0);
    },
    { interval: 20, timeout: 5000 },
  );
}

describe("the kiln-gate script in a clone", () => {
  const boxes: Array<Box> = [];

  // A pre-push hook exports GIT_DIR, which would point every fixture command at the real repository
  beforeEach(() => {
    scrubGitEnv();
  });

  afterEach(() => {
    for (const box of boxes.splice(0)) {
      rmSync(box.root, { force: true, recursive: true });
    }
  });

  function sandbox(): Box {
    const root = mkdtempSync(path.join(tmpdir(), "kiln-gate-"));
    const [kit, stub, bin, repo] = ["kit", "stub", "bin", "repo"].map((name) => path.join(root, name));
    if (kit === undefined || stub === undefined || bin === undefined || repo === undefined) {
      throw new Error("sandbox paths missing");
    }
    for (const dir of [kit, stub, bin, repo]) {
      mkdirSync(dir);
    }
    const script = path.join(kit, "kiln-gate.mjs");
    copyKilnGate(kit);
    writeFileSync(path.join(stub, "gate.sh"), stubGate);
    const gateCommand = (name: string) => `sh ${JSON.stringify(path.join(stub, "gate.sh"))} ${name}`;
    const gates = { author: gateCommand("author"), env: { STUB_DIR: stub }, merge: gateCommand("merge") };
    writeFileSync(path.join(kit, "gates.json"), JSON.stringify(gates));
    writeFileSync(path.join(bin, "gitleaks"), stubGitleaks);
    chmodSync(path.join(bin, "gitleaks"), 0o755);
    const box = { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, repo, root, script, stub };
    boxes.push(box);
    git(box, "init", "--quiet", "-b", "main");
    commitFile(box, "readme.md", "first\n");
    return box;
  }

  it("records a verdict keyed to the graded tree, run with the gate's env, its output in the log", () => {
    const box = sandbox();
    const run = kilnGate(box, ["author"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("author gate ran");
    expect(readVerdict(box, "author")).toMatchObject({
      dirty: false,
      exit: 0,
      name: "author",
      tree: git(box, "rev-parse", "HEAD^{tree}"),
    });
    expect(readFileSync(path.join(box.repo, ".git", "kiln-gate", "author.log"), "utf8")).toContain("author gate ran");
    expect(gateRuns(box)).toEqual(["author"]);
  });

  it("exits with a red gate's code and records it", () => {
    const box = sandbox();
    writeFileSync(path.join(box.stub, "exit"), "3");
    expect(kilnGate(box, ["merge"]).status).toBe(3);
    expect(readVerdict(box, "merge")).toMatchObject({ exit: 3, name: "merge" });
  });

  it("refuses a second gate over a live one and names the wait", async () => {
    const box = sandbox();
    writeFileSync(path.join(box.stub, "hold-author"), "");
    const author = startKilnGate(box, ["author"]);
    await untilGateRuns(box);
    const second = kilnGate(box, ["merge"]);
    expect(second.status).toBe(75);
    expect(second.stderr).toContain("kiln-gate wait");
    rmSync(path.join(box.stub, "hold-author"));
    const first = await author.done;
    expect(first.status).toBe(0);
    expect(gateRuns(box)).toEqual(["author"]);
    expect(readVerdict(box, "merge")).toBeUndefined();
  });

  it("waits out the running gate, then reports its verdict and exits with its code", async () => {
    const box = sandbox();
    writeFileSync(path.join(box.stub, "hold-author"), "");
    writeFileSync(path.join(box.stub, "exit"), "4");
    const author = startKilnGate(box, ["author"]);
    await untilGateRuns(box);
    const waiting = startKilnGate(box, ["wait"]);
    await sleep(300);
    expect(waiting.child.exitCode).toBeNull();
    rmSync(path.join(box.stub, "hold-author"));
    const waited = await waiting.done;
    expect(waited.status).toBe(4);
    expect(waited.stdout).toContain(`"tree":"${git(box, "rev-parse", "HEAD^{tree}")}"`);
    const gated = await author.done;
    expect(gated.status).toBe(4);
  });

  it("takes over a lock whose holder is gone", () => {
    const box = sandbox();
    const gone = spawnSync("true");
    mkdirSync(path.join(box.repo, ".git", "kiln-gate"));
    writeFileSync(path.join(box.repo, ".git", "kiln-gate", "lock"), JSON.stringify({ name: "author", pid: gone.pid }));
    expect(kilnGate(box, ["author"]).status).toBe(0);
  });

  it("never signals a group that a dead holder's lock names once another process holds that id", async () => {
    const box = sandbox();
    const gone = spawnSync("true");
    const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      const lock = { group: stranger.pid, groupStartedAt: "Thu Jan  1 00:00:00 1970", name: "author", pid: gone.pid };
      mkdirSync(path.join(box.repo, ".git", "kiln-gate"));
      writeFileSync(path.join(box.repo, ".git", "kiln-gate", "lock"), JSON.stringify(lock));
      expect(kilnGate(box, ["wait"]).status).toBe(1);
      expect(kilnGate(box, ["author"]).status).toBe(0);
      await sleep(100);
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  it("reaps the gate a killed holder orphaned, then runs the next one", async () => {
    const box = sandbox();
    const orphan = await orphanGate(box);
    expect(kilnGate(box, ["merge"]).status).toBe(0);
    expect(isRunning(orphan)).toBe(false);
    expect(gateRuns(box)).toEqual(["author", "merge"]);
  });

  it("lets one of two gates racing over a stale lock take it and turns the other away", async () => {
    const box = sandbox();
    writeFileSync(path.join(box.stub, "ignore-term-author"), "");
    await orphanGate(box);
    writeFileSync(path.join(box.stub, "hold-merge"), "");
    const racers = [startKilnGate(box, ["merge"]), startKilnGate(box, ["merge"])];
    const turnedAway = await Promise.race(racers.map(async (racer) => racer.done));
    expect(turnedAway.status).toBe(75);
    await vi.waitFor(
      () => {
        expect(gateRuns(box)).toEqual(["author", "merge"]);
      },
      { interval: 20, timeout: 5000 },
    );
    rmSync(path.join(box.stub, "hold-merge"));
    const finished = await Promise.all(racers.map(async (racer) => racer.done));
    expect(finished.map((run) => run.status).toSorted()).toEqual([0, 75]);
    expect(gateRuns(box)).toEqual(["author", "merge"]);
  }, 15_000);

  it("reports an orphaned gate as stopped rather than wait on it, and reaps it", async () => {
    const box = sandbox();
    const orphan = await orphanGate(box);
    const waited = kilnGate(box, ["wait"]);
    expect(waited.status).toBe(1);
    expect(waited.stderr).toContain("the author gate was stopped");
    expect(isRunning(orphan)).toBe(false);
  });

  it("reports no verdict when no gate has finished", () => {
    const run = kilnGate(sandbox(), ["wait"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no verdict");
  });

  it("reports a stopped gate as no verdict rather than fall back to the other gate's green", async () => {
    const box = sandbox();
    kilnGate(box, ["author"]);
    writeFileSync(path.join(box.stub, "hold-merge"), "");
    const merge = startKilnGate(box, ["merge"]);
    await vi.waitFor(
      () => {
        expect(gateRuns(box)).toEqual(["author", "merge"]);
      },
      { interval: 20, timeout: 5000 },
    );
    merge.child.kill("SIGTERM");
    const stopped = await merge.done;
    expect(stopped.status).toBe(143);
    const waited = kilnGate(box, ["wait"]);
    expect(waited.status).toBe(1);
    expect(waited.stderr).toContain("the merge gate was stopped");
  });

  it("fails a wait whose verdict graded a tree other than HEAD's", () => {
    const box = sandbox();
    kilnGate(box, ["author"]);
    commitFile(box, "readme.md", "second\n");
    const waited = kilnGate(box, ["wait"]);
    expect(waited.status).toBe(1);
    expect(waited.stderr).toContain("run the gate again");
  });

  it("installs the push hook where core.hooksPath sends git", () => {
    const box = sandbox();
    git(box, "config", "core.hooksPath", ".husky/_");
    const shim = spawnSync("bash", ["-c", pushGateShimLines.join("\n")], { cwd: box.repo, encoding: "utf8" });
    expect(shim.status).toBe(0);
    expect(readFileSync(path.join(box.repo, ".husky", "_", "pre-push"), "utf8")).toContain("exec kiln-gate push");
  });

  it("replays a green verdict for the pushed tree without running the gate again, across an amend", () => {
    const box = sandbox();
    kilnGate(box, ["author"]);
    git(box, "commit", "--quiet", "--amend", "-m", "reworded");
    const head = git(box, "rev-parse", "HEAD");
    expect(kilnGate(box, ["push", "origin"], { input: pushLine(head) }).status).toBe(0);
    expect(gateRuns(box)).toEqual(["author"]);
    expect(readFileSync(path.join(box.bin, "gitleaks-args"), "utf8")).toContain(
      `--log-opts=${head} --not --remotes=origin`,
    );
  });

  it("runs the author gate when no verdict covers the pushed tree", () => {
    const box = sandbox();
    kilnGate(box, ["author"]);
    commitFile(box, "readme.md", "second\n");
    const push = kilnGate(box, ["push", "origin"], { input: pushLine(git(box, "rev-parse", "HEAD")) });
    expect(push.status).toBe(0);
    expect(gateRuns(box)).toEqual(["author", "author"]);
    expect(readVerdict(box, "author")).toMatchObject({ tree: git(box, "rev-parse", "HEAD^{tree}") });
  });

  it("never replays a verdict graded over uncommitted changes, and refuses to grade them for the push", () => {
    const box = sandbox();
    writeFileSync(path.join(box.repo, "scratch.txt"), "notes\n");
    kilnGate(box, ["author"]);
    expect(readVerdict(box, "author")).toMatchObject({ dirty: true, exit: 0 });
    const push = kilnGate(box, ["push", "origin"], { input: pushLine(git(box, "rev-parse", "HEAD")) });
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("uncommitted changes");
    expect(push.stderr).toContain("?? scratch.txt");
    expect(gateRuns(box)).toEqual(["author"]);
  });

  it("scans a push to an existing branch from the branch's old tip, whatever the remote-tracking refs say", () => {
    const box = sandbox();
    const base = git(box, "rev-parse", "HEAD");
    commitFile(box, "readme.md", "second\n");
    kilnGate(box, ["author"]);
    const head = git(box, "rev-parse", "HEAD");
    expect(kilnGate(box, ["push", "origin"], { input: pushLine(head, base) }).status).toBe(0);
    expect(readFileSync(path.join(box.bin, "gitleaks-args"), "utf8")).toContain(`--log-opts=${base}..${head}`);
  });

  it("scans past every remote ref when the branch's old tip is not in the clone", () => {
    const box = sandbox();
    kilnGate(box, ["author"]);
    const head = git(box, "rev-parse", "HEAD");
    const missingTip = "a".repeat(40);
    expect(kilnGate(box, ["push", "origin"], { input: pushLine(head, missingTip) }).status).toBe(0);
    expect(readFileSync(path.join(box.bin, "gitleaks-args"), "utf8")).toContain(
      `--log-opts=${head} --not --remotes=origin`,
    );
  });

  it("stops at a secret-scan finding before any gate runs", () => {
    const box = sandbox();
    const push = kilnGate(box, ["push", "origin"], {
      env: { GITLEAKS_EXIT: "1" },
      input: pushLine(git(box, "rev-parse", "HEAD")),
    });
    expect(push.status).toBe(1);
    expect(gateRuns(box)).toEqual([]);
  });
});
