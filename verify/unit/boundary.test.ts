import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { capture } from "#src/shared/proc.ts";

const kilnDir = path.resolve(import.meta.dirname, "../..");
const denylistFile = path.join(kilnDir, ".claude", "denylist");

function deniedNames(): Array<string> {
  if (!existsSync(denylistFile)) {
    return [];
  }
  return readFileSync(denylistFile, "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function trackedFiles(): Array<string> {
  return capture("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], kilnDir)
    .split("\0")
    .filter((file) => file !== "" && existsSync(path.join(kilnDir, file)));
}

const names = deniedNames();

describe.skipIf(names.length === 0)("project boundary", () => {
  it("keeps every denylisted name out of the tree", () => {
    const offenders = trackedFiles().flatMap((file) => {
      const content = readFileSync(path.join(kilnDir, file), "utf8").toLowerCase();
      return names.filter((name) => content.includes(name)).map((name) => `${file}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });
});
