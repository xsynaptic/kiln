import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import { kilnConfig } from "../config/config.ts";
import { parseJson } from "../shared/lenient-json.ts";
import { capture, sleepMs } from "../shared/proc.ts";
import { safeCapture } from "../shared/run-artifacts.ts";
import { claimSlotPane } from "./herdr.ts";

export function guestClonePath(profile: string): string {
  return sshCapture(profile, `ls -d /mnt/lima-*/work/${kilnConfig.identity.cloneDirName} | head -1`);
}

// Its own socket, so a kill-server can never touch anyone else's tmux
export const agentTmuxSocket = "agent";
export const agentTmuxSession = "run";

export function agentRunExportLine(runName: string, mode: "attended" | "detached" | "shell"): string {
  return `export KILN_RUN=${JSON.stringify(`${runName} (${mode})`)}`;
}

export const bashMaxTimeoutMs = "1800000";
export const bashTimeoutExportLine = `export BASH_MAX_TIMEOUT_MS=${bashMaxTimeoutMs}`;

/** @internal */
export function gateEnvExportLines(gateEnv: Record<string, string>): Array<string> {
  return Object.entries(gateEnv).map(([name, value]) => `export ${name}=${value}`);
}

// Resolved through core.hooksPath, which hook managers such as husky move
export const pushGateShimLines = [
  'HOOKS_DIR="$(git rev-parse --git-path hooks)"',
  'mkdir -p "$HOOKS_DIR"',
  String.raw`printf '%s\n' '#!/bin/sh' 'exec kiln-gate push "$@"' > "$HOOKS_DIR/pre-push"`,
  'chmod +x "$HOOKS_DIR/pre-push"',
];

// An xterm TERM keeps claude's working titles, because herdr reads the screen-256color fallback as idle
const agentTmuxConf = [
  'set -g default-terminal "xterm-256color"',
  'set -as terminal-features "xterm-256color:RGB"',
  "set-environment -g COLORTERM truecolor",
  "set-environment -g CLAUDE_CODE_TMUX_TRUECOLOR 1",
  "set -g status off",
  "set -g focus-events on",
  "set -g set-titles on",
  'set -g set-titles-string "#{pane_title}"',
  "",
].join("\n");

export type VmState = "running" | "stopped";

interface AgentTmuxStart {
  afterStart?: Array<string>;
  beforeStart?: Array<string>;
  clonePath: string;
  profile: string;
  tokens: string;
  windowCommand: string;
}

export function agentTmuxKill(profile: string): void {
  spawnSync("colima", ["ssh", "-p", profile, "--", "tmux", "-L", agentTmuxSocket, "kill-server"], {
    stdio: "ignore",
  });
}

export async function attachAgentTmux(profile: string, isReadOnly = false): Promise<number> {
  const { configPath, hostAlias } = slotSsh(profile);
  const claim = claimSlotPane(profile);
  try {
    return await new Promise<number>((resolve) => {
      const attached = spawn(
        "ssh",
        [
          "-F",
          configPath,
          "-tt",
          hostAlias,
          "tmux",
          "-L",
          agentTmuxSocket,
          "attach-session",
          ...(isReadOnly ? ["-r"] : []),
          "-t",
          agentTmuxSession,
        ],
        { stdio: "inherit" },
      );
      attached.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });
  } finally {
    // A claim never expires, so anything that skips this leaves a phantom agent on the pane
    claim?.release();
  }
}

export function didScpFromGuest(profile: string, guestPath: string, hostDest: string): boolean {
  const { configPath, hostAlias } = slotSsh(profile);
  const result = spawnSync("scp", ["-F", configPath, `${hostAlias}:${guestPath}`, hostDest], { stdio: "ignore" });
  return result.status === 0;
}

// A slot can report running before its sshd answers, which colima shows as a bare exit 255
export function didSshAnswer(profile: string, attempts = 5): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (sshCaptureSafe(profile, "true") !== undefined) {
      return true;
    }
    sleepMs(2000);
  }
  return false;
}

export function hasAgentTmuxSession(profile: string): boolean {
  return (
    spawnSync(
      "colima",
      ["ssh", "-p", profile, "--", "tmux", "-L", agentTmuxSocket, "has-session", "-t", agentTmuxSession],
      { stdio: "ignore" },
    ).status === 0
  );
}

// The brackets stop pgrep matching the probe's own command line
export function hasHeadlessClaude(profile: string): boolean {
  const pid = sshCaptureSafe(profile, "pgrep -f '[c]laude -p' | head -1");
  return pid !== undefined && pid.length > 0;
}

const slotStampPath = "$HOME/.agent-slot-provisioned";

export function isSlotProvisioned(profile: string, stamp: string): boolean {
  const stamped = sshCaptureSafe(profile, `cat "${slotStampPath}" 2>/dev/null`);
  return stamped?.trim() === stamp;
}

export function isVmRunning(profile: string): boolean {
  return spawnSync("colima", ["status", "-p", profile], { stdio: "ignore" }).status === 0;
}

// `colima status` exits 1 for both stopped and never-created VMs; only `list` tells them apart
export function listVmStates(): Map<string, VmState> {
  return parseVmStates(safeCapture("colima", ["list", "--json"]) ?? "");
}

// colima prints one JSON object per line, not an array
/** @internal */
export function parseVmStates(listJson: string): Map<string, VmState> {
  const states = new Map<string, VmState>();
  for (const line of listJson.split("\n")) {
    const parsed = parseVmStateLine(line);
    if (parsed) {
      states.set(parsed.name, parsed.state);
    }
  }
  return states;
}

const colimaVmSchema = z.object({ name: z.string(), status: z.string() });

function parseVmStateLine(line: string): undefined | { name: string; state: VmState } {
  if (line.trim().length === 0) {
    return undefined;
  }
  const record = colimaVmSchema.safeParse(parseJson(line));
  if (!record.success) {
    return undefined;
  }
  const { name, status } = record.data;
  if (status === "Running") {
    return { name, state: "running" };
  }
  if (status === "Stopped") {
    return { name, state: "stopped" };
  }
  return undefined;
}

// has-session fails both when there is no session and when ssh fails, so the echoed word tells them apart
export function probeAgentTmuxSession(profile: string): "ended" | "live" | "unreachable" {
  const out = sshCaptureSafe(
    profile,
    `tmux -L ${agentTmuxSocket} has-session -t ${agentTmuxSession} 2>/dev/null && echo live || echo ended`,
  );
  if (out === "live" || out === "ended") {
    return out;
  }
  return "unreachable";
}

export function singleQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// Read fresh on each call, because the slot's ssh port can change
export function slotSsh(profile: string): {
  configPath: string;
  hostAlias: string;
} {
  const config = capture("colima", ["ssh-config", "-p", profile]);
  const configPath = path.join(tmpdir(), `${kilnConfig.identity.machineUser.name}-ssh-${profile}.config`);
  writeFileSync(configPath, `${config}\n`, { mode: 0o600 });
  return { configPath, hostAlias: slotSshHostAlias(profile) };
}

export function slotSshHostAlias(profile: string): string {
  return `colima-${profile}`;
}

// Its own process group, so a kill reaches the ssh grandchild; killing only colima would leave the remote command running
export function spawnDetachedSshScript(profile: string, script: string) {
  return spawn("colima", ["ssh", "-p", profile, "--", "bash", "-c", script], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function sshCaptureSafe(profile: string, command: string): string | undefined {
  return safeCapture("colima", ["ssh", "-p", profile, "--", "bash", "-c", command]);
}

export function sshScript(profile: string, script: string): void {
  const result = spawnSync("colima", ["ssh", "-p", profile, "--", "bash", "-s"], {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`guest script in ${profile} exited ${String(result.status ?? "signalled")}`);
  }
}

// The script goes in through bash -c, so stdin stays free for the script's own reads
// Without this, macOS tar adds extended attributes and ._* files that the guest's GNU tar chokes on
export function guestTarball(dir: string, options: { followSymlinks: boolean }): string {
  const tar = spawnSync("tar", ["--no-xattrs", options.followSymlinks ? "-chf" : "-cf", "-", "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tar.status !== 0) {
    throw new Error(`tar of ${dir} failed: ${tar.stderr.toString().trim()}`);
  }
  return tar.stdout.toString("base64");
}

export function sshScriptWithInput(profile: string, script: string, input: string): void {
  const result = spawnSync("colima", ["ssh", "-p", profile, "--", "bash", "-c", script], {
    input,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`guest script in ${profile} exited ${String(result.status ?? "signalled")}`);
  }
}

export function stampSlotProvisioned(profile: string, stamp: string): void {
  sshScript(profile, `echo ${singleQuote(stamp)} > "${slotStampPath}"`);
}

// Tokens go through stdin, never argv
export function startAgentTmux(options: AgentTmuxStart): void {
  const confPath = path.posix.join(path.posix.dirname(options.clonePath), "agent-tmux.conf");
  writeGuestFile(options.profile, confPath, agentTmuxConf);
  const script = [
    "set -euo pipefail",
    "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN",
    "IFS= read -r GH_TOKEN",
    "export CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN",
    ...(options.beforeStart ?? []),
    `tmux -L ${agentTmuxSocket} kill-server 2>/dev/null || true`,
    // A leftover server would hand this session the previous one's environment, tokens included
    `if tmux -L ${agentTmuxSocket} ls >/dev/null 2>&1; then echo "stale agent tmux server survived kill-server" >&2; exit 1; fi`,
    `tmux -L ${agentTmuxSocket} -f ${confPath} new-session -d -s ${agentTmuxSession} -c ${JSON.stringify(options.clonePath)} ${singleQuote(options.windowCommand)}`,
    // new-session copies exported secrets into the server's global environment, where every later pane could read them
    `for v in CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN BEADS_DOLT_PASSWORD BEADS_DOLT_SERVER_MODE BEADS_DOLT_SERVER_HOST BEADS_DOLT_SERVER_PORT BEADS_DOLT_SERVER_USER BEADS_DOLT_SERVER_DATABASE; do tmux -L ${agentTmuxSocket} set-environment -g -u "$v" 2>/dev/null || true; done`,
    ...(options.afterStart ?? []),
  ].join("\n");
  sshScriptWithInput(options.profile, script, options.tokens);
}

export function writeGuestFile(profile: string, dest: string, content: string): void {
  const quoted = JSON.stringify(dest);
  const result = spawnSync(
    "colima",
    ["ssh", "-p", profile, "--", "bash", "-c", `mkdir -p "$(dirname ${quoted})" && cat > ${quoted}`],
    { input: content, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(`writing ${dest} into ${profile} failed`);
  }
}

function sshCapture(profile: string, command: string): string {
  const result = spawnSync("colima", ["ssh", "-p", profile, "--", "bash", "-c", command], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `guest command failed: ${command}`);
  }
  return result.stdout.trim();
}
