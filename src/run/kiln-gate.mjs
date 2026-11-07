#!/usr/bin/env node
// Copied into the guest as is, so it can only import node's built-in modules

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { gateNames, replayDecision } from "./kiln-gate-replay.mjs";

const busyExit = 75;
const usageExit = 64;
const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"];
const reapGraceMs = 2000;
const shownDirt = 10;
const zeroSha = /^0+$/;
const gatesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "gates.json");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`kiln-gate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function main([command, ...rest]) {
  switch (command) {
    case "author":
    case "merge": {
      return runGate(command);
    }
    case "push": {
      return push(rest[0]);
    }
    case "wait": {
      return waitForGate();
    }
    default: {
      process.stderr.write("usage: kiln-gate author | merge | wait | push [remote]\n");
      return usageExit;
    }
  }
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

function gateDir() {
  return path.join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "kiln-gate");
}

function worktreeState() {
  const dirt = git(["--no-optional-locks", "status", "--porcelain"])
    .split("\n")
    .filter((line) => line !== "");
  return { dirt, isDirty: dirt.length > 0, tree: git(["rev-parse", "HEAD^{tree}"]) };
}

function listDirt(dirt) {
  const shown = dirt.slice(0, shownDirt).map((line) => `  ${line}\n`);
  const hidden = dirt.length - shown.length;
  return `${shown.join("")}${hidden > 0 ? `  and ${String(hidden)} more\n` : ""}`;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return;
  }
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isAlive(pid) {
  if (pid === 0 || !Number.isSafeInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock(lockPath) {
  const raw = readOptional(lockPath);
  if (raw === undefined) {
    return;
  }
  const holder = parseJson(raw);
  if (holder === undefined) {
    return { holder: {}, isLive: true, raw };
  }
  return { holder, isLive: isAlive(holder.pid), raw };
}

function processStart(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const started = result.status === 0 ? result.stdout.trim() : "";
  return started === "" ? undefined : started;
}

function signalGateGroup({ group, groupStartedAt }, signal) {
  if (typeof groupStartedAt !== "string" || !Number.isSafeInteger(group) || group <= 0) {
    return false;
  }
  if (processStart(group) !== groupStartedAt) {
    return false;
  }
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false;
  }
}

async function reapGroup(holder) {
  if (!signalGateGroup(holder, "SIGTERM")) {
    return;
  }
  for (let waited = 0; waited < reapGraceMs && isAlive(-holder.group); waited += 50) {
    await sleep(50);
  }
  signalGateGroup(holder, "SIGKILL");
}

function createLock(lockPath, name) {
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  writeSync(fd, JSON.stringify({ name, pid: process.pid, startedAt: new Date().toISOString() }));
  closeSync(fd);
  return true;
}

function abandonedClaim(claim) {
  const raw = readOptional(claim);
  if (raw === undefined) {
    return;
  }
  const claimer = parseJson(raw);
  if (claimer === undefined || isAlive(claimer?.pid)) {
    return;
  }
  return raw;
}

function clearUnderClaims(lockPath, raw, claims) {
  try {
    if (readOptional(lockPath) === raw) {
      rmSync(lockPath, { force: true });
    }
  } finally {
    for (const claim of claims) {
      rmSync(claim, { force: true });
    }
  }
}

function removeStaleLock(lockPath, raw) {
  const deadClaims = [];
  let chain = raw;
  for (;;) {
    const claim = `${lockPath}.${createHash("sha256").update(chain).digest("hex").slice(0, 16)}`;
    if (createLock(claim, "claim")) {
      clearUnderClaims(lockPath, raw, [...deadClaims, claim]);
      return;
    }
    const claimRaw = abandonedClaim(claim);
    if (claimRaw === undefined) {
      return;
    }
    deadClaims.push(claim);
    chain += `\n${claimRaw}`;
  }
}

async function takeLock(lockPath, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createLock(lockPath, name)) {
      return;
    }
    const lock = readLock(lockPath);
    if (lock?.isLive === true) {
      return lock.holder;
    }
    if (lock === undefined) {
      continue;
    }
    await reapGroup(lock.holder);
    removeStaleLock(lockPath, lock.raw);
  }
  return {};
}

function readVerdict(dir, name) {
  const raw = readOptional(path.join(dir, `${name}.json`));
  return raw === undefined ? undefined : parseJson(raw);
}

function readVerdicts(dir) {
  return gateNames
    .map((name) => readVerdict(dir, name))
    .filter((verdict) => verdict !== null && typeof verdict === "object");
}

function signalExit(signal) {
  return 128 + (constants.signals[signal] ?? 0);
}

async function runGate(name) {
  const gates = JSON.parse(readFileSync(gatesFile, "utf8"));
  const dir = gateDir();
  mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "lock");
  const holder = await takeLock(lockPath, name);
  if (holder !== undefined) {
    const running = holder.name === undefined ? "a gate" : `the ${String(holder.name)} gate`;
    process.stderr.write(
      `kiln-gate: ${running} is already running in this clone; run \`kiln-gate wait\` for its verdict rather than starting another\n`,
    );
    return busyExit;
  }
  try {
    return await gateUnderLock({ command: gates[name], dir, env: gates.env ?? {}, lockPath, name });
  } finally {
    rmSync(lockPath, { force: true });
  }
}

async function gateUnderLock({ command, dir, env, lockPath, name }) {
  const verdictPath = path.join(dir, `${name}.json`);
  rmSync(verdictPath, { force: true });
  writeFileSync(path.join(dir, "latest"), name);
  const startedAt = new Date().toISOString();
  const before = worktreeState();
  const onSpawn = (group) => {
    const groupStartedAt = processStart(group);
    writeFileSync(lockPath, JSON.stringify({ group, groupStartedAt, name, pid: process.pid, startedAt }));
  };
  const { exit, interruptedBy } = await runTeed(command, env, path.join(dir, `${name}.log`), onSpawn);
  if (interruptedBy !== undefined) {
    return signalExit(interruptedBy);
  }
  const after = worktreeState();
  const verdict = {
    dirty: before.isDirty || after.isDirty || before.tree !== after.tree,
    exit,
    finishedAt: new Date().toISOString(),
    name,
    startedAt,
    tree: before.tree,
  };
  writeFileSync(`${verdictPath}.tmp`, `${JSON.stringify(verdict)}\n`);
  renameSync(`${verdictPath}.tmp`, verdictPath);
  return exit;
}

// A grace period after exit, because a process the gate left running can hold its pipes open forever
function runTeed(command, env, logPath, onSpawn) {
  const log = openSync(logPath, "w");
  const child = spawn(command, {
    detached: true,
    env: { ...process.env, ...env },
    shell: "/bin/bash",
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn(child.pid);
  let interruptedBy;
  const forward = (signal) => {
    if (interruptedBy === undefined) {
      interruptedBy = signal;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  for (const signal of forwardedSignals) {
    process.on(signal, forward);
  }
  for (const [source, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let isSinkOpen = true;
    sink.on("error", () => {
      isSinkOpen = false;
    });
    source.on("data", (chunk) => {
      if (isSinkOpen) {
        sink.write(chunk);
      }
      writeSync(log, chunk);
    });
  }
  return new Promise((resolve, reject) => {
    let exit;
    let grace;
    let isFinished = false;
    const finish = () => {
      if (isFinished) {
        return;
      }
      isFinished = true;
      clearTimeout(grace);
      for (const signal of forwardedSignals) {
        process.off(signal, forward);
      }
      child.stdout.destroy();
      child.stderr.destroy();
      closeSync(log);
      resolve({ exit, interruptedBy });
    };
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      exit = code ?? signalExit(signal);
      grace = setTimeout(finish, 1000);
    });
    child.on("close", () => {
      if (exit !== undefined) {
        finish();
      }
    });
  });
}

async function waitForGate() {
  const dir = gateDir();
  const lockPath = path.join(dir, "lock");
  let lock = readLock(lockPath);
  while (lock?.isLive === true) {
    await sleep(1000);
    lock = readLock(lockPath);
  }
  if (lock !== undefined) {
    await reapGroup(lock.holder);
  }
  const name = readOptional(path.join(dir, "latest"))?.trim();
  if (name === undefined) {
    process.stderr.write("kiln-gate: no verdict; no gate has run in this clone since its baseline\n");
    return 1;
  }
  const verdict = readVerdict(dir, name);
  if (verdict === undefined) {
    process.stderr.write(`kiln-gate: no verdict; the ${name} gate was stopped before it finished\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(verdict)}\nlog: ${path.join(dir, `${name}.log`)}\n`);
  const { tree } = worktreeState();
  if (verdict.tree !== tree) {
    process.stderr.write(
      `kiln-gate: that verdict graded tree ${String(verdict.tree)}, not HEAD's ${tree}; run the gate again\n`,
    );
    return 1;
  }
  return Number.isSafeInteger(verdict.exit) ? verdict.exit : 1;
}

function parsePushLines(input) {
  return input
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4 && !zeroSha.test(fields[1]))
    .map(([, localSha, , remoteSha]) => ({ localSha, remoteSha }));
}

function hasCommit(sha) {
  return spawnSync("git", ["cat-file", "-e", `${sha}^0`], { stdio: "ignore" }).status === 0;
}

function scanRange({ localSha, remoteSha }, remote) {
  if (!zeroSha.test(remoteSha) && hasCommit(remoteSha)) {
    return `${remoteSha}..${localSha}`;
  }
  return `${localSha} --not ${remote === undefined ? "--remotes" : `--remotes=${remote}`}`;
}

function scanSecrets(remote, pushes) {
  for (const pushed of pushes) {
    const range = scanRange(pushed, remote);
    const result = spawnSync("gitleaks", ["git", "--no-banner", "--redact", `--log-opts=${range}`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error !== undefined) {
      process.stderr.write(`kiln-gate: gitleaks did not run (${result.error.message}); a push needs its secret scan\n`);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  return 0;
}

function pushState(pushedShas) {
  const { dirt, isDirty, tree } = worktreeState();
  return {
    dirt,
    headTree: tree,
    isDirty,
    pushedTrees: pushedShas.map((sha) => git(["log", "-1", "--format=%T", sha])),
    verdicts: readVerdicts(gateDir()),
  };
}

function refuse({ reason, trees }, dirt) {
  const why =
    reason === "dirty"
      ? "the working tree has uncommitted changes, so a gate run here would not grade what is pushed; commit or stash them, then push again"
      : "it is not the checked-out tree, so a gate run here cannot grade it; check it out, run `kiln-gate author`, then push again";
  process.stderr.write(`kiln-gate: no green verdict covers the pushed tree ${trees.join(", ")}, and ${why}\n`);
  if (reason === "dirty") {
    process.stderr.write(listDirt(dirt));
  }
  return 1;
}

async function push(remote) {
  const pushes = parsePushLines(readFileSync(0, "utf8"));
  const scanned = scanSecrets(remote, pushes);
  if (scanned !== 0) {
    return scanned;
  }
  const pushedShas = pushes.map((pushed) => pushed.localSha);
  const state = pushState(pushedShas);
  const decision = replayDecision(state);
  if (decision.kind === "pass") {
    return 0;
  }
  if (decision.kind === "refuse") {
    return refuse(decision, state.dirt);
  }
  const exit = await runGate("author");
  if (exit !== 0) {
    return exit;
  }
  const after = pushState(pushedShas);
  if (replayDecision(after).kind === "pass") {
    return 0;
  }
  process.stderr.write(
    "kiln-gate: the author gate passed but left uncommitted changes or moved HEAD, so its verdict cannot replay; gitignore what the gate writes, commit, then push again\n",
  );
  process.stderr.write(listDirt(after.dirt));
  return 1;
}
