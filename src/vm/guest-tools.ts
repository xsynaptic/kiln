import { existsSync } from "node:fs";
import path from "node:path";

import type { KilnConfig } from "../config/config-schema.ts";

// The chrome-devtools CLI reads its browser path from this file, so it finds the guest's Chrome without a flag
const devtoolsConfigFile = '"$HOME/.config/cd4a/config.json"';

export function toolProvisionLines(
  guest: Pick<KilnConfig["guest"], "globalPackages" | "mcpServers" | "playwrightPackage">,
): string {
  const playwrightPackage = guest.playwrightPackage;
  const lines: Array<string> = [];
  if (guest.globalPackages.length > 0) {
    const specs = guest.globalPackages.map((spec) => ` "${spec}"`).join("");
    lines.push(`sudo npm install -g${specs}`);
  }
  if (playwrightPackage === undefined) {
    lines.push(
      "# no guest.playwrightPackage in kiln.config.ts: skipping the guest verify browser",
      `rm -f ${devtoolsConfigFile}`,
    );
  } else {
    lines.push(
      "# Runs on every refresh, downloading only when the pinned build is missing, so a Playwright upgrade reaches existing slots",
      `PLAYWRIGHT_DOWNLOAD_NO_PROGRESS=1 pnpm -F "${playwrightPackage}" exec playwright install --with-deps chromium`,
      "# Asked of Playwright rather than searched for, because its folder layout changes between browser builds",
      `CHROME_BIN=$(pnpm --silent -F "${playwrightPackage}" exec node -e 'console.log(require("@playwright/test").chromium.executablePath())')`,
      `[ -x "$CHROME_BIN" ] || { echo "playwright names its chromium at $CHROME_BIN, but no executable is there" >&2; exit 1; }`,
      'mkdir -p "$HOME/.config/cd4a"',
      `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ executablePath: process.argv[2] }))' ${devtoolsConfigFile} "$CHROME_BIN"`,
    );
  }
  const configured = guest.mcpServers.map((server) => ` "${server.name}"`).join("");
  lines.push(
    "# The config is the slot's whole server list, so a server removed from it stops being registered on refresh",
    "# Assigned before the loop, because set -e ignores a failing substitution inside a for list",
    `UNLISTED_MCP=$(node -e 'const fs = require("fs"); const file = process.env.HOME + "/.claude.json"; const servers = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {}) : {}; const keep = new Set(process.argv.slice(1)); console.log(Object.keys(servers).filter((name) => !keep.has(name)).join(" "));'${configured})`,
    "for name in $UNLISTED_MCP; do",
    `  "$HOME/.local/bin/claude" mcp remove --scope user "$name" >/dev/null`,
    `  echo "mcp unregistered: $name"`,
    "done",
  );
  for (const server of guest.mcpServers) {
    const requiresChrome = server.args.some((arg) => arg.includes("{{CHROME_BIN}}"));
    if (requiresChrome && playwrightPackage === undefined) {
      lines.push(`# mcp ${server.name}: skipped ({{CHROME_BIN}} needs guest.playwrightPackage)`);
      continue;
    }
    const args = server.args.map((arg) => ` "${arg.replaceAll("{{CHROME_BIN}}", "$CHROME_BIN")}"`).join("");
    lines.push(
      `"$HOME/.local/bin/claude" mcp remove --scope user ${server.name} >/dev/null 2>&1 || true`,
      `"$HOME/.local/bin/claude" mcp add --scope user ${server.name} -- ${server.command}${args} >/dev/null`,
      `echo "mcp registered: ${server.name}"`,
    );
    const npxPackage = server.args.find((arg) => !arg.startsWith("-"));
    if (npxPackage !== undefined && server.command === "npx") {
      // The timeout and </dev/null stop a server that ignores --version and starts up from stalling provisioning
      lines.push(`timeout 120 npx -y "${npxPackage}" --version >/dev/null 2>&1 </dev/null || true`);
    }
  }
  return lines.join("\n");
}

export function hostLinkLines(names: Array<string>, repoRoot: string): Array<string> {
  return names
    .filter((name) => existsSync(path.join(repoRoot, name)))
    .map((name) => `[ -e ${name} ] || ln -s ${JSON.stringify(path.join(repoRoot, name))} ${name}`);
}
