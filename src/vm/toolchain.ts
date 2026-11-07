import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { kilnConfig } from "../config/config.ts";
import { optionalText } from "../shared/lenient-json.ts";
import { safeCapture } from "../shared/run-artifacts.ts";

const packageManagerSchema = z.object({ packageManager: optionalText });

// Bump this when the provisioning script itself changes; editing guest in kiln.config.ts already changes the stamp
const slotContractVersion = 7;

export interface SlotToolchain {
  beads: string;
  claude: string;
  gitleaks: string;
  node: string;
  pnpm: string;
}

export function slotToolchain(repoRoot: string): SlotToolchain {
  const pins = kilnConfig.guest.pins;
  const manifest: unknown = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const { packageManager } = packageManagerSchema.parse(manifest);
  const pnpm = packageManager?.split("@", 2)[1];
  if (pnpm === undefined) {
    throw new Error("packageManager pin missing from the root package.json");
  }
  return {
    beads: pins?.beads ?? "1.3.2",
    claude: pins?.claude ?? hostClaudeVersion(),
    gitleaks: pins?.gitleaks ?? "8.30.1",
    node: readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim(),
    pnpm,
  };
}

export function toolchainStamp(toolchain: SlotToolchain): string {
  return JSON.stringify({ contract: slotContractVersion, guest: kilnConfig.guest, ...toolchain });
}

export function parseClaudeVersion(output: string | undefined): string | undefined {
  return output?.match(/^\d+\.\d+\.\d+/)?.[0];
}

function hostClaudeVersion(): string {
  const version = parseClaudeVersion(safeCapture("claude", ["--version"]));
  if (version === undefined) {
    throw new Error("no claude on the host PATH to match slots to; set guest.pins.claude in kiln.config.ts");
  }
  return version;
}
