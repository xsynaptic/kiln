import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import type { KilnConfig } from "./config-schema.ts";

import { mainCheckoutPath } from "../shared/run-artifacts.ts";
import { kilnConfigSchema } from "./config-schema.ts";

const configFilename = "kiln.config.ts";

async function loadKilnConfig(): Promise<KilnConfig> {
  const configured = process.env.KILN_CONFIG;
  const file =
    configured === undefined || configured === "" ? path.join(mainCheckoutPath(), configFilename) : configured;
  if (!existsSync(file)) {
    throw new Error(`${file} not found; kiln reads its project descriptor from the repository root or KILN_CONFIG`);
  }
  const loaded = (await import(pathToFileURL(file).href)) as {
    default?: unknown;
  };
  const parsed = kilnConfigSchema.safeParse(loaded.default);
  if (!parsed.success) {
    throw new Error(`${configFilename} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export const kilnConfig = await loadKilnConfig();

export function githubRemoteUrl(): string {
  return `https://github.com/${kilnConfig.identity.githubRepo}.git`;
}

export function credentialsDir(): string {
  return path.join(homedir(), ".config", kilnConfig.identity.machineUser.name);
}

export function gatekeeperPatFile(): string {
  return path.join(credentialsDir(), "gatekeeper-pat");
}
