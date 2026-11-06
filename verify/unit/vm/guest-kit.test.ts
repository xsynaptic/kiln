import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RunMode } from "#src/run/run-args.ts";

import { kitRevision, renderedModes, renderMode } from "#src/vm/guest-kit.ts";

describe("renderedModes", () => {
  const modes = renderedModes();

  it("carries a manual for every mode a run can be launched in", () => {
    const launched: Array<RunMode> = ["attended", "detached", "gatekeeper"];
    for (const mode of launched) {
      expect(modes.has(`${mode}.md`)).toBe(true);
    }
  });

  it("leaves no placeholder unfilled", () => {
    for (const [file, content] of modes) {
      expect({ file, open: content.match(/\{\{[^}]*\}\}/g) }).toEqual({ file, open: null });
    }
  });

  it("names the descriptor's gates and project doc", () => {
    expect(modes.get("detached.md")).toContain("`npm run verify`");
    expect(modes.get("gatekeeper.md")).toContain("`npm run verify:all`");
    expect(modes.get("envelope.md")).toContain("git show github/main:docs/agents.md");
  });
});

describe("renderMode", () => {
  it("refuses a placeholder the descriptor does not fill", () => {
    expect(() => renderMode("run {{gates.lint}}", { "gates.author": "x" })).toThrow("{{gates.lint}}");
  });
});

describe("kitRevision", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function stagedKit(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "kit-revision-"));
    dirs.push(dir);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    return dir;
  }

  it("moves when a staged file loses a line, and holds across stagings of the same bytes", () => {
    const full = { "modes/envelope.md": "one\ntwo\n", "skills/critique/SKILL.md": "x" };
    const iced = { "modes/envelope.md": "one\n", "skills/critique/SKILL.md": "x" };
    expect(kitRevision(stagedKit(full), [])).toBe(kitRevision(stagedKit(full), []));
    expect(kitRevision(stagedKit(iced), [])).not.toBe(kitRevision(stagedKit(full), []));
  });

  it("tells apart the same bytes under different file names", () => {
    expect(kitRevision(stagedKit({ "modes/a.md": "ab" }), [])).not.toBe(
      kitRevision(stagedKit({ "modes/b.md": "ab" }), []),
    );
  });

  it("moves when a file hashed beside the kit changes", () => {
    const kit = stagedKit({ "modes/a.md": "ab" });
    const harness = stagedKit({ "hook.mjs": "one" });
    const hook = path.join(harness, "hook.mjs");
    const before = kitRevision(kit, [hook]);
    writeFileSync(hook, "two");
    expect(kitRevision(kit, [hook])).not.toBe(before);
    expect(kitRevision(kit, [])).not.toBe(before);
  });
});
