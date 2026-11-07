import { spawnSync } from "node:child_process";
import path from "node:path";

export function syncMain(
  repoRoot: string,
  isDryRun: boolean,
  didInstall: (repoRoot: string) => boolean = didInstallDependencies,
): void {
  spawnSync("git", ["fetch", "--quiet", "origin"], { cwd: repoRoot });
  if (!isDryRun && isCleanMainCheckout(repoRoot)) {
    const before = gitOutput(repoRoot, ["rev-parse", "HEAD"]);
    spawnSync("git", ["merge", "--ff-only", "--quiet", "origin/main"], { cwd: repoRoot });
    reinstallIfDependenciesMoved(repoRoot, before, didInstall);
  }
  const ahead = gitOutput(repoRoot, ["rev-list", "--count", "origin/main..main"]);
  if (ahead !== "" && ahead !== "0") {
    console.warn(
      `warning: local main is ${ahead} commit(s) ahead of origin/main; push them so main can fast-forward and they reach GitHub`,
    );
  }
}

function isCleanMainCheckout(repoRoot: string): boolean {
  const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  if (head.stdout.trim() !== "main") {
    return false;
  }
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  return status.stdout.trim() === "";
}

// With verifyDepsBeforeRun on, pnpm refuses every script once a manifest is newer than the last install
function reinstallIfDependenciesMoved(
  repoRoot: string,
  before: string,
  didInstall: (repoRoot: string) => boolean,
): void {
  const after = gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  if (before === after) {
    return;
  }
  const changed = gitOutput(repoRoot, ["diff", "--name-only", before, after]).split("\n");
  if (changed.every((file) => !isDependencyInput(file))) {
    return;
  }
  console.log("main brought in a dependency change; reinstalling");
  if (!didInstall(repoRoot)) {
    console.warn(
      "warning: pnpm install failed after fast-forwarding main; root pnpm commands refuse with ERR_PNPM_VERIFY_DEPS_BEFORE_RUN until it runs clean",
    );
  }
}

function isDependencyInput(file: string): boolean {
  return file === "pnpm-lock.yaml" || file === "pnpm-workspace.yaml" || path.posix.basename(file) === "package.json";
}

// Frozen, because a rewritten lockfile would dirty main, and a dirty main never fast-forwards again
function didInstallDependencies(repoRoot: string): boolean {
  return spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: repoRoot, stdio: "inherit" }).status === 0;
}

function gitOutput(repoRoot: string, args: Array<string>): string {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
}
