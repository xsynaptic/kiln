import { describe, expect, it } from "vitest";

import { prepareCloneScript } from "#src/run/clone-baseline.ts";

describe("prepareCloneScript", () => {
  it("fetches main alongside a non-main base, so a review's github/main is never stale", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, []);
    expect(script).toContain("git fetch --quiet github main fix/thing");
    expect(script).toContain("git checkout --quiet --force -B fix/thing github/fix/thing");
  });

  it("fetches main once when it is the base", () => {
    const script = prepareCloneScript("/work/repo", { base: "main", branch: "feat/slice" }, []);
    expect(script).toContain("git fetch --quiet github main\n");
    expect(script).not.toContain("github main main");
  });

  it("clears every transcript file, resolved against the clone", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, [
      "../verdict.json",
      ".git/gate/check.json",
    ]);
    expect(script).toContain("rm -f /work/verdict.json");
    expect(script).toContain("rm -f /work/repo/.git/gate/check.json");
  });

  it("clears logs left at the clone root", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, []);
    expect(script).toContain("rm -f /work/repo/*.log");
  });

  it("fetches before it reads the base ref", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, []);
    expect(script.indexOf("git fetch")).toBeLessThan(script.indexOf("github/fix/thing"));
  });

  it("lands main and origin/main on the fetched main, whatever the base", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, []);
    expect(script).toContain("git branch -f main github/main");
    expect(script).toContain("git update-ref refs/remotes/origin/main refs/remotes/github/main");
  });

  it("moves main after the checkout, so it is never the checked-out branch", () => {
    const script = prepareCloneScript("/work/repo", { base: "main", branch: "feat/slice" }, []);
    expect(script.indexOf("git checkout --quiet --force -B")).toBeLessThan(script.indexOf("git branch -f main"));
  });

  it("warms the gate caches detached, after the install", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, [], "pnpm warm");
    expect(script.indexOf("pnpm install")).toBeLessThan(script.indexOf("pnpm warm"));
    expect(script).toContain("setsid bash -c 'pnpm warm' >/dev/null 2>&1 &");
  });

  it("skips the warm when the descriptor names no command", () => {
    const script = prepareCloneScript("/work/repo", { base: "fix/thing", branch: "fix/thing" }, []);
    expect(script).not.toContain("setsid bash");
  });

  it("anchors every cmdline pattern: the script rides the remote argv, so a loose -f matches its own shell", () => {
    const script = prepareCloneScript(
      "/work/repo",
      { base: "fix/thing", branch: "fix/thing" },
      [],
      'pnpm warm "**/*.ts" --cache-location node_modules/.cache/',
    );
    expect(script).not.toMatch(/pkill -f '[^^]/);
    expect(script).toContain(`pkill -f '^[^ ]*node '`);
    expect(script).toContain("pkill -x claude");
  });

  it("drops the volumes of the named services, and no volume when none is named", () => {
    const baseline = { base: "fix/thing", branch: "fix/thing" };
    const script = prepareCloneScript("/work/repo", baseline, [], undefined, ["db", "queue"]);
    expect(script).toContain("docker compose down --volumes db queue >");
    expect(prepareCloneScript("/work/repo", baseline, [])).not.toContain("--volumes");
  });
});
