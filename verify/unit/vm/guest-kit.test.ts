import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RunMode } from "#src/run/run-args.ts";

import { guestStub, kitRevision, renderContract, renderedContracts } from "#src/vm/guest-kit.ts";

describe("renderedContracts", () => {
  const contracts = renderedContracts();

  it("carries a contract for every mode a run can be launched in", () => {
    const launched: Array<RunMode> = ["attended", "detached", "gatekeeper"];
    for (const mode of launched) {
      expect(contracts.has(`${mode}.md`)).toBe(true);
    }
  });

  it("leaves no placeholder unfilled", () => {
    for (const [file, content] of contracts) {
      expect({ file, open: content.match(/\{\{[^}]*\}\}/g) }).toEqual({ file, open: null });
    }
  });

  it("links only other contracts, since nothing else is staged beside them", () => {
    for (const [file, content] of contracts) {
      const targets = [...content.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
      const strays = targets.filter((target) => !/^\.\/[\w-]+\.md$/.test(target) || !contracts.has(target.slice(2)));
      expect({ file, strays }).toEqual({ file, strays: [] });
    }
  });

  it("names the descriptor's project doc", () => {
    expect(contracts.get("envelope.md")).toContain("`docs/agents.md`");
  });
});

describe("guestStub", () => {
  const contractsDir = "/home/agent/kiln/contracts";

  it("points an attended session at its contract, then the session playbook", () => {
    const stub = guestStub("kiln-3", contractsDir, "docs/kiln/session.md");
    const contractAt = stub.indexOf(`${contractsDir}/attended.md`);
    expect(contractAt).toBeGreaterThan(-1);
    expect(stub.indexOf("docs/kiln/session.md")).toBeGreaterThan(contractAt);
  });

  it("names no playbook when the project configures none", () => {
    expect(guestStub("kiln-3", contractsDir, undefined)).not.toContain("playbook");
  });

  it("refuses a profile that is not a slot, which has no port block", () => {
    expect(() => guestStub("default", contractsDir, undefined)).toThrow("not a kiln slot");
  });
});

describe("renderContract", () => {
  it("refuses a placeholder the descriptor does not fill", () => {
    expect(() => renderContract("run {{gates.lint}}", { "gates.author": "x" })).toThrow("{{gates.lint}}");
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
    const full = { "contracts/envelope.md": "one\ntwo\n", "skills/critique/SKILL.md": "x" };
    const iced = { "contracts/envelope.md": "one\n", "skills/critique/SKILL.md": "x" };
    expect(kitRevision(stagedKit(full), [])).toBe(kitRevision(stagedKit(full), []));
    expect(kitRevision(stagedKit(iced), [])).not.toBe(kitRevision(stagedKit(full), []));
  });

  it("tells apart the same bytes under different file names", () => {
    expect(kitRevision(stagedKit({ "contracts/a.md": "ab" }), [])).not.toBe(
      kitRevision(stagedKit({ "contracts/b.md": "ab" }), []),
    );
  });

  it("moves when a file hashed beside the kit changes", () => {
    const kit = stagedKit({ "contracts/a.md": "ab" });
    const harness = stagedKit({ "hook.mjs": "one" });
    const hook = path.join(harness, "hook.mjs");
    const before = kitRevision(kit, [hook]);
    writeFileSync(hook, "two");
    expect(kitRevision(kit, [hook])).not.toBe(before);
    expect(kitRevision(kit, [])).not.toBe(before);
  });
});
