import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { missingOnMainScript, prepareCloneScript } from "#src/run/clone-baseline.ts";

describe("prepareCloneScript", () => {
  it("fetches main alongside a non-main base, so a review's github/main is never stale", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" });
    expect(script).toContain("git fetch --quiet github main fix/thing");
    expect(script).toContain("git checkout --quiet --force -B fix/thing github/fix/thing");
  });

  it("fetches main once when it is the base", () => {
    const script = prepareCloneScript("/work/repo", { base: "main", branch: "feat/slice" });
    expect(script).toContain("git fetch --quiet github main\n");
    expect(script).not.toContain("github main main");
  });

  it("clears the gate's verdicts and logs, so none carries over into the next run", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" });
    expect(script).toContain("rm -rf /work/repo/.git/kiln-gate");
  });

  it("fetches before it reads the base ref", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" });
    expect(script.indexOf("git fetch")).toBeLessThan(script.indexOf("github/fix/thing"));
  });

  it("lands main and origin/main on the fetched main, whatever the base", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" });
    expect(script).toContain("git branch -f main github/main");
    expect(script).toContain("git update-ref refs/remotes/origin/main refs/remotes/github/main");
  });

  it("moves main after the checkout, so it is never the checked-out branch", () => {
    const script = prepareCloneScript("/work/repo", { base: "main", branch: "feat/slice" });
    expect(script.indexOf("git checkout --quiet --force -B")).toBeLessThan(script.indexOf("git branch -f main"));
  });

  it("warms the gate caches detached, after the install", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, "pnpm warm");
    expect(script.indexOf("pnpm install")).toBeLessThan(script.indexOf("pnpm warm"));
    expect(script).toContain("setsid bash -c 'pnpm warm' >/dev/null 2>&1 &");
  });

  it("skips the warm when the descriptor names no command", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" });
    expect(script).not.toContain("setsid bash");
  });

  it("anchors every cmdline pattern: the script rides the remote argv, so a loose -f matches its own shell", () => {
    const script = prepareCloneScript(
      "/work/repo",
      { base: "fix/thing", branch: "fix/thing" },
      'pnpm warm "**/*.ts" --cache-location node_modules/.cache/',
    );
    expect(script).not.toMatch(/pkill -f '[^^]/);
    expect(script).toContain(`pkill -f '^[^ ]*node '`);
    expect(script).toContain("pkill -x claude");
  });

  it("drops the volumes of the named services, and no volume when none is named", () => {
    const baseline = { base: "fix/thing", branch: "fix/thing" };
    const script = prepareCloneScript("/work/repo", baseline, undefined, ["db", "queue"]);
    expect(script).toContain("docker compose down --volumes db queue >");
    expect(prepareCloneScript("/work/repo", baseline)).not.toContain("--volumes");
  });
});

describe("missingOnMainScript", () => {
  it("names only the docs github/main lacks, whatever the checked-out branch holds", () => {
    const clone = mkdtempSync(path.join(tmpdir(), "kiln-docs-"));
    try {
      const git = (...args: Array<string>) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" });
      git("init", "--quiet", "--initial-branch", "main");
      mkdirSync(path.join(clone, "docs"));
      writeFileSync(path.join(clone, "docs/agents.md"), "doc\n");
      git("add", ".");
      git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "--quiet", "-m", "doc");
      git("update-ref", "refs/remotes/github/main", "HEAD");
      writeFileSync(path.join(clone, "docs/worker.md"), "unpushed\n");
      const script = missingOnMainScript(clone, ["docs/agents.md", "docs/worker.md", "docs/gatekeeper.md"]);
      expect(execFileSync("bash", ["-c", script], { encoding: "utf8" })).toBe("docs/worker.md\ndocs/gatekeeper.md\n");
    } finally {
      rmSync(clone, { force: true, recursive: true });
    }
  });
});
