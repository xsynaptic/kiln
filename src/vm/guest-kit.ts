import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { kilnConfig } from "../config/config.ts";
import { guestTarball, sshScriptWithInput } from "./vm.ts";

// Read from the host's own install, so a run gets the kiln the host runs rather than a copy its branch could rewrite
const kilnRoot = path.resolve(import.meta.dirname, "..", "..");

const placeholderValues: Readonly<Record<string, string>> = {
  "gates.author": kilnConfig.gates.author,
  "gates.merge": kilnConfig.gates.merge,
  githubRepo: kilnConfig.identity.githubRepo,
  projectDoc: kilnConfig.projectDoc,
};

export function guestModesDir(clonePath: string): string {
  return path.posix.join(path.posix.dirname(clonePath), "kiln", "modes");
}

/** @internal */
export function renderMode(source: string, values: Readonly<Record<string, string>>): string {
  return source.replaceAll(/\{\{([\w.]+)\}\}/g, (token, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`mode doc names ${token}, which the descriptor does not fill`);
    }
    return value;
  });
}

/** @internal */
export function renderedModes(): Map<string, string> {
  const dir = path.join(kilnRoot, "modes");
  return new Map(
    readdirSync(dir).map((file) => [file, renderMode(readFileSync(path.join(dir, file), "utf8"), placeholderValues)]),
  );
}

export interface StagedKit {
  kit: string;
  modesDir: string;
}

export function stageGuestKit(profile: string, clonePath: string, alsoHashed: ReadonlyArray<string> = []): StagedKit {
  const modesDir = guestModesDir(clonePath);
  const kitDir = JSON.stringify(path.posix.dirname(modesDir));
  const staging = mkdtempSync(path.join(tmpdir(), "kiln-kit-"));
  try {
    mkdirSync(path.join(staging, "modes"));
    for (const [file, content] of renderedModes()) {
      writeFileSync(path.join(staging, "modes", file), content);
    }
    cpSync(path.join(kilnRoot, "skills"), path.join(staging, "skills"), { recursive: true });
    sshScriptWithInput(
      profile,
      [
        `rm -rf ${kitDir}`,
        `mkdir -p ${kitDir} "$HOME/.claude/skills"`,
        `base64 -d | tar -x --warning=no-unknown-keyword -C ${kitDir}`,
        `for skill in ${kitDir}/skills/*/; do [ -d "$skill" ] || continue; name=$(basename "$skill"); rm -rf "$HOME/.claude/skills/$name"; cp -r "$skill" "$HOME/.claude/skills/$name"; done`,
      ].join(" && "),
      guestTarball(staging, { followSymlinks: false }),
    );
    return { kit: kitRevision(staging, alsoHashed), modesDir };
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

/** @internal */
export function kitRevision(stagingDir: string, alsoHashed: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  const files = readdirSync(stagingDir, { recursive: true })
    .map(String)
    .filter((file) => statSync(path.join(stagingDir, file)).isFile())
    .toSorted();
  for (const file of files) {
    hash
      .update(`${file}\0`)
      .update(readFileSync(path.join(stagingDir, file)))
      .update("\0");
  }
  for (const file of alsoHashed) {
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 12);
}
