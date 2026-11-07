import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";

import type { PortBlock } from "./ports.ts";
import type { SlotToolchain } from "./toolchain.ts";

import { kilnConfig } from "../config/config.ts";
import { isPortInUse } from "../shared/net.ts";
import { capture, runOrThrow } from "../shared/proc.ts";
import { mainCheckoutPath } from "../shared/run-artifacts.ts";
import { kilnGateLinkScript, stageGuestKit } from "./guest-kit.ts";
import { acquireLease } from "./lease.ts";
import { agentPortBlock, pinEnvPorts } from "./ports.ts";
import { boundaryDrillScript, guestBaseScript, guestClockScript, guestProjectScript } from "./provision-scripts.ts";
import { slotToolchain, toolchainStamp } from "./toolchain.ts";
import { guestClonePath, isVmRunning, sshScript, stampSlotProvisioned, writeGuestFile } from "./vm.ts";

interface Slot {
  block: PortBlock;
  profile: string;
}

/** @internal */
export function assertSlotWithinCap(slotNumber: number, maxSlots: number): void {
  if (slotNumber > maxSlots) {
    throw new Error(
      `kiln-${String(slotNumber)} is beyond the provisioning cap (slots.max: ${String(maxSlots)} in kiln.config.ts); ` +
        `raise the cap there if the host can afford another slot`,
    );
  }
}

export async function provisionSlot(name: string, slotNumber: number): Promise<void> {
  assertSlotWithinCap(slotNumber, kilnConfig.slots.max);
  assertColimaInstalled();

  const repoRoot = mainCheckoutPath();
  const releaseLease = acquireLease(repoRoot, name, "provision");
  try {
    await provision({ block: agentPortBlock(slotNumber), profile: name }, repoRoot);
  } finally {
    releaseLease();
  }
}

async function provision(slot: Slot, repoRoot: string): Promise<void> {
  if (isVmRunning(slot.profile)) {
    console.log(`${slot.profile} is already running; refreshing provisioning`);
  } else {
    await assertBlockFree(slot.block);
    startVm(slot.profile, repoRoot);
  }

  // First, so a slot whose boundary fails never receives env files or tokens
  console.log(`\nboundary drill:`);
  sshScript(slot.profile, boundaryDrillScript(repoRoot));

  console.log(`\nhanding the guest clock to timesyncd alone`);
  sshScript(slot.profile, guestClockScript());

  const toolchain = slotToolchain(repoRoot);
  console.log(`\nprovisioning the guest base (kiln toolchain)`);
  sshScript(slot.profile, guestBaseScript(toolchain));
  console.log(`provisioning the project (clone, node toolchain, deps)`);
  sshScript(slot.profile, guestProjectScript(slot.profile, repoRoot, toolchain));
  const clonePath = guestClonePath(slot.profile);

  console.log(`copying env files (node ports pinned to block +${String(slot.block.offset)}000)`);
  await copyEnvFiles(slot, repoRoot, clonePath);

  console.log(`writing the guest statusline`);
  writeGuestStatusline(slot);
  stageGuestKit(slot.profile, clonePath);
  sshScript(slot.profile, kilnGateLinkScript(clonePath));

  // Last, so a slot that failed anywhere above reads as unprovisioned rather than ready
  stampSlotProvisioned(slot.profile, toolchainStamp(toolchain));
  printSummary(slot, clonePath, toolchain);
}

async function assertBlockFree(block: PortBlock): Promise<void> {
  const taken: Array<string> = [];
  for (const [key, port] of Object.entries(block.ports)) {
    if (await isPortInUse(port)) {
      taken.push(`${String(port)} (${key})`);
    }
  }
  if (taken.length > 0) {
    throw new Error(
      `port block +${String(block.offset)}000 is occupied: ${taken.join(", ")} already in use.\n` +
        `Lima forwards lose silently on a taken host port, so the slot cannot start safely. ` +
        `Free the port (lsof -i :<port>) or use another slot.`,
    );
  }
}

function assertColimaInstalled(): void {
  const result = spawnSync("colima", ["version"], { stdio: "ignore" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("colima not found; install it with: brew install colima");
  }
}

async function copyEnvFiles(slot: Slot, repoRoot: string, clonePath: string): Promise<void> {
  const envFiles = await glob(["**/.env", "**/.env.*"], {
    cwd: repoRoot,
    dot: true,
    ignore: ["**/node_modules/**", "**/.env.example"],
  });
  for (const relativePath of envFiles) {
    const content = readFileSync(path.join(repoRoot, relativePath), "utf8");
    writeGuestFile(
      slot.profile,
      path.posix.join(clonePath, relativePath),
      relativePath === ".env" ? pinEnvPorts(content, slot.block) : content,
    );
  }
  console.log(`  copied ${String(envFiles.length)} env file(s)`);
}

function printSummary(slot: Slot, clonePath: string, toolchain: SlotToolchain): void {
  const { ports } = slot.block;
  const { vm } = kilnConfig.slots;
  console.log(
    `\nagent slot ready: ${slot.profile} (${String(vm.cpus)} CPU / ${String(vm.memoryGib)} GiB / ${String(vm.diskGib)} G, vz)`,
  );
  console.log(`  workspace: ${clonePath} (VM-local clone; origin = GitHub, host-ro = read-only host mount)`);
  console.log(`  boundary drill: passed`);
  console.log(
    `  toolchain: claude ${toolchain.claude}, bd ${toolchain.beads}, gitleaks ${toolchain.gitleaks}, node ${toolchain.node}, pnpm ${toolchain.pnpm}`,
  );
  console.log(
    `\nSlot node servers (block +${String(slot.block.offset)}000; Lima forwards to host localhost; everything else runs repo defaults inside the VM):`,
  );
  for (const [key, port] of Object.entries(ports)) {
    console.log(`  ${key}  http://localhost:${String(port)}`);
  }
  console.log(`\nShell in:          colima ssh -p ${slot.profile}`);
  console.log(`Guest docker:      DOCKER_CONTEXT=colima-${slot.profile} docker ...`);
  console.log(`Stop the slot:     colima stop -p ${slot.profile}`);
}

function safeDockerContext(): string | undefined {
  try {
    return capture("docker", ["context", "show"]);
  } catch {
    return undefined;
  }
}

function startVm(profile: string, repoRoot: string): void {
  const { vm } = kilnConfig.slots;
  const contextBefore = safeDockerContext();
  try {
    runOrThrow(
      "colima",
      [
        "start",
        "-p",
        profile,
        "--cpus",
        String(vm.cpus),
        "--memory",
        String(vm.memoryGib),
        "--disk",
        String(vm.diskGib),
        "--vm-type",
        "vz",
        "--activate=false",
        "--ssh-config=false",
        // Read-only, and it replaces the default writable mount of the home folder
        "--mount",
        repoRoot,
      ],
      repoRoot,
    );
  } finally {
    const contextAfter = safeDockerContext();
    if (contextBefore !== undefined && contextAfter !== contextBefore) {
      runOrThrow("docker", ["context", "use", contextBefore], repoRoot);
    }
  }
}

function writeGuestStatusline(slot: Slot): void {
  writeGuestFile(
    slot.profile,
    "$HOME/.claude/statusline.sh",
    [
      "#!/bin/sh",
      "# Claude Code pipes session JSON on stdin; the first stdout line renders",
      `cwd=$(jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)`,
      `branch=$(git -C "\${cwd:-.}" branch --show-current 2>/dev/null)`,
      `printf '%s\\n' "${slot.profile} · \${branch:-no branch} · block +${String(slot.block.offset)}000"`,
      "",
    ].join("\n"),
  );
  sshScript(slot.profile, `chmod +x "$HOME/.claude/statusline.sh"`);
}
