import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { credentialsDir } from "../config/config.ts";
import { parseJson } from "../shared/lenient-json.ts";
import { sleepMs } from "../shared/proc.ts";
import { safeCapture } from "../shared/run-artifacts.ts";
import { scrubSecrets } from "../shared/scrub.ts";
import { guestClonePath, slotSsh, slotSshHostAlias, sshCaptureSafe } from "./vm.ts";

const beadsPort = 3307;
const beadsDatabase = "bd";
// Slots never connect as root, so this grant is everything a slot can touch
const beadsRole = "agent_rw";

interface BeadsClient {
  envLines: Array<string>;
  passwordLine: string;
}

const doltStatusSchema = z.object({ running: z.literal(true) });

export function beadsClient(profile: string, isReadonly = false): BeadsClient {
  const file = passwordFile();
  if (!existsSync(file)) {
    throw new Error(`no beads rw password at ${file}; create it to give the sandbox task-state access`);
  }
  if (!didEnsureBeadsServer()) {
    throw new Error("the beads Dolt server is down and would not start; no session can reach task state");
  }
  const rolePassword = readFileSync(file, "utf8").trim();
  ensureBeadsRole(rolePassword);
  if (!didEnsureBeadsTunnel(profile)) {
    throw new Error(
      `the beads forward into ${profile} carries no connection; something else may hold guest port ${String(beadsPort)} (pnpm kiln new ${profile} clears a slot's own store)`,
    );
  }
  return {
    envLines: beadsEnvLines(isReadonly),
    passwordLine: `${rolePassword}\n`,
  };
}

// The first line reads the password from stdin, so these lines must come straight after the token reads
/** @internal */
export function beadsEnvLines(isReadonly: boolean): Array<string> {
  const readonlyVar = isReadonly ? " BD_READONLY=1" : "";
  return [
    "IFS= read -r BEADS_DOLT_PASSWORD",
    `export BEADS_DOLT_PASSWORD${readonlyVar} BEADS_DOLT_SERVER_MODE=1 BEADS_DOLT_SERVER_HOST=127.0.0.1 BEADS_DOLT_SERVER_PORT=${String(beadsPort)} BEADS_DOLT_SERVER_USER=${beadsRole} BEADS_DOLT_SERVER_DATABASE=${beadsDatabase}`,
  ];
}

function ensureBeadsRole(rolePassword: string): void {
  const rootPassword = readDoltRootPassword();
  if (rootPassword === undefined) {
    return;
  }
  // Passwords go through stdin and the environment, never argv, which any process on the host can read
  const applied = spawnSync(
    "dolt",
    ["--host", "127.0.0.1", "--port", String(beadsPort), "--user", "root", "--no-tls", "sql"],
    {
      encoding: "utf8",
      env: { ...process.env, DOLT_CLI_PASSWORD: rootPassword },
      input: roleSql(rolePassword),
    },
  );
  if (applied.status === 0) {
    return;
  }
  // dolt echoes the failing statement, which contains the new password
  const reason = scrubSecrets(applied.stderr.trim() || "unknown error", [rolePassword, rootPassword]);
  console.warn(
    `warning: could not reconcile the ${beadsRole} beads role (${reason}); a slot reaches the store only if the role already matches the password file`,
  );
}

export function didEnsureBeadsServer(): boolean {
  if (isBeadsServerUp()) {
    return true;
  }
  console.log("beads Dolt server is down; starting it (bd dolt start)");
  const started = spawnSync("bd", ["dolt", "start"], { encoding: "utf8" });
  if (started.status !== 0) {
    console.warn(`bd dolt start failed: ${started.stderr.trim() || started.stdout.trim() || "unknown error"}`);
    return false;
  }
  // `start` returns before the server accepts connections
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (isBeadsServerUp()) {
      return true;
    }
    sleepMs(250);
  }
  return false;
}

// ControlPath=none, because colima's shared ssh connection silently drops -R forwards
function didEnsureBeadsTunnel(profile: string): boolean {
  if (didProbeBeadsTunnel(profile)) {
    return true;
  }
  // A forward that fails the probe is killed, or it would keep its replacement off the guest port
  killBeadsTunnel(profile);
  const { configPath, hostAlias } = slotSsh(profile);
  const child = spawn(
    "ssh",
    [
      "-F",
      configPath,
      "-o",
      "ControlPath=none",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-N",
      "-R",
      // A bare port binds both IPv4 and IPv6, and a clash on IPv4 alone would leave ssh running a forward bd can't use
      `127.0.0.1:${String(beadsPort)}:127.0.0.1:${String(beadsPort)}`,
      hostAlias,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    sleepMs(500);
    if (didProbeBeadsTunnel(profile)) {
      return true;
    }
  }
  return false;
}

export function killBeadsTunnel(profile: string): void {
  for (const pid of tunnelPids(profile)) {
    try {
      process.kill(pid);
    } catch {}
  }
}

// A live ssh shows the guest listener is ours and `bd dolt test` shows it answers; it takes both
function didProbeBeadsTunnel(profile: string): boolean {
  if (tunnelPids(profile).length === 0) {
    return false;
  }
  return sshCaptureSafe(profile, `cd ${guestClonePath(profile)} && bd dolt test`) !== undefined;
}

function isBeadsServerUp(): boolean {
  const status = safeCapture("bd", ["dolt", "status", "--json"]);
  if (status === undefined) {
    return false;
  }
  return doltStatusSchema.safeParse(parseJson(status)).success;
}

/** @internal */
export function parseDoltRootPassword(contents: string, port: number): string | undefined {
  let isInSection = false;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      isInSection = line === `[127.0.0.1:${String(port)}]`;
      continue;
    }
    if (isInSection && line.startsWith("password=")) {
      return line.slice("password=".length).trim();
    }
  }
  return undefined;
}

function passwordFile(): string {
  return path.join(credentialsDir(), "beads-rw-password");
}

function readDoltRootPassword(): string | undefined {
  const file = path.join(homedir(), ".config", "beads", "credentials");
  if (!existsSync(file)) {
    console.warn(`warning: no beads root credentials at ${file}; the ${beadsRole} role cannot be reconciled from here`);
    return undefined;
  }
  return parseDoltRootPassword(readFileSync(file, "utf8"), beadsPort);
}

// CREATE leaves an existing role's password alone, so the ALTER is what makes the file's password the real one
/** @internal */
export function roleSql(rolePassword: string): string {
  const role = `'${beadsRole}'@'%'`;
  return [
    `CREATE USER IF NOT EXISTS ${role} IDENTIFIED BY '${rolePassword.replaceAll("'", "''")}';`,
    `ALTER USER ${role} IDENTIFIED BY '${rolePassword.replaceAll("'", "''")}';`,
    `GRANT ALL PRIVILEGES ON \`${beadsDatabase}\`.* TO ${role};`,
    "",
  ].join("\n");
}

// Found by its ssh command line rather than a pidfile, whose pid can be reused, or read as 0 and kill the whole process group
function tunnelPids(profile: string): Array<number> {
  const pattern = `[s]sh .*-R 127.0.0.1:${String(beadsPort)}:127.0.0.1:${String(beadsPort)} ${slotSshHostAlias(profile)}`;
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}
