import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertHostCredentials,
  buildHostIdEnv,
  mergeHostIdSettings,
  writeSettingsFile,
} from "#src/commands/host-id.ts";

const identityEnv = buildHostIdEnv("sample-agent", "1+sample-agent@users.noreply.github.com", "token-xyz");

describe("mergeHostIdSettings", () => {
  it("writes the stanza into a fresh (empty) settings object", () => {
    const merged = mergeHostIdSettings({}, identityEnv);
    expect(merged).toEqual({ env: identityEnv });
  });

  it("preserves unrelated top-level keys and unrelated env entries", () => {
    const existing = {
      env: { EXISTING_KEY: "keep-me" },
      permissions: { allow: ["Bash(git *)"] },
    };
    const merged = mergeHostIdSettings(existing, identityEnv);
    expect(merged.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(merged.env).toEqual({ EXISTING_KEY: "keep-me", ...identityEnv });
  });

  it("is idempotent across repeated runs and refreshes a stale token", () => {
    const once = mergeHostIdSettings({ env: { OTHER: "x" } }, identityEnv);
    const twice = mergeHostIdSettings(once, identityEnv);
    expect(twice).toEqual(once);

    const refreshed = mergeHostIdSettings(
      once,
      buildHostIdEnv("sample-agent", "1+sample-agent@users.noreply.github.com", "new-token"),
    );
    expect((refreshed.env as Record<string, string>).GH_TOKEN).toBe("new-token");
    expect((refreshed.env as Record<string, string>).OTHER).toBe("x");
  });
});

describe("writeSettingsFile", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  it("tightens a pre-existing world-readable file to 0600 (the PAT must not leak)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-id-"));
    dirs.push(dir);
    const file = path.join(dir, "settings.local.json");
    writeFileSync(file, "{}\n", { mode: 0o644 });

    writeSettingsFile(file, mergeHostIdSettings({}, identityEnv));

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      env: identityEnv,
    });
  });
});

describe("assertHostCredentials", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  it("passes when the credentials directory exists (host)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-id-"));
    dirs.push(dir);
    expect(() => {
      assertHostCredentials(dir);
    }).not.toThrow();
  });

  it("refuses when the credentials directory is absent (guest)", () => {
    const missing = path.join(tmpdir(), "host-id-does-not-exist-xyz");
    expect(() => {
      assertHostCredentials(missing);
    }).toThrow(/runs on the host only/);
  });
});
