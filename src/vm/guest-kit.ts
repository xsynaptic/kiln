import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { kilnConfig } from "../config/config.ts";
import { mainCheckoutPath } from "../shared/run-artifacts.ts";
import { agentPortBlock, agentSlotFromName } from "./ports.ts";
import { guestTarball, sshScriptWithInput, writeGuestFile } from "./vm.ts";

// Read from the host's own install, so a run gets the kiln the host runs rather than a copy its branch could rewrite
const kilnRoot = path.resolve(import.meta.dirname, "..", "..");

const kilnGateFile = "kiln-gate.mjs";

const kilnGateFiles = [kilnGateFile, "kiln-gate-replay.mjs"];

export const guestKilnGateDir = ".git/kiln-gate";

const placeholderValues: Readonly<Record<string, string>> = {
  githubRepo: kilnConfig.identity.githubRepo,
  projectDoc: kilnConfig.projectDoc,
  "slots.vm.memoryGib": String(kilnConfig.slots.vm.memoryGib),
};

function guestKitDir(clonePath: string): string {
  return path.posix.join(path.posix.dirname(clonePath), "kiln");
}

function guestContractsDir(clonePath: string): string {
  return path.posix.join(guestKitDir(clonePath), "contracts");
}

export function copyKilnGate(dir: string): void {
  for (const file of kilnGateFiles) {
    cpSync(path.join(import.meta.dirname, "..", "run", file), path.join(dir, file));
  }
  chmodSync(path.join(dir, kilnGateFile), 0o755);
}

export function kilnGateLinkScript(clonePath: string): string {
  return `sudo ln -sfn ${JSON.stringify(path.posix.join(guestKitDir(clonePath), kilnGateFile))} /usr/local/bin/kiln-gate`;
}

/** @internal */
export function renderContract(source: string, values: Readonly<Record<string, string>>): string {
  return source.replaceAll(/\{\{([\w.]+)\}\}/g, (token, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`contract names ${token}, which the descriptor does not fill`);
    }
    return value;
  });
}

/** @internal */
export function renderedContracts(): Map<string, string> {
  const dir = path.join(kilnRoot, "contracts");
  return new Map(
    readdirSync(dir).map((file) => [
      file,
      renderContract(readFileSync(path.join(dir, file), "utf8"), placeholderValues),
    ]),
  );
}

export interface StagedKit {
  contractsDir: string;
  kit: string;
}

export function stageGuestKit(profile: string, clonePath: string, alsoHashed: ReadonlyArray<string> = []): StagedKit {
  const contractsDir = guestContractsDir(clonePath);
  const kitDir = JSON.stringify(guestKitDir(clonePath));
  const staging = mkdtempSync(path.join(tmpdir(), "kiln-kit-"));
  try {
    mkdirSync(path.join(staging, "contracts"));
    for (const [file, content] of renderedContracts()) {
      writeFileSync(path.join(staging, "contracts", file), content);
    }
    stageGuestSkills(path.join(staging, "skills"));
    copyKilnGate(staging);
    writeFileSync(path.join(staging, "gates.json"), gatesJson());
    sshScriptWithInput(
      profile,
      [
        `rm -rf ${kitDir} "$HOME/.claude/skills"`,
        `mkdir -p ${kitDir} "$HOME/.claude"`,
        `base64 -d | tar -x --warning=no-unknown-keyword -C ${kitDir}`,
        `cp -r ${kitDir}/skills "$HOME/.claude/skills"`,
      ].join(" && "),
      guestTarball(staging, { followSymlinks: false }),
    );
    writeGuestFile(profile, "$HOME/.claude/CLAUDE.md", guestStub(profile, contractsDir, kilnConfig.playbooks.session));
    return { contractsDir, kit: kitRevision(staging, alsoHashed) };
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

/** @internal */
export function guestStub(profile: string, contractsDir: string, sessionPlaybook: string | undefined): string {
  const slot = agentSlotFromName(profile);
  if (slot === undefined) {
    throw new Error(`${profile} is not a kiln slot`);
  }
  const playbook = sessionPlaybook === undefined ? [] : [`Your playbook is \`${sessionPlaybook}\`.`];
  return [
    `# Sandbox slot ${profile}`,
    "",
    `A dispatched run follows the contract its launch prompt names. Every other session is attended: follow \`${contractsDir}/attended.md\`.`,
    ...playbook,
    "",
    `Dev servers run on port block +${String(agentPortBlock(slot).offset)}000; use the URLs the stack prints.`,
    "",
  ].join("\n");
}

function stageGuestSkills(target: string): void {
  mkdirSync(target);
  const configured = kilnConfig.guest.skillsDir;
  if (configured === undefined) {
    return;
  }
  const dir = configured.startsWith("~/")
    ? path.join(homedir(), configured.slice(2))
    : path.resolve(mainCheckoutPath(), configured);
  if (!existsSync(dir)) {
    throw new Error(`guest.skillsDir points at a missing folder: ${dir}`);
  }
  cpSync(dir, target, { dereference: true, recursive: true });
}

function gatesJson(): string {
  const { author, env, merge } = kilnConfig.gates;
  return `${JSON.stringify({ author, env, merge }, undefined, 2)}\n`;
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
