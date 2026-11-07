import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncMain } from "#src/dispatch/main-checkout.ts";
import { scrubGitEnv } from "#src/shared/git.ts";

// Identity, signing, and hooks pinned so the developer's global git config cannot fail or slow a commit
const gitConfig = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function git(cwd: string, ...args: Array<string>): string {
  const result = spawnSync("git", [...gitConfig, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitFile(clone: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
  writeFileSync(path.join(clone, file), content);
  git(clone, "add", file);
  git(clone, "commit", "--quiet", "-m", `touch ${file}`);
}

function fixture(): { checkout: string; upstream: string } {
  const root = mkdtempSync(path.join(tmpdir(), "main-checkout-test-"));
  const origin = path.join(root, "origin.git");
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, upstream);
  commitFile(upstream, "package.json", "{}\n");
  commitFile(upstream, "docs/readme.md", "first\n");
  git(upstream, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", origin, checkout);
  return { checkout, upstream };
}

function recordInstalls(): { didInstall: (repoRoot: string) => boolean; installs: Array<string> } {
  const installs: Array<string> = [];
  return {
    didInstall: (repoRoot) => {
      installs.push(repoRoot);
      return true;
    },
    installs,
  };
}

describe("syncMain", () => {
  // A pre-push hook exports GIT_DIR, which would point every fixture command at the real repository
  beforeEach(() => {
    scrubGitEnv();
  });

  it.each(["pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/sample/package.json"])(
    "reinstalls after fast-forwarding a change to %s",
    (file) => {
      const { checkout, upstream } = fixture();
      commitFile(upstream, file, "changed\n");
      git(upstream, "push", "--quiet", "origin", "main");
      const { didInstall, installs } = recordInstalls();

      syncMain(checkout, false, didInstall);

      expect(git(checkout, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
      expect(installs).toEqual([checkout]);
    },
  );

  it("reinstalls when the dependency change sits behind later merges in the same fast-forward", () => {
    const { checkout, upstream } = fixture();
    commitFile(upstream, "packages/other/package.json", "{}\n");
    commitFile(upstream, "docs/readme.md", "second\n");
    git(upstream, "push", "--quiet", "origin", "main");
    const { didInstall, installs } = recordInstalls();

    syncMain(checkout, false, didInstall);

    expect(installs).toEqual([checkout]);
  });

  it("leaves dependencies alone when the fast-forward moves nothing they read", () => {
    const { checkout, upstream } = fixture();
    commitFile(upstream, "docs/readme.md", "second\n");
    git(upstream, "push", "--quiet", "origin", "main");
    const { didInstall, installs } = recordInstalls();

    syncMain(checkout, false, didInstall);

    expect(git(checkout, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(installs).toEqual([]);
  });

  it("installs nothing into a dirty checkout it declined to fast-forward", () => {
    const { checkout, upstream } = fixture();
    commitFile(upstream, "pnpm-lock.yaml", "changed\n");
    git(upstream, "push", "--quiet", "origin", "main");
    writeFileSync(path.join(checkout, "docs/readme.md"), "uncommitted\n");
    const { didInstall, installs } = recordInstalls();

    syncMain(checkout, false, didInstall);

    expect(git(checkout, "rev-parse", "HEAD")).not.toBe(git(upstream, "rev-parse", "HEAD"));
    expect(installs).toEqual([]);
  });

  describe("ahead warning", () => {
    const workingDirectory = process.cwd();

    // process.chdir needs vitest's default forks pool; a worker thread refuses it
    afterEach(() => {
      process.chdir(workingDirectory);
      vi.restoreAllMocks();
    });

    // Each case pairs a checkout with a working directory on the opposite side, so a count read from the wrong one fails
    it("warns when the checkout it is handed is ahead of its origin", () => {
      const { checkout } = fixture();
      commitFile(checkout, "docs/readme.md", "unpushed\n");
      process.chdir(fixture().checkout);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      syncMain(checkout, true);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("local main is 1 commit(s) ahead"));
    });

    it("stays silent for a level checkout while the working directory is ahead", () => {
      const ahead = fixture().checkout;
      commitFile(ahead, "docs/readme.md", "unpushed\n");
      process.chdir(ahead);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      syncMain(fixture().checkout, true);

      expect(warn).not.toHaveBeenCalled();
    });

    it("stays silent when the count fails", () => {
      const lone = mkdtempSync(path.join(tmpdir(), "main-checkout-test-"));
      git(lone, "init", "--quiet", "-b", "main");
      commitFile(lone, "docs/readme.md", "first\n");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      syncMain(lone, true);

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
