import path from "node:path";

import { kilnConfig } from "../config/config.ts";
import { guestKilnGateDir } from "../vm/guest-kit.ts";
import { pushGateShimLines, singleQuote, sshCaptureSafe, sshScriptWithInput } from "../vm/vm.ts";

interface CloneBaseline {
  base: string;
  branch: string;
}

/** @internal */
export function prepareCloneScript(
  clonePath: string,
  baseline: CloneBaseline,
  warmCommand?: string,
  resetVolumes: Array<string> = [],
): string {
  const { branch } = baseline;
  const base = `github/${baseline.base}`;
  const fetchRefs = baseline.base === "main" ? [baseline.base] : ["main", baseline.base];
  return [
    "set -euo pipefail",
    "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN",
    "IFS= read -r GH_TOKEN",
    "export GH_TOKEN",
    `cd ${JSON.stringify(clonePath)}`,
    `rm -rf ${path.posix.join(clonePath, guestKilnGateDir)}`,
    // Start every -f pattern with ^: this script is in the remote bash's own command line, so an unanchored pattern kills that shell
    // node needs -f because it renames its main thread, so -x never matches it
    `docker compose down --remove-orphans >/dev/null 2>&1 || true`,
    `pkill -x claude 2>/dev/null || true`,
    `pkill -f '^[^ ]*node ' 2>/dev/null || true`,
    // Prune all regular records, because a partial prune frees no space and breaks the cache hits of what's left
    `docker builder prune --all --force --filter type=regular >/dev/null 2>&1 || true`,
    `docker builder prune --force --filter type=exec.cachemount --max-used-space 4GB >/dev/null 2>&1 || true`,
    `sudo -n fstrim /var/lib/docker >/dev/null 2>&1 || true`,
    ...(resetVolumes.length === 0
      ? []
      : [`docker compose down --volumes ${resetVolumes.join(" ")} >/dev/null 2>&1 || true`]),
    `if [ -n "$(git status --porcelain)" ]; then`,
    `  git checkout --quiet -B rescue/baseline-$(date -u +%Y%m%dT%H%M%SZ)`,
    `  git add -A`,
    `  git commit --quiet --no-verify -m "chore(rescue): WIP tree before baseline reset"`,
    `fi`,
    `git fetch --quiet github ${fetchRefs.join(" ")}`,
    // A relaunch reuses the branch name, so unlanded commits move aside before -B resets the branch
    `if git rev-parse --verify --quiet refs/heads/${branch} >/dev/null && [ "$(git rev-list --count ${base}..${branch})" -gt 0 ]; then`,
    `  git branch -m ${branch} parked/${branch}-$(date -u +%Y%m%dT%H%M%SZ)`,
    `fi`,
    `git checkout --quiet --force -B ${branch} ${base}`,
    "git branch -f main github/main",
    "git update-ref refs/remotes/origin/main refs/remotes/github/main",
    "git clean -fdq",
    "pnpm install --prefer-offline --reporter=silent",
    ...pushGateShimLines,
    ...(warmCommand === undefined ? [] : [`setsid bash -c ${singleQuote(warmCommand)} >/dev/null 2>&1 &`]),
  ].join("\n");
}

/** @internal */
export function missingOnMainScript(clonePath: string, docs: ReadonlyArray<string>): string {
  const listed = docs.map((doc) => JSON.stringify(doc)).join(" ");
  return `cd ${JSON.stringify(clonePath)} && for doc in ${listed}; do git cat-file -e "github/main:$doc" 2>/dev/null || echo "$doc"; done`;
}

export function assertDocsOnMain(profile: string, clonePath: string, docs: ReadonlyArray<string>): void {
  const missing = sshCaptureSafe(profile, missingOnMainScript(clonePath, docs));
  if (missing === undefined) {
    throw new Error(`could not ask ${profile} whether ${docs.join(", ")} are on github/main`);
  }
  if (missing !== "") {
    throw new Error(`${missing.replaceAll("\n", ", ")} not on github/main; push it, or fix the path in kiln.config.ts`);
  }
}

export function currentBranch(profile: string, clonePath: string): string | undefined {
  return sshCaptureSafe(profile, `git -C ${JSON.stringify(clonePath)} branch --show-current`);
}

export function prepareClone(profile: string, clonePath: string, baseline: CloneBaseline, tokens: string): void {
  sshScriptWithInput(
    profile,
    prepareCloneScript(clonePath, baseline, kilnConfig.gates.warmCommand, kilnConfig.slots.resetVolumes),
    tokens,
  );
}
