import { spawnSync } from "node:child_process";
import process from "node:process";

export function gitRoot(): string {
  scrubGitEnv();
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  const root = result.stdout.trim();
  if (root === "" || result.status !== 0) {
    throw new Error(`not inside a git repository (${result.stderr.trim() || "git rev-parse failed"})`);
  }
  return root;
}

// Git hooks export GIT_DIR, and without GIT_WORK_TREE git then treats the current folder as the top of the work tree
// Changes this process's environment rather than one call's copy, so every child process finds the repo the normal way
export function scrubGitEnv(): void {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
}
