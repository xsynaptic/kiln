import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { toolProvisionLines } from "#src/vm/guest-tools.ts";
import { beadsLocalConfigScript } from "#src/vm/provision-scripts.ts";
import { assertSlotWithinCap } from "#src/vm/provision.ts";

const browserServer = {
  args: ["-y", "browser-mcp@1.0.0", "--executablePath", "{{CHROME_BIN}}"],
  command: "npx",
  name: "browser-mcp",
};
const docsServer = { args: ["-y", "docs-mcp@2.0.0"], command: "npx", name: "docs-mcp" };
const localServer = { args: ["--stdio"], command: "docs-server", name: "local" };

function guestHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "guest-home-test-"));
  mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  writeFileSync(path.join(home, "claude-calls.log"), "");
  writeFileSync(path.join(home, ".local/bin/claude"), `#!/bin/sh\necho "$*" >> "${home}/claude-calls.log"\n`, {
    mode: 0o755,
  });
  return home;
}

function runInGuest(home: string, script: string) {
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    input: `set -euo pipefail\n${script}\n`,
  });
}

function devtoolsConfigPath(home: string): string {
  return path.join(home, ".config/cd4a/config.json");
}

function claudeCalls(home: string): string {
  return readFileSync(path.join(home, "claude-calls.log"), "utf8");
}

describe("assertSlotWithinCap", () => {
  it("allows slots at or under the cap", () => {
    expect(() => {
      assertSlotWithinCap(1, 2);
    }).not.toThrow();
    expect(() => {
      assertSlotWithinCap(2, 2);
    }).not.toThrow();
  });

  it("refuses a slot beyond the cap, naming the cap and the descriptor", () => {
    expect(() => {
      assertSlotWithinCap(3, 2);
    }).toThrow(/slots\.max: 2 in kiln\.config\.ts/);
  });
});

describe("beadsLocalConfigScript", () => {
  it("writes a config the guest shell leaves parseable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "beads-config-test-"));
    mkdirSync(path.join(root, ".beads"));

    const result = spawnSync("bash", ["-s"], {
      cwd: root,
      encoding: "utf8",
      input: beadsLocalConfigScript("kiln-1"),
    });

    expect(result.status).toBe(0);
    const written = readFileSync(path.join(root, ".beads/config.local.yaml"), "utf8");
    expect(written).toBe('actor: "kiln-1"\nbackup:\n    enabled: false\n');
  });
});

describe("toolProvisionLines", () => {
  it("skips {{CHROME_BIN}} entries when no playwrightPackage provisions a browser", () => {
    const lines = toolProvisionLines({ globalPackages: [], mcpServers: [browserServer, docsServer] });
    expect(lines).toContain("# mcp browser-mcp: skipped");
    expect(lines).not.toContain("mcp add --scope user browser-mcp");
    expect(lines).toContain('mcp add --scope user docs-mcp -- npx "-y" "docs-mcp@2.0.0"');
  });

  it("installs the browser and substitutes {{CHROME_BIN}} when playwrightPackage is set", () => {
    const lines = toolProvisionLines({
      globalPackages: [],
      mcpServers: [browserServer],
      playwrightPackage: "@acme/web",
    });
    expect(lines).toContain("playwright install --with-deps chromium");
    expect(lines).toContain('"--executablePath" "$CHROME_BIN"');
    expect(lines).toContain("mcp remove --scope user browser-mcp");
    expect(lines).toContain("mcp add --scope user browser-mcp");
  });

  it("cache-warms npx packages best-effort and leaves other commands alone", () => {
    const lines = toolProvisionLines({ globalPackages: [], mcpServers: [localServer, docsServer] });
    expect(lines).toContain('timeout 120 npx -y "docs-mcp@2.0.0" --version');
    expect(lines).not.toContain('npx -y "docs-server"');
    expect(lines).toContain('mcp add --scope user local -- docs-server "--stdio"');
  });
  it("installs global packages in one npm call, and none when the list is empty", () => {
    const lines = toolProvisionLines({ globalPackages: ["browser-cli@^1.0.0", "@acme/tool@2"], mcpServers: [] });
    expect(lines).toContain('sudo npm install -g "browser-cli@^1.0.0" "@acme/tool@2"');
    expect(toolProvisionLines({ globalPackages: [], mcpServers: [] })).not.toContain("npm install -g");
  });

  it("points the chrome-devtools CLI at the guest's Chromium", () => {
    const home = guestHome();
    const lines = toolProvisionLines({ globalPackages: [], mcpServers: [], playwrightPackage: "@acme/web" });
    const configLines = lines.split("\n").filter((line) => line.includes("cd4a"));

    const result = runInGuest(home, `CHROME_BIN="/opt/chrome dir/chrome"\n${configLines.join("\n")}`);

    expect(result.status).toBe(0);
    const written = readFileSync(devtoolsConfigPath(home), "utf8");
    expect(JSON.parse(written)).toStrictEqual({
      executablePath: "/opt/chrome dir/chrome",
    });
  });

  it("removes that config once no playwrightPackage provisions a browser", () => {
    const home = guestHome();
    mkdirSync(path.dirname(devtoolsConfigPath(home)), { recursive: true });
    writeFileSync(devtoolsConfigPath(home), JSON.stringify({ executablePath: "/gone/chrome" }));

    const result = runInGuest(home, toolProvisionLines({ globalPackages: [], mcpServers: [] }));

    expect(result.status).toBe(0);
    expect(existsSync(devtoolsConfigPath(home))).toBe(false);
  });

  it("unregisters user-scope servers the config no longer lists, and re-adds the ones it does", () => {
    const home = guestHome();
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { local: {}, "old-browser": {} } }));

    const result = runInGuest(home, toolProvisionLines({ globalPackages: [], mcpServers: [localServer] }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mcp unregistered: old-browser");
    expect(result.stdout).not.toContain("mcp unregistered: local");
    expect(claudeCalls(home)).toContain("mcp add --scope user local -- docs-server --stdio");
  });

  it("stops the provision on an unreadable claude config rather than skipping the reconcile", () => {
    const home = guestHome();
    writeFileSync(path.join(home, ".claude.json"), "{ not json");

    const result = runInGuest(home, toolProvisionLines({ globalPackages: [], mcpServers: [localServer] }));

    expect(result.status).not.toBe(0);
    expect(claudeCalls(home)).toBe("");
  });
});
