import { fc, test } from "@fast-check/vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect } from "vitest";

import type { KilnConfig } from "#src/config/config-schema.ts";

import { kilnConfigSchema } from "#src/config/config-schema.ts";
import { prepareCloneScript } from "#src/run/clone-baseline.ts";
import { modelFlag } from "#src/run/run-args.ts";
import { hostLinkLines, toolProvisionLines } from "#src/vm/guest-tools.ts";
import { gateEnvExportLines } from "#src/vm/vm.ts";
import descriptor from "#support/descriptor.ts";

const stubbedCommands = [
  "sudo",
  "npm",
  "npx",
  "docker",
  "rm",
  "ln",
  "node",
  "timeout",
  "git",
  "pkill",
  "setsid",
  "probe",
];

const record = String.raw`{ printf '%s' "$1"; shift; for arg in "$@"; do printf '\037%s' "$arg"; done; printf '\036'; } >> "$KILN_RECORD"`;

const stubPreamble = [
  `record() { ${record}; }`,
  ...stubbedCommands.map((command) => `${command}() { record ${command} "$@"; }`),
  'pnpm() { record pnpm "$@"; echo /bin/sh; }',
].join("\n");

const claudeStub = `#!/bin/bash\nset -- claude "$@"\n${record}\n`;

let root = "";
let bin = "";
let home = "";

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "kiln-shell-"));
  bin = path.join(root, "bin");
  home = path.join(root, "home");
  mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(home, ".local", "bin", "claude"), claudeStub);
  chmodSync(path.join(home, ".local", "bin", "claude"), 0o755);
});

interface ShellRun {
  commands: Array<Array<string>>;
  status: null | number;
}

function runInBash(script: string, cwd: string, input = ""): ShellRun {
  const record = path.join(mkdtempSync(path.join(root, "run-")), "record");
  writeFileSync(record, "");
  const result = spawnSync("bash", ["-c", `${stubPreamble}\n${script}`], {
    cwd,
    encoding: "utf8",
    env: { HOME: home, KILN_RECORD: record, PATH: `${bin}:/usr/bin:/bin` },
    input,
  });
  const commands = readFileSync(record, "utf8")
    .split("\u{1E}")
    .filter((entry) => entry !== "")
    .map((entry) => entry.split("\u{1F}"));
  return { commands, status: result.status };
}

function isAcceptedConfig(overrides: Partial<Record<keyof KilnConfig, unknown>>): boolean {
  return kilnConfigSchema.safeParse({ ...descriptor, ...overrides }).success;
}

const printable = [
  ...Array.from({ length: 95 }, (_unused, index) => String.fromCodePoint(32 + index)),
  "\t",
  "\n",
  "é",
];

function acceptedValue(isAccepted: (value: string) => boolean) {
  const first = printable.filter((character) => isAccepted(`${character}a`));
  const inner = printable.filter((character) => isAccepted(`a${character}a`));
  return fc
    .tuple(fc.constantFrom(...first), fc.array(fc.constantFrom(...inner), { maxLength: 7 }))
    .map(([head, rest]) => head + rest.join(""))
    .filter((value) => isAccepted(value));
}

const guestPath = acceptedValue((value) =>
  isAcceptedConfig({ gates: { ...descriptor.gates, verdictFiles: { log: value } } }),
);
const resetVolume = acceptedValue((value) => isAcceptedConfig({ slots: { resetVolumes: [value] } }));
const globalPackage = acceptedValue((value) => isAcceptedConfig({ guest: { globalPackages: [value] } }));
const hostLink = acceptedValue((value) => isAcceptedConfig({ guest: { hostLinks: [value] } }));
const gateEnvValue = acceptedValue((value) =>
  isAcceptedConfig({ gates: { ...descriptor.gates, env: { GATE_FLAGS: value } } }),
);
const playwrightPackage = acceptedValue((value) => isAcceptedConfig({ guest: { playwrightPackage: value } }));
const model = acceptedValue((value) => isAcceptedConfig({ dispatch: { models: [value], reviewModel: value } }));

function isAcceptedMcpServer(server: { args: Array<string>; command: string; name: string }): boolean {
  return isAcceptedConfig({ guest: { mcpServers: [server] } });
}

const mcpName = acceptedValue((value) => isAcceptedMcpServer({ args: [], command: "npx", name: value }));
const mcpCommand = fc.oneof(
  fc.constant("npx"),
  acceptedValue((value) => isAcceptedMcpServer({ args: [], command: value, name: "server" })),
);
function isMcpArg(value: string): boolean {
  return isAcceptedMcpServer({ args: [value], command: "npx", name: "server" });
}

// Args may contain braces, and unquoted those would split one arg into several
const braceArg = fc
  .tuple(
    fc.constantFrom("", "x", "--flag="),
    fc.constantFrom("a", "1", "x.y"),
    fc.constantFrom("b", "3", "z"),
    fc.constantFrom(",", ".."),
  )
  .map(([prefix, left, right, separator]) => `${prefix}{${left}${separator}${right}}`)
  .filter((value) => isMcpArg(value));

const mcpArg = fc.oneof(
  acceptedValue((value) => isMcpArg(value)),
  braceArg,
);
const mcpArgOrChrome = fc.oneof(mcpArg, fc.constant("{{CHROME_BIN}}"));

const mcpServer = fc.record(
  {
    args: fc.array(mcpArgOrChrome, { maxLength: 3 }),
    command: mcpCommand,
    name: mcpName,
  },
  { noNullPrototype: true },
);

function isFlag(value: string): boolean {
  return value.startsWith("-");
}

// Each run starts bash, so a hundred runs can outlast the default timeout on a busy machine
describe("config values a guest shell line carries", { timeout: 60_000 }, () => {
  test.prop([fc.array(guestPath, { maxLength: 3 }), fc.array(resetVolume, { maxLength: 3 })])(
    "reach the baseline reset as one word each",
    (verdictFiles, resetVolumes) => {
      const clonePath = mkdtempSync(path.join(root, "clone-"));
      mkdirSync(path.join(clonePath, ".git", "hooks"), { recursive: true });
      const script = prepareCloneScript(
        clonePath,
        { base: "main", branch: "feat/x" },
        verdictFiles,
        undefined,
        resetVolumes,
      );
      const shell = runInBash(script, clonePath, "oauth\npat\n");
      expect(shell.status).toBe(0);
      const removed = shell.commands.filter(([command]) => command === "rm").map((argv) => argv.slice(1));
      expect(removed).toEqual([
        ...verdictFiles.map((file) => ["-f", path.posix.join(clonePath, file)]),
        ["-f", path.posix.join(clonePath, "*.log")],
      ]);
      const volumeReset = shell.commands.filter((argv) => argv.includes("--volumes"));
      expect(volumeReset).toEqual(
        resetVolumes.length === 0 ? [] : [["docker", "compose", "down", "--volumes", ...resetVolumes]],
      );
      expect(resetVolumes.filter((volume) => isFlag(volume))).toEqual([]);
    },
  );

  test.prop([
    fc.array(globalPackage, { maxLength: 3 }),
    fc.array(mcpServer, { maxLength: 2 }),
    fc.option(playwrightPackage, { nil: undefined }),
  ])("reach the tool provisioning as one word each", (globalPackages, mcpServers, playwright) => {
    const lines = toolProvisionLines({
      globalPackages,
      mcpServers,
      ...(playwright === undefined ? {} : { playwrightPackage: playwright }),
    });
    const shell = runInBash(`set -euo pipefail\n${lines}`, root);
    expect(shell.status).toBe(0);
    const expected: Array<Array<string>> = [];
    if (globalPackages.length > 0) {
      expected.push(["sudo", "npm", "install", "-g", ...globalPackages]);
    }
    if (playwright !== undefined) {
      expected.push(["pnpm", "-F", playwright, "exec", "playwright", "install", "--with-deps", "chromium"]);
    }
    for (const server of mcpServers) {
      if (playwright === undefined && server.args.some((arg) => arg.includes("{{CHROME_BIN}}"))) {
        continue;
      }
      const args = server.args.map((arg) => arg.replaceAll("{{CHROME_BIN}}", "/bin/sh"));
      expected.push(
        ["claude", "mcp", "remove", "--scope", "user", server.name],
        ["claude", "mcp", "add", "--scope", "user", server.name, "--", server.command, ...args],
      );
      const npxPackage = server.args.find((arg) => !isFlag(arg));
      if (npxPackage !== undefined && server.command === "npx") {
        expected.push(["timeout", "120", "npx", "-y", npxPackage, "--version"]);
      }
    }
    const watched = new Set(["claude", "sudo", "timeout"]);
    const seen = shell.commands.filter(
      ([command, ...argv]) =>
        watched.has(command ?? "") ||
        (command === "pnpm" && argv[0] === "-F" && argv[2] === "exec" && argv[3] === "playwright"),
    );
    expect(seen).toEqual(expected);
    expect([...globalPackages, ...mcpServers.map((server) => server.name)].filter((value) => isFlag(value))).toEqual(
      [],
    );
  });

  test.prop([
    fc.dictionary(fc.constantFrom("GATE_FLAGS", "CI_LEVEL", "WORKERS"), gateEnvValue, { noNullPrototype: true }),
  ])("reach the gate's environment unchanged", (gateEnv) => {
    const probes = Object.keys(gateEnv).map((name) => `probe "$${name}"`);
    const shell = runInBash(["set -euo pipefail", ...gateEnvExportLines(gateEnv), ...probes].join("\n"), root);
    expect(shell.status).toBe(0);
    expect(shell.commands).toEqual(Object.values(gateEnv).map((value) => ["probe", value]));
  });

  test.prop([fc.uniqueArray(hostLink, { maxLength: 3 })])("reach the host links as one word each", (names) => {
    const repoRoot = mkdtempSync(path.join(root, "repo-"));
    for (const name of names) {
      if (!existsSync(path.join(repoRoot, name))) {
        writeFileSync(path.join(repoRoot, name), "");
      }
    }
    const cwd = mkdtempSync(path.join(root, "guest-"));
    const shell = runInBash(["set -euo pipefail", ...hostLinkLines(names, repoRoot)].join("\n"), cwd);
    expect(shell.status).toBe(0);
    const linked = names.filter((name) => name !== "." && name !== "..");
    expect(shell.commands).toEqual(linked.map((name) => ["ln", "-s", path.join(repoRoot, name), name]));
    expect(linked.filter((name) => isFlag(name))).toEqual([]);
  });

  test.prop([model])("reach the claude command line as one word", (name) => {
    const shell = runInBash(`"$HOME/.local/bin/claude"${modelFlag(name)} --dangerously-skip-permissions`, root);
    expect(shell.commands).toEqual([["claude", "--model", name, "--dangerously-skip-permissions"]]);
  });
});
