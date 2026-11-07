import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPlainObject } from "remeda";

import { credentialsDir, kilnConfig } from "../config/config.ts";
import { gitRoot } from "../shared/git.ts";
import { ensureDir } from "../shared/run-artifacts.ts";

const settingsRelpath = path.join(".claude", "settings.local.json");
const patFilename = "github-pat";
const settingsIgnorePattern = "**/.claude/settings.local.json";

// No credentials folder means this is a guest, where a stanza without a token would silently credit the wrong author
/** @internal */
export function assertHostCredentials(dir: string): void {
  if (!existsSync(dir)) {
    throw new Error(
      `no credentials directory at ${dir}: \`kiln host-id\` runs on the host only ` +
        `(a guest clone has none, and its identity already rides git config plus the slot actor). ` +
        `Nothing written.`,
    );
  }
}

/** @internal */
export function buildHostIdEnv(name: string, email: string, token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_NAME: name,
  };
}

/** @internal */
export function mergeHostIdSettings(
  existing: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const priorEnv = isPlainObject(existing.env) ? existing.env : {};
  return { ...existing, env: { ...priorEnv, ...env } };
}

export function run(): void {
  const credDir = credentialsDir();
  assertHostCredentials(credDir);

  const patFile = path.join(credDir, patFilename);
  if (!existsSync(patFile)) {
    throw new Error(
      `no machine-user PAT at ${patFile}; create it once (chmod 600) so gh writes attribute ` +
        `to the machine user. Nothing written.`,
    );
  }
  const token = readFileSync(patFile, "utf8").trim();
  if (token.length === 0) {
    throw new Error(`${patFile} is empty; nothing to write.`);
  }

  // The current checkout, not the main one, because each worktree has its own gitignored settings file
  const repoRoot = gitRoot();
  const settingsFile = path.join(repoRoot, settingsRelpath);
  // The ignore rule goes first, so a failure partway never leaves a file holding a token that git would track
  const didAddIgnore = didAddGitignoreLine(repoRoot, settingsRelpath);
  ensureDir(path.dirname(settingsFile));

  const merged = mergeHostIdSettings(
    readSettings(settingsFile),
    buildHostIdEnv(kilnConfig.identity.machineUser.name, kilnConfig.identity.machineUser.email, token),
  );
  writeSettingsFile(settingsFile, merged);

  console.log(
    `wrote the host-id stanza to ${settingsRelpath}: git and gh in this checkout's Claude ` +
      `sessions now attribute to ${kilnConfig.identity.machineUser.name}. Start a new session for it to take effect.`,
  );
  if (didAddIgnore) {
    console.log(`  added ${settingsIgnorePattern} to .gitignore (the stanza carries a token; never commit it)`);
  }
}

// An explicit chmod, because writeFileSync's mode only applies when it creates the file
/** @internal */
export function writeSettingsFile(file: string, settings: Record<string, unknown>): void {
  writeFileSync(file, `${JSON.stringify(settings, undefined, 2)}\n`);
  chmodSync(file, 0o600);
}

function didAddGitignoreLine(repoRoot: string, relPath: string): boolean {
  const isIgnored = spawnSync("git", ["check-ignore", "-q", relPath], { cwd: repoRoot }).status === 0;
  if (isIgnored) {
    return false;
  }
  const gitignore = path.join(repoRoot, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignore, `${current}${separator}${settingsIgnorePattern}\n`);
  return true;
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isPlainObject(parsed)) {
    throw new Error(`${file} is not a JSON object; refusing to overwrite it by hand`);
  }
  return parsed;
}
