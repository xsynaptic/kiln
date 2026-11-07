import { spawnSync } from "node:child_process";
import path from "node:path";

import { runOrThrow } from "../shared/proc.ts";
import { agentRunsPath, ensureDir, mainCheckoutPath, timestampSlug } from "../shared/run-artifacts.ts";
import { killBeadsTunnel } from "./beads.ts";
import { acquireLease } from "./lease.ts";
import { didScpFromGuest, guestClonePath, isVmRunning, sshCaptureSafe, sshScript } from "./vm.ts";

interface UnpushedBranch {
  branch: string;
  tip: string;
}

export function rescueAndStopSlot(name: string, options: { isDelete: boolean }): void {
  const repoRoot = mainCheckoutPath();
  // Held for the whole teardown, since `colima delete --force` skips its own prompt and a launch can land mid-rescue
  const releaseLease = acquireLease(repoRoot, name, "teardown");
  try {
    tearDownSlot(name, repoRoot, options.isDelete);
  } finally {
    releaseLease();
  }
}

function tearDownSlot(name: string, repoRoot: string, isDelete: boolean): void {
  killBeadsTunnel(name);
  if (!isVmRunning(name)) {
    if (isDelete) {
      throw new Error(
        `${name} is not running, so its clone cannot be rescued before deletion.\n` +
          `Start it first (pnpm kiln new ${name}), or delete by hand with ` +
          `colima delete -p ${name} --force if its work is known to be delivered.`,
      );
    }
    console.log(`${name} is not running; nothing to stop.`);
    return;
  }

  const isBranchesOk = didRescueBranches(name, repoRoot, isDelete);
  if (isDelete && !isBranchesOk) {
    throw new Error(
      `refusing to delete ${name}: branch rescue failed and its unpushed commits would be lost. ` +
        `Recover by hand, then rerun.`,
    );
  }

  if (isDelete) {
    // `--data`, because the clone lives on the runtime disk and a plain delete keeps it
    runOrThrow("colima", ["delete", "-p", name, "--force", "--data"], repoRoot);
    console.log(`${name} deleted (VM and disk gone; pnpm kiln new ${name} re-provisions cold)`);
  } else {
    runOrThrow("colima", ["stop", "-p", name], repoRoot);
    console.log(`${name} stopped (state kept; pnpm kiln new ${name} brings it back warm)`);
  }
}

// Capped, so a guest can't fill the host disk through the rescue copy
const maxBundleBytes = 2 * 1024 * 1024 * 1024;

function didRescueBranches(name: string, repoRoot: string, isDelete: boolean): boolean {
  const rescueDir = agentRunsPath(repoRoot, "transcripts", `${name}-teardown-${timestampSlug()}`);
  const clonePath = guestClonePath(name);

  const bundleScript = [
    "set -eu",
    `cd ${JSON.stringify(clonePath)}`,
    ...(isDelete
      ? [
          `if [ -n "$(git status --porcelain)" ]; then`,
          `  git checkout --quiet -B rescue/${name}-${timestampSlug()}`,
          `  git add -A`,
          `  git commit --quiet --no-verify -m "chore(rescue): WIP tree at teardown of ${name}"`,
          `fi`,
        ]
      : []),
    "git bundle create /tmp/agent-rescue.bundle --branches",
    `[ "$(stat -c %s /tmp/agent-rescue.bundle)" -le ${String(maxBundleBytes)} ] || { echo "rescue bundle exceeds ${String(maxBundleBytes)} bytes; recover by hand" >&2; exit 1; }`,
  ].join("\n");

  let isBranchesOk = false;
  let mirrored = 0;
  try {
    sshScript(name, bundleScript);
    const report = sshCaptureSafe(
      name,
      `git -C ${JSON.stringify(clonePath)} for-each-ref refs/heads --format='%(refname:short)' | ` +
        String.raw`while IFS= read -r b; do printf '%s %s %s\n' "$(git -C ${JSON.stringify(clonePath)} rev-list --count "$b" --not --remotes)" "$(git -C ${JSON.stringify(clonePath)} rev-parse "$b")" "$b"; done`,
    );
    if (report === undefined) {
      throw new Error("could not enumerate the clone's branches");
    }
    const unpushed = selectUnpushedBranches(report);
    if (unpushed.length === 0) {
      isBranchesOk = true;
    } else {
      mirrored = mirrorUnpushedBranches(name, repoRoot, rescueDir, unpushed);
      isBranchesOk = mirrored === unpushed.length;
      if (isBranchesOk && !isDelete) {
        dropRescuedBranches(
          name,
          clonePath,
          unpushed.map(({ branch }) => branch),
        );
      }
    }
  } catch (error) {
    console.warn(`  branch rescue failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(
    `  ${rescueOutcomeLine({ isBranchesOk, mirrored, rescuePath: path.relative(repoRoot, rescueDir), slot: name })}`,
  );
  return isBranchesOk;
}

// Ignores its own failure, because the rescue already worked and a prune error must not look like lost work
function dropRescuedBranches(name: string, clonePath: string, branches: Array<string>): void {
  try {
    sshScript(
      name,
      [
        "set -u",
        `cd ${JSON.stringify(clonePath)}`,
        "git checkout --quiet --detach",
        ...branches.map((branch) => `git branch -D ${JSON.stringify(branch)} >/dev/null 2>&1 || true`),
      ].join("\n"),
    );
  } catch (error) {
    console.warn(
      `  rescued branches left in the ${name} clone; they will mirror again next teardown: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// git fetch exits 0 even when it silently skips a ref, and an earlier teardown's ref would stand in for it, so each mirror must match the guest's tip
function mirrorUnpushedBranches(
  name: string,
  repoRoot: string,
  rescueDir: string,
  unpushed: Array<UnpushedBranch>,
): number {
  ensureDir(rescueDir);
  const bundleOnHost = path.join(rescueDir, "branches.bundle");
  if (!didScpFromGuest(name, "/tmp/agent-rescue.bundle", bundleOnHost)) {
    return 0;
  }
  runOrThrow("git", ["fetch", bundleOnHost, ...unpushed.map(({ branch }) => mirrorRefspec(name, branch))], repoRoot);
  const missing = unpushed.filter(({ branch, tip }) => mirroredTip(repoRoot, name, branch) !== tip);
  if (missing.length > 0) {
    console.warn(`  branches missing after the bundle fetch: ${missing.map(({ branch }) => branch).join(", ")}`);
  }
  return unpushed.length - missing.length;
}

function mirroredTip(repoRoot: string, slot: string, branch: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/kiln/${slot}/${branch}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** @internal */
export function mirrorRefspec(slot: string, branch: string): string {
  return `+refs/heads/${branch}:refs/kiln/${slot}/${branch}`;
}

function mirrorSummary(slot: string, count: number): string {
  if (count === 0) {
    return `${slot}: no unpushed branches to mirror`;
  }
  return `${slot}: mirrored ${String(count)} unpushed branch${count === 1 ? "" : "es"} -> refs/kiln/${slot}/*`;
}

/** @internal */
export function rescueOutcomeLine(outcome: {
  isBranchesOk: boolean;
  mirrored: number;
  rescuePath: string;
  slot: string;
}): string {
  if (!outcome.isBranchesOk) {
    return `${outcome.slot}: branches NOT rescued -> ${outcome.rescuePath}`;
  }
  if (outcome.mirrored === 0) {
    return mirrorSummary(outcome.slot, 0);
  }
  return `${mirrorSummary(outcome.slot, outcome.mirrored)} (${outcome.rescuePath})`;
}

/** @internal */
export function selectUnpushedBranches(report: string): Array<UnpushedBranch> {
  const unpushed: Array<UnpushedBranch> = [];
  for (const line of report.split("\n")) {
    const match = /^(\d+) ([\da-f]{40,64}) (.+)$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const [, count, tip, branch] = match;
    if (branch !== undefined && tip !== undefined && Number(count) > 0) {
      unpushed.push({ branch, tip });
    }
  }
  return unpushed;
}
